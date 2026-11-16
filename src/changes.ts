import * as vscode from 'vscode';
import { computeDiff, DiffResult, Hunk } from './diff';
import {
	contiguousTail, fileKey, groupByFile, isBlobHash, normalizeEol, planRevert, RawEntry, referencedBlobs, resolveSnapshot,
	Status, trimLog,
} from './logic';
import { readTranscriptMeta, RequestInfo } from './sessions';

export type { RawEntry, Snapshot } from './logic';

const HOOK_FILE = 'launcher-record-change.js';
const LOG_DIR = ['.claude', 'launcher-changes'];
const LOG_PATH = [...LOG_DIR, 'log.jsonl'];
const BLOB_DIR = [...LOG_DIR, 'blobs'];
const PENDING_DIR = [...LOG_DIR, 'pending'];
/** Aceito/recusado de cada edição, compartilhado entre editores (Cursor e VS Code). */
const STATUS_PATH = [...LOG_DIR, 'status.json'];
/** Explicação e pedido já achados no transcript, para não depender dele depois. */
const META_PATH = [...LOG_DIR, 'meta.json'];
const SETTINGS_PATH = ['.claude', 'settings.local.json'];
const MATCHER = 'Edit|Write|MultiEdit|NotebookEdit';
const SCHEME = 'claude-launcher-change';
const STATUS_KEY = 'claudeCodeLauncher.entryStatus';
const LEGACY_REVIEWED_KEY = 'claudeCodeLauncher.reviewedEntries';
const UNDO_KEY = 'claudeCodeLauncher.undoStack';
const PENDING_CONTEXT = 'claudeCodeLauncher.hasPendingChanges';
/** Comando interno de inline.ts: esquece a revisão aberta de um arquivo, sem marcar nada. */
export const DROP_REVIEW_COMMAND = 'claude-code-launcher.dropReview';

/** Edições mostradas no histórico. */
const MAX_HISTORY = 60;
/** Acima disso, o log perde as edições revisadas mais antigas. */
const MAX_LOG_ENTRIES = 400;
const MAX_STATUS = 3000;
const MAX_META_ATTEMPTS = 10;
/** Recusas que dá para desfazer, da mais recente para trás. */
const MAX_UNDO = 5;
/** Soma dos textos guardados para desfazer (caracteres), para o estado do editor não inchar. */
const MAX_UNDO_CHARS = 8 * 1024 * 1024;
/** Blobs sem referência só saem depois disso: o hook pode estar no meio de uma edição. */
const BLOB_GRACE_MS = 10 * 60 * 1000;
/** "pre" sem "post" (ferramenta que falhou, por exemplo) sai depois disso. */
const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function changeUri(entry: RawEntry, side: 'antes' | 'depois'): vscode.Uri {
	return vscode.Uri.from({ scheme: SCHEME, path: `/${entry.id}/${side}/${basename(entry.file)}` });
}

interface ViewEntry {
	id: string;
	time: string;
	action: string;
	file: string;
	dir: string;
	summary: string;
	reason: string | null;
	added: number;
	removed: number;
	modified: number;
	hunks: Hunk[];
	note: string | null;
	canCompare: boolean;
	status: Status | null;
	requestId: string | null;
	request: string | null;
}

interface UndoItem {
	file: string;
	/** Conteúdo antes de recusar (undefined = o arquivo não existia). */
	previous: string | undefined;
	/** Conteúdo que a recusa deixou (undefined = a recusa apagou o arquivo). */
	restored: string | undefined;
}

interface Undo {
	items: UndoItem[];
	ids: string[];
}

