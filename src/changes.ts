import * as vscode from 'vscode';
import { computeDiff, DiffResult, Hunk } from './diff';
import { findReasonInTranscript } from './sessions';

const HOOK_FILE = 'launcher-record-change.js';
const LOG_PATH = ['.claude', 'launcher-changes', 'log.jsonl'];
const SETTINGS_PATH = ['.claude', 'settings.local.json'];
const MATCHER = 'Edit|Write|MultiEdit|NotebookEdit';
const SCHEME = 'claude-launcher-change';

export function changeUri(entry: RawEntry, side: 'antes' | 'depois'): vscode.Uri {
	return vscode.Uri.from({ scheme: SCHEME, path: `/${entry.id}/${side}/${basename(entry.file)}` });
}
const MAX_ENTRIES = 60;
const MAX_REASON_ATTEMPTS = 10;

export interface Snapshot {
	exists: boolean;
	text: string | null;
	large: boolean;
}

export interface RawEntry {
	id: string;
	time: string;
	tool?: string | null;
	file: string;
	before: Snapshot | null;
	after: Snapshot | null;
	reason?: string | null;
	transcript?: string | null;
	toolUseId?: string | null;
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
}

type Message = { command?: string; id?: string };

export function registerChanges(context: vscode.ExtensionContext): ChangesController {
	const controller = new ChangesController(context);
	context.subscriptions.push(
		controller,
		vscode.window.registerWebviewViewProvider(ChangesController.viewId, controller),
		vscode.workspace.registerTextDocumentContentProvider(SCHEME, controller),
		vscode.commands.registerCommand('claude-code-launcher.showChanges', () => controller.openPanel()),
		vscode.commands.registerCommand('claude-code-launcher.enableChangeLog', () => controller.setEnabled(true)),
		vscode.commands.registerCommand('claude-code-launcher.disableChangeLog', () => controller.setEnabled(false)),
		vscode.commands.registerCommand('claude-code-launcher.clearChanges', () => controller.clear()),
	);
	void controller.installHookScript();
	return controller;
}

export class ChangesController implements vscode.WebviewViewProvider, vscode.TextDocumentContentProvider, vscode.Disposable {
	public static readonly viewId = 'claude-code-launcher.changes';

	private entries: RawEntry[] = [];
	private enabled = false;
	private view: vscode.WebviewView | undefined;
	private panel: vscode.WebviewPanel | undefined;
	private refreshTimer: unknown;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly reasonCache = new Map<string, string>();
	private readonly reasonAttempts = new Map<string, number>();
	private reasonTimer: unknown;
	private readonly entriesEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeEntries = this.entriesEmitter.event;

	constructor(private readonly context: vscode.ExtensionContext) {
		const watcher = vscode.workspace.createFileSystemWatcher('**/.claude/{launcher-changes/log.jsonl,settings.local.json}');
		const schedule = () => this.scheduleRefresh();
		this.disposables.push(
			this.entriesEmitter,
			watcher,
			watcher.onDidCreate(schedule),
			watcher.onDidChange(schedule),
			watcher.onDidDelete(schedule),
			vscode.workspace.onDidChangeWorkspaceFolders(schedule),
		);
		this.scheduleRefresh();
	}

	dispose(): void {
		clearTimeout(this.refreshTimer);
		this.disposables.forEach((disposable) => disposable.dispose());
	}

	getEntries(): readonly RawEntry[] {
		return this.entries;
	}

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

	async installHookScript(): Promise<void> {
		const target = this.hookScriptUri();
		await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
		await vscode.workspace.fs.copy(
			vscode.Uri.joinPath(this.context.extensionUri, 'hooks', 'record-change.js'),
			target,
			{ overwrite: true },
		);
	}

	async setEnabled(enable: boolean): Promise<void> {
		const folders = vscode.workspace.workspaceFolders ?? [];
		if (folders.length === 0) {
			void vscode.window.showWarningMessage('Abra uma pasta de projeto para registrar as mudanças do Claude.');
			return;
		}
		await this.installHookScript();
		const script = this.hookScriptUri().fsPath.replace(/\\/g, '/');
		for (const folder of folders) {
			await this.writeHooks(folder, script, enable);
		}
		await this.refresh();
		if (enable) {
			void vscode.window.showInformationMessage(
				'Registro de mudanças ativado. Ele vale para conversas do Claude Code iniciadas a partir de agora.',
			);
		}
	}

