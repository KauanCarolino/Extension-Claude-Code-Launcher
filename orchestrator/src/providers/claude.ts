// Adapter do Claude Code: `claude -p --output-format json --max-turns N`, com o login da assinatura da pessoa.
// O prompt entra pelo stdin; os argumentos são fixos e vão em lista.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveOnPath, runFile, type ProcResult } from '../proc';
import type { Provider, RunResult, WorkPacket } from '../types';
import { loadQuotaFixtures, matchesQuotaFixtures } from './quota';

/** Versões principais cujas flags este adapter conhece. Outra versão recusa com mensagem clara. */
export const SUPPORTED_MAJORS: readonly number[] = [2];
export const PROBE_FLAG = '--zzz-orquestra-probe';

const READ_TOOLS = 'Read,Glob,Grep';
const EDIT_TOOLS = 'Read,Edit,Write,Glob,Grep';
/** Mesmo com Bash liberado, commit, push e PR continuam fora do alcance do worker. */
const ALWAYS_DENIED = 'Bash(git *),Bash(gh *)';

export interface ClaudeOptions {
	bin?: string;
	timeoutMs: number;
	allowBash: readonly string[];
	env?: NodeJS.ProcessEnv;
}

/** Variáveis que tirariam o worker da assinatura (chave de API) ou o fariam se achar dentro de outra sessão. */
const STRIPPED_ENV = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT'];

export function workerEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const env = { ...base };
	for (const k of STRIPPED_ENV) delete env[k];
	if (base.ORQUESTRA_ALLOW_API_KEY !== '1') delete env.ANTHROPIC_API_KEY;
	return env;
}

function versionKey(dirName: string): number[] {
	const m = /(\d+)\.(\d+)\.(\d+)/.exec(dirName);
	return m ? m.slice(1).map(Number) : [0, 0, 0];
}

/** Binário que o adapter usa: variável, PATH, instalação nativa e, por fim, o que vem na extensão do editor. */
export function findClaude(env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (env.ORQUESTRA_CLAUDE_BIN) return env.ORQUESTRA_CLAUDE_BIN;
	const onPath = resolveOnPath('claude', env.PATH ?? '');
	if (onPath) return onPath;
	const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
	const native = path.join(os.homedir(), '.local', 'bin', exe);
	if (fs.existsSync(native)) return native;
	const bundled: { dir: string; key: number[] }[] = [];
	for (const root of ['.vscode', '.cursor', '.vscode-insiders', '.windsurf']) {
		const extDir = path.join(os.homedir(), root, 'extensions');
		let names: string[] = [];
		try {
			names = fs.readdirSync(extDir);
		} catch {
			continue;
		}
		for (const name of names) {
			if (!name.startsWith('anthropic.claude-code-')) continue;
			const bin = path.join(extDir, name, 'resources', 'native-binary', exe);
			if (fs.existsSync(bin)) bundled.push({ dir: bin, key: versionKey(name) });
		}
	}
	bundled.sort((a, b) => b.key[0] - a.key[0] || b.key[1] - a.key[1] || b.key[2] - a.key[2]);
	return bundled[0]?.dir;
}

export function buildArgs(packet: Pick<WorkPacket, 'maxTurns' | 'readOnly'>, allowBash: readonly string[]): string[] {
	const args = ['-p', '--output-format', 'json', '--max-turns', String(packet.maxTurns), '--no-session-persistence', '--permission-prompts', 'none'];
	if (packet.readOnly) {
		// Sem ferramenta de escrita na lista, o planner não tem como editar.
		args.push('--permission-mode', 'dontAsk', '--tools', READ_TOOLS);
		return args;
	}
	args.push('--permission-mode', 'acceptEdits', '--tools', allowBash.length ? `${EDIT_TOOLS},Bash` : EDIT_TOOLS);
	if (allowBash.length) {
		args.push('--allowedTools', allowBash.map((c) => `Bash(${c})`).join(','), '--disallowedTools', ALWAYS_DENIED);
	}
	return args;
}

/** Todas as flags que o adapter usa, mais uma inexistente: se o erro citar só ela, as outras foram aceitas. */
export function probeArgs(): string[] {
	return [
		'-p', '--output-format', 'json', '--max-turns', '1', '--no-session-persistence', '--permission-prompts', 'none',
		'--permission-mode', 'acceptEdits', '--tools', 'Read', '--allowedTools', 'Read', '--disallowedTools', 'Bash(git *)',
		PROBE_FLAG,
	];
}

export function parseVersion(text: string): { major: number; label: string } | undefined {
	const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
	return m ? { major: Number(m[1]), label: m[0] } : undefined;
}

function firstLine(text: string): string {
	return (text.split(/\r?\n/).find((l) => l.trim()) ?? '').trim().slice(0, 200);
}

interface ClaudeJson {
	type?: string;
	subtype?: string;
	is_error?: boolean;
	result?: unknown;
	num_turns?: number;
	usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}

