import * as vscode from 'vscode';
import { computeDiff } from './diff';
import { type ActiveChat, fileKey, isBlobHash, RawEntry, resolveSnapshot, Status } from './logic';
import { readTranscriptMeta, RequestInfo, sessionsDir, clearTranscriptMetadataForRoots, transcriptMetadataCacheCount, findTurnToolUse } from './sessions';
import { activeReview, copyReview, ingestEntries, ReviewContent, ReviewDecisionRequest, ReviewError, ReviewResolution, SharedReview, sameContent } from './review';
import { ReviewStore } from './review-store';
import { withCaptureMaintenance, recoverCaptureMaintenance } from './maintenance';
import { executeDecisionDetailed, ResourceAdapter, undoItemDetailed } from './reversal';
import { inspectHookConfiguration } from './hooks';
import { CaptureSetup, LOG_DIR } from './capture-setup';
import { collectLogBlobs, housekeep, MAX_LOG_ENTRIES, pruneReviewedLog } from './housekeeping';
import { writeOwnedFile } from './owned-file';
import { readShellActivity, emptyShellActivity, type ShellActivity } from './shell-activity';
import { htmlLanguage, plural, t, webviewDictionaryScript } from './i18n';
import { isTrashUnavailable, remoteName } from './remote';
import { assessResourceScope, assessStoragePath, makeCapturePolicy, readLogFile, readVerifiedBlob, safeReadText, transcriptAllowed, validateMessage, validateSavedMeta, retentionCandidates, CaptureDiagnostics, readCaptureDiagnostics } from './history';
import { captureHealth, CaptureConfiguration, retainCaptureEvidence } from './capture-health';
import { projectReview, operationView, pendingOperationView, ReviewItemResult, blockedReviewResult, ReviewResultError, formatReviewItemResult, summarizeReviewResults } from './review-results';
import { evaluateMetadataPolicy, revalidateMetadataPermit, MetadataPermit, MetadataPolicyContext } from './metadata-policy';
import { inventoryPurge, planPurge, summarizePurge, PurgeInventory, PurgeEffect, PurgeReport, PurgeReason, PurgeMemory, PURGE_MEMORY_PATHS } from './purge-plan';
import { describeReason } from './messages';
import { BaseView, FileSummary, ViewEntry, changesSummary, basename, capitalize, countFiles, errorCode, excludedPatterns, explain, purgeFailureReason, purgeInventoryText, purgeReportText, toViewEntry, HOOK_SCRIPT_DIFFERS, NODE_MISSING } from './changes-view';
import { STATUS_KEY, LEGACY_REVIEWED_KEY, UNDO_KEY, Undo, loadStatus, loadUndo, confirm, createNonce, existsLocal, canonicalResource } from './changes-support';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import * as crypto from 'node:crypto';
import { Buffer as Bytes } from 'node:buffer';
import { TextDecoder as Utf8Decoder } from 'node:util';

export type { RawEntry, Snapshot } from './logic';

const LOG_PATH = [...LOG_DIR, 'log.jsonl'];
const BLOB_DIR = [...LOG_DIR, 'blobs'];
/** Explicação e pedido já achados no transcript, para não depender dele depois. */
const META_PATH = [...LOG_DIR, 'meta.json'];
const SCHEME = 'claude-launcher-change';
const PURGE_STATE_FILE = 'purge-state.v1.json';
const PENDING_CONTEXT = 'claudeCodeLauncher.hasPendingChanges';
/** Comando interno de inline.ts: esquece a revisão aberta de um arquivo, sem marcar nada. */
export const DROP_REVIEW_COMMAND = 'claude-code-launcher.dropReview';

/** Edições mostradas no histórico. */
const MAX_HISTORY = 60;
const MAX_STATUS = 3000;
const MAX_META_ATTEMPTS = 10;
/** Intervalo da coleta de marcadores e cópias sem uso, por pasta. */
const HOUSEKEEPING_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Nova tentativa depois de uma coleta que não pôde terminar. */
const HOUSEKEEPING_RETRY_MS = 5 * 60 * 1000;

export function changeUri(entry: RawEntry, side: 'antes' | 'depois'): vscode.Uri {
	return vscode.Uri.from({ scheme: SCHEME, path: `/${entry.id}/${side}/${basename(entry.file)}` });
}


type Message = { command?: string; id?: string; key?: string; request?: string; revision?: number };

export function registerChanges(context: vscode.ExtensionContext): ChangesController {
	const controller = new ChangesController(context);
	context.subscriptions.push(
		controller,
		vscode.window.registerWebviewViewProvider(ChangesController.viewId, controller),
		vscode.workspace.registerTextDocumentContentProvider(SCHEME, controller),
		vscode.window.registerFileDecorationProvider(controller),
		vscode.commands.registerCommand('claude-code-launcher.showChanges', () => controller.openPanel()),
		vscode.commands.registerCommand('claude-code-launcher.enableChangeLog', () => controller.setEnabled(true)),
		vscode.commands.registerCommand('claude-code-launcher.disableChangeLog', () => controller.setEnabled(false)),
		vscode.commands.registerCommand('claude-code-launcher.clearChanges', () => controller.clear()),
		vscode.commands.registerCommand('claude-code-launcher.acceptEverything', () => controller.acceptEverything()),
		vscode.commands.registerCommand('claude-code-launcher.rejectEverything', () => controller.rejectEverything()),
		vscode.commands.registerCommand('claude-code-launcher.undoReject', () => controller.undoReject()),
		vscode.commands.registerCommand('claude-code-launcher.clearAllReviewData', () => controller.clearAllReviewData()),
		vscode.commands.registerCommand('claude-code-launcher.releaseReviewWriter', () => controller.releaseReviewWriter()),
		vscode.commands.registerCommand('claude-code-launcher.recoverReviewWriter', () => controller.recoverReviewWriter()),
		vscode.commands.registerCommand('claude-code-launcher.refreshChanges', () => controller.refresh()),
		vscode.commands.registerCommand('claude-code-launcher.copyChangesSummary', () => controller.copySummary()),
	);
	void controller.repairHooks().catch(() => undefined);
	return controller;
}

