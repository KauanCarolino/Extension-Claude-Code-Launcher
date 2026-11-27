import { registerCatalogs, type Catalogs } from './catalog-view';
import { registerSkills } from './skills-view';
import { OrchestraController } from './orchestra-view';
import * as vscode from 'vscode';
import { ChangesController, registerChanges } from './changes';
import { registerInline } from './inline';
import { listSessionsAsync, sessionsDir, type SessionInfo } from './sessions';
import { matchChatSessions, sessionsForTabLabel } from './logic';
import { ManagedPreference, PreferenceManager } from './preferences';
import { validateMessage } from './history';
import { configureLanguage, htmlLanguage, resolveLanguage, t, webviewDictionaryScript } from './i18n';

import { randomBytes } from 'crypto';

const CLAUDE_EXTENSION_ID = 'anthropic.claude-code';
const SIDEBAR_COMMAND = 'claude-vscode.sidebar.open';
const TAB_COMMAND = 'claude-vscode.editor.open';

type OpenTarget = 'sidebar' | 'tab';

class LauncherViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	public static readonly viewId = 'claude-code-launcher.home';

	private view: vscode.WebviewView | undefined;
	private refreshTimer: ReturnType<typeof setTimeout> | undefined;
	private generation = 0;
	private disposed = false;
	private viewSubscriptions: vscode.Disposable[] = [];

	constructor(private readonly context: vscode.ExtensionContext) {}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		if (this.disposed) { return; }
		this.viewSubscriptions.splice(0).forEach((item) => item.dispose());
		this.view = webviewView;
		const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
		webviewView.webview.options = { enableScripts: true, localResourceRoots: [media] };
		webviewView.webview.html = this.html(webviewView.webview, media);
		this.viewSubscriptions.push(webviewView.onDidChangeVisibility(() => {
			if (webviewView.visible) {
				void this.postState();
			}
		}), webviewView.onDidDispose(() => {
			if (this.view === webviewView) {
				this.view = undefined; this.generation += 1;
				this.viewSubscriptions.splice(0).forEach((item) => item.dispose());
			}
		}));

		this.viewSubscriptions.push(webviewView.webview.onDidReceiveMessage(async (value: unknown) => {
			const message = validateMessage(value, 'home');
			if (!message || this.disposed || this.view !== webviewView) { return; }
			try {
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
					case 'showPanel':
						await catalogs?.showPanel(message.key);
						return;
					case 'skills.refresh': case 'skills.open': case 'skills.reveal':
					case 'skills.toggle': case 'skills.delete': case 'skills.create':
						await skills?.handle(message.command, message.id, message.key);
						return;
					default:
						if (message.command.startsWith('orchestra.')) {
							await orchestra?.handle(message.command, message.id, message.key, message.text);
							return;
						}
						if (/^(rules|agents|mcp|permissions|hooks)\./.test(message.command)) {
							await catalogs?.handle(message.command, message.id, message.key);
							return;
						}
				}
			} catch (error) { reportLaunchError(error); }
			void this.postState();
		}));
		void this.postState();
	}

	/** Atualiza a view, agrupando chamadas seguidas (o transcript muda a cada mensagem). */
	refresh(delay = 300): void {
		if (this.disposed) { return; }
		this.generation += 1;
		clearTimeout(this.refreshTimer);
		this.refreshTimer = setTimeout(() => { void this.postState(); }, delay);
	}

	dispose(): void {
		this.disposed = true; this.generation += 1; clearTimeout(this.refreshTimer); this.view = undefined;
		this.viewSubscriptions.splice(0).forEach((item) => item.dispose());
	}

	/** Mensagem avulsa para a página (usada pelas abas de skills, regras, agentes e MCP). */
	postRaw(message: unknown): Thenable<boolean> | undefined {
		return this.disposed ? undefined : this.view?.webview.postMessage(message);
	}

	private async postState(): Promise<void> {
		if (this.disposed || !this.view?.visible) {
			return;
		}
		const folders = localFolders();
		const openTabs = claudeTabs().map(({ tab, key }) => ({ key, label: tab.label, active: tab.isActive }));
		// Com várias pastas abertas, junta as conversas de todas.
		const generation = ++this.generation;
		const view = this.view;
		const cancelled = () => this.disposed || this.generation !== generation || this.view !== view;
		const results = await Promise.allSettled(folders.map((folder) => listSessionsAsync(folder, RECENT_SESSIONS, cancelled)));
		const listings = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
		if (cancelled() || !view) { return; }
		const recent = listings.flatMap((listing) => listing.sessions)
			.sort((a, b) => b.updated - a.updated)
			.slice(0, RECENT_SESSIONS);
		const openIds = new Set(openTabs.flatMap((tab) => sessionsForTabLabel(tab.label, recent)));
		const sessions = recent.map(({ aliases: _aliases, ...session }) => ({ ...session, open: openIds.has(session.id) }));
		void view.webview.postMessage({
			coverageMessage: results.some((result) => result.status === 'rejected')
				? t('Lista parcial: não foi possível ler as conversas de uma das pastas.')
				: listings.some((listing) => listing.partial) ? t('Lista parcial: o orçamento de leitura foi atingido. As conversas mais antigas podem não aparecer.') : null,
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
		const skillsScript = webview.asWebviewUri(vscode.Uri.joinPath(media, 'skills.js'));
		const catalogScript = webview.asWebviewUri(vscode.Uri.joinPath(media, 'catalog.js'));
		const skillsStyle = webview.asWebviewUri(vscode.Uri.joinPath(media, 'skills.css'));
		const orchestraScript = webview.asWebviewUri(vscode.Uri.joinPath(media, 'orchestra.js'));
		const orchestraStyle = webview.asWebviewUri(vscode.Uri.joinPath(media, 'orchestra.css'));
		const base = webview.asWebviewUri(vscode.Uri.joinPath(media, 'base.css'));
		const codicons = webview.asWebviewUri(vscode.Uri.joinPath(media, 'codicons', 'codicon.css'));
		const l10n = webview.asWebviewUri(vscode.Uri.joinPath(media, 'l10n.js'));
		return `<!DOCTYPE html>
<html lang="${htmlLanguage()}">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<link rel="stylesheet" href="${codicons}" />
	<link rel="stylesheet" href="${base}" />
	<link rel="stylesheet" href="${style}" />
	<link rel="stylesheet" href="${skillsStyle}" />
	<link rel="stylesheet" href="${orchestraStyle}" />
	<title>Claude Code</title>
</head>
<body>
	<div id="root"><p class="loading muted"><span class="codicon codicon-loading codicon-modifier-spin"></span> ${t('Carregando…')}</p></div>
	${webviewDictionaryScript()}
	<script nonce="${nonce}" src="${l10n}"></script>
	<script nonce="${nonce}" src="${skillsScript}"></script>
	<script nonce="${nonce}" src="${catalogScript}"></script>
	<script nonce="${nonce}" src="${orchestraScript}"></script>
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
	await openClaude('tab', id);
}

/** Abre uma aba de conversa: nova, ou retomando a conversa `sessionId`. */
async function openClaudeTab(sessionId?: string): Promise<void> {
	const previous = new Map(claudeTabs().map(({ tab }) => [tab, { active: tab.isActive, label: tab.label }]));
	const commands = await vscode.commands.getCommands(true);
	if (commands.includes(TAB_COMMAND)) {
		await bounded(vscode.commands.executeCommand(TAB_COMMAND, sessionId), 10000, 'commandTimeout');
	} else {
		const scheme = vscode.env.uriScheme;
		if (!/^[a-z][a-z0-9+.-]*$/i.test(scheme)) { throw new LaunchError('unsupportedUri'); }
		const query = sessionId ? `?session=${encodeURIComponent(sessionId)}` : '';
		const opened = await bounded(vscode.env.openExternal(vscode.Uri.parse(`${scheme}://anthropic.claude-code/open${query}`)), 10000, 'commandTimeout');
		if (!opened) { throw new LaunchError('uriDenied'); }
	}
	await waitForClaudeTab(previous);
	await keepClaudeGroupFreeOfFiles();
	provider?.refresh(0);
}

let provider: LauncherViewProvider | undefined;
let skills: ReturnType<typeof registerSkills> | undefined;
let catalogs: Catalogs | undefined;
let orchestra: OrchestraController | undefined;
let changes: ChangesController | undefined;
let preferenceManager: PreferenceManager | undefined;
const PREFERENCE_KEY = 'claudeCodeLauncher.managedPreferences.v1';

export function activate(context: vscode.ExtensionContext): void {
	applyLanguage(context);
	const scope = vscode.workspace.workspaceFile?.toString() ?? (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.toString()).join('|');
	preferenceManager = new PreferenceManager({
		load: () => context.globalState.get<ManagedPreference[]>(PREFERENCE_KEY, []),
		persist: async (records) => { await context.globalState.update(PREFERENCE_KEY, records); },
		read: (section, key, target) => {
			const inspected = vscode.workspace.getConfiguration(section).inspect<unknown>(key);
			return target === 'global' ? inspected?.globalValue : inspected?.workspaceValue;
		},
		write: async (section, key, value, target) => { await vscode.workspace.getConfiguration(section).update(key, value,
			target === 'global' ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace); },
	}, scope);
	provider = new LauncherViewProvider(context);
	changes = registerChanges(context);
	registerInline(context, changes);
	scheduleActiveChat(1000);
	skills = registerSkills(context, (message) => { void provider?.postRaw(message); });
	orchestra = new OrchestraController(context, (message) => { void provider?.postRaw(message); });
	context.subscriptions.push(orchestra);
	catalogs = registerCatalogs(context, (message) => { void provider?.postRaw(message); }, (panel) => {
		if (!orchestra) { return; }
		const wasActive = orchestra.active;
		orchestra.active = panel === 'orchestra';
		if (orchestra.active && !wasActive) { void orchestra.refresh(); }
	});
	watchSessions(context);

	context.subscriptions.push(
		provider,
		vscode.window.registerWebviewViewProvider(LauncherViewProvider.viewId, provider),
		vscode.commands.registerCommand('claude-code-launcher.openSidebar', () => openClaude('sidebar')),
		vscode.commands.registerCommand('claude-code-launcher.openTab', () => openClaude('tab')),
		vscode.commands.registerCommand('claude-code-launcher.install', () => installClaude()),
		vscode.commands.registerCommand('claude-code-launcher.openWalkthrough', () => vscode.commands.executeCommand('workbench.action.openWalkthrough', `${context.extension.id}#gettingStarted`, false)),
		vscode.extensions.onDidChange(() => provider?.refresh()),
		vscode.commands.registerCommand('claude-code-launcher.newTab', () => openClaude('tab')),
		vscode.commands.registerCommand('claude-code-launcher.refreshSessions', () => provider?.refresh(0)),
		vscode.window.tabGroups.onDidChangeTabGroups(() => { provider?.refresh(); scheduleActiveChat(); }),
		vscode.window.tabGroups.onDidChangeTabs((event) => {
			provider?.refresh(); scheduleActiveChat();
			if (isolatingClaudeGroup) {
				return;
			}
			const structureChanged = event.opened.length > 0 || event.closed.length > 0;
			if (!structureChanged) {
				return;
			}
			if (event.opened.some(isClaudeTab) || claudeGroupHasFileTab()) {
				void keepClaudeGroupFreeOfFiles().catch(reportLaunchError);
			}
		}),
	);

	void configureManagement();
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('claudeCodeLauncher.manageEditorGroups')) { void configureManagement(); }
			if (event.affectsConfiguration('claudeCode.preferredLocation')) {
				void keepNewSessionsInTabs().catch(reportLaunchError);
			}
		}),
	);

	if (vscode.window.tabGroups.all.some((group) => group.tabs.some(isClaudeTab))) {
		void keepClaudeGroupFreeOfFiles().catch(reportLaunchError);
	}

	const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusItem.name = 'Launcher for Claude Code';
	statusItem.text = '$(comment-discussion) Claude';
	statusItem.tooltip = t('Abrir o chat do Claude Code');
	statusItem.command = 'claude-code-launcher.openSidebar';
	const showStatusItem = () => {
		if (vscode.workspace.getConfiguration('claudeCodeLauncher').get<boolean>('showStatusBarItem', true)) { statusItem.show(); } else { statusItem.hide(); }
	};
	showStatusItem();
	context.subscriptions.push(statusItem, vscode.workspace.onDidChangeConfiguration((event) => {
		if (event.affectsConfiguration('claudeCodeLauncher.showStatusBarItem')) { showStatusItem(); }
	}));
}

