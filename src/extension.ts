import * as vscode from 'vscode';
import { registerChanges } from './changes';
import { registerInline } from './inline';
import { listSessions, sessionsDir } from './sessions';

const CLAUDE_EXTENSION_ID = 'anthropic.claude-code';
const SIDEBAR_COMMAND = 'claude-vscode.sidebar.open';
const TAB_COMMAND = 'claude-vscode.editor.open';
const TAB_URI = 'vscode://anthropic.claude-code/open';

type OpenTarget = 'sidebar' | 'tab';

class LauncherViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewId = 'claude-code-launcher.home';

	private view: vscode.WebviewView | undefined;
	private refreshTimer: unknown;

	constructor(private readonly context: vscode.ExtensionContext) {}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
		webviewView.webview.options = { enableScripts: true, localResourceRoots: [media] };
		webviewView.webview.html = this.html(webviewView.webview, media);
		webviewView.onDidChangeVisibility(() => {
			if (webviewView.visible) {
				this.postState();
			}
		});
		webviewView.onDidDispose(() => {
			this.view = undefined;
		});

		webviewView.webview.onDidReceiveMessage(async (message: { command?: string; key?: string; id?: string }) => {
			switch (message.command) {
				case 'openSidebar':
					await openClaude('sidebar');
					break;
				case 'newTab':
					await openClaude('tab');
					break;
				case 'openSession':
					await openSession(message.id);
					break;
				case 'focusTab':
					await focusClaudeTab(message.key);
					break;
				case 'closeTab':
					await closeClaudeTab(message.key);
					break;
				case 'install':
					await installClaude();
					break;
			}
			this.postState();
		});
	}

	/** Atualiza a view, agrupando chamadas seguidas (o transcript muda a cada mensagem). */
	refresh(delay = 300): void {
		clearTimeout(this.refreshTimer);
		this.refreshTimer = setTimeout(() => this.postState(), delay);
	}

	private postState(): void {
		if (!this.view?.visible) {
			return;
		}
		const folders = localFolders();
		const openTabs = claudeTabs().map(({ tab, key }) => ({ key, label: tab.label, active: tab.isActive }));
		const openLabels = new Set(openTabs.map((tab) => tab.label));
		// Com várias pastas abertas, junta as conversas de todas.
		const sessions = folders
			.flatMap((folder) => listSessions(folder, RECENT_SESSIONS))
			.sort((a, b) => b.updated - a.updated)
			.slice(0, RECENT_SESSIONS)
			.map((session) => ({ ...session, open: openLabels.has(session.title) }));
		void this.view.webview.postMessage({
			type: 'state',
			installed: isClaudeInstalled(),
			hasFolder: folders.length > 0,
			openTabs,
			sessions,
		});
	}

	private html(webview: vscode.Webview, media: vscode.Uri): string {
		const nonce = createNonce();
		const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'home.js'));
		const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'home.css'));
		return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<link rel="stylesheet" href="${style}" />
	<title>Claude Code</title>
</head>
<body>
	<div id="root"><p class="muted">Carregando…</p></div>
	<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
	}
}

const RECENT_SESSIONS = 15;

function claudeTabs(): Array<{ tab: vscode.Tab; key: string }> {
	const result: Array<{ tab: vscode.Tab; key: string }> = [];
	for (const group of vscode.window.tabGroups.all) {
		group.tabs.forEach((tab, index) => {
			if (isClaudeTab(tab)) {
				result.push({ tab, key: `${group.viewColumn}:${index}:${tab.label}` });
			}
		});
	}
	return result;
}

async function focusClaudeTab(key: string | undefined): Promise<void> {
	const found = claudeTabs().find((item) => item.key === key);
	if (!found) {
		return;
	}
	const group = found.tab.group;
	await focusGroup(group.viewColumn);
	await vscode.commands.executeCommand('workbench.action.openEditorAtIndex', group.tabs.indexOf(found.tab));
}

async function closeClaudeTab(key: string | undefined): Promise<void> {
	const found = claudeTabs().find((item) => item.key === key);
	if (found) {
		await vscode.window.tabGroups.close(found.tab);
	}
}

async function openSession(id: string | undefined): Promise<void> {
	if (!id) {
		return;
	}
	await openClaudeTab(id);
}

