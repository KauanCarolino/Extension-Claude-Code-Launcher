import * as os from 'node:os';
import * as path from 'node:path';
import { readText, type TextRead } from './catalog';

/**
 * Servidores MCP configurados para o Claude Code, por escopo:
 * - `local`: `~/.claude.json` em `projects["<pasta>"].mcpServers` (só deste projeto, só desta pessoa);
 * - `project`: `.mcp.json` na pasta do projeto, em `mcpServers` (compartilhado pelo repositório);
 * - `user`: `~/.claude.json` em `mcpServers` (todos os projetos);
 * - `managed`: `managed-mcp.json` da organização, somente leitura.
 *
 * O launcher só lê `~/.claude.json`: o Claude Code reescreve esse arquivo o tempo todo.
 * As únicas escritas são no `.mcp.json` e na aprovação local (`.claude/settings.local.json`).
 */
export type McpScope = 'local' | 'project' | 'user' | 'managed';
export type McpState = 'active' | 'disabled' | 'pending' | 'broken';

export interface McpServer {
	id: string;
	name: string;
	scope: McpScope;
	/** `stdio`, `http`, `sse` ou o `type` declarado. */
	transport: string;
	/** Comando ou URL, sem segredos aparentes. */
	target: string;
	state: McpState;
	/** Motivo do estado, para a dica da linha. */
	note: string;
	/** Um servidor de mesmo nome num escopo de maior prioridade é o que vale. */
	shadowedBy?: McpScope;
	/** O launcher pode aprovar ou recusar: só servidores do `.mcp.json`, pela aprovação local. */
	canToggle: boolean;
	file: string;
	keyPath: string[];
}

export interface McpLocations {
	/** Pasta do workspace. */
	project?: string;
	/** `~/.claude.json`. */
	globalConfig: string;
	/** `~/.claude/settings.json`. */
	userSettings: string;
	/** `managed-mcp.json`. */
	managed: string;
	platform?: NodeJS.Platform;
}

export interface McpListing {
	servers: McpServer[];
	/** Arquivos que não puderam ser lidos ou não são JSON válido. */
	problems: string[];
	/** Existe um `managed-mcp.json`: a organização pode restringir os outros servidores. */
	managedPolicy: boolean;
}

export const PROJECT_MCP_FILE = '.mcp.json';
export const LOCAL_SETTINGS = ['.claude', 'settings.local.json'] as const;
const SHARED_SETTINGS = ['.claude', 'settings.json'] as const;
const MAX_GLOBAL_CONFIG = 64 * 1024 * 1024;
const MAX_SMALL = 2 * 1024 * 1024;
/** Ordem de prioridade documentada quando o mesmo nome aparece em mais de um escopo. */
const PRECEDENCE: McpScope[] = ['local', 'project', 'user'];
const SCOPE_LABEL: Record<McpScope, string> = { local: 'local', project: 'projeto', user: 'usuário', managed: 'organização' };