export class ChangesController implements
	vscode.WebviewViewProvider, vscode.TextDocumentContentProvider, vscode.FileDecorationProvider, vscode.Disposable {
	public static readonly viewId = 'claude-code-launcher.changes';

	/** Todas as edições do log, da mais recente para a mais antiga. */
	private entries: RawEntry[] = [];
	private enabled = false;
	private view: vscode.WebviewView | undefined;
	private panel: vscode.WebviewPanel | undefined;
	private readonly viewSubscriptions: vscode.Disposable[] = [];
	private readonly panelSubscriptions: vscode.Disposable[] = [];
	private refreshTimer: ReturnType<typeof setTimeout> | undefined;
	private publishTimer: ReturnType<typeof setTimeout> | undefined;
	/** Conversa em foco: com ela definida, o painel mostra só as edições dela (a menos que "Ver todos" esteja ligado). */
	private activeChat: ActiveChat | null = null;
	private showAllChats = false;
	/** Comandos de terminal que podem ter alterado arquivos fora da captura, nas conversas em revisão. */
	private shellActivity: (ShellActivity & { scope: 'chat' | 'pending' }) | null = null;
	private shellTimer: ReturnType<typeof setTimeout> | undefined;
	private shellGeneration = 0;
	/** Pastas com a captura do turno configurada: nelas, o que os comandos mudam já entra na revisão. */
	private readonly turnCaptureFolders = new Set<string>();
	/** Chamada de ferramenta do transcript associada a cada mudança por comando, para achar pedido e explicação. */
	private readonly commandToolUses = new Map<string, string>();
	private metaTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly reasonCache = new Map<string, string>();
	private readonly requestCache = new Map<string, RequestInfo>();
	private readonly metaAttempts = new Map<string, number>();
	private readonly pendingMetadata = new Map<string, { reason?: string; request?: RequestInfo; permits: MetadataPermit[]; epoch: number }>();
	private readonly status: Map<string, ReviewResolution>;
	private readonly undoStack: Undo[];
	private readonly stores = new Map<string, ReviewStore>();
	private readonly storeErrors = new Map<string, string>();
	private readonly sharedReviews = new Map<string, SharedReview>();
	private readonly lastOperationResults = new Map<string, ReviewItemResult>();
	private readonly lastPurgeReports: Array<{ workspace: number; report: PurgeReport }> = [];
	private readonly fileStores = new Map<string, ReviewStore>();
	private readonly logCache = new Map<string, { cursor: { offset: number; line: number }; entries: RawEntry[]; size: number; mtime: number; inode: number; rejections: number; partialReason?: string }>();
	private readonly ordinals = new Map<string, number>();
	private coverageMessage: string | null = null;
	private disposed = false;
	private maintenance = false;
	private metaEpoch = 0;
	private maintenanceCompletion: Promise<void> | undefined;
	private completeMaintenance: (() => void) | undefined;
	private disposal: Promise<void> = Promise.resolve();
	private readonly backgroundTasks = new Set<Promise<unknown>>();
	private readonly captureWarnings = new Map<string, string>();
	private readonly captureEvidence = new Map<string, CaptureDiagnostics>();
	private readonly captureHealthStates = new Map<string, ReturnType<typeof captureHealth>>();
	private readonly activeOperations = new Set<Promise<unknown>>();
	private readonly hookWarnings = new Map<string, string>();
	/** Avisos sobre o ambiente de execução do hook (executável ausente, script alterado), por pasta. */
	private readonly runtimeWarnings = new Map<string, string>();
	private readonly nextHousekeeping = new Map<string, number>();
	/** Pastas em que a recuperação da revisão já foi oferecida nesta janela. */
	private readonly recoveryOffered = new Set<string>();
	/** Script, política e handlers da captura de cada pasta. */
	readonly capture: CaptureSetup;
	private readonly resourceAliases = new Map<string, string>();
	private readonly ambiguousResources = new Set<string>();
	private refreshing: Promise<void> | undefined;
	private refreshAgain = false;
	/** Diff e textos de cada edição (a edição não muda depois de gravada). */
	private readonly viewCache = new Map<string, BaseView>();
	private readonly summaryCache = new Map<string, FileSummary>();
	/** Texto de cada blob já lido: hash → texto. */
	private blobCache = new Map<string, string>();
	/** Pasta do workspace (uri) de cujo log veio cada edição. */
	private entryFolder = new Map<string, string>();
	/** Último texto lido ou gravado de status.json e meta.json, por uri. */
	private readonly stateText = new Map<string, string>();
	private writeChain: Promise<void> = Promise.resolve();
	private writeQueued = false;
	private metaRunning = false;
	private metaAgain = false;
	/** Arquivos marcados no Explorer: chave → caminho real. */
	private decorated = new Map<string, string>();
	private readonly statusItem: vscode.StatusBarItem;

	private readonly entriesEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeEntries = this.entriesEmitter.event;
	private readonly decorationEmitter = new vscode.EventEmitter<vscode.Uri[]>();
	readonly onDidChangeFileDecorations = this.decorationEmitter.event;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.status = new Map(loadStatus(context.workspaceState));
		this.undoStack = loadUndo(context.workspaceState);
		this.capture = new CaptureSetup(context, {
			ensureStore: (folder, allowPurgeRecovery) => this.ensureStore(folder, allowPurgeRecovery),
			storeOf: (folder) => this.stores.get(folder.uri.toString()),
			cancelled: () => this.disposed,
			inMaintenance: () => this.maintenance,
		});
		this.statusItem = vscode.window.createStatusBarItem('claude-code-launcher.pending', vscode.StatusBarAlignment.Right, 99);
		this.statusItem.name = t('Mudanças do Claude');
		this.statusItem.command = 'claude-code-launcher.showChanges';

		const watcher = vscode.workspace.createFileSystemWatcher(
			'**/.claude/{launcher-changes/log.jsonl,launcher-changes/status.json,launcher-changes/review-state.v1.json,launcher-changes/capture-status.json,settings.local.json}',
		);
		const diagnosticWatcher = vscode.workspace.createFileSystemWatcher('**/.claude/launcher-changes/capture-diagnostics/v2/**/*.json');
		const schedule = () => this.scheduleRefresh();
		this.disposables.push(
			this.entriesEmitter,
			this.decorationEmitter,
			this.statusItem,
			watcher,
			watcher.onDidCreate(schedule),
			watcher.onDidChange(schedule),
			watcher.onDidDelete(schedule),
			diagnosticWatcher,
			diagnosticWatcher.onDidCreate(schedule),
			diagnosticWatcher.onDidChange(schedule),
			diagnosticWatcher.onDidDelete(schedule),
			vscode.workspace.onDidChangeWorkspaceFolders(() => {
				this.metaEpoch += 1;
				// O caminho relativo mostrado no painel depende das pastas abertas.
				this.viewCache.clear();
				this.summaryCache.clear();
				void this.repairHooks();
				schedule();
			}),
		);
		this.disposables.push(vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('claudeCodeLauncher') || event.affectsConfiguration('claudeCode.claudeProcessWrapper')) {
				this.metaEpoch += 1;
				this.pendingMetadata.clear();
				this.scheduleRefresh();
				void this.repairHooks().catch(() => undefined);
			}
		}));
		this.disposables.push(vscode.workspace.onDidChangeTextDocument((event) => {
			if (this.disposed || event.document.uri.scheme !== 'file' || !this.getSharedReview(event.document.uri.fsPath)) { return; }
			this.summaryCache.clear(); clearTimeout(this.publishTimer);
			// Cada publicação reenvia o estado às webviews; uma por rajada de digitação basta.
			this.publishTimer = setTimeout(() => { if (!this.disposed) { this.publish(); } }, 200);
		}));
		this.scheduleRefresh();
	}

	dispose(): void {
		if (this.disposed) { return; }
		this.disposed = true; this.metaEpoch += 1;
		clearTimeout(this.refreshTimer); clearTimeout(this.publishTimer); clearTimeout(this.metaTimer); clearTimeout(this.shellTimer);
		this.viewSubscriptions.splice(0).forEach((subscription) => subscription.dispose());
		this.panelSubscriptions.splice(0).forEach((subscription) => subscription.dispose());
		this.view = undefined; const panel = this.panel; this.panel = undefined; panel?.dispose();
		this.disposables.forEach((disposable) => disposable.dispose());
		const pending = [...this.activeOperations, ...this.backgroundTasks, this.writeChain, this.refreshing, this.maintenanceCompletion].filter((work): work is Promise<unknown> => work !== undefined);
		this.disposal = Promise.allSettled(pending).then(async () => {
			await Promise.allSettled([...this.stores.values()].map((store) => store.close()));
			this.stores.clear(); this.sharedReviews.clear(); this.fileStores.clear(); this.resourceAliases.clear(); this.ambiguousResources.clear();
			this.entries = []; this.undoStack.splice(0); this.status.clear(); this.logCache.clear(); this.entryFolder.clear(); this.ordinals.clear();
			clearTranscriptMetadataForRoots((vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === 'file').map((folder) => sessionsDir(folder.uri.fsPath)));
			this.reasonCache.clear(); this.requestCache.clear(); this.commandToolUses.clear(); this.metaAttempts.clear(); this.pendingMetadata.clear(); this.blobCache.clear(); this.viewCache.clear(); this.summaryCache.clear();
			this.stateText.clear(); this.comparisonTexts.clear(); this.decorated.clear(); this.lastOperationResults.clear();
			this.captureEvidence.clear(); this.captureHealthStates.clear(); this.captureWarnings.clear(); this.hookWarnings.clear(); this.runtimeWarnings.clear(); this.nextHousekeeping.clear(); this.recoveryOffered.clear(); this.storeErrors.clear();
		});
	}
	whenDisposed(): Promise<void> { return this.disposal; }
	private beginMaintenance(): void {
		if (this.disposed || this.maintenance) { throw new ReviewError('maintenanceInProgress'); }
		this.maintenance = true;
		this.maintenanceCompletion = new Promise((resolve) => { this.completeMaintenance = resolve; });
	}
	private endMaintenance(): void { this.maintenance = false; this.completeMaintenance?.(); this.completeMaintenance = undefined; this.maintenanceCompletion = undefined; }
	private async background<T>(work: () => Promise<T>): Promise<T> {
		if (this.disposed || this.maintenance) { throw new ReviewError('maintenanceInProgress'); }
		const task = work(); this.backgroundTasks.add(task);
		try { return await task; } finally { this.backgroundTasks.delete(task); }
	}

	// ---- Usado por inline.ts ----------------------------------------------------

	/** Define a conversa cujas mudanças o painel mostra; `null` mostra tudo. */
	setActiveChat(chat: ActiveChat | null): void {
		if (this.disposed || this.activeChat?.sessions.join('\0') === chat?.sessions.join('\0')) { return; }
		this.activeChat = chat;
		this.summaryCache.clear();
		this.publish();
		this.refreshShellActivity(0);
	}

	private toggleAllChats(): void {
		this.showAllChats = !this.showAllChats;
		this.summaryCache.clear();
		this.publish();
		this.refreshShellActivity(0);
	}

	/** Relê os comandos de terminal das conversas em revisão; chamado quando um transcript muda. */
	refreshShellActivity(delay = 500): void {
		if (this.disposed) { return; }
		clearTimeout(this.shellTimer);
		this.shellTimer = setTimeout(() => { void this.updateShellActivity().catch(() => undefined); }, delay);
	}

	/**
	 * Com uma conversa em foco, olha só ela; sem foco (ou com "Ver todas"), as conversas que têm
	 * mudanças para revisar. Conversas que só rodaram comandos, sem aba nem pendência, ficam de fora.
	 */
	private async updateShellActivity(): Promise<void> {
		const generation = ++this.shellGeneration;
		const scoped = Boolean(this.activeChat) && !this.showAllChats;
		const candidates = scoped ? this.activeChat?.sessions ?? []
			: this.pendingGroups().flat().map((entry) => entry.session ?? '');
		const sessions = [...new Set(candidates)].filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)).slice(0, 20);
		const localFolders = (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === 'file');
		const roots = localFolders.map((folder) => sessionsDir(folder.uri.fsPath));
		// Com a captura do turno em todas as pastas, o que os comandos mudam já aparece na lista: o aviso sobraria.
		if (localFolders.length && localFolders.every((folder) => this.turnCaptureFolders.has(folder.uri.toString()))) {
			if (this.shellActivity !== null) { this.shellActivity = null; this.publish(); }
			return;
		}
		const total = emptyShellActivity();
		for (const session of sessions) {
			for (const root of roots) {
				const activity = await readShellActivity(nodePath.join(root, session + '.jsonl'));
				if (!activity) { continue; }
				total.commands += activity.commands; total.mayWrite += activity.mayWrite; total.partial ||= activity.partial;
				total.programs = [...new Set([...activity.programs, ...total.programs])].slice(0, 3);
				break;
			}
		}
		if (this.disposed || generation !== this.shellGeneration) { return; }
		const next = total.mayWrite > 0 ? { ...total, scope: scoped ? 'chat' as const : 'pending' as const } : null;
		if (JSON.stringify(next) === JSON.stringify(this.shellActivity)) { return; }
		this.shellActivity = next;
		this.publish();
	}

	getEntries(): readonly RawEntry[] {
		return this.entries;
	}

	isReviewed(id: string): boolean {
		return this.status.has(id);
	}

	/** Compatibility entry point; actual user decisions always use the shared executor. */
	async setStatus(ids: readonly string[], status: Status | undefined): Promise<void> {
		if (status === undefined) { throw new ReviewError('explicitReopenRequired'); }
		const files = new Set(this.entries.filter((entry) => ids.includes(entry.id)).map((entry) => entry.file));
		for (const file of files) { await this.executeReviewDecision(file, { action: status === 'accepted' ? 'accept' : 'reject' }); }
	}

	getSharedReview(file: string): SharedReview | undefined {
		const key = this.resourceKey(file);
		const review = this.sharedReviews.get(key ?? this.resourceAliases.get(file) ?? file);
		return review && copyReview(review);
	}

	async executeReviewDecision(file: string, request: ReviewDecisionRequest, batchId?: string): Promise<void> {
		const blocked = (reason: string): never => {
			const result = blockedReviewResult(file, this.entries.filter((entry) => entry.file === file).map((entry) => entry.id), request.action, reason);
			this.rememberOperation(result); throw new ReviewResultError(result);
		};
		if (this.disposed || this.maintenance) { blocked('maintenanceInProgress'); }
		const key = this.resourceKey(file); if (key === undefined) { blocked('ambiguousContext'); } file = key!;
		if (this.getSharedReview(file)?.blockReason === 'purgeNeedsRecovery') { blocked('purgeNeedsRecovery'); }
		const store = this.fileStores.get(file);
		if (!store) { blocked('reviewUnavailable'); }
		const folder = vscode.workspace.workspaceFolders?.find((folder) => this.stores.get(folder.uri.toString()) === store);
		try { if (!folder || await this.readPurgeState(folder)) { blocked('purgeNeedsRecovery'); } }
		catch { blocked('purgeNeedsRecovery'); }
		if (this.disposed || this.maintenance) { blocked('maintenanceInProgress'); }
		try {
			const operation = executeDecisionDetailed(store!, file, request, this.resourceAdapter(store!), { batchId }); this.activeOperations.add(operation);
			let outcome: Awaited<typeof operation>;
			try { outcome = await operation; } finally { this.activeOperations.delete(operation); }
			this.rememberOperation(outcome.result);
			this.synchronizeViews(); this.summaryCache.clear(); this.publish();
			if (outcome.error) { throw outcome.error; }
			// Recovery commits only the previous intent, never the new request.
			if (outcome.result.outcome === 'recovered') { throw new ReviewResultError(outcome.result); }
		} catch (error) {
			this.synchronizeViews(); this.summaryCache.clear(); this.publish();
			if (error instanceof ReviewResultError) { throw error; }
			const result = blockedReviewResult(file, this.getSharedReview(file)?.ids ?? [], request.action, error);
			result.content = 'unknown'; result.outcome = 'failed'; result.nextAction = 'reconcile';
			this.rememberOperation(result); throw new ReviewResultError(result, error);
		}
	}
	private rememberOperation(result: ReviewItemResult): void {
		this.lastOperationResults.delete(result.file); this.lastOperationResults.set(result.file, result);
		// This is presentation cache only; durable recovery stays in the journal.
		if (this.lastOperationResults.size > MAX_STATUS) { this.lastOperationResults.delete(this.lastOperationResults.keys().next().value!); }
	}
	private lastOperationView(file: string, state?: ReturnType<ReviewStore['get']>, entryId?: string): ReturnType<typeof operationView> | undefined {
		const pending = state && Object.values(state.operations).filter((operation) => operation.file === file && operation.stage !== 'complete' && (!entryId || operation.ids.includes(entryId))).at(-1);
		const result = this.lastOperationResults.get(file);
		const related = result && (!entryId || result.ids.includes(entryId)) ? result : undefined;
		if (pending && (!related || related.operationId !== pending.id || related.lastKnownStage !== pending.stage)) { return pendingOperationView(pending); }
		return related && operationView(related);
	}
	private projectResourceReview(review: SharedReview | undefined): ReturnType<typeof projectReview> {
		if (!review) { return projectReview(undefined); }
		const uri = vscode.Uri.file(review.file).toString();
		const document = vscode.workspace.textDocuments.find((item) => item.uri.toString() === uri && !item.isClosed);
		const bom = review.expected.kind === 'text' && review.expected.text.startsWith('\uFEFF') ? '\uFEFF' : '';
		return projectReview(review, document && { kind: 'text', text: bom + document.getText() });
	}

	async compareReview(file: string): Promise<void> {
		const resource = this.resourceKey(file); if (resource === undefined) { throw new ReviewError('ambiguousContext'); } file = resource;
		if (!(await this.canOpenResource(file))) { throw new ReviewError('resourceOutsideScope'); }
		const review = this.getSharedReview(file);
		if (!review || review.base.kind === 'unavailable') { throw new ReviewError('unknownSnapshot'); }
		const key = crypto.randomUUID() as string;
		this.comparisonTexts.set(key, review.base.kind === 'text' ? review.base.text : '');
		if (this.comparisonTexts.size > 20) { this.comparisonTexts.delete(this.comparisonTexts.keys().next().value as string); }
		await vscode.commands.executeCommand('vscode.diff', vscode.Uri.from({ scheme: SCHEME, path: `/review/${key}` }), vscode.Uri.file(file), t('{0} (revisão pendente ↔ arquivo atual)', basename(file)), { preview: true });
	}

	private resourceKey(file: string): string | undefined {
		if (this.ambiguousResources.has(file)) { return undefined; }
		const known = this.resourceAliases.get(file); if (known) { return this.ambiguousResources.has(known) ? undefined : known; }
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			const store = this.stores.get(folder.uri.toString()); if (!store || folder.uri.scheme !== 'file') { continue; }
			const relative = nodePath.relative(folder.uri.fsPath, file);
			if (relative !== '..' && !relative.startsWith('..' + nodePath.sep) && !nodePath.isAbsolute(relative)) {
				const candidate = nodePath.join(store.root, relative);
				if (this.ambiguousResources.has(candidate)) { return undefined; }
				if (this.sharedReviews.has(candidate)) { return candidate; }
			}
		}
		return file;
	}
	async canOpenResource(file: string): Promise<boolean> {
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			if (folder.uri.scheme !== 'file') { continue; }
			try { if (await canonicalResource(file, folder.uri.fsPath)) { return true; } } catch { /* No authorization from a failed lookup. */ }
		}
		return false;
	}

	private readonly comparisonTexts = new Map<string, string>();

	private synchronizeViews(): void {
		this.sharedReviews.clear(); this.fileStores.clear(); this.status.clear(); this.ambiguousResources.clear();
		for (const [context, store] of this.stores) {
			const state = store.get();
			const blocked = this.storeErrors.get(context);
			for (const [id, status] of Object.entries(state.statuses)) { this.status.set(id, status); }
			for (const file of Object.keys(state.reviews)) {
				const review = activeReview(state, file);
				if (!review) { continue; }
				if (this.sharedReviews.has(file) || this.ambiguousResources.has(file)) { this.ambiguousResources.add(file); this.sharedReviews.set(file, { ...review, phase: 'blocked', blockReason: 'ambiguousContext' }); this.fileStores.delete(file); continue; }
				if (!blocked) { this.fileStores.set(file, store); }
				this.sharedReviews.set(file, store.writable && !blocked ? review : { ...review, phase: 'blocked', blockReason: blocked || store.blockReason || 'readOnlyOwner' });
			}
		}
		// URI.fsPath is the editor's spelling (notably the Windows drive letter).
		// Keep persisted keys/context untouched and never fold directory/file case.
		const aliases = new Map<string, Set<string>>();
		for (const file of this.sharedReviews.keys()) {
			const alias = vscode.Uri.file(file).fsPath;
			const candidates = aliases.get(alias) ?? new Set<string>(); candidates.add(file);
			const prior = this.resourceAliases.get(alias); if (prior && prior !== file && this.sharedReviews.has(prior)) { candidates.add(prior); }
			aliases.set(alias, candidates);
		}
		for (const [alias, candidates] of aliases) {
			if (candidates.size === 1) { this.resourceAliases.set(alias, candidates.values().next().value!); continue; }
			this.ambiguousResources.add(alias); this.resourceAliases.delete(alias);
			for (const file of candidates) {
				this.ambiguousResources.add(file); this.fileStores.delete(file);
				const review = this.sharedReviews.get(file); if (review) { this.sharedReviews.set(file, { ...review, phase: 'blocked', blockReason: 'ambiguousContext' }); }
			}
		}
	}

	/** Arquivos (caminho completo) com mudanças pendentes que ainda existem, na ordem do painel. */
	pendingFiles(): string[] {
		return this.pendingGroups()
			.filter((list) => list[0].after?.exists !== false)
			.map((list) => list[0].file);
	}

	// ---- Webview, conteúdo virtual e decorações ---------------------------------

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		if (this.disposed) { return; }
		this.viewSubscriptions.splice(0).forEach((subscription) => subscription.dispose());
		this.view = webviewView;
		this.viewSubscriptions.push(this.setupWebview(webviewView.webview, false));
		this.updateViewChrome();
		this.viewSubscriptions.push(webviewView.onDidDispose(() => {
			if (this.view === webviewView) { this.view = undefined; this.viewSubscriptions.splice(0).forEach((subscription) => subscription.dispose()); }
		}));
	}

	openPanel(): void {
		if (this.disposed) { return; }
		if (this.panel) {
			this.panel.reveal();
			return;
		}
		this.panel = vscode.window.createWebviewPanel(
			'claude-code-launcher.changesPanel',
			t('Mudanças do Claude'),
			vscode.ViewColumn.Active,
			{ enableScripts: true, localResourceRoots: [this.mediaUri()] },
		);
		const panel = this.panel;
		panel.iconPath = vscode.Uri.joinPath(this.mediaUri(), 'icon.svg');
		this.panelSubscriptions.push(this.setupWebview(panel.webview, true));
		this.panelSubscriptions.push(panel.onDidDispose(() => {
			if (this.panel === panel) { this.panel = undefined; this.panelSubscriptions.splice(0).forEach((subscription) => subscription.dispose()); }
		}));
	}

	provideTextDocumentContent(uri: vscode.Uri): string {
		const [, id, side] = uri.path.split('/');
		if (id === 'review') { return this.comparisonTexts.get(side) ?? ''; }
		const entry = this.entries.find((item) => item.id === id);
		const snapshot = side === 'antes' ? entry?.before : entry?.after;
		return snapshot?.text ?? '';
	}

	provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
		if (uri.scheme !== 'file' || !this.decorated.has(fileKey(uri.fsPath))) {
			return undefined;
		}
		return {
			badge: 'C',
			tooltip: t('Mudanças do Claude para revisar'),
			color: new vscode.ThemeColor('claudeCodeLauncher.pendingChangeForeground'),
		};
	}

	// ---- Registro (hooks) --------------------------------------------------------

	async setEnabled(enable: boolean): Promise<void> { return this.background(() => this.configureHooks(enable)); }
	private async configureHooks(enable: boolean): Promise<void> {
		const folders = vscode.workspace.workspaceFolders ?? [];
		if (!folders.length) { void vscode.window.showWarningMessage(t('Abra uma pasta de projeto para registrar as mudanças do Claude.')); return; }
		const failed: string[] = [];
		for (const folder of folders) {
			try {
				if (folder.uri.scheme !== 'file') { throw new ReviewError('unsupportedStore'); }
				const plan = await this.capture.prepareHookPlan(folder, enable);
				if (plan.kind !== 'ready') { throw new ReviewError(plan.code || 'hookPlanBlocked'); }
				await this.ensureStore(folder);
				await this.capture.readCapturePolicy(folder);
				await this.capture.writeCapturePolicy(folder, !enable);
				if (enable) { await this.capture.installHookScript(folder); }
				await this.capture.writeHooks(folder, enable, plan); this.hookWarnings.delete(folder.uri.toString());
			} catch (error) { failed.push(`${folder.name}: ${explain(error)}.`); }
		}
		await this.refresh();
		if (failed.length) { void vscode.window.showWarningMessage(t('Registro não concluído. {0}', failed.join(' '))); }
		else { void vscode.window.showInformationMessage(enable ? t('Registro ativado para novas conversas, com política de cópias locais aplicada.') : t('Hooks próprios desligados; configurações alheias preservadas.')); }
		if (enable && !failed.length && !this.disposed && !(await this.capture.nodeAvailable())) { void vscode.window.showWarningMessage(t(NODE_MISSING)); }
	}

	async repairHooks(): Promise<void> { if (this.disposed || this.maintenance) { return; } return this.background(() => this.repairConfiguredHooks()); }
	private async repairConfiguredHooks(): Promise<void> {
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			if (folder.uri.scheme !== 'file') { continue; }
			try {
				const read = await this.capture.readSettings(folder);
				const own = inspectHookConfiguration(read, this.capture.scriptPath(folder), this.capture.knownHookPaths());
				if (!own.valid || !own.active) { continue; }
				await this.ensureStore(folder);
				const disabled = vscode.workspace.getConfiguration('claudeCodeLauncher').get<string>('hookExecutionMode', 'auto') === 'disabled';
				const prior = await this.capture.readCapturePolicy(folder);
				const plan = await this.capture.prepareHookPlan(folder, !disabled);
				if (plan.kind !== 'ready') { throw new ReviewError(plan.code || 'hookPlanBlocked'); }
				await this.capture.writeCapturePolicy(folder, disabled || prior?.paused === true);
				if (!disabled) { await this.capture.installHookScript(folder); }
				await this.capture.writeHooks(folder, !disabled, plan); this.hookWarnings.delete(folder.uri.toString());
			} catch (error) { this.hookWarnings.set(folder.uri.toString(), t('Hooks de {0}: {1}.', folder.name, explain(error))); }
		}
	}

	async clear(): Promise<void> {
		if (this.maintenance) { throw new ReviewError('maintenanceInProgress'); }
		this.beginMaintenance();
		const failed: string[] = [];
		try {
			await Promise.allSettled([...this.activeOperations, ...this.backgroundTasks]); await this.refreshing; await this.writeChain;
			for (const folder of vscode.workspace.workspaceFolders ?? []) {
				const store = this.stores.get(folder.uri.toString()); if (!store) { continue; }
				try {
					await withCaptureMaintenance(store, async () => {
						// A poda já recolhe as cópias sem referência; sem nada a podar, a coleta roda mesmo assim.
						if (!(await this.pruneReviewedLog(folder, store, true))) { await collectLogBlobs(store, () => this.disposed); }
					});
					await housekeep(store, () => this.disposed); this.nextHousekeeping.set(folder.uri.toString(), Date.now() + HOUSEKEEPING_INTERVAL_MS);
				} catch (error) { failed.push(`${folder.name}: ${explain(error)}.`); }
			}
		} finally { this.endMaintenance(); }
		await this.refresh();
		if (failed.length) { void vscode.window.showWarningMessage(t('Limpeza parcial/bloqueada. {0}', failed.join(' '))); }
		else { void vscode.window.showInformationMessage(t('Histórico revisado sem referência de recuperação foi limpo. Pendências, decisões parciais, pausa e undo foram preservados.')); }
	}

	async clearAllReviewData(): Promise<void> {
		if (this.disposed || this.maintenance) { throw new ReviewError('maintenanceInProgress'); }
		// Dados de revisão só existem em pastas locais; o caminho de um provider virtual não é um caminho de disco.
		const folders = (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === 'file');
		const preview: string[] = [];
		for (const folder of folders) {
			const inventory = await inventoryPurge(nodePath.join(folder.uri.fsPath, ...LOG_DIR), folder.uri.fsPath, { memory: this.purgeMemory() });
			preview.push(t('Pasta {0}: {1}.', folder.index + 1, purgeInventoryText(inventory)));
		}
		if (!(await confirm(t('Apagar todos os dados locais de revisão?'), `${preview.join('\n')}\n` + t('Isso remove dados próprios de captura, histórico, cópias locais, decisões, metadados e recuperação de recusas. Caches são da janela. Arquivos atuais, controles de pausa e hooks de terceiros permanecem. Encerre conversas e outros escritores. O inventário será revalidado antes dos efeitos.'), t('Apagar dados de revisão')))) { return; }
		this.beginMaintenance(); this.metaEpoch += 1; this.pendingMetadata.clear(); this.lastPurgeReports.splice(0);
		const runs: Array<{ folder: vscode.WorkspaceFolder; before: PurgeInventory; effects: PurgeEffect[]; reason?: PurgeReason; store?: ReviewStore; marker?: string }> = [];
		let memorySucceeded = true; let memoryFailed = false;
		try {
			await Promise.allSettled([...this.activeOperations, ...this.backgroundTasks]); await this.refreshing; await this.writeChain;
			for (const folder of folders) {
				const run = { folder, before: await inventoryPurge(nodePath.join(folder.uri.fsPath, ...LOG_DIR), folder.uri.fsPath, { memory: this.purgeMemory() }), effects: [] as PurgeEffect[], reason: undefined as PurgeReason | undefined, store: undefined as ReviewStore | undefined, marker: undefined as string | undefined };
				runs.push(run);
				try {
					run.store = this.stores.get(folder.uri.toString());
					const priorMarker = await this.readPurgeState(folder, true);
					const store = this.stores.get(folder.uri.toString()) ?? (priorMarker ? await this.ensureStore(folder, true) : undefined);
					if (!store?.writable) { throw new ReviewError('readOnlyOwner'); }
					run.store = store;
					await this.capture.readCapturePolicy(folder);
					await withCaptureMaintenance(store, async () => {
						await this.capture.writeCapturePolicy(folder, true, true);
						if (Object.values(store.get().operations).some((operation) => !['complete', 'blocked'].includes(operation.stage))) { throw new ReviewError('needsReconciliation'); }
						run.before = await inventoryPurge(store.directory, store.root, { memory: this.purgeMemory() });
						const plan = planPurge(run.before, { owned: store.writable, quiescent: true });
						if (plan.kind !== 'ready') { run.reason = plan.reason; return; }
						const prior = await this.readPurgeState(folder, true);
						const prepared = JSON.stringify({ schemaVersion: 1, phase: 'prepared', id: crypto.randomUUID(), startedAt: new Date().toISOString() }) + '\n';
						await this.writeOwnedFile(store, nodePath.join(store.directory, PURGE_STATE_FILE), prepared, prior); run.marker = prepared;
						for (const item of plan.items) {
							try {
								if (this.disposed || !store.writable) { throw new ReviewError('cancelledBeforeEffect'); }
								const file = nodePath.join(store.directory, ...item.relativePath.split('/'));
								if (!(await assessStoragePath(file, store.root)).allowed) { throw new ReviewError('unsafeStorageType'); }
								const stat = await nodeFs.promises.lstat(file);
								if (stat.isSymbolicLink() || (item.kind === 'file' ? !stat.isFile() : !stat.isDirectory())) { throw new ReviewError('unsafeStorageType'); }
								if (item.kind === 'directory') { await nodeFs.promises.rmdir(file); } else { await nodeFs.promises.unlink(file); }
								run.effects.push({ ...item, outcome: 'removed' });
								if (item.relativePath === 'capture-diagnostics' || item.relativePath.startsWith('capture-diagnostics/') || item.relativePath === 'capture-status.json') { this.forgetCapture(folder); }
							} catch (error) { run.effects.push({ ...item, outcome: 'failed', reason: purgeFailureReason(error) }); }
						}
					});
				} catch (error) { run.reason = purgeFailureReason(error); }
			}
			if (runs.every((run) => !run.reason && run.effects.every((effect) => effect.outcome === 'removed'))) {
				try { await this.context.workspaceState.update(UNDO_KEY, []); await this.context.workspaceState.update(STATUS_KEY, {}); await this.context.workspaceState.update(LEGACY_REVIEWED_KEY, []); this.undoStack.splice(0); }
				catch { memorySucceeded = false; memoryFailed = true; }
			} else { memorySucceeded = false; }
			this.reasonCache.clear(); this.requestCache.clear(); this.commandToolUses.clear(); this.metaAttempts.clear(); this.pendingMetadata.clear(); this.blobCache.clear(); this.viewCache.clear(); this.summaryCache.clear(); this.comparisonTexts.clear(); this.lastOperationResults.clear(); this.stateText.clear();
			clearTranscriptMetadataForRoots(folders.filter((folder) => folder.uri.scheme === 'file').map((folder) => sessionsDir(folder.uri.fsPath)));
			for (const run of runs) {
				try {
					if (run.marker && run.store) {
						const marker = nodePath.join(run.store.directory, PURGE_STATE_FILE);
						if (memorySucceeded && !run.reason && run.effects.every((effect) => effect.outcome === 'removed')) { if ((await this.readPurgeState(run.folder, true)) !== run.marker) { throw new ReviewError('stateChanged'); } await nodeFs.promises.unlink(marker); this.forgetCapture(run.folder); }
						else { const partial = JSON.stringify({ ...JSON.parse(run.marker), phase: 'partial' }) + '\n'; await this.writeOwnedFile(run.store, marker, partial, run.marker); }
					}
				} catch (error) { run.reason = purgeFailureReason(error); }
				finally { if (run.store) { try { await run.store.close(); } catch (error) { run.reason = purgeFailureReason(error); } this.stores.delete(run.folder.uri.toString()); } this.logCache.delete(run.folder.uri.toString()); }
				const after = await inventoryPurge(nodePath.join(run.folder.uri.fsPath, ...LOG_DIR), run.folder.uri.fsPath, { memory: this.purgeMemory() });
				if (!memorySucceeded) { run.effects.push({ relativePath: PURGE_MEMORY_PATHS.undo, category: 'undo', outcome: memoryFailed ? 'failed' : 'blocked', reason: 'memoryUnavailable' }); }
				this.lastPurgeReports.push({ workspace: run.folder.index + 1, report: summarizePurge(run.before, after, run.effects, { blockedReason: run.reason }) });
			}
		} finally { this.endMaintenance(); }
		await this.refresh();
		if (this.disposed) { return; }
		const complete = this.lastPurgeReports.every(({ report }) => report.outcome === 'complete');
		const message = this.lastPurgeReports.map(({ workspace, report }) => t('Pasta {0}: {1}', workspace, purgeReportText(report))).join('\n');
		if (complete) { void vscode.window.showInformationMessage(t('Dados locais de revisão removidos. A captura permanece pausada. {0}', message)); }
		else { void vscode.window.showWarningMessage(t('Limpeza parcial/bloqueada. {0} Use Apagar todos os dados locais de revisão para tentar concluir; controles e dados desconhecidos foram preservados.', message)); }
	}
	private purgeMemory(): PurgeMemory {
		try {
			const saved = this.context.workspaceState.get<unknown>(UNDO_KEY, []); if (!Array.isArray(saved)) { return { undoCount: null, cacheCount: null, complete: false }; }
			const undoCount = saved.length + [...this.stores.values()].reduce((count, store) => count + store.get().undo.filter((item) => item.phase !== 'consumed').length, 0);
			const roots = (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === 'file').map((folder) => sessionsDir(folder.uri.fsPath));
			return { undoCount, cacheCount: this.reasonCache.size + this.requestCache.size + this.commandToolUses.size + this.pendingMetadata.size + this.blobCache.size + this.viewCache.size + this.summaryCache.size + this.comparisonTexts.size + this.lastOperationResults.size + this.stateText.size + transcriptMetadataCacheCount(roots), complete: true };
		} catch { return { undoCount: null, cacheCount: null, complete: false }; }
	}
	private forgetCapture(folder: vscode.WorkspaceFolder): void { const key = folder.uri.toString(); this.captureEvidence.delete(key); this.captureHealthStates.delete(key); this.captureWarnings.delete(key); this.runtimeWarnings.delete(key); }
	private async readPurgeState(folder: vscode.WorkspaceFolder, validate = false): Promise<string | undefined> {
		const read = await safeReadText(nodePath.join(folder.uri.fsPath, ...LOG_DIR, PURGE_STATE_FILE), folder.uri.fsPath, 4096);
		if (read.kind === 'absent') { return undefined; }
		if (read.kind === 'error') { throw new ReviewError('purgeNeedsRecovery'); }
		if (validate) {
			try { const value = JSON.parse(read.text); if (value.schemaVersion !== 1 || !['prepared', 'partial'].includes(value.phase) || typeof value.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.id) || typeof value.startedAt !== 'string' || new Date(value.startedAt).toISOString() !== value.startedAt || Object.keys(value).some((key) => !['schemaVersion', 'phase', 'id', 'startedAt'].includes(key))) { throw new Error('shape'); } }
			catch { throw new ReviewError('purgeNeedsRecovery'); }
		}
		return read.text;
	}

	async releaseReviewWriter(): Promise<void> {
		this.beginMaintenance();
		try {
			await Promise.allSettled([...this.activeOperations, ...this.backgroundTasks]);
			for (const store of this.stores.values()) { if (Object.values(store.get().operations).some((op) => !['complete', 'blocked'].includes(op.stage))) { throw new ReviewError('needsReconciliation'); } }
			for (const store of this.stores.values()) { await store.close(); }
		} finally { this.endMaintenance(); }
		this.synchronizeViews(); this.publish();
	}
	async recoverReviewWriter(): Promise<void> {
		this.beginMaintenance();
		try {
			await Promise.allSettled([...this.activeOperations, ...this.backgroundTasks]);
			for (const folder of vscode.workspace.workspaceFolders ?? []) { if (folder.uri.scheme === 'file' && await this.readPurgeState(folder)) { throw new ReviewResultError(blockedReviewResult('', [], 'reject', 'purgeNeedsRecovery')); } }
			for (const store of this.stores.values()) { try { await store.recoverWriter(); await recoverCaptureMaintenance(store); } catch (error) { void vscode.window.showWarningMessage(error instanceof Error && error.message !== errorCode(error) ? error.message : t('Recuperação não concluída: {0}.', explain(error))); throw error; } }
		} finally { this.endMaintenance(); }
		await this.refresh();
	}


	// ---- Aceitar e recusar ---------------------------------------------------------

	/** Mantém tudo como o Claude deixou e tira os arquivos da lista de pendentes. */
	async acceptEverything(): Promise<void> {
		const groups = this.pendingGroups();
		if (groups.length > 0) {
			this.report(await this.accept(groups));
		}
	}

	async rejectEverything(): Promise<void> {
		const groups = this.pendingGroups();
		if (groups.length === 0) {
			return;
		}
		const ok = await confirm(
			t('Recusar as mudanças do Claude em {0}?', countFiles(groups.length)),
			t('Cada arquivo volta a ser como era antes do Claude editar: arquivos que ele criou vão para a lixeira e os que ele apagou são recriados. Dá para desfazer logo depois.'),
			t('Recusar todas'),
		);
		if (ok) {
			this.report(await this.revert(groups));
		}
	}

	/** Undo only successful individual items; conflicts retain their recovery. */
	async undoReject(): Promise<void> {
		if (this.maintenance) { throw new ReviewError('maintenanceInProgress'); }
		const all = [...this.stores.values()].flatMap((store) => store.get().undo.filter((item) => item.phase !== 'consumed').map((item) => ({ store, item })));
		const last = all.sort((a, b) => String(a.item.completedAt || a.item.createdAt || '').localeCompare(String(b.item.completedAt || b.item.createdAt || ''))).at(-1);
		if (!last) { void vscode.window.showInformationMessage(t('Não há recusa para desfazer.')); return; }
		const batch = last.item.batchId || last.item.id; const results: ReviewItemResult[] = [];
		for (const { store, item } of all.filter(({ item }) => (item.batchId || item.id) === batch).reverse()) {
			const operation = undoItemDetailed(store, item.id, this.resourceAdapter(store)); this.activeOperations.add(operation);
			try { const outcome = await operation; results.push(outcome.result); this.rememberOperation(outcome.result); }
			catch (error) { const result = blockedReviewResult(item.file, item.ids, 'undo', error); result.content = 'unknown'; result.outcome = 'failed'; this.rememberOperation(result); results.push(result); }
			finally { this.activeOperations.delete(operation); }
		}
		this.synchronizeViews(); this.summaryCache.clear(); this.publish();
		this.report(results);
	}

	private async acceptFile(key: string | undefined, revision?: number): Promise<void> {
		const group = this.pendingGroups().find((list) => list[0].file === key);
		if (group) {
			await this.executeReviewDecision(group[0].file, { action: 'accept', revision });
		}
	}

	private async rejectFile(key: string | undefined, revision?: number): Promise<void> {
		const group = this.pendingGroups().find((list) => list[0].file === key);
		if (group) {
			await this.executeReviewDecision(group[0].file, { action: 'reject', revision });
		}
	}

	/** Arquivos pendentes em que todas as mudanças vieram deste pedido; os que misturam outros pedidos ficam de fora. */
	private requestGroups(requestId: string | undefined): RawEntry[][] {
		const ids = new Set(this.entries.filter((entry) => requestId && this.requestCache.get(entry.id)?.id === requestId && !this.status.has(entry.id)).map((entry) => entry.id));
		if (!ids.size) { return []; }
		return this.pendingGroups().filter((list) => list.some((entry) => ids.has(entry.id)) && this.getSharedReview(list[0].file)?.ids.every((id) => ids.has(id)));
	}

	/** Mantém tudo o que o Claude mudou para atender um pedido. */
	private async acceptRequest(requestId: string | undefined): Promise<void> {
		const pending = this.entries.some((entry) => requestId && this.requestCache.get(entry.id)?.id === requestId && !this.status.has(entry.id));
		if (!pending) { return; }
		const groups = this.requestGroups(requestId);
		if (!groups.length) { void vscode.window.showInformationMessage(t('Os arquivos deste pedido também têm mudanças de outros pedidos. Aceite-os um a um.')); return; }
		this.report(await this.accept(groups));
	}

	/** As edições que o painel mostra agora: as da conversa em foco (e pendentes sem dono), ou todas. */
	private visibleEntries(): RawEntry[] {
		const chat = this.activeChat;
		if (!chat || this.showAllChats) { return this.entries; }
		const focus = new Set(chat.sessions), elsewhere = new Set(chat.elsewhere);
		return this.entries.filter((entry) => focus.has(entry.session ?? '') || !this.status.has(entry.id) && !elsewhere.has(entry.session ?? ''));
	}

	/** Copia um resumo em markdown das mudanças visíveis, agrupado por pedido, para a descrição de um PR. */
	async copySummary(): Promise<void> {
		if (this.disposed) { return; }
		const entries = this.visibleEntries().slice(0, MAX_HISTORY).reverse();
		if (!entries.length) { void vscode.window.showInformationMessage(t('Não há mudanças para resumir.')); return; }
		const markdown = changesSummary(entries.map((entry) => {
			const view = this.viewOf(entry), request = this.requestCache.get(entry.id);
			return { file: view.file, dir: view.dir, action: view.action, added: view.added + view.modified, removed: view.removed + view.modified,
				status: this.status.get(entry.id) ?? null, requestId: request?.id ?? null, request: request?.text ?? null, reason: this.reasonOf(entry) };
		}));
		await vscode.env.clipboard.writeText(markdown);
		const files = new Set(entries.map((entry) => entry.file)).size;
		void vscode.window.showInformationMessage(plural(files, 'Resumo de {0} arquivo copiado para a área de transferência.', 'Resumo de {0} arquivos copiado para a área de transferência.'));
	}

	/** Recusa tudo o que o Claude mudou para atender um pedido. */
	private async rejectRequest(requestId: string | undefined): Promise<void> {
		const entries = this.entries.filter(
			(entry) => this.requestCache.get(entry.id)?.id === requestId && !this.status.has(entry.id),
		);
		if (!requestId || entries.length === 0) {
			return;
		}
		const requestIds = new Set(entries.map((entry) => entry.id));
		const groups = this.pendingGroups().filter((list) => list.some((entry) => requestIds.has(entry.id)) && this.getSharedReview(list[0].file)?.ids.every((id) => requestIds.has(id)));
		const text = this.requestCache.get(entries[0].id)?.text ?? '';
		const ok = await confirm(
			t('Desfazer o pedido "{0}"?', text),
			plural(groups.length, '{0} arquivo volta a ser como era antes deste pedido. Arquivos mudados depois dele ficam como estão. Dá para desfazer logo depois.',
				'{0} arquivos voltam a ser como eram antes deste pedido. Arquivos mudados depois dele ficam como estão. Dá para desfazer logo depois.'),
			t('Desfazer pedido'),
		);
		if (ok) {
			this.report(await this.revert(groups));
		}
	}

		private async accept(groups: RawEntry[][]): Promise<ReviewItemResult[]> {
			return this.decideGroups(groups, 'accept');
	}

		private async revert(groups: RawEntry[][]): Promise<ReviewItemResult[]> {
			return this.decideGroups(groups, 'reject');
		}
		private async decideGroups(groups: RawEntry[][], action: 'accept' | 'reject'): Promise<ReviewItemResult[]> {
			const results: ReviewItemResult[] = []; const batch = crypto.randomUUID() as string;
		for (const list of groups) {
			try {
					await this.executeReviewDecision(list[0].file, { action }, batch);
					const result = this.lastOperationResults.get(list[0].file); if (result) { results.push(result); }
				} catch (error) {
					results.push(error instanceof ReviewResultError ? error.result : blockedReviewResult(list[0].file, list.map((entry) => entry.id), action, error));
				}
		}
			return results;
	}

		private report(results: readonly ReviewItemResult[]): void {
			if (this.disposed || !results.length) { return; }
			const summary = summarizeReviewResults(results);
			const details = () => {
				if (this.disposed) { return; }
				return vscode.window.showQuickPick(results.map((result) => ({ label: basename(result.file), description: result.reason,
					detail: formatReviewItemResult(result) })), { title: t('Resultado da revisão por arquivo'), placeHolder: t('Confira o conteúdo, o registro e a próxima ação de cada item.') });
			};
			const complete = results.every((result) => result.outcome === 'complete');
			const undoLabel = t('Desfazer'), detailsLabel = t('Detalhes');
			if (complete) {
				const undo = results.every((result) => result.action === 'reject');
				void vscode.window.showInformationMessage(summary.message, ...(undo ? [undoLabel, detailsLabel] : [detailsLabel])).then((choice) => {
					if (this.disposed) { return; }
					if (choice === undoLabel) { void this.undoReject(); } else if (choice === detailsLabel) { void details(); }
				});
			} else { void vscode.window.showWarningMessage(summary.message, detailsLabel).then((choice) => { if (!this.disposed && choice === detailsLabel) { void details(); } }); }
	}


	private resourceAdapter(store: ReviewStore): ResourceAdapter {
		return { read: (file) => this.observeResource(file, store.root, true), readPersisted: (file) => this.observeResource(file, store.root, false), write: (file, target, expected) => this.writeResource(file, store.root, target, expected) };
	}
	private async observeResource(file: string, root: string, buffer: boolean): Promise<ReviewContent> {
		const scope = await assessResourceScope(file, root); if (!scope.allowed) { throw new ReviewError(scope.code || 'resourceOutsideScope'); }
		const uri = vscode.Uri.file(file);
		let disk: ReviewContent;
		try {
			const stat = await nodeFs.promises.lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) { throw new ReviewError('unsupportedResource'); }
			const bytes = await nodeFs.promises.readFile(file);
			disk = { kind: 'text', text: new Utf8Decoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) };
		} catch (error) { if ((error as { code?: string }).code === 'ENOENT') { disk = { kind: 'absent' }; } else { throw error; } }
		if (buffer) {
			const open = vscode.workspace.textDocuments.find((doc) => !doc.isClosed && doc.uri.toString() === uri.toString());
			if (open && !(disk.kind === 'absent' && !open.isDirty)) { const text = open.getText(); return { kind: 'text', text: disk.kind === 'text' && disk.text.startsWith('\uFEFF') && !text.startsWith('\uFEFF') ? '\uFEFF' + text : text }; }
		}
		return disk;
	}
	private async writeResource(file: string, root: string, target: ReviewContent, expected: ReviewContent): Promise<void> {
		if (this.disposed) { throw new ReviewError('cancelledBeforeEffect'); }
		const purge = await safeReadText(nodePath.join(root, ...LOG_DIR, PURGE_STATE_FILE), root, 4096);
		if (purge.kind !== 'absent') { throw new ReviewError('purgeNeedsRecovery'); }
		if (!sameContent(await this.observeResource(file, root, true), expected)) { throw new ReviewError('externalChange'); }
		const uri = vscode.Uri.file(file);
		if (file.toLowerCase().endsWith('.ipynb') || vscode.workspace.notebookDocuments.some((doc) => doc.uri.toString() === uri.toString())) { throw new ReviewError('unsupportedNotebook'); }
		if (target.kind === 'unavailable') { throw new ReviewError('unknownSnapshot'); }
		if (target.kind === 'absent') {
			const open = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === uri.toString());
			if (open?.isDirty) { throw new ReviewError('dirtyDocument'); }
			if (expected.kind === 'absent') { return; }
			if (this.disposed) { throw new ReviewError('cancelledBeforeEffect'); }
			try { await vscode.workspace.fs.delete(uri, { useTrash: true }); } catch (error) { if (isTrashUnavailable(error)) { throw new ReviewError('trashUnavailable'); } throw error; }
			if (this.disposed) { throw new ReviewError('cancelledAfterEffect'); } return;
		}
		if (expected.kind === 'absent') {
			await nodeFs.promises.mkdir(nodePath.dirname(file), { recursive: true });
			const scope = await assessResourceScope(file, root); if (!scope.allowed) { throw new ReviewError('resourceOutsideScope'); }
			if (this.disposed) { throw new ReviewError('cancelledBeforeEffect'); }
			// Arquivo do projeto, não dado privado da revisão: nasce com a permissão padrão do sistema (umask).
			await nodeFs.promises.writeFile(file, target.text, { flag: 'wx' }); if (this.disposed) { throw new ReviewError('cancelledAfterEffect'); } return;
		}
		const document = await vscode.workspace.openTextDocument(uri);
		if (this.disposed) { throw new ReviewError('cancelledBeforeEffect'); }
		const current = await this.observeResource(file, root, true);
		if (!sameContent(current, expected)) { throw new ReviewError('externalChange'); }
		const disk = await this.observeResource(file, root, false);
		if (disk.kind !== 'text' || disk.text.startsWith('\uFEFF') !== target.text.startsWith('\uFEFF')) { throw new ReviewError('unsupportedEncoding'); }
		const text = target.text.replace(/^\uFEFF/, '');
		if (document.getText() !== text) {
			const version = document.version;
			const edit = new vscode.WorkspaceEdit();
			const clean = text.replace(/\r\n/g, '\n');
			const eol = text.includes('\r\n') ? vscode.EndOfLine.CRLF : vscode.EndOfLine.LF;
			edit.set(uri, [vscode.TextEdit.replace(document.validateRange(new vscode.Range(0, 0, document.lineCount, 0)), clean), vscode.TextEdit.setEndOfLine(eol)]);
			if (this.disposed) { throw new ReviewError('cancelledBeforeEffect'); }
			if (document.version !== version) { throw new ReviewError('externalChange'); }
			if (!(await vscode.workspace.applyEdit(edit))) { throw new ReviewError('applyFailed'); }
		}
		if (this.disposed) { throw new ReviewError('cancelledAfterEffect'); }
		// A human edit may arrive while applyEdit is in flight. Keep that buffer
		// dirty instead of implicitly saving text that was not part of this plan.
		if (document.getText() !== text) { throw new ReviewError('externalChange'); }
		const saved = await document.save();
		if (this.disposed) { throw new ReviewError('cancelledAfterEffect'); }
		if (!saved) { throw new ReviewError('saveReturnedFalse'); }
	}

	// ---- Estado ---------------------------------------------------------------------

	/** Edições pendentes agrupadas por arquivo, da mais recente para a mais antiga. */
	private pendingGroups(): RawEntry[][] {
		const groups = new Map<string, RawEntry[]>();
		for (const entry of this.entries) { if (!this.status.has(entry.id)) { const list = groups.get(entry.file) ?? []; list.push(entry); groups.set(entry.file, list); } }
		return [...groups.values()];
	}

	private setupWebview(webview: vscode.Webview, wide: boolean): vscode.Disposable {
		webview.options = { enableScripts: true, localResourceRoots: [this.mediaUri()] };
		webview.html = this.html(webview);
		return webview.onDidReceiveMessage((message: unknown) => { if (this.disposed) { return; } void this.handleMessage(message, webview, wide).catch((error) => { if (!this.disposed) { void vscode.window.showWarningMessage(error instanceof ReviewResultError ? formatReviewItemResult(error.result) : t('A ação não foi concluída: {0}.', explain(error))); } }); });
	}

	private async handleMessage(value: unknown, webview: vscode.Webview, wide: boolean): Promise<void> {
		const message = validateMessage(value, 'changes') as Message | undefined; if (!message) { return; }
		switch (message.command) {
			case 'ready':
				this.post(webview, wide);
				return;
			case 'refresh':
				await this.refresh();
				return;
			case 'toggleChatFilter':
				this.toggleAllChats();
				return;
			case 'enable':
				await this.setEnabled(true);
				return;
			case 'disable':
				await this.setEnabled(false);
				return;
			case 'clear':
				await this.clear();
				return;
			case 'openPanel':
				this.openPanel();
				return;
			case 'compare':
				await this.compare(message.id);
				return;
			case 'showInCode':
				await vscode.commands.executeCommand('claude-code-launcher.showInlineChanges', message.id);
				return;
			case 'openFile':
				await this.openFile(message.id);
				return;
			case 'acceptAll':
				await this.acceptEverything();
				return;
			case 'rejectAll':
				await this.rejectEverything();
				return;
			case 'acceptFile':
				await this.acceptFile(message.key, message.revision);
				return;
			case 'rejectFile':
				await this.rejectFile(message.key, message.revision);
				return;
			case 'rejectRequest':
				await this.rejectRequest(message.request);
				return;
			case 'acceptRequest':
				await this.acceptRequest(message.request);
				return;
			case 'copySummary':
				await this.copySummary();
				return;
			case 'purge': case 'clearAllReviewData': await this.clearAllReviewData(); return;
			case 'release': case 'releaseWriter': await this.releaseReviewWriter(); return;
			case 'recover': case 'recoverWriter': await this.recoverReviewWriter(); return;
			case 'undoReject':
				await this.undoReject();
				return;
			case 'openScm':
				await vscode.commands.executeCommand('workbench.view.scm');
				return;
			case 'newChat':
				await vscode.commands.executeCommand('claude-code-launcher.newTab');
				return;
			case 'openWalkthrough':
				await vscode.commands.executeCommand('claude-code-launcher.openWalkthrough');
				return;
			default:
				// validateMessage só admite os comandos acima; qualquer outro não tem efeito.
				return;
		}
	}

	private async compare(id: string | undefined): Promise<void> {
		const entry = this.entries.find((item) => item.id === id);
		if (!entry) {
			return;
		}
		const name = basename(entry.file);
		await vscode.commands.executeCommand('vscode.diff', changeUri(entry, 'antes'), changeUri(entry, 'depois'), t('{0} (antes ↔ depois)', name), {
			preview: true,
		});
	}

	private async openFile(id: string | undefined): Promise<void> {
		const entry = this.entries.find((item) => item.id === id);
		if (!entry || !(await this.canOpenResource(entry.file))) {
			return;
		}
		try {
			await vscode.window.showTextDocument(vscode.Uri.file(entry.file), { preview: true });
		} catch {
			void vscode.window.showWarningMessage(t('O arquivo {0} não existe mais.', basename(entry.file)));
		}
	}

	private scheduleRefresh(): void {
		if (this.disposed) { return; }
		clearTimeout(this.refreshTimer);
		this.refreshTimer = setTimeout(() => {
			void this.refresh();
		}, 250);
	}

	async refresh(): Promise<void> {
		if (this.disposed || this.maintenance) { return; }
		if (this.refreshing) { this.refreshAgain = true; return this.refreshing; }
		this.refreshing = (async () => {
			do {
				this.refreshAgain = false; await this.writeChain;
				this.entries = await this.loadEntries(); this.enabled = await this.hooksEnabled();
				await this.applyRetention();
				if (this.disposed) { return; }
				const live = new Set(this.entries.map((entry) => entry.id));
				for (const id of this.viewCache.keys()) { if (!live.has(id)) { this.viewCache.delete(id); } }
				this.summaryCache.clear(); this.publish(); void this.fillMeta().catch(() => undefined); this.refreshShellActivity(0);
				// Depois de publicar: a coleta não muda o que o painel mostra e não deve atrasá-lo.
				await this.applyHousekeeping();
			} while (this.refreshAgain && !this.disposed);
		})().catch((error) => { this.coverageMessage = t('Não foi possível atualizar parte da revisão: {0}.', explain(error)); if (!this.disposed) { this.publish(); } }).finally(() => { this.refreshing = undefined; });
		return this.refreshing;
	}

	/** Espalha o estado atual: marcas no editor, painel, Explorer e barra de status. */
	private publish(): void {
		if (this.disposed) { return; }
		this.entriesEmitter.fire();
		if (this.view) {
			this.post(this.view.webview, false);
		}
		if (this.panel) {
			this.post(this.panel.webview, true);
		}

		const groups = this.pendingGroups();
		this.updateViewChrome(groups.length);
		const next = new Map(
			groups.filter((list) => list[0].after?.exists !== false).map((list) => [fileKey(list[0].file), list[0].file]),
		);
		const changed = [...this.decorated, ...next]
			.filter(([key]) => this.decorated.has(key) !== next.has(key))
			.map(([, file]) => vscode.Uri.file(file));
		this.decorated = next;
		if (changed.length > 0) {
			this.decorationEmitter.fire(changed);
		}

		if (groups.length > 0) {
			this.statusItem.text = `$(sparkle) ${groups.length}`;
			this.statusItem.tooltip = plural(groups.length, '{0} arquivo com mudanças do Claude para revisar', '{0} arquivos com mudanças do Claude para revisar');
			this.statusItem.show();
		} else {
			this.statusItem.hide();
		}
		void vscode.commands.executeCommand('setContext', PENDING_CONTEXT, groups.length > 0);
		this.updateViewContexts();
	}

	/** Há alguma recusa que ainda pode ser desfeita, em qualquer pasta. */
	private canUndoReject(): boolean {
		return [...this.stores.values()].some((store) => store.get().undo.some((item) => item.phase !== 'consumed'));
	}

	/** Alguma pasta está só para leitura (outra janela é a dona da revisão, ou o estado não abriu). */
	private readOnlyReason(): string | null {
		const reasons = [...this.storeErrors.values(), ...[...this.stores.values()].filter((store) => !store.writable).map((store) => store.blockReason)].filter(Boolean);
		if (reasons.includes('purgeNeedsRecovery')) { return t('Uma limpeza foi interrompida. Use Apagar todos os dados locais de revisão para concluir; não remova o marcador manualmente.'); }
		return [...new Set(reasons.map((reason) => capitalize(describeReason(reason))))].join('; ') || null;
	}

	/**
	 * O estado do registro fica ao lado do título da view, e os pendentes viram um
	 * número no ícone da barra de atividades, como o Git faz.
	 */
	private updateViewChrome(pending = this.pendingGroups().length): void {
		if (!this.view) {
			return;
		}
		const hasFolder = (vscode.workspace.workspaceFolders ?? []).length > 0;
		let description: string | undefined;
		if (hasFolder) {
			const configured = [...this.captureHealthStates.values()].some((health) => health.configuration === 'configured');
			description = this.readOnlyReason() ? t('Somente leitura') : configured ? t('Registro configurado') : t('Registro desligado ou indisponível');
		}
		this.view.description = description;
		this.view.badge = pending > 0
			? { value: pending, tooltip: plural(pending, '{0} arquivo com mudanças do Claude para revisar', '{0} arquivos com mudanças do Claude para revisar') }
			: undefined;
	}

	/** Contextos que decidem quais botões aparecem no título da view Mudanças. */
	private updateViewContexts(): void {
		const readOnly = Boolean(this.readOnlyReason());
		const configured = [...this.captureHealthStates.values()].some((health) => health.configuration === 'configured');
		void vscode.commands.executeCommand('setContext', 'claudeCodeLauncher.changeLogEnabled', configured);
		void vscode.commands.executeCommand('setContext', 'claudeCodeLauncher.hasChangeHistory', this.entries.length > 0);
		void vscode.commands.executeCommand('setContext', 'claudeCodeLauncher.canUndoReject', !readOnly && this.canUndoReject());
		void vscode.commands.executeCommand('setContext', 'claudeCodeLauncher.reviewReadOnly', readOnly);
		void vscode.commands.executeCommand('setContext', 'claudeCodeLauncher.reviewWriter', !readOnly && this.stores.size > 0);
	}

	private post(webview: vscode.Webview, wide: boolean): void {
			if (this.disposed) { return; }
			// Read each canonical store once per publication, including historical and
			// earlier blocked segments rather than projecting only the latest review.
			const states = new Map([...this.stores].map(([key, store]) => [key, store.get()]));
			const projections = new Map<string, ReturnType<typeof projectReview>>();
		const chat = this.activeChat;
		const scoped = Boolean(chat) && !this.showAllChats;
		const chatSessions = new Set(chat?.sessions), elsewhere = new Set(chat?.elsewhere);
		const inFocus = (entry: RawEntry): boolean => chatSessions.has(entry.session ?? '');
		// A conversa em foco é deduzida do título da aba e pode falhar (título gerado que o transcript ainda
		// não tem, chat na barra lateral). Só se escondem mudanças que outra aba aberta identificou como suas;
		// pendentes sem dono conhecido continuam visíveis para não sumirem da revisão.
		const unclaimedPending = (entry: RawEntry): boolean => !inFocus(entry) && !this.status.has(entry.id) && !elsewhere.has(entry.session ?? '');
		const visibleWhenScoped = (entry: RawEntry): boolean => inFocus(entry) || unclaimedPending(entry);
		const inChat = (entry: RawEntry): boolean => !scoped || visibleWhenScoped(entry);
		const history: ViewEntry[] = this.entries.filter(inChat).slice(0, MAX_HISTORY).map((entry) => {
			const request = this.requestCache.get(entry.id);
				const context = this.entryFolder.get(entry.id), store = context ? this.stores.get(context) : undefined;
				const segment = context ? states.get(context)?.reviews[entry.file]?.find((review) => review.ids.includes(entry.id)) : undefined;
				const active = this.getSharedReview(entry.file);
				const contextError = context ? this.storeErrors.get(context) : undefined;
				const projected = segment ? active?.blockReason === 'ambiguousContext'
					? { ...segment, phase: 'blocked' as const, blockReason: 'ambiguousContext' }
					: contextError || store && !store.writable ? { ...segment, phase: 'blocked' as const, blockReason: contextError || store?.blockReason || 'readOnlyOwner' } : segment : undefined;
				const projectionKey = `${context}\0${entry.file}\0${segment?.firstId}\0${projected?.revision}\0${projected?.phase}\0${projected?.blockReason}`;
				if (!projections.has(projectionKey)) { projections.set(projectionKey, this.projectResourceReview(projected)); }
				return {
				...this.viewOf(entry),
					...projections.get(projectionKey),
					lastOperation: this.lastOperationView(entry.file, context ? states.get(context) : undefined, entry.id),
				reason: this.reasonOf(entry),
				status: this.status.get(entry.id) ?? null,
				requestId: request?.id ?? null,
				request: request?.text ?? null,
			};
		});
		void webview.postMessage({
			type: 'state',
			wide,
			hasFolder: (vscode.workspace.workspaceFolders ?? []).length > 0,
			enabled: this.enabled,
			captureHealth: (vscode.workspace.workspaceFolders ?? []).flatMap((folder) => {
				const health = this.captureHealthStates.get(folder.uri.toString());
				return health ? [{ workspace: folder.index + 1, ...health }] : [];
			}),
			entries: history,
				files: this.pendingGroups().map((list) => list.filter(inChat)).filter((list) => list.length > 0)
					.map((list) => this.summaryOf(list, states.get(this.entryFolder.get(list[0].id) || ''))),
			chat: chat ? { title: chat.title, scoped, matches: chat.sessions.length,
				others: this.entries.filter((entry) => !visibleWhenScoped(entry)).length,
				unclaimed: this.entries.filter(unclaimedPending).length } : null,
			canUndo: this.canUndoReject(),
			shell: this.shellActivity,
			coverageMessage: [this.coverageMessage, ...this.hookWarnings.values(), ...this.runtimeWarnings.values(), ...this.captureWarnings.values()].filter(Boolean).join(' ') || null,
			reviewWriter: [...this.stores.values()].every((store) => store.writable),
			readOnlyReason: this.readOnlyReason(),
				readOnlyAction: [...this.storeErrors.values()].includes('purgeNeedsRecovery') ? 'clearAllReviewData' : 'recoverWriter',
		});
	}

	/** Diff e textos da edição, calculados uma vez só. */
	private viewOf(entry: RawEntry): BaseView {
		let view = this.viewCache.get(entry.id);
		if (!view) {
			view = toViewEntry(entry, vscode.workspace.asRelativePath(entry.file, false));
			this.viewCache.set(entry.id, view);
		}
		return view;
	}

	private reasonOf(entry: RawEntry): string | null {
		return (entry.reason || this.reasonCache.get(entry.id) || '').trim() || null;
	}

	/**
	 * Uma linha por arquivo, como a lista "N Files" do Cursor. Compara o conteúdo de
	 * antes da primeira edição pendente com o de depois da última; quando falta
	 * algum desses textos, soma os números de cada edição. `list` vem da mais
	 * recente para a mais antiga.
	 */
		private summaryOf(list: readonly RawEntry[], state?: ReturnType<ReviewStore['get']>): FileSummary & { revision?: number } {
		const cacheKey = list.map((entry) => entry.id).join('|');
		const cached = this.summaryCache.get(cacheKey);
		if (cached) {
			return cached;
		}
		const newest = list[0];
		const oldest = list[list.length - 1];
		const view = this.viewOf(newest);
		const shared = this.getSharedReview(newest.file);
		const first = shared && shared.base.kind !== 'unavailable' ? { exists: shared.base.kind === 'text', text: shared.base.kind === 'text' ? shared.base.text : '', large: false } : oldest.before;
		const last = shared && shared.expected.kind !== 'unavailable' ? { exists: shared.expected.kind === 'text', text: shared.expected.kind === 'text' ? shared.expected.text : '', large: false } : newest.after;
		let added = 0;
		let removed = 0;
		if (list.length === 1) {
			added = view.added + view.modified;
			removed = view.removed + view.modified;
		} else if (first && last && !first.large && !last.large && last.text !== null && !(first.exists && first.text === null)) {
			const diff = computeDiff(first.text ?? '', last.text);
			added = diff.added + diff.modified;
			removed = diff.removed + diff.modified;
		} else {
			for (const item of list.map((entry) => this.viewOf(entry))) {
				added += item.added + item.modified;
				removed += item.removed + item.modified;
			}
		}
		const summary: FileSummary & { revision?: number } = {
				...this.projectResourceReview(this.getSharedReview(newest.file)),
				lastOperation: this.lastOperationView(newest.file, state),
			id: newest.id,
			key: newest.file,
			revision: this.getSharedReview(newest.file)?.revision,
			file: view.file,
			dir: view.dir,
			added,
			removed,
			created: first !== null && !first.exists,
			deleted: last !== null && !last.exists,
		};
		this.summaryCache.set(cacheKey, summary);
		return summary;
	}

	private async loadEntries(): Promise<RawEntry[]> {
		const all: RawEntry[] = []; const folders = vscode.workspace.workspaceFolders ?? [];
		const currentFolders = new Set(folders.filter((folder) => folder.uri.scheme === 'file').map((folder) => folder.uri.toString()));
		for (const key of this.captureEvidence.keys()) { if (!currentFolders.has(key)) { this.captureEvidence.delete(key); this.captureHealthStates.delete(key); this.captureWarnings.delete(key); } }
		for (const key of [...this.runtimeWarnings.keys(), ...this.nextHousekeeping.keys()]) { if (!currentFolders.has(key)) { this.runtimeWarnings.delete(key); this.nextHousekeeping.delete(key); } }
		for (const [key, store] of this.stores) { if (!currentFolders.has(key)) { await store.close(); this.stores.delete(key); } }
		this.entryFolder.clear(); this.ordinals.clear(); this.resourceAliases.clear(); this.coverageMessage = null;
		const collisions = new Set<string>(); const blobs = new Map<string, string>();
		for (const folder of folders) {
			if (folder.uri.scheme !== 'file') { this.coverageMessage = t('Revisão em provider não validado: somente leitura.'); continue; }
			const key = folder.uri.toString(), log = nodePath.join(folder.uri.fsPath, ...LOG_PATH);
			let stat: nodeFs.Stats | undefined; try { stat = await nodeFs.promises.lstat(log); } catch (error) { if ((error as { code?: string }).code !== 'ENOENT') { this.coverageMessage = t('Parte do histórico não pôde ser lida.'); } }
			let cache = this.logCache.get(key);
			if (!stat || !cache || cache.inode !== stat.ino || stat.size < cache.cursor.offset || stat.size === cache.size && stat.mtimeMs !== cache.mtime) { cache = { cursor: { offset: 0, line: 0 }, entries: [], size: -1, mtime: -1, inode: stat?.ino ?? 0, rejections: 0 }; }
			if (stat && (cache.size !== stat.size || cache.mtime !== stat.mtimeMs || cache.cursor.offset < stat.size)) {
				const parsed = await readLogFile(log, folder.uri.fsPath, { cursor: cache.cursor, maxEntries: 1000, maxBytes: 8 * 1024 * 1024 });
				cache.entries.push(...parsed.entries); cache.rejections += parsed.rejections.length; cache.partialReason = parsed.coverage.status === 'partial' ? parsed.coverage.reason || 'partial' : undefined; cache.cursor = parsed.cursor; cache.size = stat.size; cache.mtime = stat.mtimeMs; cache.inode = stat.ino;
				if (parsed.coverage.status === 'partial' || parsed.rejections.length) { this.coverageMessage = t('Histórico parcial: há registros incompatíveis, incompletos ou leitura pendente de orçamento.'); }
				if (parsed.coverage.reason === 'budget' && parsed.cursor.offset > 0 && parsed.cursor.offset < stat.size) { this.scheduleRefresh(); }
			}
			this.logCache.set(key, cache);
			if (cache.rejections || cache.partialReason) { this.coverageMessage = t('Histórico parcial: registros incompatíveis/incompletos foram preservados ou aguardam leitura.'); }
			const entries: RawEntry[] = [];
			for (const raw of cache.entries) {
				const canonical = await canonicalResource(raw.file, folder.uri.fsPath);
				if (!canonical) { this.coverageMessage = t('Recursos fora das raízes autorizadas permanecem somente leitura.'); continue; }
				this.resourceAliases.set(raw.file, canonical);
				this.resourceAliases.set(vscode.Uri.file(canonical).fsPath, canonical);
				entries.push({ ...raw, file: canonical, before: raw.before && { ...raw.before }, after: raw.after && { ...raw.after } });
			}
			await this.resolveBlobs(folder.uri, entries, blobs);
			for (let ordinal = 0; ordinal < entries.length; ordinal += 1) {
				const entry = entries[ordinal];
				if (this.entryFolder.has(entry.id) && this.entryFolder.get(entry.id) !== key) { collisions.add(entry.id); continue; }
				this.entryFolder.set(entry.id, key); this.ordinals.set(entry.id, ordinal); all.push(entry);
			}
			this.applySavedMeta(await this.readState(vscode.Uri.joinPath(folder.uri, ...META_PATH)));
			await this.loadCaptureHealth(folder);

			let purging = false;
			try { purging = Boolean(await this.readPurgeState(folder)); } catch { purging = true; }
			if (purging) { this.storeErrors.set(key, 'purgeNeedsRecovery'); continue; }
			if (entries.length || await existsLocal(nodePath.join(folder.uri.fsPath, ...LOG_DIR, 'review-state.v1.json'))) {
				try {
					let store = this.stores.get(key);
					if (!store) { const legacy = Object.fromEntries([...this.status].filter(([id]) => entries.some((entry) => entry.id === id))); store = await ReviewStore.open(folder.uri.fsPath, legacy); this.stores.set(key, store); }
					else { await store.reload(); }
					if (store.writable) {
						const state = store.get();
						if (ingestEntries(state, entries)) { await store.update((draft) => { ingestEntries(draft, entries); }); }
					} else { const transient = store.get(); ingestEntries(transient, entries); }
					await this.migrateLegacyUndo(store, entries);
					this.storeErrors.delete(key);
					if (!store.writable && store.blockReason === 'anotherWriter' && store.writerExited()) { this.offerWriterRecovery(folder); }
				} catch (error) { this.storeErrors.set(key, errorCode(error)); }
			}
		}
		if (collisions.size) { this.coverageMessage = t('IDs de histórico ambíguos entre pastas foram isolados.'); }
		this.blobCache = blobs;
		this.synchronizeViews();
		return all.filter((entry) => !collisions.has(entry.id)).sort((a, b) => b.time.localeCompare(a.time) || (this.ordinals.get(b.id) ?? 0) - (this.ordinals.get(a.id) ?? 0));
	}

	/** Preenche o texto dos snapshots que o log guarda só como hash. */

	/**
	 * Depois de uma queda, o lock da janela anterior fica no disco e esta abre só para leitura.
	 * A posse nunca é tomada sozinha (o processo pode estar vivo em outra máquina ou contêiner que
	 * compartilha a pasta), mas a recuperação é oferecida uma vez em vez de depender de o usuário
	 * achar o comando.
	 */
	private offerWriterRecovery(folder: vscode.WorkspaceFolder): void {
		const key = folder.uri.toString();
		if (this.disposed || this.maintenance || this.recoveryOffered.has(key)) { return; }
		this.recoveryOffered.add(key);
		const action = t('Recuperar revisão');
		void vscode.window.showInformationMessage(t('A janela que era dona da revisão de "{0}" não está mais em execução, e esta janela abriu só para leitura. Se o projeto não estiver aberto em outra máquina ou contêiner, recupere a revisão aqui.', folder.name), action)
			.then((choice) => { if (choice === action && !this.disposed) { void this.recoverReviewWriter().catch(() => undefined); } });
	}

	private async migrateLegacyUndo(store: ReviewStore, entries: readonly RawEntry[]): Promise<void> {
		if (!store.writable || !this.undoStack.length) { return; }
		const marker = 'legacy-undo-migration-' + crypto.createHash('sha256').update(JSON.stringify(this.undoStack)).digest('hex');
		if (store.get().operations[marker]) { return; }
		const imports: import('./review').ReviewUndoItem[] = [];
		for (const batch of this.undoStack) {
			const batchId = 'legacy-' + crypto.createHash('sha256').update(JSON.stringify(batch)).digest('hex');
			for (const item of batch.items) {
				const file = await canonicalResource(item.file, store.root); if (!file) { continue; }
				const linked = batch.ids.filter((id) => entries.some((entry) => entry.id === id && entry.file === file));
				if (!linked.length) { continue; }
				const id = batchId + '-' + crypto.createHash('sha256').update(file).digest('hex').slice(0, 16);
				if (store.get().undo.some((saved) => saved.id === id)) { continue; }
				imports.push({ id, operationId: id, file, ids: linked, previous: item.previous === undefined ? { kind: 'absent' } : { kind: 'text', text: item.previous }, restored: item.restored === undefined ? { kind: 'absent' } : { kind: 'text', text: item.restored }, phase: 'available', batchId, createdAt: '1970-01-01T00:00:00.000Z' });
			}
		}
		await store.update((state) => { state.undo.push(...imports); state.operations[marker] = { id: marker, file: store.root, ids: [], expected: { kind: 'absent' }, target: { kind: 'absent' }, stage: 'complete', kind: 'migration' }; });
	}

	private pruneReviewedLog(folder: vscode.WorkspaceFolder, store: ReviewStore, clear: boolean): Promise<boolean> {
		return pruneReviewedLog(store, { clear, cancelled: () => this.disposed, onRewritten: () => this.logCache.delete(folder.uri.toString()),
			retentionDays: vscode.workspace.getConfiguration('claudeCodeLauncher').get<number>('historyRetentionDays', 30) });
	}
	private async applyRetention(): Promise<void> {
		if (this.maintenance || this.disposed || this.activeOperations.size || this.backgroundTasks.size) { return; }
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			const store = this.stores.get(folder.uri.toString()); if (!store?.writable) { continue; }
			const entries = this.entries.filter((entry) => this.entryFolder.get(entry.id) === folder.uri.toString());
			const days = vscode.workspace.getConfiguration('claudeCodeLauncher').get<number>('historyRetentionDays', 30);
			if (entries.length <= MAX_LOG_ENTRIES && !retentionCandidates(entries, days, Date.now(), (id) => this.status.has(id)).length) { continue; }
			try { const changed = await withCaptureMaintenance(store, () => this.pruneReviewedLog(folder, store, false)); if (changed) { this.refreshAgain = true; } }
			catch (error) { this.coverageMessage = t('Retenção adiada: {0}. Pendências preservadas.', explain(error)); }
		}
	}

	/**
	 * O hook deixa um marcador em completed/ a cada edição gravada e um "pre" em pending/ quando a
	 * ferramenta não chega ao "post"; o estado canônico acumula cópias em review-blobs/. A retenção
	 * do log não alcança nenhum deles, e o hook para de capturar quando a pasta passa do seu
	 * orçamento de inventário. A coleta roda de tempos em tempos, só na janela dona da revisão.
	 */
	private async applyHousekeeping(): Promise<void> {
		if (this.maintenance || this.disposed || this.activeOperations.size || this.backgroundTasks.size) { return; }
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			const key = folder.uri.toString(), store = this.stores.get(key);
			if (!store?.writable || Date.now() < (this.nextHousekeeping.get(key) ?? 0)) { continue; }
			// Falha aqui não é um problema da revisão: tenta de novo mais tarde, sem aviso.
			try { await housekeep(store, () => this.disposed); this.nextHousekeeping.set(key, Date.now() + HOUSEKEEPING_INTERVAL_MS); }
			catch { this.nextHousekeeping.set(key, Date.now() + HOUSEKEEPING_RETRY_MS); }
		}
	}

	private async resolveBlobs(folder: vscode.Uri, entries: RawEntry[], blobs: Map<string, string>): Promise<void> {
		const wanted = new Set<string>();
		for (const entry of entries) {
			for (const snapshot of [entry.before, entry.after]) {
				if (snapshot && snapshot.text === null && isBlobHash(snapshot.hash) && !blobs.has(snapshot.hash)) {
					wanted.add(snapshot.hash);
				}
			}
		}
		let bytesRead = [...blobs.values()].reduce((total, text) => total + Bytes.byteLength(text, 'utf8'), 0);
		const hashes = [...wanted];
		for (let offset = 0; offset < hashes.length; offset += 4) {
			if (bytesRead >= 64 * 1024 * 1024) { this.coverageMessage = t('Parte dos snapshots aguarda orçamento de memória; os registros originais foram preservados.'); break; }
			const batch = await Promise.all(hashes.slice(offset, offset + 4).map(async (hash) => {
				const text = this.blobCache.get(hash) ?? await readVerifiedBlob(vscode.Uri.joinPath(folder, ...BLOB_DIR, hash + '.txt').fsPath, folder.fsPath, hash);
				return { hash, text };
			}));
			for (const { hash, text } of batch) { if (text !== undefined && bytesRead + Bytes.byteLength(text, 'utf8') <= 64 * 1024 * 1024) { blobs.set(hash, text); bytesRead += Bytes.byteLength(text, 'utf8'); } }
		}

		const get = (hash: string) => blobs.get(hash);
		for (const entry of entries) {
			entry.before = resolveSnapshot(entry.before, get);
			entry.after = resolveSnapshot(entry.after, get);
		}
	}


	/** Edições cuja explicação e pedido valem a pena buscar: as do histórico e as pendentes. */
	private metaTargets(): RawEntry[] {
		const shown = new Set(this.entries.slice(0, MAX_HISTORY).map((entry) => entry.id));
		return this.entries.filter((entry) => shown.has(entry.id) || !this.status.has(entry.id));
	}

	private hasMeta(entry: RawEntry): boolean {
			const pending = this.pendingMetadata.get(entry.id);
			return (Boolean(entry.reason) || this.reasonCache.has(entry.id) || Boolean(pending?.reason)) && (this.requestCache.has(entry.id) || Boolean(pending?.request));
	}
		private async metadataPolicyContexts(entry: RawEntry): Promise<MetadataPolicyContext[] | undefined> {
			try {
				const folder = vscode.workspace.workspaceFolders?.find((candidate) => candidate.uri.toString() === this.entryFolder.get(entry.id))
					?? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(entry.file));
				if (!folder || folder.uri.scheme !== 'file' || !this.stores.get(folder.uri.toString())?.writable || await this.readPurgeState(folder)) { return undefined; }
				const root = await nodeFs.promises.realpath(folder.uri.fsPath), file = await canonicalResource(entry.file, folder.uri.fsPath);
				if (!file) { return undefined; }
				const diskPolicy = await this.capture.readCapturePolicy(folder);
				const config = vscode.workspace.getConfiguration('claudeCodeLauncher');
				// Absence has the same recognized legacy default as capture; an invalid
				// or unreadable policy above never falls back to that default.
				const legacy = diskPolicy ?? makeCapturePolicy({ generation: 'legacy-default' });
				const settings = makeCapturePolicy({ generation: 'metadata-settings', excludedPatterns: excludedPatterns(config),
					maxStorageMB: config.get<number>('historyMaxStorageMB', 128), retentionDays: config.get<number>('historyRetentionDays', 30) });
				return [legacy, settings].map((policy) => ({ policy, canonicalRoot: root, canonicalFile: file, scopeVerified: true }));
			} catch { return undefined; }
		}
		private async metadataPermits(entry: RawEntry): Promise<MetadataPermit[] | undefined> {
			const contexts = await this.metadataPolicyContexts(entry); if (!contexts) { return undefined; }
			const permits: MetadataPermit[] = [];
			for (const context of contexts) { const decision = evaluateMetadataPolicy(context); if (!decision.allowed) { return undefined; } permits.push(decision.permit); }
			return permits;
		}
		private async metadataPermitsCurrent(entry: RawEntry, permits: readonly MetadataPermit[], epoch: number): Promise<boolean> {
			if (this.disposed || this.maintenance || epoch !== this.metaEpoch) { return false; }
			const contexts = await this.metadataPolicyContexts(entry);
			return !this.disposed && !this.maintenance && epoch === this.metaEpoch && contexts?.length === permits.length
				&& contexts.every((context, index) => revalidateMetadataPermit(permits[index], context).allowed);
		}

	// O hook não lê o transcript (o Claude espera por ele, e o texto da edição
	// pode nem estar gravado ainda). Aqui a explicação e o pedido são buscados;
	// enquanto faltarem, tenta outra vez em alguns segundos, até
	// MAX_META_ATTEMPTS vezes por edição. O que for achado vai para meta.json.
	private async fillMeta(): Promise<void> {
		if (this.disposed || this.maintenance) { return; }
		if (this.metaRunning) {
			this.metaAgain = true;
			return;
		}
		this.metaRunning = true;
		const epoch = this.metaEpoch;
		try {
			const byTranscript = new Map<string, RawEntry[]>();
				const permissions = new Map<string, MetadataPermit[]>();
			for (const entry of this.metaTargets()) {
				if (!entry.transcript || this.hasMeta(entry) || !(await transcriptAllowed(entry.transcript, (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === 'file').map((folder) => sessionsDir(folder.uri.fsPath))))) {
					continue;
				}
				if (!(await this.metaToolUseId(entry))) {
					continue;
				}
				if ((this.metaAttempts.get(entry.id) ?? 0) >= MAX_META_ATTEMPTS) {
					continue;
				}
					const permits = await this.metadataPermits(entry);
					if (!permits || !(await this.metadataPermitsCurrent(entry, permits, epoch))) { continue; }
					permissions.set(entry.id, permits);
				const list = byTranscript.get(entry.transcript) ?? [];
				list.push(entry);
				byTranscript.set(entry.transcript, list);
			}
			let found = false;
			let missing = false;
			for (const [transcript, list] of byTranscript) {
					const permitted: RawEntry[] = [];
					for (const entry of list) { const permits = permissions.get(entry.id); if (permits && await this.metadataPermitsCurrent(entry, permits, epoch)) { permitted.push(entry); } }
					if (!permitted.length) { continue; }
					if (permitted.length > 256) { missing = true; }
					const selected = permitted.slice(0, 256);
					const meta = await readTranscriptMeta(transcript, { toolUseIds: [...new Set(selected.map((entry) => this.toolUseOf(entry) as string))], cache: false });
				if (epoch !== this.metaEpoch || this.maintenance || this.disposed) { return; }
					for (const entry of selected) {
						const permits = permissions.get(entry.id)!;
						if (!(await this.metadataPermitsCurrent(entry, permits, epoch))) { continue; }
					const toolUseId = this.toolUseOf(entry) as string;
					const reason = meta.reasons.get(toolUseId);
					const request = meta.requests.get(toolUseId);
						if (reason !== undefined && !this.reasonCache.has(entry.id) || request && !this.requestCache.has(entry.id)) {
							this.pendingMetadata.set(entry.id, { reason: this.reasonCache.has(entry.id) ? undefined : reason,
								request: this.requestCache.has(entry.id) ? undefined : request, permits, epoch }); found = true;
						}
					if (!this.hasMeta(entry)) {
						const attempts = (this.metaAttempts.get(entry.id) ?? 0) + 1;
						this.metaAttempts.set(entry.id, attempts);
						missing = missing || attempts < MAX_META_ATTEMPTS;
					}
				}
			}
			if (found) {
				this.queueStateWrite();
			}
			if (missing) {
				clearTimeout(this.metaTimer);
				this.metaTimer = setTimeout(() => {
					void this.fillMeta();
				}, 3000);
			}
		} finally {
			this.metaRunning = false;
			if (this.metaAgain && !this.disposed && !this.maintenance) {
				this.metaAgain = false;
				void this.fillMeta();
			}
		}
	}

	private toolUseOf(entry: RawEntry): string | undefined {
		return entry.toolUseId || this.commandToolUses.get(entry.id);
	}

	/**
	 * Mudanças por comando (captura do turno) não têm chamada de ferramenta própria: o pedido e a
	 * explicação vêm da última chamada (de preferência de terminal) do mesmo turno no transcript.
	 */
	private async metaToolUseId(entry: RawEntry): Promise<string | undefined> {
		const known = this.toolUseOf(entry);
		if (known || entry.tool !== 'Command' || !entry.transcript) { return known; }
		const found = await findTurnToolUse(entry.transcript, entry.time);
		if (found) {
			this.commandToolUses.set(entry.id, found);
			if (this.commandToolUses.size > MAX_STATUS) { this.commandToolUses.delete(this.commandToolUses.keys().next().value as string); }
		}
		return found;
	}

	private applySavedMeta(saved: Record<string, unknown> | undefined): void {
		for (const [id, value] of Object.entries(validateSavedMeta(saved))) {
			const item = value as { reason?: unknown; request?: { id?: unknown; text?: unknown } } | null;
			if (!item || typeof item !== 'object') {
				continue;
			}
			if (typeof item.reason === 'string' && !this.reasonCache.has(id)) {
				this.reasonCache.set(id, item.reason);
			}
			const request = item.request;
			if (request && typeof request.id === 'string' && typeof request.text === 'string' && !this.requestCache.has(id)) {
				this.requestCache.set(id, { id: request.id, text: request.text });
			}
		}
	}

	// ---- Estado gravado: status.json, meta.json, undo -------------------------------

	private async readState(uri: vscode.Uri): Promise<Record<string, unknown> | undefined> {
		const folder = vscode.workspace.getWorkspaceFolder(uri); if (!folder || folder.uri.scheme !== 'file') { return undefined; }
		const read = await safeReadText(uri.fsPath, folder.uri.fsPath, 8 * 1024 * 1024);
		if (read.kind === 'absent') { return undefined; }
		if (read.kind === 'error') { this.coverageMessage = t('Metadados locais não puderam ser lidos com segurança.'); return undefined; }
		this.stateText.set(uri.toString(), read.text);
		try { const parsed: unknown = JSON.parse(read.text.replace(/^\uFEFF/, '')); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && !Object.hasOwn(parsed, 'schemaVersion')) { return parsed as Record<string, unknown>; } } catch { /* Invalid is not an empty valid state. */ }
		this.coverageMessage = t('Metadados locais incompatíveis foram preservados.'); return undefined;
	}

	/** Grava status.json e meta.json em seguida, juntando pedidos feitos enquanto uma gravação espera. */
	private queueStateWrite(): void {
		if (this.disposed || this.maintenance || this.writeQueued) {
			return;
		}
		this.writeQueued = true;
		this.writeChain = this.writeChain
			.then(async () => {
				this.writeQueued = false;
				await this.writeStateFiles();
			})
			.catch((error) => { this.coverageMessage = t('Metadados preservados sem atualização: {0}.', explain(error)); if (!this.disposed) { this.publish(); } });
	}

	private async writeStateFiles(): Promise<void> {
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			const folderKey = folder.uri.toString();
			const status: Record<string, ReviewResolution> = {};
			const meta: Record<string, { reason: string | null; request: RequestInfo | null }> = {};
			const priorRead = await this.readState(vscode.Uri.joinPath(folder.uri, ...META_PATH));
			const prior = validateSavedMeta(priorRead);
			// Enrichment is not a cleanup operation: an incremental log cursor may
			// not have loaded every legacy ID yet. Preserve all admitted old fields.
			Object.assign(meta, prior);
			const staged = new Map<string, NonNullable<ReturnType<typeof this.pendingMetadata.get>>>();
			let count = 0;
			for (const [id, owner] of this.entryFolder) {
				if (owner !== folderKey) {
					continue;
				}
				count += 1;
				const value = this.status.get(id);
				if (value) {
					status[id] = value;
				}
				if (prior[id]) { meta[id] = prior[id]; }
				const candidate = this.pendingMetadata.get(id), entry = this.entries.find((entry) => entry.id === id);
				if (!candidate || !entry) { continue; }
				if (!(await this.metadataPermitsCurrent(entry, candidate.permits, candidate.epoch))) { this.pendingMetadata.delete(id); continue; }
				meta[id] = { reason: candidate.reason ?? prior[id]?.reason ?? null, request: candidate.request ?? prior[id]?.request ?? null };
				staged.set(id, candidate);
			}
			if (count === 0) {
				continue;
			}
			if (!this.stores.get(folderKey)?.writable) { continue; }
			// status.json is written exclusively by the canonical store projection.
			const assertPermits = async () => {
				for (const [id, candidate] of staged) {
					const entry = this.entries.find((entry) => entry.id === id);
					if (!entry || this.pendingMetadata.get(id) !== candidate || !(await this.metadataPermitsCurrent(entry, candidate.permits, candidate.epoch))) { throw new ReviewError('metadataPolicyChanged'); }
				}
			};
			await this.writeIfChanged(vscode.Uri.joinPath(folder.uri, ...META_PATH), meta, assertPermits);
			for (const [id, candidate] of staged) {
				if (this.pendingMetadata.get(id) !== candidate) { continue; }
				if (candidate.reason !== undefined) { this.reasonCache.set(id, candidate.reason); }
				if (candidate.request) { this.requestCache.set(id, candidate.request); }
				this.pendingMetadata.delete(id);
			}
		}
		if (!this.disposed) { this.publish(); }
	}

	private async writeIfChanged(uri: vscode.Uri, value: object, assertPermits?: () => Promise<void>): Promise<void> {
		const folder = vscode.workspace.getWorkspaceFolder(uri), store = folder && this.stores.get(folder.uri.toString());
		if (!store?.writable || this.maintenance) { return; }
		await assertPermits?.();
		const text = JSON.stringify(value) + '\n'; if (this.stateText.get(uri.toString()) === text) { return; }
		const read = await safeReadText(uri.fsPath, store.root, 8 * 1024 * 1024);
		if (read.kind === 'error') { throw new ReviewError(read.code); }
		if (read.kind === 'content') { try { const parsed = JSON.parse(read.text.replace(/^\uFEFF/, '')); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.hasOwn(parsed, 'schemaVersion') || Object.keys(validateSavedMeta(parsed)).length !== Object.keys(parsed).length) { throw new Error('shape'); } } catch { throw new ReviewError('invalidMetadata'); } }
		await this.writeOwnedFile(store, uri.fsPath, text, read.kind === 'content' ? read.text : undefined, assertPermits);
		this.stateText.set(uri.toString(), text);
	}


	private async loadCaptureHealth(folder: vscode.WorkspaceFolder): Promise<void> {
		const epoch = this.metaEpoch, key = folder.uri.toString();
		const diagnostic = await readCaptureDiagnostics(nodePath.join(folder.uri.fsPath, ...LOG_DIR), folder.uri.fsPath);
		const capability = await this.capture.hookCapability();
		const inspected = inspectHookConfiguration(await this.capture.readSettings(folder), this.capture.scriptPath(folder), this.capture.knownHookPaths());
		const active = inspected.valid && inspected.active && capability.status !== 'unsupported';
		const script = active ? await this.capture.verifyHookScript(folder) : 'ok';
		const nodeFound = !active || await this.capture.nodeAvailable();
		if (this.disposed || this.maintenance || epoch !== this.metaEpoch
			|| !(vscode.workspace.workspaceFolders ?? []).some((current) => current.uri.toString() === key)) { return; }
		this.runtimeWarnings.delete(key);
		if (script === 'differs') { this.runtimeWarnings.set(key, t(HOOK_SCRIPT_DIFFERS)); }
		// Um evento já observado prova que o executável existe para o Claude, mesmo fora do PATH desta janela.
		else if (!nodeFound && diagnostic.kind !== 'known') { this.runtimeWarnings.set(key, t(NODE_MISSING)); }
		const diagnostics = retainCaptureEvidence(this.captureEvidence.get(key), diagnostic);
		this.captureEvidence.set(key, diagnostics);
		const disabled = vscode.workspace.getConfiguration('claudeCodeLauncher').get<string>('hookExecutionMode', 'auto') === 'disabled';
		const configuration: CaptureConfiguration = disabled ? 'disabled' : !inspected.valid ? 'unknown' : inspected.active ? 'configured' : 'notConfigured';
		if (active && inspected.turn) { this.turnCaptureFolders.add(key); } else { this.turnCaptureFolders.delete(key); }
		const health = captureHealth(configuration, capability, diagnostics, active && inspected.turn, remoteName());
		this.captureHealthStates.set(key, health);
		this.captureWarnings.delete(key);
		const latest = diagnostics.latestObservation;
		if (latest && !['capturePrepared', 'captureRecorded', 'excludedByPolicy'].includes(latest.code)) {
			this.captureWarnings.set(key, health.observation?.guidance || t('Captura não confirmada; confira o diagnóstico local.'));
		}
	}

	private async hooksEnabled(): Promise<boolean> {
		if (vscode.workspace.getConfiguration('claudeCodeLauncher').get<string>('hookExecutionMode', 'auto') === 'disabled') { return false; }
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			if (folder.uri.scheme !== 'file') { continue; }
			const read = await this.capture.readSettings(folder);
			if (inspectHookConfiguration(read, this.capture.scriptPath(folder), this.capture.knownHookPaths()).active) {
				try { const policy = await this.capture.readCapturePolicy(folder); if (policy?.paused || this.captureWarnings.has(folder.uri.toString())) { continue; } const capability = await this.capture.hookCapability(); if (capability.status !== 'confirmed') { this.hookWarnings.set(folder.uri.toString(), t('Capacidade de hooks não confirmada; revisão do histórico continua disponível.')); continue; } return true; }
				catch { this.hookWarnings.set(folder.uri.toString(), t('Política de captura incompatível preservada.')); }
			}
		}
		return false;
	}
	private async ensureStore(folder: vscode.WorkspaceFolder, allowPurgeRecovery = false): Promise<ReviewStore> {
		if (this.disposed) { throw new ReviewError('cancelledBeforeEffect'); }
		if (folder.uri.scheme !== 'file') { throw new ReviewError('unsupportedStore'); }
		if (!allowPurgeRecovery && await this.readPurgeState(folder)) { throw new ReviewError('purgeNeedsRecovery'); }
		let store = this.stores.get(folder.uri.toString());
		if (!store) { store = await ReviewStore.open(folder.uri.fsPath); this.stores.set(folder.uri.toString(), store); }
		if (!store.writable) { throw new ReviewError(store.blockReason || 'readOnlyOwner'); }
		return store;
	}



	private writeOwnedFile(store: ReviewStore, file: string, text: string, expected: string | undefined, assertPermits?: () => Promise<void>): Promise<void> {
		return writeOwnedFile(store, file, text, expected, { cancelled: () => this.disposed, assertPermits });
	}

	private mediaUri(): vscode.Uri {
		return vscode.Uri.joinPath(this.context.extensionUri, 'media');
	}

	private html(webview: vscode.Webview): string {
		const nonce = createNonce();
		const script = webview.asWebviewUri(vscode.Uri.joinPath(this.mediaUri(), 'changes.js'));
		const l10n = webview.asWebviewUri(vscode.Uri.joinPath(this.mediaUri(), 'l10n.js'));
		const style = webview.asWebviewUri(vscode.Uri.joinPath(this.mediaUri(), 'changes.css'));
		const base = webview.asWebviewUri(vscode.Uri.joinPath(this.mediaUri(), 'base.css'));
		const codicons = webview.asWebviewUri(vscode.Uri.joinPath(this.mediaUri(), 'codicons', 'codicon.css'));
		return `<!DOCTYPE html>
<html lang="${htmlLanguage()}">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<link rel="stylesheet" href="${codicons}" />
	<link rel="stylesheet" href="${base}" />
	<link rel="stylesheet" href="${style}" />
	<title>${t('Mudanças do Claude')}</title>
</head>
<body>
	<div id="root"><p class="loading muted"><span class="codicon codicon-loading codicon-modifier-spin"></span> ${t('Carregando…')}</p></div>
	${webviewDictionaryScript()}
	<script nonce="${nonce}" src="${l10n}"></script>
	<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
	}
}