/** Abre uma aba de conversa: nova, ou retomando a conversa `sessionId`. */
async function openClaudeTab(sessionId?: string): Promise<void> {
	try {
		await vscode.commands.executeCommand(TAB_COMMAND, sessionId);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!/not found/i.test(message)) {
			throw error;
		}
		const query = sessionId ? `?session=${encodeURIComponent(sessionId)}` : '';
		await vscode.env.openExternal(vscode.Uri.parse(`${TAB_URI}${query}`));
	}
	await waitForClaudeTab();
	await keepClaudeGroupFreeOfFiles();
	provider?.refresh(0);
}

let provider: LauncherViewProvider | undefined;

export function activate(context: vscode.ExtensionContext): void {
	provider = new LauncherViewProvider(context);
	registerInline(context, registerChanges(context));
	watchSessions(context);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(LauncherViewProvider.viewId, provider),
		vscode.commands.registerCommand('claude-code-launcher.openSidebar', () => openClaude('sidebar')),
		vscode.commands.registerCommand('claude-code-launcher.openTab', () => openClaude('tab')),
		vscode.commands.registerCommand('claude-code-launcher.install', () => installClaude()),
		vscode.extensions.onDidChange(() => provider?.refresh()),
		vscode.commands.registerCommand('claude-code-launcher.newTab', () => openClaude('tab')),
		vscode.window.tabGroups.onDidChangeTabs(() => provider?.refresh()),
		vscode.window.tabGroups.onDidChangeTabGroups(() => provider?.refresh()),
		vscode.window.tabGroups.onDidChangeTabs((event) => {
			if (isolatingClaudeGroup) {
				return;
			}
			const structureChanged = event.opened.length > 0 || event.closed.length > 0;
			if (!structureChanged) {
				return;
			}
			if (event.opened.some(isClaudeTab) || claudeGroupHasFileTab()) {
				void keepClaudeGroupFreeOfFiles();
			}
		}),
	);

	void keepNewSessionsInTabs();
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('claudeCode.preferredLocation')) {
				void keepNewSessionsInTabs();
			}
		}),
	);

	if (vscode.window.tabGroups.all.some((group) => group.tabs.some(isClaudeTab))) {
		void keepClaudeGroupFreeOfFiles();
	}

	const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusItem.name = 'Claude Code';
	statusItem.text = '$(comment-discussion) Claude';
	statusItem.tooltip = 'Abrir o chat do Claude Code';
	statusItem.command = 'claude-code-launcher.openSidebar';
	statusItem.show();
	context.subscriptions.push(statusItem);
}

export function deactivate(): void {}

function isClaudeInstalled(): boolean {
	return Boolean(vscode.extensions.getExtension(CLAUDE_EXTENSION_ID));
}

async function openClaude(target: OpenTarget): Promise<void> {
	if (!isClaudeInstalled()) {
		const installed = await promptInstall();
		if (!installed) {
			return;
		}
	}

	const extension = vscode.extensions.getExtension(CLAUDE_EXTENSION_ID);
	if (!extension) {
		return;
	}

	if (!extension.isActive) {
		await extension.activate();
	}

	if (target === 'sidebar') {
		await openClaudeSidebar();
		return;
	}

	try {
		await openClaudeTab();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		void vscode.window.showErrorMessage(`Não foi possível abrir o Claude Code: ${message}`);
	}
}

// A barra lateral é uma view, não um grupo de editor: nela não entram abas de arquivo.
// Por isso este caminho nunca abre o chat como aba, nem como fallback.
const SIDEBAR_FALLBACKS = [
	SIDEBAR_COMMAND,
	'claudeVSCodeSidebarSecondary.focus',
	'workbench.view.extension.claude-sidebar-secondary',
	'claudeVSCodeSidebar.focus',
];

