import * as path from 'node:path';
import * as vscode from 'vscode';
import { AGENTS_DIR, createAgent, markShadowedAgents, scanAgents, type AgentInfo } from './agents';
import { claudeConfigDir, managedDir, readText, setFileEnabled, validKebabName, writeTextIfUnchanged } from './catalog';
import {
	entryFromInput, findJsonKey, globalConfigFile, lineAt, loadMcp, LOCAL_SETTINGS, planAddServer, planApproval, planRemoveServer,
	PROJECT_MCP_FILE, validServerName, type McpServer,
} from './mcp';
import { createRule, MEMORY_FILE, parsePathsInput, PROJECT_MEMORY, RULES_DIR, scanMemory, scanRules, type RuleInfo } from './rules';
import {
	loadHooks, loadPermissions, permissionKindLabel, PERMISSION_KINDS, planAddPermission, planRemovePermission, settingsSources, validPermissionRule,
	type HookHandlerInfo, type PermissionKind, type PermissionRule, type SettingsSource,
} from './settings-catalog';
import { m, t } from './i18n';
import { deleteToTrash, revealPath } from './remote';

/** Abas da view do launcher. Só a de conversas mostra o painel de Mudanças. */
export const PANELS = ['chats', 'skills', 'rules', 'agents', 'mcp', 'permissions', 'hooks', 'orchestra'] as const;
export type Panel = typeof PANELS[number];
export type CatalogKind = 'rules' | 'agents' | 'mcp' | 'permissions' | 'hooks';

interface Item { id: string; name: string; scope: string; state: string; folder?: string; projectRoot?: string }

/** O que cada aba sabe fazer. Ações ausentes não aparecem na interface nem são aceitas. */
interface Source<T extends Item> {
	kind: CatalogKind;
	/** Prefixo das mensagens de erro (marcado com `m`, traduzido ao mostrar). */
	title: string;
	load(): Promise<{ items: T[]; extra?: Record<string, unknown> }>;
	/** Campos enviados à página: nunca caminhos de arquivo. */
	view(item: T): Record<string, unknown>;
	open(item: T): Promise<void>;
	reveal(item: T): Promise<void>;
	toggle?(item: T): Promise<void>;
	remove?(item: T): Promise<void>;
	create?(scope: string | undefined): Promise<void>;
	/** Pastas e padrões que, ao mudarem, pedem uma nova leitura. */
	watch(): Array<{ base: string; pattern: string }>;
}

/** Uma pasta local do workspace: cada uma tem os seus `.claude/`, `CLAUDE.md` e `.mcp.json`. */
interface ProjectFolder { root: string; name: string }
const projectFolders = (): ProjectFolder[] => (vscode.workspace.workspaceFolders ?? [])
	.filter((item) => item.uri.scheme === undefined || item.uri.scheme === 'file')
	.map((item) => ({ root: item.uri.fsPath, name: item.name || path.basename(item.uri.fsPath) }));
const configDir = () => claudeConfigDir();

/**
 * Itens do projeto ganham a pasta de origem. A primeira pasta mantém os ids de sempre; as outras
 * recebem um sufixo, para dois `CLAUDE.md` de pastas diferentes não se confundirem.
 */
function fromFolder<T extends Item>(items: readonly T[], folder: ProjectFolder, position: number, total: number): T[] {
	return items.map((item) => ({ ...item, id: position === 0 ? item.id : `${item.id}@${position}`, folder: total > 1 ? folder.name : undefined, projectRoot: folder.root }));
}

/** Pasta onde criar algo do projeto: a única aberta ou a que o usuário escolher. */
async function pickProjectFolder(): Promise<ProjectFolder | undefined> {
	const folders = projectFolders();
	if (!folders.length) { void vscode.window.showWarningMessage(t('Abra uma pasta para criar no projeto.')); return undefined; }
	if (folders.length === 1) { return folders[0]; }
	const picked = await vscode.window.showWorkspaceFolderPick({ placeHolder: t('Em qual pasta do workspace?') });
	return picked ? folders.find((folder) => folder.root === picked.uri.fsPath) : undefined;
}
const openFile = (file: string, line?: { line: number; character: number }) => vscode.window.showTextDocument(vscode.Uri.file(file),
	line ? { selection: new vscode.Range(line.line, line.character, line.line, line.character) } : undefined);
const reveal = (file: string) => revealPath(file);

