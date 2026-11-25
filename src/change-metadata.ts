// Explicação e pedido de cada edição, buscados no transcript depois que o hook a gravou.
//
// O hook não lê o transcript (o Claude espera por ele, e o texto da edição pode nem estar gravado
// ainda). Aqui a explicação e o pedido são buscados; enquanto faltarem, tenta outra vez em alguns
// segundos, até MAX_META_ATTEMPTS vezes por edição. O que for achado fica em `pendingMetadata` até
// o controlador gravar meta.json, e cada leitura e gravação confere de novo a política de privacidade.

import * as vscode from 'vscode';
import * as nodeFs from 'node:fs';
import type { RawEntry } from './logic';
import { readTranscriptMeta, RequestInfo, sessionsDir, findTurnToolUse } from './sessions';
import { makeCapturePolicy, transcriptAllowed, validateSavedMeta } from './history';
import { evaluateMetadataPolicy, revalidateMetadataPermit, MetadataPermit, MetadataPolicyContext } from './metadata-policy';
import { excludedPatterns, MAX_HISTORY } from './changes-view';
import { canonicalResource } from './changes-support';
import type { CapturePolicy } from './history';

const MAX_META_ATTEMPTS = 10;
const MAX_COMMAND_TOOL_USES = 3000;
/** Chamadas de ferramenta lidas de um transcript por vez. */
const MAX_TOOL_USES_PER_READ = 256;
const RETRY_MS = 3000;

/** O que o controlador conhece e esta busca consulta. */
export interface MetadataHost {
	/** Todas as edições, da mais recente para a mais antiga. */
	entries(): readonly RawEntry[];
	/** A edição já foi aceita ou recusada. */
	isDecided(id: string): boolean;
	/** Pasta do workspace (uri) de cujo log veio a edição. */
	folderKeyOf(id: string): string | undefined;
	storeWritable(folderKey: string): boolean;
	readPurgeState(folder: vscode.WorkspaceFolder): Promise<string | undefined>;
	readCapturePolicy(folder: vscode.WorkspaceFolder): Promise<CapturePolicy | undefined>;
	disposed(): boolean;
	inMaintenance(): boolean;
	/** Muda quando pastas, configuração ou dados mudam: resultados de uma época antiga são descartados. */
	epoch(): number;
	/** Pede ao controlador para gravar meta.json com o que está em `pendingMetadata`. */
	queueStateWrite(): void;
}

export interface PendingMetadata { reason?: string; request?: RequestInfo; permits: MetadataPermit[]; epoch: number }

export class ChangeMetadata {
	readonly reasonCache = new Map<string, string>();
	readonly requestCache = new Map<string, RequestInfo>();
	readonly pendingMetadata = new Map<string, PendingMetadata>();
	/** Chamada de ferramenta do transcript associada a cada mudança por comando, para achar pedido e explicação. */
	readonly commandToolUses = new Map<string, string>();
	private readonly attempts = new Map<string, number>();
	private timer: ReturnType<typeof setTimeout> | undefined;
	private running = false;
	private again = false;

	constructor(private readonly host: MetadataHost) {}

	/** Itens guardados em memória, para o inventário da limpeza completa. */
	get size(): number {
		return this.reasonCache.size + this.requestCache.size + this.commandToolUses.size + this.pendingMetadata.size;
	}

	clear(): void {
		this.reasonCache.clear(); this.requestCache.clear(); this.commandToolUses.clear(); this.attempts.clear(); this.pendingMetadata.clear();
	}

	dispose(): void { clearTimeout(this.timer); }