type Message = { command?: string; id?: string; key?: string; request?: string };

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
	);
	void controller.repairHooks();
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
	private refreshTimer: unknown;
	private publishTimer: unknown;
	private metaTimer: unknown;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly reasonCache = new Map<string, string>();
	private readonly requestCache = new Map<string, RequestInfo>();
	private readonly metaAttempts = new Map<string, number>();
	private readonly status: Map<string, Status>;
	/** Sobe a cada setStatus: uma leitura de status.json mais antiga que isso é descartada. */
	private statusVersion = 0;
	private readonly undoStack: Undo[];
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
		this.status = loadStatus(context.workspaceState);
		this.undoStack = loadUndo(context.workspaceState);
		this.statusItem = vscode.window.createStatusBarItem('claude-code-launcher.pending', vscode.StatusBarAlignment.Right, 99);
		this.statusItem.name = 'Mudanças do Claude';
		this.statusItem.command = 'claude-code-launcher.showChanges';

		const watcher = vscode.workspace.createFileSystemWatcher(
			'**/.claude/{launcher-changes/log.jsonl,launcher-changes/status.json,settings.local.json}',
		);
		const schedule = () => this.scheduleRefresh();
		this.disposables.push(
			this.entriesEmitter,
			this.decorationEmitter,
			this.statusItem,
			watcher,
			watcher.onDidCreate(schedule),
			watcher.onDidChange(schedule),
			watcher.onDidDelete(schedule),
			vscode.workspace.onDidChangeWorkspaceFolders(() => {
				// O caminho relativo mostrado no painel depende das pastas abertas.
				this.viewCache.clear();
				this.summaryCache.clear();
				void this.repairHooks();
				schedule();
			}),
		);
		this.scheduleRefresh();
	}

	dispose(): void {
		clearTimeout(this.refreshTimer);
		clearTimeout(this.publishTimer);
		clearTimeout(this.metaTimer);
		this.disposables.forEach((disposable) => disposable.dispose());
	}

	// ---- Usado por inline.ts ----------------------------------------------------

	getEntries(): readonly RawEntry[] {
		return this.entries;
	}

	isReviewed(id: string): boolean {
		return this.status.has(id);
	}

	/** Marca edições como aceitas ou recusadas; `undefined` volta para pendente. */
	setStatus(ids: readonly string[], status: Status | undefined): void {
		let changed = false;
		for (const id of ids) {
			if (status === undefined) {
				changed = this.status.delete(id) || changed;
			} else if (this.status.get(id) !== status) {
				this.status.delete(id);
				this.status.set(id, status);
				changed = true;
			}
		}
		if (!changed) {
			return;
		}
		this.statusVersion += 1;
		this.saveStatusMemento();
		this.queueStateWrite();
		// Pode ser chamado no meio de uma pintura das marcas: avisa depois.
		clearTimeout(this.publishTimer);
		this.publishTimer = setTimeout(() => this.publish(), 0);
	}

	/** Arquivos (caminho completo) com mudanças pendentes que ainda existem, na ordem do painel. */
	pendingFiles(): string[] {
		return this.pendingGroups()
			.filter((list) => list[0].after?.exists !== false)
			.map((list) => list[0].file);
	}

	// ---- Webview, conteúdo virtual e decorações ---------------------------------

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		this.setupWebview(webviewView.webview, false);
		webviewView.onDidDispose(() => {
			this.view = undefined;
		});
	}

	openPanel(): void {
		if (this.panel) {
			this.panel.reveal();
			return;
		}
		this.panel = vscode.window.createWebviewPanel(
			'claude-code-launcher.changesPanel',
			'Mudanças do Claude',
			vscode.ViewColumn.Active,
			{ enableScripts: true, localResourceRoots: [this.mediaUri()] },
		);
		this.setupWebview(this.panel.webview, true);
		this.panel.onDidDispose(() => {
			this.panel = undefined;
		});
	}

	provideTextDocumentContent(uri: vscode.Uri): string {
		const [, id, side] = uri.path.split('/');
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
			tooltip: 'Mudanças do Claude para revisar',
			color: new vscode.ThemeColor('claudeCodeLauncher.pendingChangeForeground'),
		};
	}

	// ---- Registro (hooks) --------------------------------------------------------

	async setEnabled(enable: boolean): Promise<void> {
		const folders = vscode.workspace.workspaceFolders ?? [];
		if (folders.length === 0) {
			void vscode.window.showWarningMessage('Abra uma pasta de projeto para registrar as mudanças do Claude.');
			return;
		}
		for (const folder of folders) {
			if (enable) {
				await this.installHookScript(folder);
			}
			await this.writeHooks(folder, enable);
		}
		await this.refresh();
		if (enable) {
			void vscode.window.showInformationMessage(
				'Registro de mudanças ativado. Ele vale para conversas do Claude Code iniciadas a partir de agora.',
			);
		}
	}

	/**
	 * Mantém o hook funcionando: atualiza a cópia do script dentro do projeto e,
	 * se o settings ainda aponta para outro lugar (versão antiga, que usava o
	 * armazenamento global do editor), passa a apontar para essa cópia.
	 */
	async repairHooks(): Promise<void> {
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			try {
				const text = await readText(vscode.Uri.joinPath(folder.uri, ...SETTINGS_PATH));
				if (!text?.includes(HOOK_FILE)) {
					continue;
				}
				await this.installHookScript(folder);
				if (!text.includes(this.scriptPath(folder))) {
					await this.writeHooks(folder, true);
				}
			} catch {
				// Sem permissão de escrita, por exemplo: o registro segue como estava.
			}
		}
	}

	async clear(): Promise<void> {
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			try {
				await vscode.workspace.fs.delete(vscode.Uri.joinPath(folder.uri, ...LOG_PATH));
			} catch {
				// Nada registrado nesta pasta.
			}
			await this.collectBlobs(folder.uri, []);
		}
		await this.refresh();
	}

	// ---- Aceitar e recusar ---------------------------------------------------------

	/** Mantém tudo como o Claude deixou e tira os arquivos da lista de pendentes. */
	async acceptEverything(): Promise<void> {
		const groups = this.pendingGroups();
		if (groups.length > 0) {
			await this.accept(groups);
			void vscode.window.showInformationMessage(`Mudanças do Claude aceitas em ${countFiles(groups.length)}.`);
		}
	}

	async rejectEverything(): Promise<void> {
		const groups = this.pendingGroups();
		if (groups.length === 0) {
			return;
		}
		const ok = await confirm(
			`Recusar as mudanças do Claude em ${countFiles(groups.length)}?`,
			'Cada arquivo volta a ser como era antes do Claude editar: arquivos que ele criou vão para a lixeira e os que ele '
			+ 'apagou são recriados. Dá para desfazer logo depois.',
			'Recusar todas',
		);
		if (ok) {
			this.report(await this.revert(groups));
		}
	}

	/** Volta os arquivos de uma recusa para como estavam antes dela. */
	async undoReject(): Promise<void> {
		const undo = this.undoStack.pop();
		if (!undo) {
			void vscode.window.showInformationMessage('Não há recusa para desfazer.');
			return;
		}
		this.saveUndo();
		const failed: string[] = [];
		for (const item of undo.items) {
			const uri = vscode.Uri.file(item.file);
			try {
				const current = await currentText(uri);
				const untouched = item.restored === undefined
					? current === undefined
					: current !== undefined && normalizeEol(current) === normalizeEol(item.restored);
				if (!untouched) {
					failed.push(basename(item.file));
					continue;
				}
				if (item.previous !== undefined) {
					await writeText(uri, item.previous);
				} else if (current !== undefined) {
					await deleteFile(uri);
				}
				await vscode.commands.executeCommand(DROP_REVIEW_COMMAND, uri.toString());
			} catch {
				failed.push(basename(item.file));
			}
		}
		this.setStatus(undo.ids, undefined);
		if (failed.length > 0) {
			void vscode.window.showWarningMessage(
				`Não desfiz a recusa em ${failed.join(', ')}: ${failed.length === 1 ? 'o arquivo mudou' : 'os arquivos mudaram'} depois dela.`,
			);
		} else {
			void vscode.window.showInformationMessage('Recusa desfeita: as mudanças do Claude voltaram.');
		}
	}

	private async acceptFile(key: string | undefined): Promise<void> {
		const group = this.pendingGroups().find((list) => fileKey(list[0].file) === key);
		if (group) {
			await this.accept([group]);
		}
	}

	private async rejectFile(key: string | undefined): Promise<void> {
		const group = this.pendingGroups().find((list) => fileKey(list[0].file) === key);
		if (group) {
			this.report(await this.revert([group]));
		}
	}

	/** Recusa tudo o que o Claude mudou para atender um pedido. */
	private async rejectRequest(requestId: string | undefined): Promise<void> {
		const entries = this.entries.filter(
			(entry) => this.requestCache.get(entry.id)?.id === requestId && this.status.get(entry.id) !== 'rejected',
		);
		if (!requestId || entries.length === 0) {
			return;
		}
		const groups = groupByFile(entries);
		const text = this.requestCache.get(entries[0].id)?.text ?? '';
		const ok = await confirm(
			`Desfazer o pedido "${text}"?`,
			`${capitalize(countFiles(groups.length))} ${groups.length === 1 ? 'volta' : 'voltam'} a ser como era antes deste pedido. `
			+ 'Arquivos mudados depois dele ficam como estão. Dá para desfazer logo depois.',
			'Desfazer pedido',
		);
		if (ok) {
			this.report(await this.revert(groups));
		}
	}

	private async accept(groups: RawEntry[][]): Promise<void> {
		for (const list of groups) {
			await vscode.commands.executeCommand(DROP_REVIEW_COMMAND, vscode.Uri.file(list[0].file).toString());
		}
		this.setStatus(groups.flat().map((entry) => entry.id), 'accepted');
	}

	/**
	 * Volta cada arquivo para antes da edição mais antiga do grupo. Cada grupo
	 * tem as edições de um arquivo, da mais recente para a mais antiga.
	 */
	private async revert(groups: RawEntry[][]): Promise<{ done: number; skipped: string[]; partial: string[] }> {
		const items: UndoItem[] = [];
		const ids: string[] = [];
		const skipped: string[] = [];
		const partial: string[] = [];
		for (const list of groups) {
			// Só a sequência contínua mais recente: se o arquivo mudou entre duas
			// edições do Claude, voltar ao "antes" da mais antiga apagaria essa mudança.
			const tail = contiguousTail([...list].reverse());
			const newest = tail[tail.length - 1];
			const oldest = tail[0];
			const uri = vscode.Uri.file(newest.file);
			try {
				const current = await currentText(uri);
				const plan = planRevert(oldest, newest, current);
				if (plan.kind === 'skip') {
					skipped.push(basename(newest.file));
					continue;
				}
				if (plan.kind === 'write') {
					await writeText(uri, plan.text);
				} else if (plan.kind === 'delete') {
					await deleteFile(uri);
				}
				items.push({ file: newest.file, previous: current, restored: plan.kind === 'write' ? plan.text : undefined });
				await vscode.commands.executeCommand(DROP_REVIEW_COMMAND, uri.toString());
				ids.push(...tail.map((entry) => entry.id));
				if (tail.length < list.length) {
					partial.push(basename(newest.file));
				}
			} catch {
				skipped.push(basename(newest.file));
			}
		}
		if (ids.length > 0) {
			this.pushUndo({ items, ids });
			this.setStatus(ids, 'rejected');
		}
		return { done: groups.length - skipped.length, skipped, partial };
	}

	private report({ done, skipped, partial }: { done: number; skipped: string[]; partial: string[] }): void {
		if (done > 0) {
			const message = done === 1
				? '1 arquivo voltou a ser como era antes do Claude.'
				: `${done} arquivos voltaram a ser como eram antes do Claude.`;
			void vscode.window.showInformationMessage(message, 'Desfazer').then((choice) => {
				if (choice === 'Desfazer') {
					void this.undoReject();
				}
			});
		}
		if (skipped.length > 0) {
			const one = skipped.length === 1;
			void vscode.window.showWarningMessage(
				`${one ? '1 arquivo ficou' : `${skipped.length} arquivos ficaram`} como ${one ? 'está' : 'estão'} porque `
				+ `${one ? 'mudou' : 'mudaram'} depois do Claude ou não há cópia do conteúdo anterior: ${skipped.join(', ')}. `
				+ 'Use "Ver no código" para recusar trecho a trecho.',
			);
		}
		if (partial.length > 0) {
			void vscode.window.showWarningMessage(
				`Em ${partial.join(', ')} só recusei as últimas edições do Claude: o arquivo foi mudado entre elas e as `
				+ 'anteriores, e voltar mais apagaria essa mudança. As edições anteriores continuam pendentes.',
			);
		}
	}

	// ---- Estado ---------------------------------------------------------------------

	/** Edições pendentes agrupadas por arquivo, da mais recente para a mais antiga. */
	private pendingGroups(): RawEntry[][] {
		return groupByFile(this.entries.filter((entry) => !this.status.has(entry.id)));
	}

	private setupWebview(webview: vscode.Webview, wide: boolean): void {
		webview.options = { enableScripts: true, localResourceRoots: [this.mediaUri()] };
		webview.html = this.html(webview);
		webview.onDidReceiveMessage((message: Message) => this.handleMessage(message, webview, wide));
	}

	private async handleMessage(message: Message, webview: vscode.Webview, wide: boolean): Promise<void> {
		switch (message.command) {
			case 'ready':
				this.post(webview, wide);
				return;
			case 'refresh':
				await this.refresh();
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
				await this.acceptFile(message.key);
				return;
			case 'rejectFile':
				await this.rejectFile(message.key);
				return;
			case 'rejectRequest':
				await this.rejectRequest(message.request);
				return;
			case 'undoReject':
				await this.undoReject();
				return;
		}
	}

	private async compare(id: string | undefined): Promise<void> {
		const entry = this.entries.find((item) => item.id === id);
		if (!entry) {
			return;
		}
		const name = basename(entry.file);
		await vscode.commands.executeCommand('vscode.diff', changeUri(entry, 'antes'), changeUri(entry, 'depois'), `${name} (antes ↔ depois)`, {
			preview: true,
		});
	}

	private async openFile(id: string | undefined): Promise<void> {
		const entry = this.entries.find((item) => item.id === id);
		if (!entry) {
			return;
		}
		try {
			await vscode.window.showTextDocument(vscode.Uri.file(entry.file), { preview: true });
		} catch {
			void vscode.window.showWarningMessage(`O arquivo ${basename(entry.file)} não existe mais.`);
		}
	}

	private scheduleRefresh(): void {
		clearTimeout(this.refreshTimer);
		this.refreshTimer = setTimeout(() => {
			void this.refresh();
		}, 250);
	}

	private async refresh(): Promise<void> {
		// Uma gravação de status.json em andamento precisa terminar antes da leitura.
		await this.writeChain;
		this.entries = await this.loadEntries();
		this.enabled = await this.hooksEnabled();
		const live = new Set(this.entries.map((entry) => entry.id));
		for (const id of [...this.viewCache.keys()]) {
			if (!live.has(id)) {
				this.viewCache.delete(id);
			}
		}
		this.summaryCache.clear();
		this.publish();
		void this.fillMeta();
	}

	/** Espalha o estado atual: marcas no editor, painel, Explorer e barra de status. */
	private publish(): void {
		this.entriesEmitter.fire();
		if (this.view) {
			this.post(this.view.webview, false);
		}
		if (this.panel) {
			this.post(this.panel.webview, true);
		}

		const groups = this.pendingGroups();
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
			this.statusItem.tooltip = `${capitalize(countFiles(groups.length))} com mudanças do Claude para revisar`;
			this.statusItem.show();
		} else {
			this.statusItem.hide();
		}
		void vscode.commands.executeCommand('setContext', PENDING_CONTEXT, groups.length > 0);
	}

	private post(webview: vscode.Webview, wide: boolean): void {
		const pending = this.entries.filter((entry) => !this.status.has(entry.id));
		const history: ViewEntry[] = this.entries.slice(0, MAX_HISTORY).map((entry) => {
			const request = this.requestCache.get(entry.id);
			return {
				...this.viewOf(entry),
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
			entries: history,
			files: groupByFile(pending).map((list) => this.summaryOf(list)),
			canUndo: this.undoStack.length > 0,
		});
	}

	/** Diff e textos da edição, calculados uma vez só. */
	private viewOf(entry: RawEntry): BaseView {
		let view = this.viewCache.get(entry.id);
		if (!view) {
			view = toViewEntry(entry);
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
	private summaryOf(list: readonly RawEntry[]): FileSummary {
		const cacheKey = list.map((entry) => entry.id).join('|');
		const cached = this.summaryCache.get(cacheKey);
		if (cached) {
			return cached;
		}
		const newest = list[0];
		const oldest = list[list.length - 1];
		const view = this.viewOf(newest);
		const first = oldest.before;
		const last = newest.after;
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
		const summary: FileSummary = {
			id: newest.id,
			key: fileKey(newest.file),
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
		const all: RawEntry[] = [];
		const entryFolder = new Map<string, string>();
		const blobs = new Map<string, string>();
		const statusFiles: Array<{ folder: string; saved: Record<string, unknown> | undefined }> = [];
		const version = this.statusVersion;
		let migrate = false;
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			const uri = vscode.Uri.joinPath(folder.uri, ...LOG_PATH);
			let text = await readText(uri);
			if (text === undefined) {
				continue;
			}
			text = await this.rotate(folder.uri, uri, text);
			const folderKey = folder.uri.toString();
			const entries: RawEntry[] = [];
			for (const line of text.split('\n')) {
				if (!line.trim()) {
					continue;
				}
				try {
					const entry = JSON.parse(line) as RawEntry;
					if (entry && typeof entry.id === 'string' && typeof entry.file === 'string') {
						entries.push(entry);
						entryFolder.set(entry.id, folderKey);
					}
				} catch {
					// Linha incompleta: o hook pode estar escrevendo neste momento.
				}
			}
			await this.resolveBlobs(folder.uri, entries, blobs);
			all.push(...entries);

			const saved = await this.readState(vscode.Uri.joinPath(folder.uri, ...STATUS_PATH));
			statusFiles.push({ folder: folderKey, saved });
			migrate = migrate || (saved === undefined && entries.length > 0);
			this.applySavedMeta(await this.readState(vscode.Uri.joinPath(folder.uri, ...META_PATH)));
		}
		this.blobCache = blobs;
		this.entryFolder = entryFolder;

		// status.json é a fonte da verdade quando existe; sem ele, vale o que o
		// editor guardava (versões anteriores) e o arquivo é criado.
		if (version === this.statusVersion) {
			for (const { folder, saved } of statusFiles) {
				if (!saved) {
					continue;
				}
				for (const [id, owner] of entryFolder) {
					if (owner !== folder) {
						continue;
					}
					const value = saved[id];
					if (value === 'accepted' || value === 'rejected') {
						this.status.set(id, value);
					} else {
						this.status.delete(id);
					}
				}
			}
			this.saveStatusMemento();
		}
		if (migrate) {
			this.queueStateWrite();
		}

		all.sort((a, b) => b.time.localeCompare(a.time));
		return all;
	}

	/** Preenche o texto dos snapshots que o log guarda só como hash. */
	private async resolveBlobs(folder: vscode.Uri, entries: RawEntry[], blobs: Map<string, string>): Promise<void> {
		const wanted = new Set<string>();
		for (const entry of entries) {
			for (const snapshot of [entry.before, entry.after]) {
				if (snapshot && snapshot.text === null && isBlobHash(snapshot.hash) && !blobs.has(snapshot.hash)) {
					wanted.add(snapshot.hash);
				}
			}
		}
		await Promise.all([...wanted].map(async (hash) => {
			const text = this.blobCache.get(hash) ?? await readText(vscode.Uri.joinPath(folder, ...BLOB_DIR, `${hash}.txt`));
			if (text !== undefined) {
				blobs.set(hash, text);
			}
		}));
		const get = (hash: string) => blobs.get(hash);
		for (const entry of entries) {
			entry.before = resolveSnapshot(entry.before, get);
			entry.after = resolveSnapshot(entry.after, get);
		}
	}

	/** Mantém o log abaixo de MAX_LOG_ENTRIES, tirando as edições revisadas mais antigas. */
	private async rotate(folder: vscode.Uri, uri: vscode.Uri, text: string): Promise<string> {
		const kept = trimLog(text.split('\n'), MAX_LOG_ENTRIES, (id) => this.status.has(id));
		if (!kept) {
			return text;
		}
		try {
			// O hook pode ter acrescentado uma linha desde a leitura: ela é mantida.
			const again = await readText(uri);
			if (again === undefined || !again.startsWith(text)) {
				return text;
			}
			const next = `${kept.join('\n')}\n${again.slice(text.length)}`;
			await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(next));
			await this.collectBlobs(folder, next.split('\n'));
			return next;
		} catch {
			return text;
		}
	}

	/**
	 * Apaga os blobs que nenhuma linha do log nem nenhum "pre" em andamento
	 * cita. Blobs recentes ficam: o hook pode tê-los gravado agora há pouco.
	 */
	private async collectBlobs(folder: vscode.Uri, logLines: readonly string[]): Promise<void> {
		try {
			const now = Date.now();
			const keep = referencedBlobs(logLines);
			const pendingDir = vscode.Uri.joinPath(folder, ...PENDING_DIR);
			for (const [name] of await readDirectory(pendingDir)) {
				const uri = vscode.Uri.joinPath(pendingDir, name);
				if (await olderThan(uri, now, PENDING_MAX_AGE_MS)) {
					await vscode.workspace.fs.delete(uri).then(undefined, () => undefined);
					continue;
				}
				const text = await readText(uri);
				if (text !== undefined) {
					referencedBlobs([text]).forEach((hash) => keep.add(hash));
				}
			}
			const blobDir = vscode.Uri.joinPath(folder, ...BLOB_DIR);
			for (const [name] of await readDirectory(blobDir)) {
				const hash = name.slice(0, 40);
				if (keep.has(hash) && name === `${hash}.txt`) {
					continue;
				}
				const uri = vscode.Uri.joinPath(blobDir, name);
				if (await olderThan(uri, now, BLOB_GRACE_MS)) {
					await vscode.workspace.fs.delete(uri).then(undefined, () => undefined);
				}
			}
		} catch {
			// A limpeza fica para a próxima vez.
		}
	}

	/** Edições cuja explicação e pedido valem a pena buscar: as do histórico e as pendentes. */
	private metaTargets(): RawEntry[] {
		const shown = new Set(this.entries.slice(0, MAX_HISTORY).map((entry) => entry.id));
		return this.entries.filter((entry) => shown.has(entry.id) || !this.status.has(entry.id));
	}

	private hasMeta(entry: RawEntry): boolean {
		return (Boolean(entry.reason) || this.reasonCache.has(entry.id)) && this.requestCache.has(entry.id);
	}

	// O hook não lê o transcript (o Claude espera por ele, e o texto da edição
	// pode nem estar gravado ainda). Aqui a explicação e o pedido são buscados;
	// enquanto faltarem, tenta outra vez em alguns segundos, até
	// MAX_META_ATTEMPTS vezes por edição. O que for achado vai para meta.json.
	private async fillMeta(): Promise<void> {
		if (this.metaRunning) {
			this.metaAgain = true;
			return;
		}
		this.metaRunning = true;
		try {
			const byTranscript = new Map<string, RawEntry[]>();
			for (const entry of this.metaTargets()) {
				if (!entry.transcript || !entry.toolUseId || this.hasMeta(entry)) {
					continue;
				}
				if ((this.metaAttempts.get(entry.id) ?? 0) >= MAX_META_ATTEMPTS) {
					continue;
				}
				const list = byTranscript.get(entry.transcript) ?? [];
				list.push(entry);
				byTranscript.set(entry.transcript, list);
			}
			let found = false;
			let missing = false;
			for (const [transcript, list] of byTranscript) {
				const meta = await readTranscriptMeta(transcript);
				for (const entry of list) {
					const toolUseId = entry.toolUseId as string;
					const reason = meta.reasons.get(toolUseId);
					if (reason !== undefined && !this.reasonCache.has(entry.id)) {
						this.reasonCache.set(entry.id, reason);
						found = true;
					}
					const request = meta.requests.get(toolUseId);
					if (request && !this.requestCache.has(entry.id)) {
						this.requestCache.set(entry.id, request);
						found = true;
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
				this.publish();
			}
			if (missing) {
				clearTimeout(this.metaTimer);
				this.metaTimer = setTimeout(() => {
					void this.fillMeta();
				}, 3000);
			}
		} finally {
			this.metaRunning = false;
			if (this.metaAgain) {
				this.metaAgain = false;
				void this.fillMeta();
			}
		}
	}

	private applySavedMeta(saved: Record<string, unknown> | undefined): void {
		for (const [id, value] of Object.entries(saved ?? {})) {
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
		const text = await readText(uri);
		if (text === undefined) {
			return undefined;
		}
		this.stateText.set(uri.toString(), text);
		try {
			const parsed = JSON.parse(text);
			return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
		} catch {
			return {};
		}
	}

	/** Grava status.json e meta.json em seguida, juntando pedidos feitos enquanto uma gravação espera. */
	private queueStateWrite(): void {
		if (this.writeQueued) {
			return;
		}
		this.writeQueued = true;
		this.writeChain = this.writeChain
			.then(async () => {
				this.writeQueued = false;
				await this.writeStateFiles();
			})
			.catch(() => undefined);
	}

	private async writeStateFiles(): Promise<void> {
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			const folderKey = folder.uri.toString();
			const status: Record<string, Status> = {};
			const meta: Record<string, { reason: string | null; request: RequestInfo | null }> = {};
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
				const reason = this.reasonCache.get(id);
				const request = this.requestCache.get(id);
				if (reason !== undefined || request) {
					meta[id] = { reason: reason ?? null, request: request ?? null };
				}
			}
			if (count === 0) {
				continue;
			}
			await this.writeIfChanged(vscode.Uri.joinPath(folder.uri, ...STATUS_PATH), status);
			await this.writeIfChanged(vscode.Uri.joinPath(folder.uri, ...META_PATH), meta);
		}
	}

	private async writeIfChanged(uri: vscode.Uri, value: object): Promise<void> {
		const text = `${JSON.stringify(value)}\n`;
		if (this.stateText.get(uri.toString()) === text) {
			return;
		}
		try {
			await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
			this.stateText.set(uri.toString(), text);
		} catch {
			// Sem permissão de escrita: o estado do editor continua valendo.
		}
	}

	private saveStatusMemento(): void {
		while (this.status.size > MAX_STATUS) {
			this.status.delete(this.status.keys().next().value as string);
		}
		void this.context.workspaceState.update(STATUS_KEY, Object.fromEntries(this.status));
	}

	private pushUndo(undo: Undo): void {
		this.undoStack.push(undo);
		let size = this.undoStack.reduce((total, item) => total + undoSize(item), 0);
		while (this.undoStack.length > 1 && (this.undoStack.length > MAX_UNDO || size > MAX_UNDO_CHARS)) {
			size -= undoSize(this.undoStack.shift() as Undo);
		}
		this.saveUndo();
	}

	private saveUndo(): void {
		const fits = this.undoStack.reduce((total, item) => total + undoSize(item), 0) <= MAX_UNDO_CHARS;
		// Uma recusa enorme ainda pode ser desfeita nesta sessão, mas não é guardada.
		void this.context.workspaceState.update(UNDO_KEY, fits ? this.undoStack : []);
	}

	private async hooksEnabled(): Promise<boolean> {
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			const text = await readText(vscode.Uri.joinPath(folder.uri, ...SETTINGS_PATH));
			if (text?.includes(HOOK_FILE)) {
				return true;
			}
		}
		return false;
	}

	/** Copia o script do hook para dentro do projeto, numa pasta que o git ignora. */
	private async installHookScript(folder: vscode.WorkspaceFolder): Promise<void> {
		const dir = vscode.Uri.joinPath(folder.uri, ...LOG_DIR);
		await vscode.workspace.fs.createDirectory(dir);
		const ignore = vscode.Uri.joinPath(dir, '.gitignore');
		if ((await readText(ignore)) === undefined) {
			await vscode.workspace.fs.writeFile(ignore, new TextEncoder().encode('*\n'));
		}
		await vscode.workspace.fs.copy(
			vscode.Uri.joinPath(this.context.extensionUri, 'hooks', 'record-change.js'),
			this.scriptUri(folder),
			{ overwrite: true },
		);
	}

	private async writeHooks(folder: vscode.WorkspaceFolder, enable: boolean): Promise<void> {
		const uri = vscode.Uri.joinPath(folder.uri, ...SETTINGS_PATH);
		const text = await readText(uri);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		let settings: any = {};
		if (text !== undefined && text.trim()) {
			try {
				settings = JSON.parse(text);
			} catch {
				void vscode.window.showErrorMessage(
					`Não alterei ${uri.fsPath}: o arquivo não é um JSON válido. Corrija-o e tente de novo.`,
				);
				return;
			}
		}
		if (!enable && text === undefined) {
			return;
		}

		const script = this.scriptPath(folder);
		const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
		for (const [event, phase] of [['PreToolUse', 'pre'], ['PostToolUse', 'post']] as const) {
			const groups: unknown[] = Array.isArray(hooks[event]) ? hooks[event] : [];
			const kept = groups.filter((group) => !JSON.stringify(group).includes(HOOK_FILE));
			if (enable) {
				kept.push({
					matcher: MATCHER,
					hooks: [{ type: 'command', command: `node "${script}" ${phase}`, timeout: 10 }],
				});
			}
			if (kept.length > 0) {
				hooks[event] = kept;
			} else {
				delete hooks[event];
			}
		}
		if (Object.keys(hooks).length > 0) {
			settings.hooks = hooks;
		} else {
			delete settings.hooks;
		}

		await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, '.claude'));
		await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(`${JSON.stringify(settings, null, 2)}\n`));
	}

	private scriptUri(folder: vscode.WorkspaceFolder): vscode.Uri {
		return vscode.Uri.joinPath(folder.uri, ...LOG_DIR, HOOK_FILE);
	}

	private scriptPath(folder: vscode.WorkspaceFolder): string {
		return this.scriptUri(folder).fsPath.replace(/\\/g, '/');
	}

	private mediaUri(): vscode.Uri {
		return vscode.Uri.joinPath(this.context.extensionUri, 'media');
	}

	private html(webview: vscode.Webview): string {
		const nonce = createNonce();
		const script = webview.asWebviewUri(vscode.Uri.joinPath(this.mediaUri(), 'changes.js'));
		const style = webview.asWebviewUri(vscode.Uri.joinPath(this.mediaUri(), 'changes.css'));
		return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<link rel="stylesheet" href="${style}" />
	<title>Mudanças do Claude</title>
</head>
<body>
	<div id="root"><p class="muted">Carregando…</p></div>
	<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
	}
}

