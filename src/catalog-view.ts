import * as path from 'node:path';
import * as vscode from 'vscode';
import { AGENTS_DIR, createAgent, markShadowedAgents, scanAgents, type AgentInfo } from './agents';
import { claudeConfigDir, managedDir, readText, setFileEnabled, validKebabName, writeTextIfUnchanged } from './catalog';
import {
	entryFromInput, findJsonKey, globalConfigFile, lineAt, loadMcp, LOCAL_SETTINGS, planAddServer, planApproval, planRemoveServer,
	PROJECT_MCP_FILE, validServerName, type McpServer,
} from './mcp';
import { createRule, MEMORY_FILE, parsePathsInput, PROJECT_MEMORY, RULES_DIR, scanMemory, scanRules, type RuleInfo } from './rules';

/** Abas da view do launcher. Só a de conversas mostra o painel de Mudanças. */
export const PANELS = ['chats', 'skills', 'rules', 'agents', 'mcp'] as const;
export type Panel = typeof PANELS[number];
export type CatalogKind = 'rules' | 'agents' | 'mcp';

interface Item { id: string; name: string; scope: string; state: string }

/** O que cada aba sabe fazer. Ações ausentes não aparecem na interface nem são aceitas. */
interface Source<T extends Item> {
	kind: CatalogKind;
	/** Prefixo das mensagens de erro. */
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

const folder = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
const configDir = () => claudeConfigDir();
const openFile = (file: string, line?: { line: number; character: number }) => vscode.window.showTextDocument(vscode.Uri.file(file),
	line ? { selection: new vscode.Range(line.line, line.character, line.line, line.character) } : undefined);
const reveal = (file: string) => vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(file));

async function confirmTrash(label: string, file: string): Promise<boolean> {
	const ok = await vscode.window.showWarningMessage(`Excluir ${label}? O arquivo vai para a lixeira.`, { modal: true, detail: file }, 'Excluir');
	if (ok !== 'Excluir') { return false; }
	await vscode.workspace.fs.delete(vscode.Uri.file(file), { useTrash: true });
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
		this.postToView({ type: 'catalog', kind, hasProject: Boolean(folder()), ...loaded.extra, items: loaded.items.map((item) => this.source.view(item)) });
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
			void vscode.window.showErrorMessage(`${source.title}: ${error instanceof Error ? error.message : String(error)}`);
		}
		await this.post();
	}
}

async function askName(prompt: string, example: string, valid: (v: string) => boolean): Promise<string | undefined> {
	return vscode.window.showInputBox({ prompt, validateInput: (v) => valid(v) ? undefined : `Ex.: ${example}` });
}

/** Raiz de criação para o escopo pedido; avisa quando é do projeto sem pasta aberta. */
function creationRoot(scope: string | undefined, sub: string): { root: string; project: boolean } | undefined {
	const project = scope === 'project';
	const base = project ? folder() : configDir();
	if (!base) { void vscode.window.showWarningMessage('Abra uma pasta para criar no projeto.'); return undefined; }
	return { root: project ? path.join(base, '.claude', sub) : path.join(base, sub), project };
}

// ---- Regras --------------------------------------------------------------------------

