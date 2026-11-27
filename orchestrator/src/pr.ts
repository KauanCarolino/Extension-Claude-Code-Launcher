// Fase 4: depois do teste verde, o orquestrador (nunca o worker) envia o branch e abre o PR com o `gh` da pessoa.
// Retomar é seguro: o push não força nada e um PR aberto para o mesmo branch é reaproveitado.
import * as os from 'node:os';
import * as g from './git';
import { resolveOnPath, runFile } from './proc';
import { formatDuration } from './status';
import type { Job } from './types';

export interface Publisher {
	available(): Promise<{ ok: boolean; reason?: string }>;
	open(job: Job, cwd: string): Promise<{ url: string; reused: boolean }>;
}

export interface GhOptions {
	bin?: string;
	env?: NodeJS.ProcessEnv;
	remote: string;
	draft: boolean;
	timeoutMs?: number;
}

export function findGh(env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (env.ORQUESTRA_GH_BIN) return env.ORQUESTRA_GH_BIN;
	return resolveOnPath('gh', env.PATH ?? '');
}

export const TITLE_MAX = 72;

export function prTitle(job: Job): string {
	const text = (job.plan?.goal || job.request).split(/\r?\n/)[0].trim();
	return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX - 1).trimEnd()}…` : text;
}

export function prBody(job: Job): string {
	const lines: string[] = ['## Request', '', job.request, ''];
	if (job.plan) {
		lines.push('## Steps', '');
		for (const s of job.steps) {
			lines.push(`- ${s.commit ? `\`${s.commit.slice(0, 8)}\` ` : ''}${s.title}${s.provider ? ` (${s.provider})` : ''}`);
		}
		if (job.repairCycles) lines.push(`- ${job.repairCycles} repair cycle(s) after the first test run`);
		lines.push('');
	}
	if (job.lastTest) {
		const t = job.lastTest;
		lines.push('## Test', '', `\`${t.command}\` ${t.passed ? 'passed' : 'failed'} (exit ${String(t.exitCode)}, ${formatDuration(t.durationMs)}) on the last commit of this branch.`, '');
	}
	lines.push('---', '', `Opened by orquestra, job \`${job.id}\`. Each commit carries the \`${g.JOB_TRAILER}\` and \`${g.STEP_TRAILER}\` trailers.`);
	return `${lines.join('\n')}\n`;
}

/** URL do PR na saída do `gh pr create`: a última linha que é um link. */
export function parsePrUrl(stdout: string): string | undefined {
	return stdout
		.split(/\r?\n/)
		.map((l) => l.trim())
		.reverse()
		.find((l) => /^https?:\/\/\S+$/.test(l));
}

function firstLine(text: string): string {
	return (text.split(/\r?\n/).find((l) => l.trim()) ?? '').trim().slice(0, 200);
}

export class GhPublisher implements Publisher {
	private checked: Promise<{ ok: boolean; reason?: string }> | undefined;
	private bin: string | undefined;
	private readonly env: NodeJS.ProcessEnv;
	private readonly timeoutMs: number;

	constructor(private readonly opts: GhOptions) {
		this.env = opts.env ?? process.env;
		this.timeoutMs = opts.timeoutMs ?? 120_000;
	}

	/** Confere que o `gh` existe e tem login. Nada é enviado aqui. */
	available(): Promise<{ ok: boolean; reason?: string }> {
		this.checked ??= this.check();
		return this.checked;
	}

	private async check(): Promise<{ ok: boolean; reason?: string }> {
		const bin = this.opts.bin ?? findGh(this.env);
		if (!bin) return { ok: false, reason: 'gh was not found (install the GitHub CLI, put it on PATH, or set ORQUESTRA_GH_BIN)' };
		const auth = await runFile(bin, ['auth', 'status'], { cwd: os.tmpdir(), timeoutMs: 30_000, env: this.env });
		if (auth.spawnError) return { ok: false, reason: `could not start gh: ${auth.spawnError}` };
		if (auth.exitCode !== 0) return { ok: false, reason: `gh is not logged in (run \`gh auth login\`): ${firstLine(auth.stderr + auth.stdout)}` };
		this.bin = bin;
		return { ok: true };
	}

	private async gh(cwd: string, args: string[], input?: string) {
		return runFile(this.bin as string, args, { cwd, timeoutMs: this.timeoutMs, env: this.env, input });
	}

	async open(job: Job, cwd: string): Promise<{ url: string; reused: boolean }> {
		const status = await this.available();
		if (!status.ok || !this.bin) throw new Error(status.reason ?? 'gh is not available');
		if (!(await g.remoteExists(cwd, this.opts.remote))) throw new Error(`the remote "${this.opts.remote}" does not exist in this repository`);
		if ((await g.currentBranch(cwd)) !== job.branch) throw new Error(`the checked-out branch is not ${job.branch}`);

		// Sem `--force`: se o branch remoto divergiu, a pessoa decide.
		await g.pushBranch(cwd, this.opts.remote, job.branch);

		const view = await this.gh(cwd, ['pr', 'view', job.branch, '--json', 'url,state']);
		if (view.exitCode === 0) {
			try {
				const pr = JSON.parse(view.stdout) as { url?: string; state?: string };
				if (pr.url && pr.state === 'OPEN') return { url: pr.url, reused: true };
			} catch {
				// Saída inesperada: segue para criar.
			}
		}

		const args = ['pr', 'create', '--base', job.baseBranch, '--head', job.branch, '--title', prTitle(job), '--body-file', '-'];
		if (this.opts.draft) args.push('--draft');
		const created = await this.gh(cwd, args, prBody(job));
		if (created.timedOut) throw new Error('gh pr create timed out');
		if (created.spawnError) throw new Error(`could not start gh: ${created.spawnError}`);
		const url = parsePrUrl(created.stdout);
		if (created.exitCode !== 0 || !url) {
			throw new Error(`gh pr create failed (exit ${String(created.exitCode)}): ${firstLine(created.stderr + created.stdout)}`);
		}
		return { url, reused: false };
	}
}
