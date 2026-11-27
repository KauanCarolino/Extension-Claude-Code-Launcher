// `.orquestra/project.json`: a convenção do projeto, a única peça que vai para o git.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PROVIDER_IDS, type ProjectConfig, type ProviderId } from './types';

/** Segredos nunca entram no pacote nem num commit, no mesmo espírito do launcher. */
export const DEFAULT_DENY: readonly string[] = [
	'**/.env',
	'**/.env.*',
	'**/*.pem',
	'**/*.key',
	'**/*.p12',
	'**/*.pfx',
	'**/id_rsa',
	'**/id_ed25519',
	'**/*credential*',
];

export const DEFAULT_PROJECT: ProjectConfig = {
	test: 'npm test',
	baseBranch: 'main',
	maxRepairCycles: 2,
	testTimeoutSec: 900,
	modelTimeoutSec: 1800,
	defaultProvider: 'claude',
	deny: [...DEFAULT_DENY],
	allowBash: [],
	remote: 'origin',
	prDraft: false,
};

export function orquestraDir(cwd: string): string {
	return path.join(cwd, '.orquestra');
}

export function loadProject(cwd: string): ProjectConfig {
	const file = path.join(orquestraDir(cwd), 'project.json');
	if (!fs.existsSync(file)) {
		return { ...DEFAULT_PROJECT, deny: [...DEFAULT_PROJECT.deny], allowBash: [] };
	}
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch (err) {
		throw new Error(`.orquestra/project.json is not valid JSON: ${(err as Error).message}`);
	}
	return parseProject(raw);
}

export function parseProject(raw: unknown): ProjectConfig {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new Error('.orquestra/project.json must be an object');
	}
	const r = raw as Record<string, unknown>;
	const out: ProjectConfig = { ...DEFAULT_PROJECT, deny: [...DEFAULT_PROJECT.deny], allowBash: [] };
	if (r.test !== undefined) out.test = commandField(r.test, 'test');
	if (r.check !== undefined) out.check = commandField(r.check, 'check');
	if (r.baseBranch !== undefined) {
		if (typeof r.baseBranch !== 'string' || !r.baseBranch) throw new Error('baseBranch must be a non-empty string');
		out.baseBranch = r.baseBranch;
	}
	if (r.maxRepairCycles !== undefined) {
		// O teto do plano é dois reparos; o projeto pode pedir menos, nunca mais.
		if (!Number.isInteger(r.maxRepairCycles) || (r.maxRepairCycles as number) < 0 || (r.maxRepairCycles as number) > 2) {
			throw new Error('maxRepairCycles must be an integer from 0 to 2');
		}
		out.maxRepairCycles = r.maxRepairCycles as number;
	}
	if (r.testTimeoutSec !== undefined) {
		if (!Number.isInteger(r.testTimeoutSec) || (r.testTimeoutSec as number) < 1) throw new Error('testTimeoutSec must be a positive integer');
		out.testTimeoutSec = r.testTimeoutSec as number;
	}
	if (r.modelTimeoutSec !== undefined) {
		if (!Number.isInteger(r.modelTimeoutSec) || (r.modelTimeoutSec as number) < 1) throw new Error('modelTimeoutSec must be a positive integer');
		out.modelTimeoutSec = r.modelTimeoutSec as number;
	}
	if (r.allowBash !== undefined) {
		if (!Array.isArray(r.allowBash) || !r.allowBash.every((c) => typeof c === 'string' && c.trim())) {
			throw new Error('allowBash must be a list of command patterns');
		}
		for (const c of r.allowBash as string[]) {
			// Commit, push e PR são do orquestrador; nenhum padrão libera isso para o worker.
			if (/^\s*(git|gh)\b/i.test(c)) throw new Error(`allowBash cannot include git or gh commands: ${c}`);
		}
		out.allowBash = (r.allowBash as string[]).map((c) => c.trim());
	}
	if (r.remote !== undefined) {
		if (typeof r.remote !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(r.remote) || r.remote.startsWith('-')) {
			throw new Error('remote must be the name of a git remote');
		}
		out.remote = r.remote;
	}
	if (r.prDraft !== undefined) {
		if (typeof r.prDraft !== 'boolean') throw new Error('prDraft must be true or false');
		out.prDraft = r.prDraft;
	}
	if (r.defaultProvider !== undefined) {
		if (!PROVIDER_IDS.includes(r.defaultProvider as ProviderId)) throw new Error(`defaultProvider must be one of ${PROVIDER_IDS.join(', ')}`);
		out.defaultProvider = r.defaultProvider as ProviderId;
	}
	if (r.deny !== undefined) {
		if (!Array.isArray(r.deny) || !r.deny.every((d) => typeof d === 'string' && d.length > 0)) {
			throw new Error('deny must be a list of glob strings');
		}
		// A lista do projeto soma à padrão: um project.json não consegue liberar segredo.
		out.deny = [...new Set([...DEFAULT_DENY, ...(r.deny as string[])])];
	}
	return out;
}

function commandField(value: unknown, name: string): string | string[] {
	if (typeof value === 'string' && value.trim()) return value;
	if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string')) return value as string[];
	throw new Error(`${name} must be a command string or a non-empty list of arguments`);
}

export function commandLabel(cmd: string | string[]): string {
	return Array.isArray(cmd) ? cmd.join(' ') : cmd;
}

/** Glob mínimo: `**` atravessa pastas, `*` e `?` ficam dentro de um segmento. Sem diferença de caixa. */
export function globToRegExp(glob: string): RegExp {
	let re = '';
	const g = glob.replace(/\\/g, '/');
	for (let i = 0; i < g.length; i++) {
		const c = g[i];
		if (c === '*') {
			if (g[i + 1] === '*') {
				const slash = g[i + 2] === '/';
				re += slash ? '(?:.*/)?' : '.*';
				i += slash ? 2 : 1;
			} else {
				re += '[^/]*';
			}
		} else if (c === '?') {
			re += '[^/]';
		} else {
			re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
		}
	}
	return new RegExp(`^${re}$`, 'i');
}

export function isDenied(file: string, deny: readonly string[]): boolean {
	const normalized = file.replace(/\\/g, '/').replace(/^\.\//, '');
	return deny.some((d) => globToRegExp(d).test(normalized));
}

/** O arquivo está entre os permitidos do passo? Uma entrada terminada em `/` libera a pasta. */
export function isAllowed(file: string, allowed: readonly string[]): boolean {
	const f = file.replace(/\\/g, '/').toLowerCase();
	return allowed.some((a) => {
		const n = a.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
		if (n.endsWith('/')) return f.startsWith(n);
		if (/[*?]/.test(n)) return globToRegExp(n).test(f);
		return f === n;
	});
}
