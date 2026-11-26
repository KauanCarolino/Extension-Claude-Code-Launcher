#!/usr/bin/env node
// orquestra plan | run | status | resume | list
import * as readline from 'node:readline/promises';
import { repoRoot } from './git';
import { acquireLock, listJobs, loadJob } from './job';
import { loadProject } from './project';
import { ClaudeProvider } from './providers/claude';
import { PendingProvider } from './providers/pending';
import { createJob, DirtyTreeError, planJob, resumeJob, runJob, type Context } from './runner';
import { formatList, formatPlan, formatStatus } from './status';
import { PROVIDER_IDS, type Job, type ProjectConfig, type Provider, type ProviderId } from './types';

const USAGE = `Usage:
  orquestra providers
  orquestra plan "<request>" [--provider claude|codex]
  orquestra run "<request>" [--yes] [--pr] [--provider claude|codex]
  orquestra status [id]
  orquestra resume [id] [--yes] [--discard]
  orquestra list`;

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
			if (!['--yes', '--pr', '--discard'].includes(a)) throw new Error(`Unknown option ${a}`);
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
		new PendingProvider('codex', 3),
	];
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
	};

	switch (args.command) {
		case 'plan': {
			const request = args.positional.join(' ');
			const job = await createJob(ctx, request, args.provider);
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
			if (args.flags.has('--pr')) throw new Error('--pr arrives in phase 4. Run without it for now.');
			const job = await createJob(ctx, args.positional.join(' '), args.provider);
			await runJob(ctx, job, { discard: false });
			process.stdout.write(`${formatStatus(job, new Date())}\n`);
			return job.state === 'passed' || job.state === 'pr_open' || job.state === 'planning' ? 0 : 1;
		}
		case 'resume': {
			const id = args.positional[0] ?? latest(cwd).id;
			const job = await resumeJob(ctx, id, { discard: args.flags.has('--discard') });
			process.stdout.write(`${formatStatus(job, new Date())}\n`);
			return job.state === 'passed' || job.state === 'pr_open' || job.state === 'planning' ? 0 : 1;
		}
		case 'status': {
			const job = args.positional[0] ? loadJob(cwd, args.positional[0]) : latest(cwd);
			process.stdout.write(`${formatStatus(job, new Date())}\n`);
			return 0;
		}
		case 'list':
			process.stdout.write(`${formatList(listJobs(cwd))}\n`);
			return 0;
		case 'providers': {
			// Versão e flags de cada CLI, sem nenhuma chamada de modelo.
			let any = false;
			for (const p of ctx.providers) {
				const s = await p.available();
				any ||= s.ok;
				process.stdout.write(`${p.id.padEnd(7)} ${s.ok ? 'ready' : `unavailable — ${s.reason ?? ''}`}\n`);
			}
			return any ? 0 : 1;
		}
		default:
			process.stderr.write(`Unknown command ${args.command}\n${USAGE}\n`);
			return 2;
	}
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