export const rulesSource: Source<RuleInfo> = {
	kind: 'rules', title: 'Regras',
	async load() {
		const project = folder(), config = configDir();
		const parts = await Promise.all([
			project ? scanMemory(project, PROJECT_MEMORY, 'project') : [],
			project ? scanRules(path.join(project, '.claude', RULES_DIR), 'project') : [],
			scanMemory(config, [MEMORY_FILE], 'global'),
			scanRules(path.join(config, RULES_DIR), 'global'),
			scanMemory(managedDir(), [MEMORY_FILE], 'managed'),
		]);
		return { items: parts.flat() };
	},
	view: ({ id, name, description, scope, state, kind, paths }) => ({
		id, name, description, scope, state, kind, paths, canToggle: scope !== 'managed' && state !== 'broken', canDelete: scope !== 'managed',
	}),
	open: async (rule) => { await openFile(rule.actual); },
	reveal: async (rule) => { await reveal(rule.actual); },
	async toggle(rule) {
		if (rule.scope === 'managed' || rule.state === 'broken') { return; }
		await setFileEnabled(rule.file, rule.state === 'disabled', rule.kind === 'memory' ? `O ${path.basename(rule.file)}` : 'A regra');
	},
	async remove(rule) { if (rule.scope !== 'managed') { await confirmTrash(`"${rule.name}"`, rule.actual); } },
	async create(scope) {
		const target = creationRoot(scope, RULES_DIR);
		if (!target) { return; }
		const name = await askName(`Nome da regra ${target.project ? 'do projeto' : 'global'} (minúsculas, números e hífens)`, 'minha-regra', validKebabName);
		if (!name) { return; }
		const paths = await vscode.window.showInputBox({
			prompt: 'Aplicar só a alguns arquivos? Globs separados por vírgula (ex.: src/**/*.ts). Vazio = vale sempre.',
		});
		if (paths === undefined) { return; }
		await openFile(await createRule(target.root, name, parsePathsInput(paths)));
	},
	watch() {
		const project = folder(), config = configDir();
		return [
			{ base: config, pattern: `{${MEMORY_FILE}*,${RULES_DIR}/**}` },
			...(project ? [{ base: project, pattern: `{CLAUDE.md*,CLAUDE.local.md*,.claude/CLAUDE.md*,.claude/${RULES_DIR}/**}` }] : []),
		];
	},
};

// ---- Agentes -------------------------------------------------------------------------