function findJson(stdout: string): ClaudeJson | undefined {
	const text = stdout.trim();
	const tryParse = (s: string) => {
		try {
			const v = JSON.parse(s) as unknown;
			return v && typeof v === 'object' && !Array.isArray(v) ? (v as ClaudeJson) : undefined;
		} catch {
			return undefined;
		}
	};
	const whole = tryParse(text);
	if (whole) return whole;
	const lines = text.split(/\r?\n/).reverse();
	for (const l of lines) {
		if (!l.trim().startsWith('{')) continue;
		const v = tryParse(l.trim());
		if (v && v.type === 'result') return v;
	}
	return undefined;
}

/** Traduz a saída do `claude -p --output-format json` para o resultado comum. */
export function parseClaudeOutput(proc: ProcResult, timeoutMs: number): RunResult {
	const raw = [proc.stdout, proc.stderr].filter(Boolean).join('\n');
	const base = { stderr: proc.stderr, durationMs: proc.durationMs, raw };
	if (proc.timedOut) return { ...base, exitCode: null, output: '', error: `claude timed out after ${Math.round(timeoutMs / 1000)}s` };
	if (proc.spawnError) return { ...base, exitCode: null, output: '', error: `could not start claude: ${proc.spawnError}` };
	const json = findJson(proc.stdout);
	if (!json) {
		return {
			...base,
			exitCode: proc.exitCode === 0 ? 1 : proc.exitCode,
			output: proc.stdout,
			error: `claude returned no JSON result${firstLine(raw) ? `: ${firstLine(raw)}` : ''}`,
		};
	}
	const text = typeof json.result === 'string' ? json.result : '';
	const ok = proc.exitCode === 0 && json.is_error !== true && (json.subtype === undefined || json.subtype === 'success');
	const u = json.usage;
	return {
		...base,
		exitCode: ok ? 0 : proc.exitCode || 1,
		output: text,
		error: ok ? undefined : `claude ${json.subtype ?? 'error'}${text ? `: ${firstLine(text)}` : ''}`,
		usage: u
			? {
					inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
					outputTokens: u.output_tokens ?? 0,
				}
			: undefined,
		turns: typeof json.num_turns === 'number' ? json.num_turns : undefined,
	};
}

export class ClaudeProvider implements Provider {
	readonly id = 'claude' as const;
	private readonly fixtures = loadQuotaFixtures('claude');
	private readonly env: NodeJS.ProcessEnv;
	private checked: Promise<{ ok: boolean; reason?: string }> | undefined;
	private bin: string | undefined;

	constructor(private readonly opts: ClaudeOptions) {
		this.env = workerEnv(opts.env ?? process.env);
	}

	/** Lê a versão e confere as flags uma vez por processo. Nenhuma chamada de modelo acontece aqui. */
	available(): Promise<{ ok: boolean; reason?: string }> {
		this.checked ??= this.check();
		return this.checked;
	}

	private async check(): Promise<{ ok: boolean; reason?: string }> {
		const bin = this.opts.bin ?? findClaude(this.opts.env ?? process.env);
		if (!bin) return { ok: false, reason: 'claude was not found (install Claude Code, put it on PATH, or set ORQUESTRA_CLAUDE_BIN)' };
		const cwd = os.tmpdir();
		const v = await runFile(bin, ['--version'], { cwd, timeoutMs: 30_000, env: this.env });
		const version = parseVersion(v.stdout);
		if (v.spawnError || !version) {
			return { ok: false, reason: `could not read the claude version from ${bin}: ${v.spawnError ?? firstLine(v.stdout + v.stderr)}` };
		}
		if (!SUPPORTED_MAJORS.includes(version.major) && this.env.ORQUESTRA_CLAUDE_ANY_VERSION !== '1') {
			return {
				ok: false,
				reason: `claude ${version.label} is a version this adapter does not know (it supports ${SUPPORTED_MAJORS.map((m) => `${m}.x`).join(', ')}); update the orchestrator, or set ORQUESTRA_CLAUDE_ANY_VERSION=1 at your own risk`,
			};
		}
		const probe = await runFile(bin, probeArgs(), { cwd, timeoutMs: 30_000, env: this.env });
		const said = probe.stdout + probe.stderr;
		if (!said.includes(`'${PROBE_FLAG}'`)) {
			return { ok: false, reason: `claude ${version.label} rejected a flag the adapter uses: ${firstLine(said) || `exit ${String(probe.exitCode)}`}` };
		}
		this.bin = bin;
		return { ok: true };
	}

	async run(packet: WorkPacket): Promise<RunResult> {
		const status = await this.available();
		if (!status.ok || !this.bin) throw new Error(status.reason ?? 'claude is not available');
		const proc = await runFile(this.bin, buildArgs(packet, this.opts.allowBash), {
			cwd: packet.cwd,
			input: packet.prompt,
			timeoutMs: this.opts.timeoutMs,
			env: this.env,
		});
		return parseClaudeOutput(proc, this.opts.timeoutMs);
	}

	isQuotaError(result: RunResult): boolean {
		return matchesQuotaFixtures([result.raw, result.output, result.stderr, result.error].filter(Boolean).join('\n'), this.fixtures);
	}
}