/**
 * O editor só aguarda o que `deactivate` devolve; descartes assíncronos em `subscriptions` não são
 * esperados. A posse da revisão (review-writer.lock) é liberada no fim do descarte do controlador:
 * sem esta espera, a próxima janela poderia abrir a revisão só para leitura.
 */
export function deactivate(): Promise<void> | undefined {
	clearTimeout(chatTimer); provider?.dispose(); provider = undefined; skills = undefined; catalogs = undefined;
	const controller = changes; changes = undefined;
	if (!controller) { return undefined; }
	controller.dispose();
	return controller.whenDisposed();
}

/**
 * Idioma da interface: `claudeCodeLauncher.language`, ou o do editor com "auto". As páginas das views
 * recebem o dicionário ao serem criadas, por isso a troca pede para recarregar a janela.
 */
function applyLanguage(context: vscode.ExtensionContext): void {
	const preference = () => vscode.workspace.getConfiguration('claudeCodeLauncher').get<string>('language', 'auto');
	configureLanguage(resolveLanguage(vscode.env?.language, preference()), context.extensionPath);
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
		if (!event.affectsConfiguration('claudeCodeLauncher.language')) { return; }
		configureLanguage(resolveLanguage(vscode.env?.language, preference()), context.extensionPath);
		const reload = t('Recarregar janela');
		void vscode.window.showInformationMessage(t('O novo idioma vale por completo depois de recarregar a janela.'), reload).then((choice) => {
			if (choice === reload) { void vscode.commands.executeCommand('workbench.action.reloadWindow'); }
		});
	}));
}

