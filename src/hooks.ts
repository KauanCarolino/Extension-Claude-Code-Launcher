/** Pure, conservative ownership and configuration of Claude command hooks. */
import * as crypto from 'node:crypto';

export const HOOK_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit';
export const HOOK_NAME = 'launcher-record-change.js';
/** Um handler próprio: evento do Claude Code, fase passada ao script e matcher do grupo (sem matcher nos eventos de turno). */
interface HandlerSpec { event: string; phase: string; matcher?: string }
/** Captura por chamada das ferramentas de edição: define se o registro está ativo. */
const EDIT_HANDLERS: readonly HandlerSpec[] = [{ event: 'PreToolUse', phase: 'pre', matcher: HOOK_MATCHER }, { event: 'PostToolUse', phase: 'post', matcher: HOOK_MATCHER }];
/** Captura do turno (o que comandos e outras ferramentas mudaram): opcional, junto do registro. */
const TURN_HANDLERS: readonly HandlerSpec[] = [{ event: 'UserPromptSubmit', phase: 'turn-start' }, { event: 'Stop', phase: 'turn-end' }];
const HANDLERS = [...EDIT_HANDLERS, ...TURN_HANDLERS];
const EVENTS = [...new Set(HANDLERS.map((spec) => spec.event))];
const MAX_SETTINGS_BYTES = 2 * 1024 * 1024;

