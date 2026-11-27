// Adapter do Codex: `codex exec --json`, com o login do ChatGPT da pessoa.
// O prompt entra pelo stdin (`-` no lugar do prompt); os argumentos são fixos e vão em lista.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveOnPath, runFile, type ProcResult } from '../proc';
import type { Provider, RunResult, WorkPacket } from '../types';
import { loadQuotaFixtures, matchesQuotaFixtures } from './quota';

export const PROBE_FLAG = '--zzz-orquestra-probe';

export interface CodexOptions {
	bin?: string;
	timeoutMs: number;
	env?: NodeJS.ProcessEnv;
}

/** Chaves que tirariam o worker do login do ChatGPT, e marcas de estar dentro de outra sessão do Codex. */
const API_KEY_ENV = ['OPENAI_API_KEY', 'CODEX_API_KEY'];
const NESTED_ENV = ['CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'CODEX_THREAD_ID'];

export function codexEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const env = { ...base };
	for (const k of NESTED_ENV) delete env[k];
	if (base.ORQUESTRA_ALLOW_API_KEY !== '1') for (const k of API_KEY_ENV) delete env[k];
	return env;
}

function versionKey(name: string): number[] {
	const m = /(\d+)\.(\d+)\.(\d+)/.exec(name);
	return m ? m.slice(1).map(Number) : [0, 0, 0];
}

/** Procura `codex` dentro de `bin/` da extensão, em qualquer subpasta de plataforma. */
function findInExtension(extRoot: string, exe: string): string | undefined {
	const bin = path.join(extRoot, 'bin');
	const direct = path.join(bin, exe);
	if (fs.existsSync(direct)) return direct;
	let subdirs: string[] = [];
	try {
		subdirs = fs.readdirSync(bin);
	} catch {
		return undefined;
	}
	for (const sub of subdirs) {
		const candidate = path.join(bin, sub, exe);
		if (fs.existsSync(candidate)) return candidate;
	}
	return undefined;
}

/** Binário que o adapter usa: variável, PATH e, por fim, o que vem na extensão do Codex no editor. */
export function findCodex(env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (env.ORQUESTRA_CODEX_BIN) return env.ORQUESTRA_CODEX_BIN;
	const onPath = resolveOnPath('codex', env.PATH ?? '');
	if (onPath) return onPath;
	const exe = process.platform === 'win32' ? 'codex.exe' : 'codex';
	const bundled: { bin: string; key: number[] }[] = [];
	for (const root of ['.vscode', '.cursor', '.vscode-insiders', '.windsurf']) {
		const extDir = path.join(os.homedir(), root, 'extensions');
		let names: string[] = [];
		try {
			names = fs.readdirSync(extDir);
		} catch {
			continue;
		}
		for (const name of names) {
			if (!name.startsWith('openai.chatgpt-')) continue;
			const bin = findInExtension(path.join(extDir, name), exe);
			if (bin) bundled.push({ bin, key: versionKey(name) });
		}
	}
	bundled.sort((a, b) => b.key[0] - a.key[0] || b.key[1] - a.key[1] || b.key[2] - a.key[2]);
	return bundled[0]?.bin;
}

/**
 * O planner roda com sandbox só leitura; o worker, com escrita só na pasta do repositório e sem rede.
 * O `codex exec` não tem teto de turnos: o limite de cada chamada é o timeout do projeto.
 * O Codex também não filtra comandos por padrão como o `allowBash` do Claude: o shell dele fica preso ao sandbox.
 */
export function buildArgs(packet: Pick<WorkPacket, 'readOnly'>): string[] {
	return [
		'exec',
		'--json',
		'--ephemeral',
		'--color',
		'never',
		'--sandbox',
		packet.readOnly ? 'read-only' : 'workspace-write',
		'-c',
		'approval_policy=never',
		'-',
	];
}

/** Todas as flags que o adapter usa, mais uma inexistente antes do prompt: o parser cita só ela se aceitou as outras. */
export function probeArgs(): string[] {
	return ['exec', '--json', '--ephemeral', '--color', 'never', '--sandbox', 'workspace-write', '-c', 'approval_policy=never', PROBE_FLAG, '-'];
}

export function parseVersion(text: string): string | undefined {
	return /(\d+)\.(\d+)\.(\d+)/.exec(text)?.[0];
}

function firstLine(text: string): string {
	return (text.split(/\r?\n/).find((l) => l.trim()) ?? '').trim().slice(0, 200);
}

interface CodexEvent {
	type?: string;
	message?: string;
	error?: { message?: string };
	item?: { type?: string; text?: string };
	usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number; reasoning_output_tokens?: number };
}

