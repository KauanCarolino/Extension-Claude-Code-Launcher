#!/usr/bin/env node
// orquestra plan | run | status | resume | list | drop | providers
import * as readline from 'node:readline/promises';
import { repoRoot } from './git';
import * as fs from 'node:fs';
import { acquireLock, dropJob, listJobs, loadJob } from './job';
import { killActiveChildren } from './proc';
import { loadProject } from './project';
import { GhPublisher } from './pr';
import { ClaudeProvider } from './providers/claude';
import { CodexProvider } from './providers/codex';
import { createJob, DirtyTreeError, planJob, resumeJob, runJob, type Context } from './runner';
import { formatList, formatPlan, formatStatus } from './status';
import { PROVIDER_IDS, type Job, type ProjectConfig, type Provider, type ProviderId } from './types';

const USAGE = `Usage:
  orquestra providers [--json]
  orquestra plan "<request>" [--provider claude|codex]
  orquestra run "<request>" [--yes] [--pr] [--provider claude|codex]
  orquestra status [id] [--json]
  orquestra resume [id] [--yes] [--discard] [--pr]
  orquestra list [--json]
  orquestra drop <id>

  --stdin reads the request of plan/run from standard input instead of the arguments.
  --json prints machine-readable output for list, status and providers.`;

interface Args {
	command: string;
	positional: string[];
	flags: Set<string>;
	provider?: ProviderId;
}

function parseArgs(argv: string[]): Args {
	const [command = 'help', ...rest] = argv;
	const positional: string[] = [];
	const flags = new Set<string>();
	let provider: ProviderId | undefined;
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i];
		if (a === '--provider') {
			const v = rest[++i];
			if (!PROVIDER_IDS.includes(v as ProviderId)) throw new Error(`--provider must be one of ${PROVIDER_IDS.join(', ')}`);
			provider = v as ProviderId;
		} else if (a.startsWith('--')) {
			if (!['--yes', '--pr', '--discard', '--json', '--stdin'].includes(a)) throw new Error(`Unknown option ${a}`);
			flags.add(a);
		} else {
			positional.push(a);
		}
	}
	return { command, positional, flags, provider };
}

function providers(project: ProjectConfig): Provider[] {
	return [
		new ClaudeProvider({ timeoutMs: project.modelTimeoutSec * 1000, allowBash: project.allowBash }),
		new CodexProvider({ timeoutMs: project.modelTimeoutSec * 1000 }),
	];
}

/** Terminou como pedido: teste verde, e PR aberto quando a tarefa pediu um. */
function finished(job: Job): boolean {
	if (job.state === 'pr_open' || job.state === 'planning') return true;
	return job.state === 'passed' && !(job.wantPr && !job.pr);
}

async function askConfirm(job: Job): Promise<boolean> {
	process.stdout.write(`\n${formatPlan(job)}\n\n`);
	if (!process.stdin.isTTY) return false;
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = await rl.question('Start editing with this plan? [y/N] ');
		return /^y(es)?$/i.test(answer.trim());
	} finally {
		rl.close();
	}
}

function latest(cwd: string): Job {
	const job = listJobs(cwd)[0];
	if (!job) throw new Error('No jobs in .orquestra/jobs.');
	return job;
}