export const agentsSource: Source<AgentInfo> = {
	kind: 'agents', title: 'Agentes',
	async load() {
		const project = folder();
		const [projectAgents, globalAgents] = await Promise.all([
			project ? scanAgents(path.join(project, '.claude', AGENTS_DIR), 'project') : [],
			scanAgents(path.join(configDir(), AGENTS_DIR), 'global'),
		]);
		return { items: markShadowedAgents([...projectAgents, ...globalAgents]) };
	},
	view: ({ id, name, description, scope, state, rel, model, shadowed }) => ({
		id, name, description, scope, state, file: rel, model, shadowed, canToggle: state !== 'broken', canDelete: true,
	}),
	open: async (agent) => { await openFile(agent.actual); },
	reveal: async (agent) => { await reveal(agent.actual); },
	async toggle(agent) { if (agent.state !== 'broken') { await setFileEnabled(agent.file, agent.state === 'disabled', 'O agente'); } },
	async remove(agent) { await confirmTrash(`o agente "${agent.name}"`, agent.actual); },
	async create(scope) {
		const target = creationRoot(scope, AGENTS_DIR);
		if (!target) { return; }
		const name = await askName(`Nome do agente ${target.project ? 'do projeto' : 'global'} (minúsculas, números e hífens)`, 'revisor-de-codigo', validKebabName);
		if (!name) { return; }
		const description = await vscode.window.showInputBox({ prompt: 'Quando o Claude deve chamar este agente? (descrição)' });
		if (description === undefined) { return; }
		await openFile(await createAgent(target.root, name, description));
	},
	watch() {
		const project = folder();
		return [
			{ base: configDir(), pattern: `${AGENTS_DIR}/**` },
			...(project ? [{ base: project, pattern: `.claude/${AGENTS_DIR}/**` }] : []),
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

export const mcpSource: Source<McpServer> = {
	kind: 'mcp', title: 'MCP',
	async load() {
		const listing = await loadMcp({
			project: folder(), globalConfig: globalConfigFile(), userSettings: path.join(configDir(), 'settings.json'),
			managed: path.join(managedDir(), 'managed-mcp.json'),
		});
		return { items: listing.servers, extra: { problems: listing.problems, managedPolicy: listing.managedPolicy } };
	},
	view: ({ id, name, scope, state, transport, target, note, shadowedBy, canToggle }) => ({
		id, name, scope, state, transport, target, note, shadowed: Boolean(shadowedBy), canToggle, canDelete: scope === 'project',
	}),
	open: async (server) => { await openMcpEntry(server.file, server.keyPath); },
	reveal: async (server) => { await reveal(server.file); },
	async toggle(server) {
		const project = folder();
		if (!project || server.scope !== 'project' || !server.canToggle) { return; }
		await editJson(localSettings(project), (text) => planApproval(text, server.name, server.state !== 'active'));
	},
	async remove(server) {
		if (server.scope !== 'project') { return; }
		const ok = await vscode.window.showWarningMessage(`Remover o servidor "${server.name}" do ${PROJECT_MCP_FILE}?`, {
			modal: true, detail: `${server.file}\n\nO arquivo costuma ser compartilhado pelo repositório: a remoção vale para todos que o usam.`,
		}, 'Remover');
		if (ok === 'Remover') { await editJson(server.file, (text) => planRemoveServer(text, server.name)); }
	},
	async create(scope) {
		const project = folder();
		if (scope !== 'project') { return; }
		if (!project) { void vscode.window.showWarningMessage('Abra uma pasta para criar no projeto.'); return; }
		const name = await askName('Nome do servidor MCP do projeto (letras, números, hífens e sublinhados)', 'github', validServerName);
		if (!name) { return; }
		const input = await vscode.window.showInputBox({
			prompt: 'Comando (stdio) ou URL (http) do servidor',
			placeHolder: 'npx -y @modelcontextprotocol/server-filesystem .   ou   https://mcp.exemplo.com/mcp',
			validateInput: (v) => { try { entryFromInput(v); return undefined; } catch (error) { return error instanceof Error ? error.message : String(error); } },
		});
		if (input === undefined) { return; }
		const file = path.join(project, PROJECT_MCP_FILE);
		await editJson(file, (text) => planAddServer(text, name, entryFromInput(input)));
		await openMcpEntry(file, ['mcpServers', name]);
	},
	watch() {
		const project = folder(), global = globalConfigFile();
		return [
			{ base: path.dirname(global), pattern: path.basename(global) },
			{ base: configDir(), pattern: 'settings.json' },
			...(project ? [{ base: project, pattern: `{${PROJECT_MCP_FILE},.claude/settings.json,.claude/settings.local.json}` }] : []),
		];
	},
};

// ---- Registro ------------------------------------------------------------------------

export interface Catalogs {
	/** Troca de aba pedida pela própria página: não devolve a troca para ela. */
	showPanel(panel: string | undefined): Promise<void>;
	handle(command: string, id?: string, key?: string): Promise<void>;
}

export function registerCatalogs(context: vscode.ExtensionContext, postToView: (message: unknown) => void): Catalogs {
	const controllers: Array<CatalogController<RuleInfo> | CatalogController<AgentInfo> | CatalogController<McpServer>> = [
		new CatalogController(rulesSource, postToView), new CatalogController(agentsSource, postToView), new CatalogController(mcpSource, postToView),
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
		await vscode.commands.executeCommand('setContext', 'claudeCodeLauncher.panel', panel);
		// Pela paleta, a página também precisa trocar de aba.
		if (!fromView) { postToView({ type: 'tab', tab: panel }); }
	};
	void setPanel('chats', true);
	const titles: Record<Panel, string> = { chats: 'Chats', skills: 'Skills', rules: 'Rules', agents: 'Agents', mcp: 'Mcp' };
	context.subscriptions.push(...controllers, { dispose: () => watchers.forEach((w) => w.dispose()) },
		vscode.workspace.onDidChangeWorkspaceFolders(() => { rewatch(); controllers.forEach((c) => c.refresh(0)); }),
		...PANELS.map((panel) => vscode.commands.registerCommand(`claude-code-launcher.show${titles[panel]}`, () => setPanel(panel, false))),
	);
	return {
		async showPanel(panel) { if ((PANELS as readonly string[]).includes(panel ?? '')) { await setPanel(panel as Panel, true); } },
		async handle(command, id, key) { await controllers.find((c) => command.startsWith(`${c.source.kind}.`))?.handle(command, id, key); },
	};
}
