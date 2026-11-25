import * as path from 'node:path';
import { readText } from './catalog';
import { HOOK_NAME } from './hooks';
import { m, t } from './i18n';
import { redactArgs } from './mcp';

/**
 * Permissões e hooks configurados para o Claude Code, por escopo de `settings.json`:
 * - `local`: `.claude/settings.local.json` do projeto (só você);
 * - `project`: `.claude/settings.json` do projeto (compartilhado pelo repositório);
 * - `user`: `settings.json` da pasta de configuração do Claude (todos os seus projetos);
 * - `managed`: `managed-settings.json` da organização, somente leitura e com prioridade.
 * Sem dependência do VS Code, para ser testável.
 */
export type SettingsScope = 'local' | 'project' | 'user' | 'managed';
export type PermissionKind = 'allow' | 'ask' | 'deny';
export const PERMISSION_KINDS: readonly PermissionKind[] = ['allow', 'ask', 'deny'];

export interface SettingsSource {
	scope: SettingsScope;
	file: string;
	/** Nome curto do arquivo para mensagens (".claude/settings.json"). */
	label: string;
}

export interface PermissionRule {
	id: string;
	/** A regra como está no arquivo, por exemplo `Bash(npm test:*)`. */
	name: string;
	scope: SettingsScope;
	kind: PermissionKind;
	state: 'active';
	file: string;
	keyPath: string[];
	/** Outra regra igual num tipo que vence este (deny vence ask, que vence allow). */
	shadowedBy?: PermissionKind;
	note: string;
}