	/** Explicação e pedido já gravados em meta.json. */
	applySaved(saved: Record<string, unknown> | undefined): void {
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

	/** As permissões da política ainda valem para esta edição, nesta época. */
	async permitsCurrent(entry: RawEntry, permits: readonly MetadataPermit[], epoch: number): Promise<boolean> {
		if (this.stopped() || epoch !== this.host.epoch()) { return false; }
		const contexts = await this.policyContexts(entry);
		return !this.stopped() && epoch === this.host.epoch() && contexts?.length === permits.length
			&& contexts.every((context, index) => revalidateMetadataPermit(permits[index], context).allowed);
	}

	async fill(): Promise<void> {
		if (this.stopped()) { return; }
		if (this.running) {
			this.again = true;
			return;
		}
		this.running = true;
		const epoch = this.host.epoch();
		try {
			const byTranscript = new Map<string, RawEntry[]>();
			const permissions = new Map<string, MetadataPermit[]>();
			const roots = (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === 'file').map((folder) => sessionsDir(folder.uri.fsPath));
			for (const entry of this.targets()) {
				if (!entry.transcript || this.has(entry) || !(await transcriptAllowed(entry.transcript, roots))) {
					continue;
				}
				if (!(await this.toolUseIdFor(entry))) {
					continue;
				}
				if ((this.attempts.get(entry.id) ?? 0) >= MAX_META_ATTEMPTS) {
					continue;
				}
				const permits = await this.permits(entry);
				if (!permits || !(await this.permitsCurrent(entry, permits, epoch))) { continue; }
				permissions.set(entry.id, permits);
				const list = byTranscript.get(entry.transcript) ?? [];
				list.push(entry);
				byTranscript.set(entry.transcript, list);
			}
			let found = false;
			let missing = false;
			for (const [transcript, list] of byTranscript) {
				const permitted: RawEntry[] = [];
				for (const entry of list) { const permits = permissions.get(entry.id); if (permits && await this.permitsCurrent(entry, permits, epoch)) { permitted.push(entry); } }
				if (!permitted.length) { continue; }
				if (permitted.length > MAX_TOOL_USES_PER_READ) { missing = true; }
				const selected = permitted.slice(0, MAX_TOOL_USES_PER_READ);
				const meta = await readTranscriptMeta(transcript, { toolUseIds: [...new Set(selected.map((entry) => this.toolUseOf(entry) as string))], cache: false });
				if (epoch !== this.host.epoch() || this.stopped()) { return; }
				for (const entry of selected) {
					const permits = permissions.get(entry.id)!;
					if (!(await this.permitsCurrent(entry, permits, epoch))) { continue; }
					const toolUseId = this.toolUseOf(entry) as string;
					const reason = meta.reasons.get(toolUseId);
					const request = meta.requests.get(toolUseId);
					if (reason !== undefined && !this.reasonCache.has(entry.id) || request && !this.requestCache.has(entry.id)) {
						this.pendingMetadata.set(entry.id, { reason: this.reasonCache.has(entry.id) ? undefined : reason,
							request: this.requestCache.has(entry.id) ? undefined : request, permits, epoch }); found = true;
					}
					if (!this.has(entry)) {
						const attempts = (this.attempts.get(entry.id) ?? 0) + 1;
						this.attempts.set(entry.id, attempts);
						missing = missing || attempts < MAX_META_ATTEMPTS;
					}
				}
			}
			if (found) {
				this.host.queueStateWrite();
			}
			if (missing) {
				clearTimeout(this.timer);
				this.timer = setTimeout(() => {
					void this.fill();
				}, RETRY_MS);
			}
		} finally {
			this.running = false;
			if (this.again && !this.stopped()) {
				this.again = false;
				void this.fill();
			}
		}
	}

	private stopped(): boolean { return this.host.disposed() || this.host.inMaintenance(); }

	/** Edições cuja explicação e pedido valem a pena buscar: as do histórico e as pendentes. */
	private targets(): RawEntry[] {
		const entries = this.host.entries();
		const shown = new Set(entries.slice(0, MAX_HISTORY).map((entry) => entry.id));
		return entries.filter((entry) => shown.has(entry.id) || !this.host.isDecided(entry.id));
	}

	private has(entry: RawEntry): boolean {
		const pending = this.pendingMetadata.get(entry.id);
		return (Boolean(entry.reason) || this.reasonCache.has(entry.id) || Boolean(pending?.reason)) && (this.requestCache.has(entry.id) || Boolean(pending?.request));
	}

	private async policyContexts(entry: RawEntry): Promise<MetadataPolicyContext[] | undefined> {
		try {
			const folder = vscode.workspace.workspaceFolders?.find((candidate) => candidate.uri.toString() === this.host.folderKeyOf(entry.id))
				?? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(entry.file));
			if (!folder || folder.uri.scheme !== 'file' || !this.host.storeWritable(folder.uri.toString()) || await this.host.readPurgeState(folder)) { return undefined; }
			const root = await nodeFs.promises.realpath(folder.uri.fsPath), file = await canonicalResource(entry.file, folder.uri.fsPath);
			if (!file) { return undefined; }
			const diskPolicy = await this.host.readCapturePolicy(folder);
			const config = vscode.workspace.getConfiguration('claudeCodeLauncher');
			// Absence has the same recognized legacy default as capture; an invalid
			// or unreadable policy above never falls back to that default.
			const legacy = diskPolicy ?? makeCapturePolicy({ generation: 'legacy-default' });
			const settings = makeCapturePolicy({ generation: 'metadata-settings', excludedPatterns: excludedPatterns(config),
				maxStorageMB: config.get<number>('historyMaxStorageMB', 128), retentionDays: config.get<number>('historyRetentionDays', 30) });
			return [legacy, settings].map((policy) => ({ policy, canonicalRoot: root, canonicalFile: file, scopeVerified: true }));
		} catch { return undefined; }
	}

	private async permits(entry: RawEntry): Promise<MetadataPermit[] | undefined> {
		const contexts = await this.policyContexts(entry); if (!contexts) { return undefined; }
		const permits: MetadataPermit[] = [];
		for (const context of contexts) { const decision = evaluateMetadataPolicy(context); if (!decision.allowed) { return undefined; } permits.push(decision.permit); }
		return permits;
	}

	private toolUseOf(entry: RawEntry): string | undefined {
		return entry.toolUseId || this.commandToolUses.get(entry.id);
	}

	/**
	 * Mudanças por comando (captura do turno) não têm chamada de ferramenta própria: o pedido e a
	 * explicação vêm da última chamada (de preferência de terminal) do mesmo turno no transcript.
	 */
	private async toolUseIdFor(entry: RawEntry): Promise<string | undefined> {
		const known = this.toolUseOf(entry);
		if (known || entry.tool !== 'Command' || !entry.transcript) { return known; }
		const found = await findTurnToolUse(entry.transcript, entry.time);
		if (found) {
			this.commandToolUses.set(entry.id, found);
			if (this.commandToolUses.size > MAX_COMMAND_TOOL_USES) { this.commandToolUses.delete(this.commandToolUses.keys().next().value as string); }
		}
		return found;
	}
}