/** `$CLAUDE_CONFIG_DIR/.claude.json` quando definido, senão `~/.claude.json`. */
export function globalConfigFile(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
	return path.join(env.CLAUDE_CONFIG_DIR || home, '.claude.json');
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

function parseRead(read: TextRead, label: string, problems: string[]): Json | undefined {
	if (read.kind === 'absent') { return undefined; }
	try {
		const value: unknown = JSON.parse(read.text.replace(/^﻿/, ''));
		if (isObject(value)) { return value; }
	} catch { /* relatado abaixo */ }
	problems.push(`${label} não é um JSON válido.`);
	return undefined;
}

async function readJson(file: string, label: string, problems: string[], max = MAX_SMALL): Promise<Json | undefined> {
	try { return parseRead(await readText(file, max), label, problems); } catch (error) {
		problems.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}

/** Chave da pasta em `projects` do `~/.claude.json`: o Claude Code grava com `/` também no Windows. */
export function projectKey(projects: Json, folder: string, platform: NodeJS.Platform = process.platform): string | undefined {
	const norm = (p: string) => { const s = p.replace(/\\/g, '/').replace(/\/+$/, ''); return platform === 'win32' ? s.toLowerCase() : s; };
	const want = norm(folder);
	return Object.keys(projects).find((key) => norm(key) === want);
}

// ---- Descrição sem segredos ------------------------------------------------------------

const SECRET_FLAG = /(token|key|secret|passw|auth|bearer|credential)/i;
const SECRET_VALUE = /^(?:gh[pousr]_|github_pat_|sk-|xox[abprs]-|glpat-|AKIA)|^(?=.*\d)(?=.*[A-Za-z])[A-Za-z0-9_\-+/=]{32,}$/;

export function redactArgs(args: readonly string[]): string[] {
	const out: string[] = [];
	let hideNext = false;
	for (const arg of args) {
		const eq = /^(--?[\w.-]+)=(.*)$/.exec(arg);
		if (hideNext && !arg.startsWith('-')) { out.push('•••'); hideNext = false; continue; }
		hideNext = false;
		if (eq && SECRET_FLAG.test(eq[1])) { out.push(`${eq[1]}=•••`); continue; }
		if (/^--?[\w.-]+$/.test(arg) && SECRET_FLAG.test(arg)) { hideNext = true; out.push(arg); continue; }
		const kv = /^([A-Za-z_][\w]*)=(.*)$/.exec(arg);
		if (kv && SECRET_FLAG.test(kv[1])) { out.push(`${kv[1]}=•••`); continue; }
		out.push(SECRET_VALUE.test(arg) ? '•••' : arg);
	}
	return out;
}

/** Origem e caminho; usuário, senha, query e fragmento ficam de fora. */
export function redactUrl(url: string): string {
	try {
		const u = new URL(url);
		return `${u.protocol}//${u.host}${u.pathname === '/' ? '' : u.pathname}${u.search ? '?…' : ''}`;
	} catch { return url.replace(/[?#].*$/, '?…').slice(0, 200); }
}

function clip(text: string, max = 200): string { return text.length > max ? `${text.slice(0, max - 1)}…` : text; }

/** Transporte e alvo de uma entrada, ou o motivo de ela não poder funcionar. */
export function describeEntry(value: unknown): { transport: string; target: string; problem?: string } {
	if (!isObject(value)) { return { transport: '?', target: '', problem: 'A entrada não é um objeto JSON.' }; }
	const type = value.type;
	const url = typeof value.url === 'string' ? value.url : undefined;
	if (type === 'http' || type === 'streamable-http' || type === 'sse') {
		const transport = type === 'sse' ? 'sse' : 'http';
		return url ? { transport, target: redactUrl(url) } : { transport, target: '', problem: 'Falta "url".' };
	}
	if (type === undefined || type === 'stdio') {
		if (typeof value.command === 'string' && value.command) {
			return { transport: 'stdio', target: clip([value.command, ...redactArgs(strings(value.args))].join(' ')) };
		}
		if (type === undefined && url) { return { transport: '?', target: redactUrl(url), problem: 'Tem "url" mas falta "type": "http". Sem type, o Claude Code trata a entrada como stdio.' }; }
		return { transport: 'stdio', target: '', problem: 'Falta "command".' };
	}
	return { transport: clip(String(type), 16), target: url ? redactUrl(url) : '' };
}

// ---- Leitura ---------------------------------------------------------------------------

interface Approval { enabled: Set<string>; disabled: Map<string, string>; all: boolean }

function collectApproval(sources: Array<[string, Json | undefined]>): Approval {
	const approval: Approval = { enabled: new Set(), disabled: new Map(), all: false };
	for (const [label, settings] of sources) {
		if (!settings) { continue; }
		strings(settings.enabledMcpjsonServers).forEach((n) => approval.enabled.add(n));
		for (const n of strings(settings.disabledMcpjsonServers)) { if (!approval.disabled.has(n)) { approval.disabled.set(n, label); } }
		if (settings.enableAllProjectMcpServers === true) { approval.all = true; }
	}
	return approval;
}

export async function loadMcp(loc: McpLocations): Promise<McpListing> {
	const problems: string[] = [];
	const platform = loc.platform ?? process.platform;
	const [global, userSettings, managed] = await Promise.all([
		readJson(loc.globalConfig, path.basename(loc.globalConfig), problems, MAX_GLOBAL_CONFIG),
		readJson(loc.userSettings, 'settings.json do usuário', problems),
		readJson(loc.managed, 'managed-mcp.json', problems),
	]);
	const projectFile = loc.project ? path.join(loc.project, PROJECT_MCP_FILE) : undefined;
	const [mcpJson, shared, local] = loc.project ? await Promise.all([
		readJson(projectFile as string, PROJECT_MCP_FILE, problems),
		readJson(path.join(loc.project, ...SHARED_SETTINGS), '.claude/settings.json', problems),
		readJson(path.join(loc.project, ...LOCAL_SETTINGS), '.claude/settings.local.json', problems),
	]) : [undefined, undefined, undefined];

	const projects = isObject(global?.projects) ? global.projects : {};
	const key = loc.project ? projectKey(projects, loc.project, platform) : undefined;
	const projectConfig = key && isObject(projects[key]) ? projects[key] : undefined;
	// Desligados pelo `/mcp` neste projeto: vale para servidores de qualquer escopo.
	const toggledOff = new Set(strings(projectConfig?.disabledMcpServers));
	const approval = collectApproval([
		['.claude/settings.local.json', local], ['.claude/settings.json', shared], ['settings.json do usuário', userSettings],
		[path.basename(loc.globalConfig), projectConfig],
	]);

	const servers: McpServer[] = [];
	const add = (scope: McpScope, file: string, keyPath: string[], entries: unknown) => {
		if (!isObject(entries)) { return; }
		for (const name of Object.keys(entries).sort((a, b) => a.localeCompare(b))) {
			const { transport, target, problem } = describeEntry(entries[name]);
			let state: McpState = 'active', note = '', canToggle = false;
			if (problem) { state = 'broken'; note = problem; }
			else if (scope !== 'managed' && toggledOff.has(name)) { state = 'disabled'; note = 'Desativado pelo /mcp neste projeto. Reative pelo /mcp no chat.'; }
			else if (scope === 'project') {
				const by = approval.disabled.get(name);
				if (by) {
					state = 'disabled'; note = `Recusado em ${by}.`;
					// Só desfaz o que o próprio launcher pode editar: a recusa no settings.local.json.
					canToggle = by === '.claude/settings.local.json' && [shared, userSettings, projectConfig].every((s) => !strings(s?.disabledMcpjsonServers).includes(name));
				} else if (approval.all || approval.enabled.has(name)) { note = 'Aprovado para este projeto.'; canToggle = true; }
				else { state = 'pending'; note = 'Aguardando aprovação: o Claude Code pergunta ao abrir o projeto.'; canToggle = true; }
			}
			servers.push({ id: `${scope}:${name}`, name, scope, transport, target, state, note, canToggle, file, keyPath: [...keyPath, name] });
		}
	};
	if (key && projectConfig) { add('local', loc.globalConfig, ['projects', key, 'mcpServers'], projectConfig.mcpServers); }
	if (projectFile) { add('project', projectFile, ['mcpServers'], mcpJson?.mcpServers); }
	add('user', loc.globalConfig, ['mcpServers'], global?.mcpServers);
	add('managed', loc.managed, ['mcpServers'], managed?.mcpServers);

	for (const server of servers) {
		const rank = PRECEDENCE.indexOf(server.scope);
		if (rank <= 0) { continue; }
		const winner = servers.find((s) => s.name === server.name && s.state !== 'broken' && PRECEDENCE.indexOf(s.scope) >= 0 && PRECEDENCE.indexOf(s.scope) < rank);
		if (winner) {
			server.shadowedBy = winner.scope;
			server.note = `Substituído pelo servidor de mesmo nome do escopo ${SCOPE_LABEL[winner.scope]}.${server.note ? ` ${server.note}` : ''}`;
		}
	}
	return { servers, problems, managedPolicy: managed !== undefined };
}

// ---- Alterações ------------------------------------------------------------------------

/** Mesma regra do `claude mcp add`: letras, números, hífens e sublinhados. */
export const validServerName = (name: string): boolean => /^[A-Za-z0-9_-]{1,64}$/.test(name);

function parseForEdit(text: string | undefined, label: string): Json {
	if (text === undefined) { return {}; }
	let value: unknown;
	try { value = JSON.parse(text.replace(/^﻿/, '')); } catch { throw new Error(`${label} não é um JSON válido. Corrija o arquivo antes.`); }
	if (!isObject(value)) { throw new Error(`${label} não contém um objeto JSON.`); }
	return value;
}

const serialize = (value: Json) => `${JSON.stringify(value, null, 2)}\n`;

/** Aprova (`enable`) ou recusa um servidor do `.mcp.json` no `settings.local.json`, tirando-o da outra lista. */
export function planApproval(text: string | undefined, name: string, enable: boolean): string {
	const settings = parseForEdit(text, 'settings.local.json');
	const update = (key: 'enabledMcpjsonServers' | 'disabledMcpjsonServers', include: boolean) => {
		const current = settings[key];
		if (current !== undefined && (!Array.isArray(current) || current.some((n) => typeof n !== 'string'))) {
			throw new Error(`"${key}" no settings.local.json não é uma lista de nomes.`);
		}
		const next = ((current as string[] | undefined) ?? []).filter((n) => n !== name);
		if (include) { next.push(name); }
		if (next.length) { settings[key] = next; } else if (current !== undefined) { delete settings[key]; }
	};
	update('enabledMcpjsonServers', enable);
	update('disabledMcpjsonServers', !enable);
	return serialize(settings);
}

function servers(config: Json): Json {
	if (config.mcpServers === undefined) { config.mcpServers = {}; }
	if (!isObject(config.mcpServers)) { throw new Error('"mcpServers" no .mcp.json não é um objeto.'); }
	return config.mcpServers;
}

export function planAddServer(text: string | undefined, name: string, entry: Json): string {
	if (!validServerName(name)) { throw new Error('Use letras, números, hífens e sublinhados (ex.: github).'); }
	const config = parseForEdit(text, PROJECT_MCP_FILE), list = servers(config);
	if (Object.prototype.hasOwnProperty.call(list, name)) { throw new Error(`Já existe um servidor "${name}" no .mcp.json.`); }
	list[name] = entry;
	return serialize(config);
}

export function planRemoveServer(text: string | undefined, name: string): string {
	const config = parseForEdit(text, PROJECT_MCP_FILE), list = servers(config);
	if (!Object.prototype.hasOwnProperty.call(list, name)) { throw new Error(`O servidor "${name}" não está mais no .mcp.json.`); }
	delete list[name];
	return serialize(config);
}

/** Divide uma linha de comando: espaços separam, aspas agrupam, `\` só escapa dentro de aspas duplas. */
export function splitCommandLine(input: string): string[] {
	const out: string[] = [];
	let current = '', quote: '"' | "'" | undefined, started = false;
	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		if (quote) {
			if (ch === quote) { quote = undefined; }
			else if (quote === '"' && ch === '\\' && (input[i + 1] === '"' || input[i + 1] === '\\')) { current += input[++i]; }
			else { current += ch; }
		} else if (ch === '"' || ch === "'") { quote = ch; started = true; }
		else if (/\s/.test(ch)) { if (started) { out.push(current); current = ''; started = false; } }
		else { current += ch; started = true; }
	}
	if (quote) { throw new Error('Aspas sem fechamento no comando.'); }
	if (started) { out.push(current); }
	return out;
}

/** Entrada nova a partir do que o usuário digitou: uma URL vira servidor http; o resto, um comando stdio. */
export function entryFromInput(input: string): Json {
	const text = input.trim();
	if (/^https?:\/\//i.test(text)) {
		try { new URL(text); } catch { throw new Error('URL inválida.'); }
		return { type: 'http', url: text };
	}
	const [command, ...args] = splitCommandLine(text);
	if (!command) { throw new Error('Informe um comando ou uma URL.'); }
	return { type: 'stdio', command, args };
}

// ---- Localização no arquivo ------------------------------------------------------------

/** Posição da chave `keyPath` num JSON, para abrir o arquivo na entrada certa. Indefinida se não achar. */
export function findJsonKey(text: string, keyPath: readonly string[]): number | undefined {
	let i = 0;
	const ws = () => { while (i < text.length && /\s/.test(text[i])) { i++; } };
	const str = (): string => {
		let out = ''; i++;
		while (i < text.length && text[i] !== '"') {
			if (text[i] === '\\') {
				const n = text[i + 1];
				if (n === 'u') { out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16)); i += 6; continue; }
				out += ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' } as Record<string, string>)[n] ?? n; i += 2; continue;
			}
			out += text[i++];
		}
		i++;
		return out;
	};
	const value = (depth: number, matching: boolean): number | undefined => {
		ws();
		const ch = text[i];
		if (ch === '{' || ch === '[') {
			const object = ch === '{', close = object ? '}' : ']';
			i++; ws();
			if (text[i] === close) { i++; return undefined; }
			for (;;) {
				let hit = false;
				if (object) {
					ws(); const at = i; const key = str(); ws(); i++;
					hit = matching && key === keyPath[depth];
					if (hit && depth === keyPath.length - 1) { return at; }
				}
				const found = value(depth + 1, hit);
				if (found !== undefined) { return found; }
				ws();
				if (text[i] === ',') { i++; continue; }
				i++;
				return undefined;
			}
		}
		if (ch === '"') { str(); return undefined; }
		while (i < text.length && !/[,}\]\s]/.test(text[i])) { i++; }
		return undefined;
	};
	return keyPath.length ? value(0, true) : undefined;
}

export function lineAt(text: string, offset: number): { line: number; character: number } {
	const before = text.slice(0, offset);
	const line = (before.match(/\n/g) ?? []).length;
	return { line, character: offset - (before.lastIndexOf('\n') + 1) };
}