async function openClaudeSidebar(): Promise<void> {
	let lastError = '';
	for (const command of SIDEBAR_FALLBACKS) {
		try {
			await vscode.commands.executeCommand(command);
			await keepNewSessionsInTabs();
			return;
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
	}

	void vscode.window.showErrorMessage(
		`Não foi possível abrir o Claude Code na barra lateral (${lastError}). `
		+ 'Verifique se a barra lateral secundária está habilitada (View > Appearance > Secondary Side Bar).',
	);
}

/**
 * O botão "new session" do Claude abre a conversa em `claudeCode.preferredLocation`.
 * Com "sidebar", o Cursor a mostra na view do Claude dentro do Explorer. A extensão
 * oficial grava "sidebar" sozinha quando o chat é aberto na lateral, então o valor
 * volta para "panel" (nova aba) sempre que mudar.
 */
async function keepNewSessionsInTabs(): Promise<void> {
	const config = vscode.workspace.getConfiguration('claudeCode');
	const inspected = config.inspect<string>('preferredLocation');
	const targets: Array<[string | undefined, vscode.ConfigurationTarget]> = [
		[inspected?.globalValue, vscode.ConfigurationTarget.Global],
		[inspected?.workspaceValue, vscode.ConfigurationTarget.Workspace],
	];
	for (const [value, target] of targets) {
		if (value !== undefined && value !== 'panel') {
			await config.update('preferredLocation', 'panel', target);
		}
	}
}

async function promptInstall(): Promise<boolean> {
	const choice = await vscode.window.showInformationMessage(
		'O chat do Claude Code vem da extensão oficial da Anthropic.',
		'Instalar',
		'Ver na loja',
	);
	if (choice === 'Instalar') {
		return installClaude();
	}
	if (choice === 'Ver na loja') {
		await vscode.commands.executeCommand('workbench.extensions.search', CLAUDE_EXTENSION_ID);
	}
	return false;
}

async function installClaude(): Promise<boolean> {
	try {
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'Instalando Claude Code…',
			},
			async () => {
				await vscode.commands.executeCommand(
					'workbench.extensions.installExtension',
					CLAUDE_EXTENSION_ID,
				);
			},
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const choice = await vscode.window.showErrorMessage(
			`Não foi possível instalar o Claude Code: ${message}`,
			'Ver na loja',
		);
		if (choice === 'Ver na loja') {
			await vscode.commands.executeCommand('workbench.extensions.search', CLAUDE_EXTENSION_ID);
		}
		return false;
	}

	const extension = await waitForExtension();
	provider?.refresh();
	if (!extension) {
		void vscode.window.showInformationMessage(
			'Claude Code foi solicitado. Se o chat não abrir, recarregue a janela e use o botão de novo.',
		);
		return false;
	}
	return true;
}

async function waitForExtension(): Promise<vscode.Extension<unknown> | undefined> {
	const timeoutAt = Date.now() + 8000;
	while (Date.now() < timeoutAt) {
		const extension = vscode.extensions.getExtension(CLAUDE_EXTENSION_ID);
		if (extension) {
			return extension;
		}
		await delay(200);
	}
	return undefined;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

let isolatingClaudeGroup = false;

function isClaudeTab(tab: vscode.Tab): boolean {
	return tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes('claudeVSCodePanel');
}

function canMoveTab(tab: vscode.Tab): boolean {
	const input = tab.input;
	return input instanceof vscode.TabInputText
		|| input instanceof vscode.TabInputTextDiff
		|| input instanceof vscode.TabInputNotebook
		|| input instanceof vscode.TabInputNotebookDiff
		|| input instanceof vscode.TabInputCustom;
}

function claudeGroupHasFileTab(): boolean {
	return vscode.window.tabGroups.all.some((group) =>
		group.tabs.some(isClaudeTab) && group.tabs.some((tab) => !isClaudeTab(tab) && canMoveTab(tab)),
	);
}

async function waitForClaudeTab(): Promise<void> {
	const timeoutAt = Date.now() + 4000;
	while (Date.now() < timeoutAt) {
		if (vscode.window.tabGroups.all.some((group) => group.tabs.some(isClaudeTab))) {
			return;
		}
		await delay(100);
	}
}

async function keepClaudeGroupFreeOfFiles(): Promise<void> {
	if (isolatingClaudeGroup) {
		return;
	}
	isolatingClaudeGroup = true;
	try {
		await ensureClaudeLocksGroups();
		const columns = vscode.window.tabGroups.all
			.filter((group) => group.tabs.some(isClaudeTab))
			.map((group) => group.viewColumn);

		for (const column of columns) {
			await ejectFileTabs(column);
			await lockGroup(column);
			await rememberAutoLock(column);
		}
	} finally {
		isolatingClaudeGroup = false;
	}
}

async function ejectFileTabs(column: vscode.ViewColumn): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		const group = groupByColumn(column);
		const intruder = group?.tabs.find((tab) => !isClaudeTab(tab) && canMoveTab(tab));
		if (!group || !intruder) {
			return;
		}
		await focusGroup(column);
		await revealTab(intruder);
		await moveActiveEditorOut(column);
		await delay(50);
	}
}

async function revealTab(tab: vscode.Tab): Promise<void> {
	const column = tab.group.viewColumn;
	const input = tab.input;
	if (
		input instanceof vscode.TabInputText
		|| input instanceof vscode.TabInputNotebook
		|| input instanceof vscode.TabInputCustom
	) {
		await vscode.commands.executeCommand('vscode.open', input.uri, {
			viewColumn: column,
			preview: false,
			preserveFocus: false,
		});
		return;
	}
	if (input instanceof vscode.TabInputTextDiff || input instanceof vscode.TabInputNotebookDiff) {
		await vscode.commands.executeCommand('vscode.diff', input.original, input.modified, tab.label, {
			viewColumn: column,
			preview: false,
		});
	}
}