async function confirmTrash(label: string, file: string): Promise<boolean> {
	const remove = t('Excluir');
	const ok = await vscode.window.showWarningMessage(t('Excluir {0}? O arquivo vai para a lixeira.', label), { modal: true, detail: file }, remove);
	if (ok !== remove) { return false; }
	await deleteToTrash(vscode.Uri.file(file));
	return true;
}

/** Lista de uma aba desenhada na view do launcher. Só relê o disco com a aba aberta. */
export class CatalogController<T extends Item> implements vscode.Disposable {
	private items = new Map<string, T>();
	private timer?: NodeJS.Timeout;
	private disposed = false;
	active = false;
	constructor(readonly source: Source<T>, private readonly postToView: (message: unknown) => void) {}

	/** Mudança em disco: relê só com a aba visível. A troca de aba pede uma leitura própria. */
	refresh(delay = 250): void {
		if (!this.active) { return; }
		clearTimeout(this.timer);
		this.timer = setTimeout(() => { void this.post(); }, delay);
	}

	dispose(): void { this.disposed = true; clearTimeout(this.timer); }

	async post(): Promise<void> {
		if (this.disposed) { return; }
		const { kind } = this.source;
		let loaded: { items: T[]; extra?: Record<string, unknown> };
		try { loaded = await this.source.load(); } catch (error) {
			loaded = { items: [], extra: { problems: [error instanceof Error ? error.message : String(error)] } };
		}
		if (this.disposed) { return; }
		this.items = new Map(loaded.items.map((item) => [item.id, item]));
		this.postToView({ type: 'catalog', kind, hasProject: projectFolders().length > 0, ...loaded.extra,
			items: loaded.items.map((item) => ({ ...this.source.view(item), ...(item.folder ? { folder: item.folder } : {}) })) });
	}

	/** `command` já validado pela lista de comandos da view; `id` só vale se for de um item listado. */
	async handle(command: string, id?: string, key?: string): Promise<void> {
		const item = id ? this.items.get(id) : undefined;
		const { source } = this;
		try {
			switch (command.slice(source.kind.length + 1)) {
				case 'refresh': break;
				case 'open': if (item && item.state !== 'broken') { await source.open(item); } break;
				case 'reveal': if (item) { await source.reveal(item); } break;
				case 'toggle': if (item && source.toggle) { await source.toggle(item); } break;
				case 'delete': if (item && source.remove) { await source.remove(item); } break;
				case 'create': if (source.create) { await source.create(key); } break;
			}
		} catch (error) {
			void vscode.window.showErrorMessage(`${t(source.title)}: ${error instanceof Error ? error.message : String(error)}`);
		}
		await this.post();
	}
}

async function askName(prompt: string, example: string, valid: (v: string) => boolean): Promise<string | undefined> {
	return vscode.window.showInputBox({ prompt, validateInput: (v) => valid(v) ? undefined : t('Ex.: {0}', example) });
}

/** Raiz de criação para o escopo pedido; no projeto, pergunta a pasta quando há mais de uma. */
async function creationRoot(scope: string | undefined, sub: string): Promise<{ root: string; project: boolean } | undefined> {
	if (scope !== 'project') { return { root: path.join(configDir(), sub), project: false }; }
	const folder = await pickProjectFolder();
	return folder && { root: path.join(folder.root, '.claude', sub), project: true };
}

// ---- Regras --------------------------------------------------------------------------