async function main(argv: string[]): Promise<number> {
	const args = parseArgs(argv);
	if (args.command === 'help' || args.command === '--help' || args.command === '-h') {
		process.stdout.write(`${USAGE}\n`);
		return 0;
	}
	const cwd = await repoRoot(process.cwd());
	const yes = args.flags.has('--yes');
	const project = loadProject(cwd);
	const ctx: Context = {
		cwd,
		providers: providers(project),
		project,
		log: (m) => process.stderr.write(`${m}\n`),
		confirmPlan: async (job) => (yes ? true : askConfirm(job)),
		publisher: new GhPublisher({ remote: project.remote, draft: project.prDraft }),
	};
	const pr = args.flags.has('--pr');
	const json = args.flags.has('--json');
	// A interface do editor manda o pedido pelo stdin: texto longo, aspas e quebras de linha chegam intactos.
	const request = () => (args.flags.has('--stdin') ? fs.readFileSync(0, 'utf8') : args.positional.join(' '));

	switch (args.command) {
		case 'plan': {
			const job = await createJob(ctx, request(), args.provider);
			const lock = acquireLock(cwd, job.id);
			try {
				await planJob(ctx, job);
			} finally {
				lock.release();
			}
			process.stdout.write(
				job.plan
					? `${formatPlan(job)}\n\nNothing was edited. Run \`orquestra resume ${job.id}\` to confirm and start.\n`
					: `${formatStatus(job, new Date())}\n`,
			);
			return job.plan ? 0 : 1;
		}
		case 'run': {
			if (pr) {
				// Antes de criar a tarefa: sem `gh` com login, nenhuma cota é gasta.
				const status = await ctx.publisher?.available();
				if (!status?.ok) throw new Error(`--pr cannot open a pull request: ${status?.reason ?? 'gh is unavailable'}`);
			}
			const job = await createJob(ctx, request(), args.provider);
			await runJob(ctx, job, { discard: false, pr });
			process.stdout.write(`${formatStatus(job, new Date())}\n`);
			return finished(job) ? 0 : 1;
		}
		case 'resume': {
			const id = args.positional[0] ?? latest(cwd).id;
			const job = await resumeJob(ctx, id, { discard: args.flags.has('--discard'), pr });
			process.stdout.write(`${formatStatus(job, new Date())}\n`);
			return finished(job) ? 0 : 1;
		}
		case 'status': {
			const job = args.positional[0] ? loadJob(cwd, args.positional[0]) : latest(cwd);
			process.stdout.write(json ? `${JSON.stringify(job)}\n` : `${formatStatus(job, new Date())}\n`);
			return 0;
		}
		case 'list':
			process.stdout.write(json ? `${JSON.stringify(listJobs(cwd))}\n` : `${formatList(listJobs(cwd))}\n`);
			return 0;
		case 'drop': {
			const id = args.positional[0];
			if (!id) throw new Error('drop needs a job id');
			dropJob(cwd, id);
			process.stdout.write(`Job ${id} dropped. Nothing had been edited.\n`);
			return 0;
		}
		case 'providers': {
			// Versão e flags de cada CLI, sem nenhuma chamada de modelo.
			const statuses = await Promise.all(ctx.providers.map(async (p) => ({ id: p.id, ...(await p.available()) })));
			const any = statuses.some((s) => s.ok);
			// O `gh` só importa para `--pr`; ele não muda o código de saída.
			const gh = await ctx.publisher?.available();
			if (json) {
				process.stdout.write(`${JSON.stringify({ providers: statuses, gh: gh ?? { ok: false, reason: 'not configured' }, defaultProvider: project.defaultProvider })}\n`);
				return any ? 0 : 1;
			}
			for (const s of statuses) process.stdout.write(`${s.id.padEnd(7)} ${s.ok ? 'ready' : `unavailable — ${s.reason ?? ''}`}\n`);
			if (gh) process.stdout.write(`${'gh'.padEnd(7)} ${gh.ok ? 'ready (for --pr)' : `unavailable — ${gh.reason ?? ''}`}\n`);
			return any ? 0 : 1;
		}
		default:
			process.stderr.write(`Unknown command ${args.command}\n${USAGE}\n`);
			return 2;
	}
}

// Ctrl+C no terminal ou "Parar" no editor: o modelo e o teste rodam em grupo próprio e precisam ser mortos aqui.
// O passo interrompido fica `running` sem commit; `resume` o devolve para pending.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, () => {
		killActiveChildren();
		process.stderr.write(`orquestra: stopped (${signal}). Run \`orquestra resume\` to continue; add --discard to drop a half-done edit.\n`);
		process.exit(130);
	});
}

main(process.argv.slice(2)).then(
	(code) => {
		process.exitCode = code;
	},
	(err: unknown) => {
		process.stderr.write(`orquestra: ${(err as Error).message || String(err)}\n`);
		process.exitCode = err instanceof DirtyTreeError ? 3 : 1;
	},
);