async function moveActiveEditorOut(column: vscode.ViewColumn): Promise<void> {
	const command = column === vscode.ViewColumn.One
		? 'workbench.action.moveEditorToNextGroup'
		: 'workbench.action.moveEditorToFirstGroup';
	try {
		await vscode.commands.executeCommand(command);
	} catch {
		await vscode.commands.executeCommand('workbench.action.moveEditorToPreviousGroup');
	}
}

async function lockGroup(column: vscode.ViewColumn): Promise<void> {
	const group = groupByColumn(column);
	if (!group?.tabs.some(isClaudeTab)) {
		return;
	}
	await focusGroup(column);
	try {
		await vscode.commands.executeCommand('workbench.action.lockEditorGroup');
	} catch {
		// O grupo já estava travado.
	}
}

async function focusGroup(column: vscode.ViewColumn): Promise<void> {
	const commands: Partial<Record<number, string>> = {
		1: 'workbench.action.focusFirstEditorGroup',
		2: 'workbench.action.focusSecondEditorGroup',
		3: 'workbench.action.focusThirdEditorGroup',
		4: 'workbench.action.focusFourthEditorGroup',
		5: 'workbench.action.focusFifthEditorGroup',
		6: 'workbench.action.focusSixthEditorGroup',
		7: 'workbench.action.focusSeventhEditorGroup',
		8: 'workbench.action.focusEighthEditorGroup',
	};
	await vscode.commands.executeCommand(commands[column] ?? 'workbench.action.focusLastEditorGroup');
}

function groupByColumn(column: vscode.ViewColumn): vscode.TabGroup | undefined {
	return vscode.window.tabGroups.all.find((group) => group.viewColumn === column);
}

async function ensureClaudeLocksGroups(): Promise<void> {
	const config = vscode.workspace.getConfiguration('claudeCode');
	if (config.inspect<boolean>('lockEditorGroups')?.globalValue === false) {
		await config.update('lockEditorGroups', true, vscode.ConfigurationTarget.Global);
	}
}

async function rememberAutoLock(column: vscode.ViewColumn): Promise<void> {
	const viewType = groupByColumn(column)?.tabs.find(isClaudeTab)?.input;
	if (!(viewType instanceof vscode.TabInputWebview)) {
		return;
	}
	const config = vscode.workspace.getConfiguration('workbench');
	const inspected = config.inspect<Record<string, boolean>>('editor.autoLockGroups');
	const current = inspected?.globalValue ?? {};
	const keys = [viewType.viewType, `mainThreadWebview-${viewType.viewType}`];
	if (keys.every((key) => current[key] === true)) {
		return;
	}
	const next = { ...current };
	for (const key of keys) {
		next[key] = true;
	}
	await config.update('editor.autoLockGroups', next, vscode.ConfigurationTarget.Global);
}

function createNonce(): string {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let nonce = '';
	for (let index = 0; index < 32; index += 1) {
		nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
	}
	return nonce;
}

/** Pastas do workspace no disco local (as conversas do Claude Code ficam indexadas por esse caminho). */
function localFolders(): string[] {
	return (vscode.workspace.workspaceFolders ?? [])
		.filter((folder) => folder.uri.scheme === 'file')
		.map((folder) => folder.uri.fsPath);
}

/** Observa as conversas de cada pasta aberta e refaz os observadores quando as pastas mudam. */
function watchSessions(context: vscode.ExtensionContext): void {
	let watchers: vscode.Disposable[] = [];
	const refresh = () => provider?.refresh(1500);
	const setup = () => {
		watchers.forEach((watcher) => watcher.dispose());
		watchers = [];
		for (const folder of localFolders()) {
			const pattern = new vscode.RelativePattern(vscode.Uri.file(sessionsDir(folder)), '*.jsonl');
			const watcher = vscode.workspace.createFileSystemWatcher(pattern);
			watchers.push(watcher, watcher.onDidCreate(refresh), watcher.onDidChange(refresh), watcher.onDidDelete(refresh));
		}
	};
	setup();
	context.subscriptions.push(
		vscode.workspace.onDidChangeWorkspaceFolders(() => {
			setup();
			provider?.refresh(0);
		}),
		{ dispose: () => watchers.forEach((watcher) => watcher.dispose()) },
	);
}