export const rulesSource: Source<RuleInfo & Item> = {
	kind: 'rules', title: m('Regras'),
	async load() {
		const folders = projectFolders(), config = configDir();
		const project = await Promise.all(folders.map(async (folder, position) => fromFolder([
			...await scanMemory(folder.root, PROJECT_MEMORY, 'project'),
			...await scanRules(path.join(folder.root, '.claude', RULES_DIR), 'project'),
		], folder, position, folders.length)));
		const parts = await Promise.all([
			scanMemory(config, [MEMORY_FILE], 'global'),
			scanRules(path.join(config, RULES_DIR), 'global'),
			scanMemory(managedDir(), [MEMORY_FILE], 'managed'),
		]);
		return { items: [...project.flat(), ...parts.flat()] };
	},
	view: ({ id, name, description, scope, state, kind, paths }) => ({
		id, name, description, scope, state, kind, paths, canToggle: scope !== 'managed' && state !== 'broken', canDelete: scope !== 'managed',
	}),
	open: async (rule) => { await openFile(rule.actual); },
	reveal: async (rule) => { await reveal(rule.actual); },
	async toggle(rule) {
		if (rule.scope === 'managed' || rule.state === 'broken') { return; }
		await setFileEnabled(rule.file, rule.state === 'disabled', rule.kind === 'memory' ? t('O {0}', path.basename(rule.file)) : t('A regra'));
	},
	async remove(rule) { if (rule.scope !== 'managed') { await confirmTrash(`"${rule.name}"`, rule.actual); } },
	async create(scope) {
		const target = await creationRoot(scope, RULES_DIR);
		if (!target) { return; }
		const name = await askName(target.project ? t('Nome da regra do projeto (minúsculas, números e hífens)') : t('Nome da regra global (minúsculas, números e hífens)'), t('minha-regra'), validKebabName);
		if (!name) { return; }
		const paths = await vscode.window.showInputBox({
			prompt: t('Aplicar só a alguns arquivos? Globs separados por vírgula (ex.: src/**/*.ts). Vazio = vale sempre.'),
		});
		if (paths === undefined) { return; }
		await openFile(await createRule(target.root, name, parsePathsInput(paths)));
	},
	watch() {
		return [
			{ base: configDir(), pattern: `{${MEMORY_FILE}*,${RULES_DIR}/**}` },
			...projectFolders().map((folder) => ({ base: folder.root, pattern: `{CLAUDE.md*,CLAUDE.local.md*,.claude/CLAUDE.md*,.claude/${RULES_DIR}/**}` })),
		];
	},
};

// ---- Agentes -------------------------------------------------------------------------

export const agentsSource: Source<AgentInfo & Item> = {
	kind: 'agents', title: m('Agentes'),
	async load() {
		const folders = projectFolders();
		const [globalAgents, ...projectAgents] = await Promise.all([
			scanAgents(path.join(configDir(), AGENTS_DIR), 'global'),
			...folders.map(async (folder, position) => fromFolder(await scanAgents(path.join(folder.root, '.claude', AGENTS_DIR), 'project'), folder, position, folders.length)),
		]);
		return { items: markShadowedAgents([...projectAgents.flat(), ...globalAgents]) };
	},
	view: ({ id, name, description, scope, state, rel, model, shadowed }) => ({
		id, name, description, scope, state, file: rel, model, shadowed, canToggle: state !== 'broken', canDelete: true,
	}),
	open: async (agent) => { await openFile(agent.actual); },
	reveal: async (agent) => { await reveal(agent.actual); },
	async toggle(agent) { if (agent.state !== 'broken') { await setFileEnabled(agent.file, agent.state === 'disabled', t('O agente')); } },
	async remove(agent) { await confirmTrash(t('o agente "{0}"', agent.name), agent.actual); },
	async create(scope) {
		const target = await creationRoot(scope, AGENTS_DIR);
		if (!target) { return; }
		const name = await askName(target.project ? t('Nome do agente do projeto (minúsculas, números e hífens)') : t('Nome do agente global (minúsculas, números e hífens)'), t('revisor-de-codigo'), validKebabName);
		if (!name) { return; }
		const description = await vscode.window.showInputBox({ prompt: t('Quando o Claude deve chamar este agente? (descrição)') });
		if (description === undefined) { return; }
		await openFile(await createAgent(target.root, name, description));
	},
	watch() {
		return [
			{ base: configDir(), pattern: `${AGENTS_DIR}/**` },
			...projectFolders().map((folder) => ({ base: folder.root, pattern: `.claude/${AGENTS_DIR}/**` })),
		];
	},
};

// ---- MCP -----------------------------------------------------------------------------

const MCP_EDIT_LIMIT = 2 * 1024 * 1024;
const localSettings = (project: string) => path.join(project, ...LOCAL_SETTINGS);

async function editJson(file: string, plan: (text: string | undefined) => string): Promise<void> {
	const read = await readText(file, MCP_EDIT_LIMIT);
	const before = read.kind === 'content' ? read.text : undefined;
	await writeTextIfUnchanged(file, before, plan(before), MCP_EDIT_LIMIT);
}

async function openMcpEntry(file: string, keyPath: readonly string[]): Promise<void> {
	let position: { line: number; character: number } | undefined;
	try {
		const read = await readText(file, 64 * 1024 * 1024);
		const offset = read.kind === 'content' ? findJsonKey(read.text, keyPath) : undefined;
		if (read.kind === 'content' && offset !== undefined) { position = lineAt(read.text, offset); }
	} catch { position = undefined; }
	await openFile(file, position);
}