function loadStatus(memento: vscode.Memento): Map<string, Status> {
	const saved = memento.get<Record<string, Status>>(STATUS_KEY);
	if (saved && typeof saved === 'object') {
		return new Map(Object.entries(saved).filter(([, value]) => value === 'accepted' || value === 'rejected'));
	}
	// Versões anteriores guardavam só a lista de edições revisadas.
	const legacy = memento.get<string[]>(LEGACY_REVIEWED_KEY, []);
	return new Map(legacy.map((id) => [id, 'accepted' as Status]));
}

async function confirm(message: string, detail: string, action: string): Promise<boolean> {
	const answer = await vscode.window.showWarningMessage(message, { modal: true, detail }, action);
	return answer === action;
}

/** Texto atual do arquivo: o do editor, se estiver aberto, senão o do disco. */
async function currentText(uri: vscode.Uri): Promise<string | undefined> {
	const open = vscode.workspace.textDocuments.find((doc) => !doc.isClosed && doc.uri.toString() === uri.toString());
	return open ? open.getText() : readText(uri);
}

/** Grava o texto pelo editor quando o arquivo está aberto (fica no Ctrl+Z); senão, direto no disco. */
async function writeText(uri: vscode.Uri, text: string): Promise<void> {
	const open = vscode.workspace.textDocuments.find((doc) => !doc.isClosed && doc.uri.toString() === uri.toString());
	if (open) {
		const clean = normalizeEol(text);
		const content = open.eol === vscode.EndOfLine.CRLF ? clean.replace(/\n/g, '\r\n') : clean;
		const edit = new vscode.WorkspaceEdit();
		edit.replace(uri, open.validateRange(new vscode.Range(0, 0, open.lineCount, 0)), content);
		if (!(await vscode.workspace.applyEdit(edit))) {
			throw new Error('O editor recusou a edição.');
		}
		await open.save();
		return;
	}
	await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
	await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
}