function isClaudeInstalled(): boolean {
	return Boolean(vscode.extensions.getExtension(CLAUDE_EXTENSION_ID));
}

async function openClaude(target: OpenTarget, sessionId?: string): Promise<void> {
	try {
		if (!isClaudeInstalled()) {
			const installed = await promptInstall();
			if (!installed) {
				return;
			}
		}

		const extension = vscode.extensions.getExtension(CLAUDE_EXTENSION_ID);
		if (!extension) {
			throw new LaunchError('missingExtension');
		}

		if (!extension.isActive) {
			await bounded(extension.activate(), 10000, 'activationTimeout');
		}

		if (target === 'sidebar') {
			await openClaudeSidebar();
			return;
		}

		await openClaudeTab(sessionId);
	} catch (error) {
		reportLaunchError(error);
	}
}

// A barra lateral é uma view, não um grupo de editor: nela não entram abas de arquivo.
// Por isso este caminho só abre o chat como aba quando a "barra lateral" seria o Explorer.
const SIDEBAR_FALLBACKS = [
	SIDEBAR_COMMAND,
	'claudeVSCodeSidebarSecondary.focus',
	'workbench.view.extension.claude-sidebar-secondary',
	'claudeVSCodeSidebar.focus',
];

/**
 * O Cursor recusa contêineres em `secondarySidebar`, e o editor põe no Explorer as views de um
 * contêiner que não existe. A extensão oficial usa a view `claudeVSCodeSidebarSecondary` a partir
 * da API 1.106, então nesse editor "abrir na barra lateral" mistura o chat às views do Explorer.
 * Sinal: a view está registrada, mas o comando do contêiner dela não.
 */