export const mcpSource: Source<McpServer & Item> = {
	kind: 'mcp', title: m('MCP'),
	async load() {
		const folders = projectFolders();
		const shared = { globalConfig: globalConfigFile(), userSettings: path.join(configDir(), 'settings.json'), managed: path.join(managedDir(), 'managed-mcp.json') };
		if (!folders.length) {
			const listing = await loadMcp({ ...shared, project: undefined });
			return { items: listing.servers, extra: { problems: listing.problems, managedPolicy: listing.managedPolicy } };
		}
		// Uma leitura por pasta: os escopos local e projeto são dela; usuário e organização vêm uma vez só.
		const listings = await Promise.all(folders.map((folder) => loadMcp({ ...shared, project: folder.root })));
		const ownScope = (server: McpServer & Item) => server.scope === 'local' || server.scope === 'project';
		const items = listings.flatMap((listing, position) => [
			...fromFolder(listing.servers.filter(ownScope), folders[position], position, folders.length),
			...(position === 0 ? listing.servers.filter((server) => !ownScope(server)) : []),
		]);
		const everywhere = (problem: string) => listings.every((listing) => listing.problems.includes(problem));
		const problems = [...new Set(listings.flatMap((listing, position) => listing.problems.map((problem) =>
			folders.length > 1 && !everywhere(problem) ? `${folders[position].name}: ${problem}` : problem)))];
		return { items, extra: { problems, managedPolicy: listings.some((listing) => listing.managedPolicy) } };
	},
	view: ({ id, name, scope, state, transport, target, note, shadowedBy, canToggle }) => ({
		id, name, scope, state, transport, target, note, shadowed: Boolean(shadowedBy), canToggle, canDelete: scope === 'project',
	}),
	open: async (server) => { await openMcpEntry(server.file, server.keyPath); },
	reveal: async (server) => { await reveal(server.file); },
	async toggle(server) {
		const project = server.projectRoot;
		if (!project || server.scope !== 'project' || !server.canToggle) { return; }
		await editJson(localSettings(project), (text) => planApproval(text, server.name, server.state !== 'active'));
	},
	async remove(server) {
		if (server.scope !== 'project') { return; }
		const removeLabel = t('Remover');
		const ok = await vscode.window.showWarningMessage(t('Remover o servidor "{0}" do {1}?', server.name, PROJECT_MCP_FILE), {
			modal: true, detail: `${server.file}\n\n` + t('O arquivo costuma ser compartilhado pelo repositório: a remoção vale para todos que o usam.'),
		}, removeLabel);
		if (ok === removeLabel) { await editJson(server.file, (text) => planRemoveServer(text, server.name)); }
	},
	async create(scope) {
		if (scope !== 'project') { return; }
		const folder = await pickProjectFolder();
		if (!folder) { return; }
		const project = folder.root;
		const name = await askName(t('Nome do servidor MCP do projeto (letras, números, hífens e sublinhados)'), 'github', validServerName);
		if (!name) { return; }
		const input = await vscode.window.showInputBox({
			prompt: t('Comando (stdio) ou URL (http) do servidor'),
			placeHolder: t('npx -y @modelcontextprotocol/server-filesystem .   ou   https://mcp.exemplo.com/mcp'),
			validateInput: (v) => { try { entryFromInput(v); return undefined; } catch (error) { return error instanceof Error ? error.message : String(error); } },
		});
		if (input === undefined) { return; }
		const file = path.join(project, PROJECT_MCP_FILE);
		await editJson(file, (text) => planAddServer(text, name, entryFromInput(input)));
		await openMcpEntry(file, ['mcpServers', name]);
	},
	watch() {
		const global = globalConfigFile();
		return [
			{ base: path.dirname(global), pattern: path.basename(global) },
			{ base: configDir(), pattern: 'settings.json' },
			...projectFolders().map((folder) => ({ base: folder.root, pattern: `{${PROJECT_MCP_FILE},.claude/settings.json,.claude/settings.local.json}` })),
		];
	},
};

// ---- Permissões e hooks ---------------------------------------------------------------