/** Traduz o JSONL do `codex exec --json` para o resultado comum. */
export function parseCodexOutput(proc: ProcResult, timeoutMs: number): RunResult {
	const raw = [proc.stdout, proc.stderr].filter(Boolean).join('\n');
	const base = { stderr: proc.stderr, durationMs: proc.durationMs, raw };
	if (proc.timedOut) return { ...base, exitCode: null, output: '', error: `codex timed out after ${Math.round(timeoutMs / 1000)}s` };
	if (proc.spawnError) return { ...base, exitCode: null, output: '', error: `could not start codex: ${proc.spawnError}` };

	let events = 0;
	let message = '';
	let turns = 0;
	let failed: string | undefined;
	let lastError: string | undefined;
	let usage: { inputTokens: number; outputTokens: number } | undefined;
	for (const line of proc.stdout.split(/\r?\n/)) {
		const t = line.trim();
		if (!t.startsWith('{')) continue;
		let ev: CodexEvent;
		try {
			ev = JSON.parse(t) as CodexEvent;
		} catch {
			continue;
		}
		if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') continue;
		events++;
		if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && typeof ev.item.text === 'string') {
			message = ev.item.text;
		} else if (ev.type === 'turn.completed') {
			turns++;
			const u = ev.usage;
			if (u) {
				usage ??= { inputTokens: 0, outputTokens: 0 };
				// `input_tokens` já inclui o que veio do cache.
				usage.inputTokens += u.input_tokens ?? 0;
				usage.outputTokens += u.output_tokens ?? 0;
			}
		} else if (ev.type === 'turn.failed') {
			failed = ev.error?.message ?? 'turn failed';
		} else if (ev.type === 'error') {
			lastError = ev.message ?? ev.error?.message;
		}
	}

	if (!events) {
		return {
			...base,
			exitCode: proc.exitCode === 0 ? 1 : proc.exitCode,
			output: proc.stdout,
			error: `codex returned no JSON events${firstLine(raw) ? `: ${firstLine(raw)}` : ''}`,
		};
	}
	// Um `error` solto (reconexão, aviso) não derruba uma rodada que terminou.
	const ok = proc.exitCode === 0 && !failed && turns > 0;
	const reason = failed ?? lastError ?? (turns ? `exit ${String(proc.exitCode)}` : 'the turn never completed');
	return {
		...base,
		exitCode: ok ? 0 : proc.exitCode || 1,
		output: message,
		error: ok ? undefined : `codex failed: ${firstLine(reason)}`,
		usage,
		turns: turns || undefined,
	};
}

export class CodexProvider implements Provider {
	readonly id = 'codex' as const;
	private readonly fixtures = loadQuotaFixtures('codex');
	private readonly env: NodeJS.ProcessEnv;
	private checked: Promise<{ ok: boolean; reason?: string }> | undefined;
	private bin: string | undefined;

	constructor(private readonly opts: CodexOptions) {
		this.env = codexEnv(opts.env ?? process.env);
	}

	/** Lê a versão, confere as flags e o tipo de login, uma vez por processo. Nenhuma chamada de modelo acontece aqui. */
	available(): Promise<{ ok: boolean; reason?: string }> {
		this.checked ??= this.check();
		return this.checked;
	}

	private async check(): Promise<{ ok: boolean; reason?: string }> {
		const bin = this.opts.bin ?? findCodex(this.opts.env ?? process.env);
		if (!bin) return { ok: false, reason: 'codex was not found (install the Codex CLI, put it on PATH, or set ORQUESTRA_CODEX_BIN)' };
		const cwd = os.tmpdir();
		const v = await runFile(bin, ['--version'], { cwd, timeoutMs: 30_000, env: this.env });
		const version = parseVersion(v.stdout + v.stderr);
		if (v.spawnError || !version) {
			return { ok: false, reason: `could not read the codex version from ${bin}: ${v.spawnError ?? firstLine(v.stdout + v.stderr)}` };
		}
		const probe = await runFile(bin, probeArgs(), { cwd, timeoutMs: 30_000, env: this.env });
		const said = probe.stdout + probe.stderr;
		if (!said.includes(`'${PROBE_FLAG}'`)) {
			return { ok: false, reason: `codex ${version} rejected a flag the adapter uses: ${firstLine(said) || `exit ${String(probe.exitCode)}`}` };
		}
		const login = await runFile(bin, ['login', 'status'], { cwd, timeoutMs: 30_000, env: this.env });
		const loginText = firstLine(login.stdout + login.stderr);
		if (login.exitCode !== 0) {
			return { ok: false, reason: `codex is not logged in (run \`codex login\`)${loginText ? `: ${loginText}` : ''}` };
		}
		if (/api key/i.test(login.stdout + login.stderr) && this.env.ORQUESTRA_ALLOW_API_KEY !== '1') {
			return { ok: false, reason: 'codex is logged in with an API key, not a ChatGPT plan; run `codex login` with your ChatGPT account, or set ORQUESTRA_ALLOW_API_KEY=1' };
		}
		this.bin = bin;
		return { ok: true };
	}

	async run(packet: WorkPacket): Promise<RunResult> {
		const status = await this.available();
		if (!status.ok || !this.bin) throw new Error(status.reason ?? 'codex is not available');
		const proc = await runFile(this.bin, buildArgs(packet), {
			cwd: packet.cwd,
			input: packet.prompt,
			timeoutMs: this.opts.timeoutMs,
			env: this.env,
		});
		return parseCodexOutput(proc, this.opts.timeoutMs);
	}

	isQuotaError(result: RunResult): boolean {
		return matchesQuotaFixtures([result.raw, result.output, result.stderr, result.error].filter(Boolean).join('\n'), this.fixtures);
	}
}