	async clear(): Promise<void> {
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			try {
				await vscode.workspace.fs.delete(vscode.Uri.joinPath(folder.uri, ...LOG_PATH));
			} catch {
				// Nada registrado nesta pasta.
			}
		}
		await this.refresh();
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
		}
	}

	/** Mantém tudo como o Claude deixou: tira as marcas do código e esvazia a lista. */
	private async acceptEverything(): Promise<void> {
		const files = groupByFile(this.entries);
		if (files.length === 0) {
			return;
		}
		for (const list of files) {
			await vscode.commands.executeCommand('claude-code-launcher.acceptAllChanges', vscode.Uri.file(list[0].file).toString());
		}
		await this.removeEntries(new Set(files.flat().map((entry) => entry.id)));
		void vscode.window.showInformationMessage(
			files.length === 1 ? 'Mudanças do Claude aceitas em 1 arquivo.' : `Mudanças do Claude aceitas em ${files.length} arquivos.`,
		);
	}

	/**
	 * Volta cada arquivo para como estava antes das edições do Claude: restaura o
	 * texto anterior e apaga os arquivos que ele criou. Arquivos que mudaram
	 * depois da última edição do Claude ficam como estão.
	 */
	private async rejectEverything(): Promise<void> {
		const files = groupByFile(this.entries);
		if (files.length === 0) {
			return;
		}
		const label = files.length === 1 ? '1 arquivo' : `${files.length} arquivos`;
		const confirm = 'Recusar todas';
		const answer = await vscode.window.showWarningMessage(
			`Recusar as mudanças do Claude em ${label}?`,
			{ modal: true, detail: 'Cada arquivo volta a ser como era antes do Claude editar. Arquivos que ele criou vão para a lixeira.' },
			confirm,
		);
		if (answer !== confirm) {
			return;
		}

		const done = new Set<string>();
		const skipped: string[] = [];
		for (const list of files) {
			// `entries` vem da mais recente para a mais antiga.
			const newest = list[0];
			const oldest = list[list.length - 1];
			let reverted = false;
			try {
				reverted = await this.revertFile(newest, oldest);
			} catch {
				reverted = false;
			}
			if (reverted) {
				list.forEach((entry) => done.add(entry.id));
			} else {
				skipped.push(basename(newest.file));
			}
		}
		await this.removeEntries(done);

		if (skipped.length > 0) {
			const one = skipped.length === 1;
			void vscode.window.showWarningMessage(
				`${one ? '1 arquivo ficou' : `${skipped.length} arquivos ficaram`} como ${one ? 'está' : 'estão'} porque `
				+ `${one ? 'mudou' : 'mudaram'} depois do Claude ou não há cópia do conteúdo anterior: ${skipped.join(', ')}. `
				+ 'Use "Ver mudança no código" para recusar trecho a trecho.',
			);
		}
	}

	private async revertFile(newest: RawEntry, oldest: RawEntry): Promise<boolean> {
		const before = oldest.before;
		const after = newest.after;
		if (!before || !after || before.large || after.large || (before.exists && before.text === null)) {
			return false;
		}
		const uri = vscode.Uri.file(newest.file);
		const open = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === uri.toString());
		const current = open ? open.getText() : await readText(uri);

		// Só mexe se o arquivo ainda está exatamente como o Claude deixou.
		const untouched = after.exists
			? current !== undefined && normalize(current) === normalize(after.text ?? '')
			: current === undefined;
		if (!untouched) {
			return false;
		}

		if (!before.exists) {
			await vscode.workspace.fs.delete(uri, { useTrash: true });
			return true;
		}

		const text = normalize(before.text ?? '');
		if (open) {
			const content = open.eol === vscode.EndOfLine.CRLF ? text.replace(/\n/g, '\r\n') : text;
			const edit = new vscode.WorkspaceEdit();
			edit.replace(uri, open.validateRange(new vscode.Range(0, 0, open.lineCount, 0)), content);
			if (!(await vscode.workspace.applyEdit(edit))) {
				return false;
			}
			await open.save();
		} else {
			await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(before.text ?? ''));
		}
		await vscode.commands.executeCommand('claude-code-launcher.acceptAllChanges', uri.toString());
		return true;
	}

	/** Tira do registro as edições indicadas, mantendo as demais. */
	private async removeEntries(ids: Set<string>): Promise<void> {
		if (ids.size > 0) {
			for (const folder of vscode.workspace.workspaceFolders ?? []) {
				const uri = vscode.Uri.joinPath(folder.uri, ...LOG_PATH);
				const text = await readText(uri);
				if (text === undefined) {
					continue;
				}
				const kept = text.split('\n').filter((line) => {
					if (!line.trim()) {
						return false;
					}
					try {
						return !ids.has((JSON.parse(line) as RawEntry).id);
					} catch {
						return true;
					}
				});
				if (kept.length === 0) {
					await vscode.workspace.fs.delete(uri);
				} else {
					await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(kept.join('\n') + '\n'));
				}
			}
		}
		await this.refresh();
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

	// O hook roda antes de o Claude Code gravar o texto da edição no transcript.
	// Aqui a explicação é buscada de novo; enquanto faltar, tenta outra vez em
	// alguns segundos, até MAX_REASON_ATTEMPTS vezes por edição.
	private fillReasons(entries: RawEntry[]): void {
		let missing = false;
		for (const entry of entries) {
			if (entry.reason || !entry.transcript || !entry.toolUseId) {
				continue;
			}
			const cached = this.reasonCache.get(entry.id);
			if (cached !== undefined) {
				entry.reason = cached;
				continue;
			}
			const reason = findReasonInTranscript(entry.transcript, entry.toolUseId);
			if (reason !== null) {
				this.reasonCache.set(entry.id, reason);
				entry.reason = reason;
				continue;
			}
			const attempts = (this.reasonAttempts.get(entry.id) ?? 0) + 1;
			this.reasonAttempts.set(entry.id, attempts);
			if (attempts < MAX_REASON_ATTEMPTS) {
				missing = true;
			}
		}
		if (missing) {
			clearTimeout(this.reasonTimer);
			this.reasonTimer = setTimeout(() => {
				void this.refresh();
			}, 3000);
		}
	}

	private async refresh(): Promise<void> {
		this.entries = await this.loadEntries();
		this.enabled = await this.hooksEnabled();
		this.entriesEmitter.fire();
		if (this.view) {
			this.post(this.view.webview, false);
		}
		if (this.panel) {
			this.post(this.panel.webview, true);
		}
	}

	private post(webview: vscode.Webview, wide: boolean): void {
		void webview.postMessage({
			type: 'state',
			wide,
			hasFolder: (vscode.workspace.workspaceFolders ?? []).length > 0,
			enabled: this.enabled,
			entries: this.entries.map(toViewEntry),
			files: summarizeFiles(this.entries),
		});
	}

	private async loadEntries(): Promise<RawEntry[]> {
		const all: RawEntry[] = [];
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			const text = await readText(vscode.Uri.joinPath(folder.uri, ...LOG_PATH));
			if (text === undefined) {
				continue;
			}
			for (const line of text.split('\n')) {
				if (!line.trim()) {
					continue;
				}
				try {
					const entry = JSON.parse(line) as RawEntry;
					if (entry && typeof entry.id === 'string' && typeof entry.file === 'string') {
						all.push(entry);
					}
				} catch {
					// Linha incompleta: o hook pode estar escrevendo neste momento.
				}
			}
		}
		all.sort((a, b) => b.time.localeCompare(a.time));
		const recent = all.slice(0, MAX_ENTRIES);
		this.fillReasons(recent);
		return recent;
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

	private async writeHooks(folder: vscode.WorkspaceFolder, script: string, enable: boolean): Promise<void> {
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

	private hookScriptUri(): vscode.Uri {
		return vscode.Uri.joinPath(this.context.globalStorageUri, HOOK_FILE);
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

function toViewEntry(entry: RawEntry): ViewEntry {
	const relative = vscode.workspace.asRelativePath(entry.file, false).replace(/\\/g, '/');
	const slash = relative.lastIndexOf('/');
	const before = entry.before;
	const after = entry.after;
	const created = before !== null && !before.exists && after?.exists === true;
	const deleted = after !== null && !after.exists;

	const base: ViewEntry = {
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
		hunks: [],
		note: null,
		canCompare: false,
	};

	if (deleted) {
		return { ...base, summary: 'O arquivo não existe mais depois desta ação.' };
	}
	if (before?.large || after?.large) {
		return { ...base, summary: 'Arquivo grande demais (mais de 512 KB) para guardar o antes e o depois.' };
	}
	if (before === null || after === null || after.text === null) {
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
	file: string;
	dir: string;
	added: number;
	removed: number;
	created: boolean;
	deleted: boolean;
}

/** Agrupa as edições por arquivo, mantendo a ordem (da mais recente para a mais antiga). */
function groupByFile(entries: readonly RawEntry[]): RawEntry[][] {
	const byFile = new Map<string, RawEntry[]>();
	for (const entry of entries) {
		const key = entry.file.replace(/\\/g, '/').toLowerCase();
		const list = byFile.get(key) ?? [];
		list.push(entry);
		byFile.set(key, list);
	}
	return [...byFile.values()];
}

function normalize(text: string): string {
	return text.replace(/\r\n/g, '\n');
}

/**
 * Uma linha por arquivo, como a lista "N Files" do Cursor. Compara o conteúdo de
 * antes da primeira edição registrada com o de depois da última; quando falta
 * algum desses textos, soma os números de cada edição.
 */
function summarizeFiles(entries: readonly RawEntry[]): FileSummary[] {
	const result: FileSummary[] = [];
	for (const list of groupByFile(entries)) {
		// `entries` vem da mais recente para a mais antiga.
		const newest = list[0];
		const oldest = list[list.length - 1];
		const view = toViewEntry(newest);
		const first = oldest.before;
		const last = newest.after;
		let added = 0;
		let removed = 0;
		if (first && last && !first.large && !last.large && last.text !== null) {
			const diff = computeDiff(first.text ?? '', last.text);
			added = diff.added + diff.modified;
			removed = diff.removed + diff.modified;
		} else {
			for (const entry of list.map(toViewEntry)) {
				added += entry.added + entry.modified;
				removed += entry.removed + entry.modified;
			}
		}
		result.push({
			id: newest.id,
			file: view.file,
			dir: view.dir,
			added,
			removed,
			created: first !== null && !first.exists,
			deleted: last !== null && !last.exists,
		});
	}
	return result;
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