function sidebarLandsInExplorer(available: ReadonlySet<string>): boolean {
	const [major = 0, minor = 0] = vscode.version.split('.').map(Number);
	const officialUsesSecondary = major > 1 || major === 1 && minor >= 106;
	return officialUsesSecondary && available.has('claudeVSCodeSidebarSecondary.focus')
		&& !available.has('workbench.view.extension.claude-sidebar-secondary');
}

/** Sem barra lateral própria, mostra a aba de chat já aberta (a ativa no grupo, se houver) ou abre uma. */
async function showClaudeTab(): Promise<void> {
	const open = claudeTabs();
	const current = open.find(({ tab }) => tab.isActive) ?? open[0];
	if (current) {
		await focusClaudeTab(current.key);
		return;
	}
	await openClaudeTab();
}

async function openClaudeSidebar(): Promise<void> {
	const available = new Set(await vscode.commands.getCommands(true));
	// `claude-vscode.sidebar.open` também grava `claudeCode.preferredLocation: "sidebar"`, e o botão
	// "✻ Claude Code" da oficial passaria a abrir no Explorer. Nesse caso o chat fica em aba.
	if (sidebarLandsInExplorer(available)) {
		await showClaudeTab();
		return;
	}
	for (const command of SIDEBAR_FALLBACKS) {
		if (available.has(command)) {
			await bounded(vscode.commands.executeCommand(command), 10000, 'commandTimeout');
			await keepNewSessionsInTabs();
			return;
		}
	}
	throw new LaunchError('sidebarUnavailable');
}