async function deleteFile(uri: vscode.Uri): Promise<void> {
	try {
		await vscode.workspace.fs.delete(uri, { useTrash: true });
	} catch {
		await vscode.workspace.fs.delete(uri, { useTrash: false });
	}
}

function toViewEntry(entry: RawEntry): BaseView {
	const relative = vscode.workspace.asRelativePath(entry.file, false).replace(/\\/g, '/');
	const slash = relative.lastIndexOf('/');
	const before = entry.before;
	const after = entry.after;
	const created = before !== null && !before.exists && after?.exists === true;
	const deleted = after !== null && !after.exists;

	const base = {
		id: entry.id,
		time: entry.time,
		action: actionLabel(entry.tool, created),
		file: slash >= 0 ? relative.slice(slash + 1) : relative,
		dir: slash >= 0 ? relative.slice(0, slash) : '',
		summary: '',
		reason: entry.reason?.trim() || null,
		added: 0,
		removed: 0,
		modified: 0,
		hunks: [] as Hunk[],
		note: null as string | null,
		canCompare: false,
	};

	if (deleted) {
		return { ...base, summary: 'O arquivo não existe mais depois desta ação.' };
	}
	if (before?.large || after?.large) {
		return { ...base, summary: 'Arquivo grande demais (mais de 512 KB) para guardar o antes e o depois.' };
	}
	// Texto null num arquivo que existe: o blob dele sumiu (ou nunca foi guardado).
	if (before === null || after === null || after.text === null || (before.exists && before.text === null)) {
		return {
			...base,
			summary: 'Não foi possível capturar o conteúdo de antes desta edição.',
			note: 'Isso acontece quando o registro foi ativado no meio de uma conversa.',
		};
	}

	const diff: DiffResult = computeDiff(before.text ?? '', after.text);
	return {
		...base,
		summary: summarize(diff, created),
		added: diff.added,
		removed: diff.removed,
		modified: diff.modified,
		hunks: diff.hunks,
		canCompare: true,
		note: diff.clipped
			? 'Parte das linhas foi omitida aqui. Use "Lado a lado" para ver tudo.'
			: diff.approximate
				? 'Arquivo grande: as linhas foram comparadas em bloco. "Lado a lado" mostra o diff exato.'
				: null,
	};
}