export interface HookHandlerInfo {
	id: string;
	/** Comando ou prompt, sem segredos aparentes. */
	name: string;
	scope: SettingsScope;
	state: 'active' | 'disabled';
	event: string;
	matcher: string;
	type: string;
	file: string;
	keyPath: string[];
	/** Criado pelo registro de mudanças deste launcher. */
	launcher: boolean;
	note: string;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const MAX_SETTINGS = 2 * 1024 * 1024;
const RANK: Record<PermissionKind, number> = { allow: 0, ask: 1, deny: 2 };
const KIND_LABEL: Record<PermissionKind, string> = { allow: m('permitir'), ask: m('perguntar'), deny: m('negar') };

export function permissionKindLabel(kind: PermissionKind): string { return t(KIND_LABEL[kind]); }

async function readSettings(source: SettingsSource, problems: string[]): Promise<Json | undefined> {
	try {
		const read = await readText(source.file, MAX_SETTINGS);
		if (read.kind === 'absent') { return undefined; }
		const value: unknown = JSON.parse(read.text.replace(/^﻿/, ''));
		if (isObject(value)) { return value; }
	} catch (error) {
		if (!(error instanceof SyntaxError)) { problems.push(`${source.label}: ${error instanceof Error ? error.message : String(error)}`); return undefined; }
	}
	problems.push(t('{0} não é um JSON válido.', source.label));
	return undefined;
}

/** Regras de `permissions.allow/ask/deny` de cada escopo e o `defaultMode` declarado. */
export async function loadPermissions(sources: readonly SettingsSource[]): Promise<{ items: PermissionRule[]; problems: string[]; modes: Array<{ scope: SettingsScope; mode: string }> }> {
	const problems: string[] = [], items: PermissionRule[] = [], modes: Array<{ scope: SettingsScope; mode: string }> = [];
	for (const source of sources) {
		const settings = await readSettings(source, problems);
		const permissions = settings?.permissions;
		if (!isObject(permissions)) { continue; }
		if (typeof permissions.defaultMode === 'string' && permissions.defaultMode) { modes.push({ scope: source.scope, mode: permissions.defaultMode.slice(0, 64) }); }
		for (const kind of PERMISSION_KINDS) {
			for (const rule of [...new Set(strings(permissions[kind]))]) {
				items.push({ id: `${source.scope}:${kind}:${rule}`, name: rule, scope: source.scope, kind, state: 'active', file: source.file, keyPath: ['permissions', kind], note: '' });
			}
		}
	}
	for (const item of items) {
		const winner = items.filter((other) => other.name === item.name && RANK[other.kind] > RANK[item.kind]).sort((a, b) => RANK[b.kind] - RANK[a.kind])[0];
		if (winner) {
			item.shadowedBy = winner.kind;
			item.note = t('A mesma regra também está em "{0}", que vence.', permissionKindLabel(winner.kind));
		}
	}
	return { items, problems, modes };
}

const LAUNCHER_PHASES = ['pre', 'post', 'turn-start', 'turn-end'];
const LEGACY_LAUNCHER_COMMAND = new RegExp(`/${HOOK_NAME.replace(/\./g, '\\.')}" (?:${LAUNCHER_PHASES.join('|')})$`);

/** O handler foi criado pelo registro de mudanças: o script do launcher com uma das fases dele. */
export function isLauncherHook(handler: Json): boolean {
	const args = strings(handler.args);
	if (args.length === 2 && args[0].replace(/\\/g, '/').endsWith(`/${HOOK_NAME}`) && LAUNCHER_PHASES.includes(args[1])) { return true; }
	return handler.args === undefined && typeof handler.command === 'string' && LEGACY_LAUNCHER_COMMAND.test(handler.command.replace(/\\/g, '/'));
}

function clip(text: string, max = 200): string { return text.length > max ? `${text.slice(0, max - 1)}…` : text; }

/** Como mostrar o handler: comando com argumentos sem segredos aparentes, ou o começo do prompt. */
function describeHandler(handler: Json): string {
	if (typeof handler.command === 'string' && handler.command) {
		return clip([handler.command, ...redactArgs(strings(handler.args))].join(' '));
	}
	if (typeof handler.prompt === 'string') { return clip(handler.prompt.replace(/\s+/g, ' ').trim(), 120); }
	return t('(sem comando)');
}

/** Hooks de cada escopo, um item por handler, com evento, matcher e se é do próprio launcher. */
export async function loadHooks(sources: readonly SettingsSource[]): Promise<{ items: HookHandlerInfo[]; problems: string[] }> {
	const problems: string[] = [], items: HookHandlerInfo[] = [];
	for (const source of sources) {
		const settings = await readSettings(source, problems);
		if (!settings) { continue; }
		const disabled = settings.disableAllHooks === true;
		if (disabled) { problems.push(t('{0} desliga todos os hooks (disableAllHooks).', source.label)); }
		if (settings.hooks === undefined) { continue; }
		if (!isObject(settings.hooks)) { problems.push(t('A seção "hooks" de {0} não é um objeto.', source.label)); continue; }
		for (const [event, groups] of Object.entries(settings.hooks)) {
			if (!Array.isArray(groups)) { problems.push(t('O evento "{0}" de {1} não é uma lista.', event, source.label)); continue; }
			groups.forEach((group, groupIndex) => {
				if (!isObject(group) || !Array.isArray(group.hooks)) { return; }
				const matcher = typeof group.matcher === 'string' ? group.matcher : '';
				group.hooks.forEach((handler, handlerIndex) => {
					if (!isObject(handler)) { return; }
					const launcher = isLauncherHook(handler);
					items.push({ id: `${source.scope}:${event}:${groupIndex}:${handlerIndex}`, name: describeHandler(handler), scope: source.scope,
						state: disabled ? 'disabled' : 'active', event: clip(event, 64), matcher: clip(matcher, 80), type: typeof handler.type === 'string' ? clip(handler.type, 32) : '?',
						file: source.file, keyPath: ['hooks', event], launcher,
						note: launcher ? t('Criado pelo registro de mudanças do launcher. Use Ativar ou Desligar registro de mudanças.') : '' });
				});
			});
		}
	}
	return { items, problems };
}

// ---- Alterações ------------------------------------------------------------------------

/** Mesma forma que o Claude Code aceita: ferramenta, opcionalmente com um especificador entre parênteses. */
export function validPermissionRule(rule: string): boolean {
	return rule.length > 0 && rule.length <= 512 && !/[\u0000-\u001f\u007f]/.test(rule) && /^[A-Za-z_][\w.*-]*(?:\(.+\))?$/.test(rule.trim()) && rule === rule.trim();
}

function parseForEdit(text: string | undefined, label: string): Json {
	if (text === undefined) { return {}; }
	let value: unknown;
	try { value = JSON.parse(text.replace(/^﻿/, '')); } catch { throw new Error(t('{0} não é um JSON válido. Corrija o arquivo antes.', label)); }
	if (!isObject(value)) { throw new Error(t('{0} não contém um objeto JSON.', label)); }
	return value;
}

function permissionList(settings: Json, kind: PermissionKind, label: string): string[] {
	if (settings.permissions === undefined) { settings.permissions = {}; }
	if (!isObject(settings.permissions)) { throw new Error(t('"permissions" em {0} não é um objeto.', label)); }
	const current = settings.permissions[kind];
	if (current !== undefined && (!Array.isArray(current) || current.some((item) => typeof item !== 'string'))) {
		throw new Error(t('"permissions.{0}" em {1} não é uma lista de regras.', kind, label));
	}
	return (current as string[] | undefined) ?? [];
}

const serialize = (value: Json) => `${JSON.stringify(value, null, 2)}\n`;

export function planAddPermission(text: string | undefined, label: string, kind: PermissionKind, rule: string): string {
	if (!validPermissionRule(rule)) { throw new Error(t('Use o formato do Claude Code, por exemplo Bash(npm test:*) ou Read(./src/**).')); }
	const settings = parseForEdit(text, label), list = permissionList(settings, kind, label);
	if (list.includes(rule)) { throw new Error(t('A regra "{0}" já está em {1}.', rule, label)); }
	(settings.permissions as Json)[kind] = [...list, rule];
	return serialize(settings);
}

export function planRemovePermission(text: string | undefined, label: string, kind: PermissionKind, rule: string): string {
	const settings = parseForEdit(text, label), list = permissionList(settings, kind, label);
	if (!list.includes(rule)) { throw new Error(t('A regra "{0}" não está mais em {1}.', rule, label)); }
	const permissions = settings.permissions as Json, next = list.filter((item) => item !== rule);
	if (next.length) { permissions[kind] = next; } else { delete permissions[kind]; }
	if (!Object.keys(permissions).length) { delete settings.permissions; }
	return serialize(settings);
}

/** Os quatro arquivos de configurações, do mais específico ao da organização. */
export function settingsSources(options: { project?: string; configDir: string; managedDir: string }): SettingsSource[] {
	const sources: SettingsSource[] = [];
	if (options.project) {
		sources.push({ scope: 'local', file: path.join(options.project, '.claude', 'settings.local.json'), label: '.claude/settings.local.json' });
		sources.push({ scope: 'project', file: path.join(options.project, '.claude', 'settings.json'), label: '.claude/settings.json' });
	}
	sources.push({ scope: 'user', file: path.join(options.configDir, 'settings.json'), label: t('settings.json do usuário') });
	sources.push({ scope: 'managed', file: path.join(options.managedDir, 'managed-settings.json'), label: 'managed-settings.json' });
	return sources;
}