class LaunchError extends Error { constructor(readonly code: string) { super(code); } }
async function bounded<T>(work: Thenable<T>, milliseconds: number, code: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([Promise.resolve(work), new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new LaunchError(code)), milliseconds);
		})]);
	} finally { clearTimeout(timer); }
}
function reportLaunchError(error: unknown): void {
	const text = error instanceof Error ? error.message : String(error);
	const explanations: Record<string, string> = {
		missingExtension: t('A extensão oficial não está disponível nesta janela. Instale-a ou recarregue a janela.'),
		activationTimeout: t('A extensão oficial não terminou de iniciar no prazo. Consulte a saída do Claude Code antes de tentar novamente.'),
		commandTimeout: t('O comando não respondeu no prazo. Ele ainda pode concluir; confira o Claude Code antes de repetir a abertura.'),
		tabTimeout: t('O comando foi enviado, mas não confirmei uma aba nova ou ativada. Confira a aba existente, o login e a saída do Claude Code.'),
		uriDenied: t('O editor não aceitou a abertura do endereço do Claude Code.'),
		unsupportedUri: t('Este editor não informou um protocolo de abertura compatível.'),
		sidebarUnavailable: t('Esta versão da extensão oficial não disponibilizou um comando conhecido para a barra lateral.'),
	};
	const detail = error instanceof LaunchError ? explanations[error.code]
		: /auth|login|sign.?in|unauthori[sz]ed|401/i.test(text)
			? t('A extensão oficial solicitou autenticação. Faça login no Claude Code e tente novamente.')
			: t('A extensão oficial não concluiu a abertura. Consulte o canal de saída do Claude Code para os detalhes.');
	void vscode.window.showErrorMessage(t('Não foi possível confirmar a abertura do Claude Code. {0}', detail));
}

/**
 * O botão "new session" do Claude abre a conversa em `claudeCode.preferredLocation`.
 * Com "sidebar", o Cursor a mostra na view do Claude dentro do Explorer. A extensão
 * oficial grava "sidebar" sozinha quando o chat é aberto na lateral, então o valor
 * volta para "panel" (nova aba) sempre que mudar.
 */
async function keepNewSessionsInTabs(): Promise<void> {
	if (!manageEditorGroups()) { return; }
	const config = vscode.workspace.getConfiguration('claudeCode');
	const inspected = config.inspect<string>('preferredLocation');
	const targets: Array<[string | undefined, vscode.ConfigurationTarget]> = [
		[inspected?.globalValue, vscode.ConfigurationTarget.Global],
		[inspected?.workspaceValue, vscode.ConfigurationTarget.Workspace],
	];
	for (const [value, target] of targets) {
		if (value !== undefined) {
			await preferenceManager?.set('claudeCode', 'preferredLocation', 'panel', target === vscode.ConfigurationTarget.Global ? 'global' : 'workspace');
		}
	}
}

async function promptInstall(): Promise<boolean> {
	const install = t('Instalar'), store = t('Ver na loja');
	const choice = await vscode.window.showInformationMessage(t('O chat do Claude Code vem da extensão oficial da Anthropic.'), install, store);
	if (choice === install) {
		return installClaude();
	}
	if (choice === store) {
		await vscode.commands.executeCommand('workbench.extensions.search', CLAUDE_EXTENSION_ID);
	}
	return false;
}