interface FileSummary {
	/** Edição mais recente do arquivo: "Ver no código" parte dela. */
	id: string;
	/** Identifica o arquivo nas ações aceitar/recusar. */
	key: string;
	file: string;
	dir: string;
	added: number;
	removed: number;
	created: boolean;
	deleted: boolean;
}

type BaseView = Omit<ViewEntry, 'status' | 'requestId' | 'request'>;

function loadUndo(memento: vscode.Memento): Undo[] {
	const saved = memento.get<Undo[]>(UNDO_KEY, []);
	if (!Array.isArray(saved)) {
		return [];
	}
	return saved.filter((undo) => undo && Array.isArray(undo.items) && Array.isArray(undo.ids)).slice(-MAX_UNDO);
}

function undoSize(undo: Undo): number {
	return undo.items.reduce((total, item) => total + (item.previous?.length ?? 0) + (item.restored?.length ?? 0), 0);
}

async function readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
	try {
		return await vscode.workspace.fs.readDirectory(uri);
	} catch {
		return [];
	}
}

async function olderThan(uri: vscode.Uri, now: number, age: number): Promise<boolean> {
	try {
		return now - (await vscode.workspace.fs.stat(uri)).mtime > age;
	} catch {
		return false;
	}
}

function actionLabel(tool: string | null | undefined, created: boolean): string {
	if (created) {
		return 'Criou';
	}
	switch (tool) {
		case 'Write':
			return 'Reescreveu';
		case 'MultiEdit':
			return 'Editou em várias partes';
		case 'NotebookEdit':
			return 'Editou notebook';
		default:
			return 'Editou';
	}
}