export type SettingsRead = { kind: 'content'; text: string } | { kind: 'absent' } | { kind: 'error' };
export interface HookCapability {
	status: 'confirmed' | 'unknown' | 'unsupported';
	harness: string;
	version?: string;
	evidence?: string;
}
export interface HookOptions {
	read: SettingsRead;
	scriptPath: string;
	enable: boolean;
	capability: HookCapability;
	/** Exact paths whose previous installation ownership has been established. */
	knownScriptPaths?: readonly string[];
	executable?: string;
	/** Instala também os handlers do turno (UserPromptSubmit/Stop). Sem isso, eles são removidos. */
	turnCapture?: boolean;
}
export interface HookPlan {
	kind: 'ready' | 'blocked';
	code?: string;
	originalFingerprint: string | null;
	originalText?: string;
	nextText?: string;
	changed: boolean;
	active: boolean;
}

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function configFingerprint(text: string | undefined): string | null {
	return text === undefined ? null : crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function validPath(value: string): boolean {
	return value.length > 0 && value.length <= 8192 && !/[\u0000-\u001f\u007f]/.test(value)
		&& (/^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(value));
}

function ownHandler(value: unknown, phase: string, options: HookOptions): boolean {
	if (!object(value) || value.type !== 'command') {
		return false;
	}
	const paths = [options.scriptPath, ...(options.knownScriptPaths ?? [])];
	const executable = options.executable ?? 'node';
	if (Array.isArray(value.args)) {
		return value.command === executable && value.args.length === 2 && value.args[1] === phase
			&& paths.some((path) => value.args && (value.args as unknown[])[0] === path);
	}
	// Recognition only, never evaluation: the exact legacy descriptor we wrote.
	return value.args === undefined && paths.some((path) =>
		validPath(path) && value.command === `node "${path.replace(/\\/g, '/')}" ${phase}`);
}

function ambiguousHandler(value: unknown, phase: string, options: HookOptions): boolean {
	if (!object(value) || value.type !== 'command' || ownHandler(value, phase, options)) { return false; }
	if (Array.isArray(value.args) && typeof value.args[0] === 'string' && validPath(value.args[0])
		&& value.args[0].replace(/\\/g, '/').endsWith(`/${HOOK_NAME}`) && value.args[1] === phase) { return true; }
	return typeof value.command === 'string' && value.command.startsWith('node "')
		&& value.command.endsWith(`/${HOOK_NAME}" ${phase}`);
}

function parsedSettings(read: SettingsRead): { settings?: Record<string, unknown>; code?: string } {
	if (read.kind === 'error') {
		return { code: 'settingsReadFailed' };
	}
	if (read.kind === 'absent') {
		return { settings: {} };
	}
	if (new TextEncoder().encode(read.text).byteLength > MAX_SETTINGS_BYTES) {
		return { code: 'settingsBudgetExceeded' };
	}
	let value: unknown;
	try {
		value = JSON.parse(read.text.replace(/^\uFEFF/, ''));
	} catch {
		return { code: 'invalidSettingsJson' };
	}
	if (!object(value) || (value.hooks !== undefined && !object(value.hooks))) {
		return { code: 'invalidSettingsShape' };
	}
	const hooks = value.hooks;
	for (const event of EVENTS) {
		if (hooks?.[event] === undefined) {
			continue;
		}
		const groups = hooks[event];
		if (!Array.isArray(groups) || groups.some((group) => !object(group)
			|| !Array.isArray(group.hooks) || group.hooks.some((handler: unknown) => !object(handler))
			|| (group.matcher !== undefined && typeof group.matcher !== 'string'))) {
			return { code: 'invalidHookGroups' };
		}
	}
	return { settings: value };
}

export function planHooks(options: HookOptions): HookPlan {
	const originalText = options.read.kind === 'content' ? options.read.text : undefined;
	const base: HookPlan = {
		kind: 'blocked', originalFingerprint: configFingerprint(originalText), originalText,
		changed: false, active: false,
	};
	if (!validPath(options.scriptPath) || (options.executable !== undefined
		&& (!options.executable || /[\u0000-\u001f\u007f]/.test(options.executable)))) {
		return { ...base, code: 'invalidHookPath' };
	}
	const parsed = parsedSettings(options.read);
	if (!parsed.settings) {
		return { ...base, code: parsed.code };
	}
	const settings = parsed.settings;
	const hooks: Record<string, unknown> = { ...(settings.hooks as Record<string, unknown> | undefined) };
	if (ambiguousOwnership(hooks, options)) {
		return { ...base, code: 'ambiguousHookOwnership' };
	}
	base.active = EDIT_HANDLERS.every((spec) => present(hooks, spec, options));
	if (options.enable && options.capability.status !== 'confirmed') {
		return { ...base, code: 'execArgumentsNotConfirmed' };
	}
	for (const spec of HANDLERS) {
		const { event, phase } = spec;
		const groups = (hooks[event] as Record<string, unknown>[] | undefined) ?? [];
		const next: Record<string, unknown>[] = [];
		for (const group of groups) {
			if (group.matcher !== spec.matcher) {
				next.push(group);
				continue;
			}
			const handlers = group.hooks as unknown[];
			const kept = handlers.filter((handler) => !ownHandler(handler, phase, options));
			if (kept.length === handlers.length) {
				next.push(group);
			} else if (kept.length > 0) {
				next.push({ ...group, hooks: kept });
			}
		}
		if (options.enable && (EDIT_HANDLERS.includes(spec) || options.turnCapture === true)) {
			next.push({ ...(spec.matcher === undefined ? {} : { matcher: spec.matcher }), hooks: [{
				type: 'command', command: options.executable ?? 'node',
				args: [options.scriptPath, phase], timeout: 10,
			}] });
		}
		if (next.length > 0) {
			hooks[event] = next;
		} else {
			delete hooks[event];
		}
	}
	const next = { ...settings };
	if (Object.keys(hooks).length > 0) {
		next.hooks = hooks;
	} else {
		delete next.hooks;
	}
	const changed = JSON.stringify(settings) !== JSON.stringify(next);
	return {
		...base, kind: 'ready', changed, active: options.enable,
		nextText: changed ? `${JSON.stringify(next, null, 2)}\n` : originalText,
	};
}

/** Um handler próprio fora do grupo esperado, ou um parecido que esta instalação não criou. */
function ambiguousOwnership(hooks: Record<string, unknown> | undefined, options: HookOptions): boolean {
	return HANDLERS.some(({ event, phase, matcher }) => (hooks?.[event] as Record<string, unknown>[] | undefined)?.some((group) =>
		(group.hooks as unknown[]).some((handler) => ambiguousHandler(handler, phase, options)
			|| (group.matcher !== matcher && ownHandler(handler, phase, options)))) ?? false);
}

function present(hooks: Record<string, unknown> | undefined, spec: HandlerSpec, options: HookOptions): boolean {
	return (hooks?.[spec.event] as unknown[] | undefined)?.some((group) => object(group) && group.matcher === spec.matcher
		&& (group.hooks as unknown[]).some((handler) => ownHandler(handler, spec.phase, options))) ?? false;
}

export function inspectHookConfiguration(read: SettingsRead, scriptPath: string, knownScriptPaths: readonly string[] = []): {
	valid: boolean; active: boolean; turn: boolean; code?: string;
} {
	const parsed = parsedSettings(read);
	if (!parsed.settings || !validPath(scriptPath)) {
		return { valid: false, active: false, turn: false, code: parsed.code ?? 'invalidHookPath' };
	}
	const options: HookOptions = { read, scriptPath, knownScriptPaths, enable: false,
		capability: { status: 'unknown', harness: 'inspection' } };
	const hooks = parsed.settings.hooks as Record<string, unknown> | undefined;
	if (ambiguousOwnership(hooks, options)) {
		return { valid: false, active: false, turn: false, code: 'ambiguousHookOwnership' };
	}
	const active = EDIT_HANDLERS.every((spec) => present(hooks, spec, options));
	return { valid: true, active, turn: active && TURN_HANDLERS.every((spec) => present(hooks, spec, options)) };
}

export interface HookConfigIO {
	read(): Promise<SettingsRead>;
	assertOwnership(): Promise<void>;
	backup(text: string, fingerprint: string): Promise<void>;
	/** Write a new file/replace under supported local ownership; preserve recovery. */
	write(text: string, expectedFingerprint: string | null): Promise<void>;
}

export async function applyHookPlan(plan: HookPlan, io: HookConfigIO): Promise<{
	kind: 'persisted' | 'unchanged' | 'blocked' | 'conflict' | 'failed'; code?: string;
}> {
	if (plan.kind !== 'ready') {
		return { kind: 'blocked', code: plan.code };
	}
	if (!plan.changed) {
		return { kind: 'unchanged' };
	}
	const matches = (read: SettingsRead) => read.kind !== 'error'
		&& configFingerprint(read.kind === 'content' ? read.text : undefined) === plan.originalFingerprint;
	try {
		await io.assertOwnership();
		if (!matches(await io.read())) {
			return { kind: 'conflict', code: 'settingsChanged' };
		}
		if (plan.originalText !== undefined && plan.originalFingerprint !== null) {
			await io.backup(plan.originalText, plan.originalFingerprint);
		}
		await io.assertOwnership();
		if (!matches(await io.read())) {
			return { kind: 'conflict', code: 'settingsChanged' };
		}
		await io.write(plan.nextText ?? '{}\n', plan.originalFingerprint);
		const verified = await io.read();
		if (verified.kind !== 'content' || verified.text !== plan.nextText) {
			return { kind: 'failed', code: 'settingsVerificationFailed' };
		}
		return { kind: 'persisted' };
	} catch {
		return { kind: 'failed', code: 'settingsWriteFailed' };
	}
}