async function installClaude(): Promise<boolean> {
	try {
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: t('Instalando Claude Code…'),
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
		const store = t('Ver na loja');
		const choice = await vscode.window.showErrorMessage(t('Não foi possível instalar o Claude Code: {0}', message), store);
		if (choice === store) {
			await vscode.commands.executeCommand('workbench.extensions.search', CLAUDE_EXTENSION_ID);
		}
		return false;
	}

	const extension = await waitForExtension();
	provider?.refresh();
	if (!extension) {
		void vscode.window.showInformationMessage(
			t('Claude Code foi solicitado. Se o chat não abrir, recarregue a janela e use o botão de novo.'),
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

async function waitForClaudeTab(previous: Map<vscode.Tab, { active: boolean; label: string }>): Promise<void> {
	const timeoutAt = Date.now() + 4000;
	while (Date.now() < timeoutAt) {
		if (claudeTabs().some(({ tab }) => {
			const before = previous.get(tab);
			return !before || before.label !== tab.label || !before.active && tab.isActive;
		})) {
			return;
		}
		await delay(100);
	}
	throw new LaunchError('tabTimeout');
}

async function keepClaudeGroupFreeOfFiles(): Promise<void> {
	if (!manageEditorGroups()) { return; }
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
	if (config.inspect<boolean>('lockEditorGroups')?.globalValue !== undefined) {
		await preferenceManager?.set('claudeCode', 'lockEditorGroups', true, 'global');
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
	const next = { ...current };
	for (const key of keys) {
		next[key] = true;
	}
	await preferenceManager?.set('workbench', 'editor.autoLockGroups', next, 'global');
}

function manageEditorGroups(): boolean { return vscode.workspace.getConfiguration('claudeCodeLauncher').get<boolean>('manageEditorGroups', false); }
async function configureManagement(): Promise<void> {
	try {
		if (!manageEditorGroups()) { await preferenceManager?.restore(); return; }
		await keepNewSessionsInTabs();
		await keepClaudeGroupFreeOfFiles();
	} catch { void vscode.window.showWarningMessage(t('Não foi possível atualizar as preferências de organização. Seus valores atuais foram preservados quando possível.')); }
}

// Extension Host Node; avoid adding a runtime dependency.
function createNonce(): string {
	return randomBytes(24).toString('hex');
}

/**
 * Descobre qual conversa está em foco (pelo título da aba do chat) e avisa o painel Mudanças.
 * Se o foco vai para um arquivo, mantém a última conversa; sem correspondência, mostra tudo.
 * Conversas com o mesmo título são mostradas juntas (ver `matchChatSessions`), e mudanças pendentes
 * de conversas que nenhuma outra aba identifica continuam visíveis (ver ChangesController.post).
 */
let chatTimer: NodeJS.Timeout | undefined;
let chatGeneration = 0;
function scheduleActiveChat(delay = 250): void {
	clearTimeout(chatTimer);
	chatTimer = setTimeout(() => { void updateActiveChat().catch(() => undefined); }, delay);
}

async function updateActiveChat(): Promise<void> {
	if (!changes) { return; }
	const open = claudeTabs().map(({ tab }) => tab);
	// Sem nenhuma aba de chat (por exemplo, só o chat da barra lateral), não há conversa para escolher: mostra tudo.
	if (!open.length) { ++chatGeneration; changes.setActiveChat(null); return; }
	const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
	if (!tab || !isClaudeTab(tab)) { return; }
	const generation = ++chatGeneration;
	const label = tab.label;
	const others = open.filter((other) => other !== tab).map((other) => other.label);
	const sessions = await chatSessions();
	if (generation !== chatGeneration) { return; }
	changes.setActiveChat(matchChatSessions(label, sessions, others));
}

/**
 * Conversas usadas para reconhecer a aba em foco. Trocar de aba não muda os transcripts, então a
 * lista é reaproveitada até o observador de transcripts (ou das pastas) avisar, ou por no máximo 30 s.
 */
const CHAT_SESSIONS_TTL = 30_000;
let chatSessionsCache: { at: number; sessions: Promise<SessionInfo[]> } | undefined;
function chatSessions(): Promise<SessionInfo[]> {
	if (!chatSessionsCache || Date.now() - chatSessionsCache.at > CHAT_SESSIONS_TTL) {
		const sessions = Promise.allSettled(localFolders().map((folder) => listSessionsAsync(folder, 100)))
			.then((results) => results.flatMap((result) => result.status === 'fulfilled' ? result.value.sessions : []));
		chatSessionsCache = { at: Date.now(), sessions };
	}
	return chatSessionsCache.sessions;
}
function forgetChatSessions(): void { chatSessionsCache = undefined; }

/** Pastas do workspace no disco local (as conversas do Claude Code ficam indexadas por esse caminho). */
function localFolders(): string[] {
	return (vscode.workspace.workspaceFolders ?? [])
		.filter((folder) => folder.uri.scheme === 'file')
		.map((folder) => folder.uri.fsPath);
}

/** Observa as conversas de cada pasta aberta e refaz os observadores quando as pastas mudam. */
function watchSessions(context: vscode.ExtensionContext): void {
	let watchers: vscode.Disposable[] = [];
	// O título gerado chega ao transcript depois de aparecer na aba: refaz também a conversa em foco.
	// Os comandos de terminal da conversa também vêm do transcript.
	const refresh = () => { forgetChatSessions(); provider?.refresh(1500); scheduleActiveChat(1500); changes?.refreshShellActivity(); };
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
			forgetChatSessions();
			setup();
			provider?.refresh(0);
		}),
		{ dispose: () => watchers.forEach((watcher) => watcher.dispose()) },
	);
}