function summarize(diff: DiffResult, created: boolean): string {
	if (created) {
		return `Arquivo novo, com ${plural(diff.added, 'linha', 'linhas')}.`;
	}
	if (diff.hunks.length === 0) {
		return 'O conteúdo ficou igual: nenhuma linha mudou.';
	}
	const parts: string[] = [];
	if (diff.modified > 0) {
		parts.push(`${plural(diff.modified, 'linha modificada', 'linhas modificadas')}`);
	}
	if (diff.added > 0) {
		parts.push(`${plural(diff.added, 'linha nova', 'linhas novas')}`);
	}
	if (diff.removed > 0) {
		parts.push(`${plural(diff.removed, 'linha removida', 'linhas removidas')}`);
	}
	const where = diff.hunks.length === 1 ? 'em 1 trecho' : `em ${diff.hunks.length} trechos`;
	return `${joinPt(parts)}, ${where} do arquivo.`;
}

function countFiles(count: number): string {
	return plural(count, 'arquivo', 'arquivos');
}

function plural(count: number, one: string, many: string): string {
	return `${count} ${count === 1 ? one : many}`;
}

function joinPt(parts: string[]): string {
	if (parts.length <= 1) {
		return capitalize(parts[0] ?? '');
	}
	return capitalize(`${parts.slice(0, -1).join(', ')} e ${parts[parts.length - 1]}`);
}

function capitalize(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

function basename(file: string): string {
	const parts = file.split(/[\\/]/);
	return parts[parts.length - 1] || file;
}

async function readText(uri: vscode.Uri): Promise<string | undefined> {
	try {
		return new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri));
	} catch {
		return undefined;
	}
}

function createNonce(): string {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let nonce = '';
	for (let index = 0; index < 32; index += 1) {
		nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
	}
	return nonce;
}