/** Arquivos de configurações de cada pasta (local e projeto) e os de usuário e organização, uma vez só. */
function allSettingsSources(): Array<SettingsSource & { folder?: ProjectFolder }> {
	const folders = projectFolders(), shared = { configDir: configDir(), managedDir: managedDir() };
	const own = folders.flatMap((folder) => settingsSources({ ...shared, project: folder.root })
		.filter((source) => source.scope === 'local' || source.scope === 'project').map((source) => ({ ...source, folder })));
	return [...own, ...settingsSources(shared)];
}

/** Itens de uma fonte de configurações ganham a pasta (com várias pastas) e um id único entre elas. */
function located<T extends Item & { file: string }>(items: T[], sources: ReturnType<typeof allSettingsSources>): T[] {
	const folders = projectFolders();
	return items.map((item) => {
		const source = sources.find((candidate) => candidate.file === item.file);
		const position = source?.folder ? folders.findIndex((folder) => folder.root === source.folder?.root) : 0;
		return source?.folder ? { ...fromFolder([item], source.folder, Math.max(0, position), folders.length)[0] } : item;
	});
}

const SCOPE_FILE: Record<string, string> = { local: '.claude/settings.local.json', project: '.claude/settings.json' };

export const permissionsSource: Source<PermissionRule & Item> = {
	kind: 'permissions', title: m('Permissões'),
	async load() {
		const sources = allSettingsSources();
		const listing = await loadPermissions(sources);
		const scopes: Record<string, string> = { local: t('Local'), project: t('Projeto'), user: t('Usuário'), managed: t('Organização') };
		return { items: located(listing.items, sources), extra: { problems: listing.problems,
			notes: [t('Negar vence perguntar, que vence permitir. As regras da organização (managed-settings.json) valem acima das demais.'),
				...listing.modes.map(({ scope, mode }) => t('Modo padrão ({0}): {1}', scopes[scope] ?? scope, mode))] } };
	},
	view: ({ id, name, scope, state, kind, note, shadowedBy }) => ({
		id, name, scope, state, note, shadowed: Boolean(shadowedBy), canToggle: false, canDelete: scope !== 'managed',
		tags: [{ text: permissionKindLabel(kind), tone: kind === 'deny' ? 'broken' : kind === 'ask' ? 'off' : '' }],
	}),
	open: async (rule) => { await openMcpEntry(rule.file, rule.keyPath); },
	reveal: async (rule) => { await reveal(rule.file); },
	async remove(rule) {
		if (rule.scope === 'managed') { return; }
		const label = SCOPE_FILE[rule.scope] ?? path.basename(rule.file);
		const removeLabel = t('Remover');
		const ok = await vscode.window.showWarningMessage(t('Remover a regra "{0}" de {1}?', rule.name, label), { modal: true, detail: rule.file }, removeLabel);
		if (ok === removeLabel) { await editJson(rule.file, (text) => planRemovePermission(text, label, rule.kind, rule.name)); }
	},
	async create(scope) {
		if (scope !== 'local' && scope !== 'project' && scope !== 'user') { return; }
		const folder = scope === 'user' ? undefined : await pickProjectFolder();
		if (scope !== 'user' && !folder) { return; }
		const file = folder ? path.join(folder.root, '.claude', scope === 'local' ? 'settings.local.json' : 'settings.json') : path.join(configDir(), 'settings.json');
		const label = SCOPE_FILE[scope] ?? t('settings.json do usuário');
		const kinds: Array<vscode.QuickPickItem & { permission: PermissionKind }> = PERMISSION_KINDS.map((kind) => ({ permission: kind, label: permissionKindLabel(kind), description: kind,
			detail: kind === 'allow' ? t('O Claude usa sem perguntar.') : kind === 'ask' ? t('O Claude pede confirmação antes.') : t('O Claude não pode usar.') }));
		const picked = await vscode.window.showQuickPick(kinds, { placeHolder: t('Que tipo de regra?') });
		if (!picked) { return; }
		const rule = await vscode.window.showInputBox({ prompt: t('Regra no formato do Claude Code'), placeHolder: 'Bash(npm test:*)   Read(./src/**)   WebFetch(domain:example.com)',
			validateInput: (value) => validPermissionRule(value.trim()) ? undefined : t('Use o formato do Claude Code, por exemplo Bash(npm test:*) ou Read(./src/**).') });
		if (!rule) { return; }
		await editJson(file, (text) => planAddPermission(text, label, picked.permission, rule.trim()));
		await openMcpEntry(file, ['permissions', picked.permission]);
	},
	watch() {
		return [
			{ base: configDir(), pattern: 'settings.json' },
			{ base: managedDir(), pattern: 'managed-settings.json' },
			...projectFolders().map((folder) => ({ base: folder.root, pattern: '.claude/{settings.json,settings.local.json}' })),
		];
	},
};

export const hooksSource: Source<HookHandlerInfo & Item> = {
	kind: 'hooks', title: m('Hooks'),
	async load() {
		const sources = allSettingsSources();
		const listing = await loadHooks(sources);
		return { items: located(listing.items, sources), extra: { problems: listing.problems,
			notes: [t('Hooks rodam comandos a cada evento do Claude Code, com as suas permissões. Abra o arquivo para mudar um hook.')] } };
	},
	view: ({ id, name, scope, state, event, matcher, type, note, launcher }) => ({
		id, name, scope, state, note, canToggle: false, canDelete: false,
		tags: [{ text: event, tone: '' }, ...(matcher ? [{ text: matcher, tone: 'off' }] : []), ...(type !== 'command' ? [{ text: type, tone: 'off' }] : []),
			...(launcher ? [{ text: t('launcher'), tone: 'accent' }] : [])],
	}),
	open: async (hook) => { await openMcpEntry(hook.file, hook.keyPath); },
	reveal: async (hook) => { await reveal(hook.file); },
	watch() { return permissionsSource.watch(); },
};

// ---- Registro ------------------------------------------------------------------------

export interface Catalogs {
	/** Troca de aba pedida pela própria página: não devolve a troca para ela. */
	showPanel(panel: string | undefined): Promise<void>;
	handle(command: string, id?: string, key?: string): Promise<void>;
}

/** `onPanel` avisa quem desenha uma aba fora dos catálogos (o orquestrador) de cada troca de aba. */
export function registerCatalogs(context: vscode.ExtensionContext, postToView: (message: unknown) => void, onPanel?: (panel: Panel) => void): Catalogs {
	const controllers: Array<CatalogController<RuleInfo & Item> | CatalogController<AgentInfo & Item> | CatalogController<McpServer & Item>
		| CatalogController<PermissionRule & Item> | CatalogController<HookHandlerInfo & Item>> = [
		new CatalogController(rulesSource, postToView), new CatalogController(agentsSource, postToView), new CatalogController(mcpSource, postToView),
		new CatalogController(permissionsSource, postToView), new CatalogController(hooksSource, postToView),
	];
	let watchers: vscode.Disposable[] = [];
	const rewatch = () => {
		watchers.forEach((w) => w.dispose());
		watchers = controllers.flatMap((controller) => controller.source.watch().map(({ base, pattern }) => {
			const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(base), pattern));
			const refresh = () => controller.refresh();
			w.onDidCreate(refresh); w.onDidDelete(refresh); w.onDidChange(refresh);
			return w;
		}));
	};
	rewatch();

	const setPanel = async (panel: Panel, fromView: boolean) => {
		controllers.forEach((c) => { c.active = c.source.kind === panel; });
		onPanel?.(panel);
		await vscode.commands.executeCommand('setContext', 'claudeCodeLauncher.panel', panel);
		// Pela paleta, a página também precisa trocar de aba.
		if (!fromView) { postToView({ type: 'tab', tab: panel }); }
	};
	void setPanel('chats', true);
	const titles: Record<Panel, string> = { chats: 'Chats', skills: 'Skills', rules: 'Rules', agents: 'Agents', mcp: 'Mcp', permissions: 'Permissions', hooks: 'Hooks', orchestra: 'Orchestra' };
	context.subscriptions.push(...controllers, { dispose: () => watchers.forEach((w) => w.dispose()) },
		vscode.workspace.onDidChangeWorkspaceFolders(() => { rewatch(); controllers.forEach((c) => c.refresh(0)); }),
		...PANELS.map((panel) => vscode.commands.registerCommand(`claude-code-launcher.show${titles[panel]}`, () => setPanel(panel, false))),
	);
	return {
		async showPanel(panel) { if ((PANELS as readonly string[]).includes(panel ?? '')) { await setPanel(panel as Panel, true); } },
		async handle(command, id, key) { await controllers.find((c) => command.startsWith(`${c.source.kind}.`))?.handle(command, id, key); },
	};
}
