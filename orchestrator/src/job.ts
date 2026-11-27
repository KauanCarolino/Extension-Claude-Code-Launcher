// O job em disco: `.orquestra/jobs/<id>.json`, gravado a cada transição.
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { orquestraDir } from './project';
import type { Job, JobState, ProviderId } from './types';

export function jobsDir(cwd: string): string {
	return path.join(orquestraDir(cwd), 'jobs');
}

export function jobFile(cwd: string, id: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid job id: ${id}`);
	return path.join(jobsDir(cwd), `${id}.json`);
}

export function slugify(text: string): string {
	const slug = text
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40)
		.replace(/-+$/g, '');
	return slug || 'tarefa';
}

export function newJobId(now: Date): string {
	const stamp = now.toISOString().slice(0, 10).replace(/-/g, '');
	return `${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

export interface NewJobInput {
	request: string;
	baseBranch: string;
	baseCommit: string;
	preferredProvider: ProviderId;
	now: Date;
}

export function newJob(input: NewJobInput): Job {
	const id = newJobId(input.now);
	const slug = slugify(input.request);
	const at = input.now.toISOString();
	return {
		version: 1,
		id,
		slug,
		request: input.request,
		createdAt: at,
		updatedAt: at,
		state: 'planning',
		branch: `orquestra/${id}-${slug}`,
		baseBranch: input.baseBranch,
		baseCommit: input.baseCommit,
		preferredProvider: input.preferredProvider,
		planConfirmed: false,
		planAttempts: 0,
		steps: [],
		repairCycles: 0,
		quota: {},
		timing: { modelMs: {}, testMs: 0, quotaWaitMs: 0 },
		budget: { inputTokensEstimate: 0, calls: 0 },
		calibrationRecorded: false,
		events: [{ at, state: 'planning', note: 'created' }],
	};
}

/** Escrita atômica: um processo morto no meio nunca deixa um job pela metade. */
export function saveJob(cwd: string, job: Job, now: Date): void {
	job.updatedAt = now.toISOString();
	const file = jobFile(cwd, job.id);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(job, null, 2)}\n`);
	fs.renameSync(tmp, file);
}

export function loadJob(cwd: string, id: string): Job {
	const file = jobFile(cwd, id);
	if (!fs.existsSync(file)) throw new Error(`Job ${id} not found in .orquestra/jobs`);
	const job = JSON.parse(fs.readFileSync(file, 'utf8')) as Job;
	if (job.version !== 1) throw new Error(`Job ${id} has unknown schema version ${String(job.version)}`);
	return job;
}

export function listJobs(cwd: string): Job[] {
	const dir = jobsDir(cwd);
	if (!fs.existsSync(dir)) return [];
	const jobs: Job[] = [];
	for (const name of fs.readdirSync(dir)) {
		if (!name.endsWith('.json')) continue;
		try {
			jobs.push(loadJob(cwd, name.slice(0, -5)));
		} catch {
			// Um job ilegível não impede listar os outros.
		}
	}
	return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Muda o estado, grava o evento e mantém a conta de espera de cota separada do tempo de modelo. */
export function transition(job: Job, state: JobState, now: Date, note?: string): void {
	const at = now.toISOString();
	if (job.state === 'blocked_quota' && state !== 'blocked_quota' && job.timing.quotaSince) {
		job.timing.quotaWaitMs += Math.max(0, now.getTime() - Date.parse(job.timing.quotaSince));
		job.timing.quotaSince = undefined;
	}
	if (state === 'blocked_quota' && job.state !== 'blocked_quota') {
		job.timing.quotaSince = at;
	}
	job.state = state;
	job.reason = state === 'needs_human' || state === 'blocked_quota' || state === 'blocked_test' ? note : undefined;
	if (state === 'passed' || state === 'pr_open') job.timing.endedAt = at;
	job.events.push(note ? { at, state, note } : { at, state });
}

export interface Lock {
	release(): void;
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/** Impede dois `run`/`resume` na mesma tarefa. Um lock de processo morto é retomado. */
export function acquireLock(cwd: string, id: string): Lock {
	const file = jobFile(cwd, id).replace(/\.json$/, '.lock');
	fs.mkdirSync(path.dirname(file), { recursive: true });
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = fs.openSync(file, 'wx');
			fs.writeSync(fd, String(process.pid));
			fs.closeSync(fd);
			let released = false;
			return {
				release() {
					if (released) return;
					released = true;
					try {
						fs.unlinkSync(file);
					} catch {}
				},
			};
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
			const owner = Number.parseInt(fs.readFileSync(file, 'utf8'), 10);
			if (Number.isInteger(owner) && owner > 0 && pidAlive(owner)) {
				throw new Error(`Job ${id} is already running in process ${owner}`);
			}
			try {
				fs.unlinkSync(file);
			} catch {}
		}
	}
	throw new Error(`Could not lock job ${id}`);
}

/** Apaga uma tarefa que ainda não editou nada: sem plano confirmado, nenhum branch foi criado. */
export function dropJob(cwd: string, id: string): void {
	const lock = acquireLock(cwd, id);
	try {
		const job = loadJob(cwd, id);
		if (job.planConfirmed) {
			throw new Error(`Job ${id} already started editing on ${job.branch}; it cannot be dropped. Delete the branch yourself if you no longer want it.`);
		}
		fs.rmSync(jobFile(cwd, id), { force: true });
		fs.rmSync(path.join(jobsDir(cwd), `${id}.runs`), { recursive: true, force: true });
	} finally {
		lock.release();
	}
}

export function wallMs(job: Job, now: Date): number {
	const end = job.timing.endedAt ? Date.parse(job.timing.endedAt) : now.getTime();
	return Math.max(0, end - Date.parse(job.createdAt));
}

export function quotaWaitMs(job: Job, now: Date): number {
	const open = job.timing.quotaSince ? Math.max(0, now.getTime() - Date.parse(job.timing.quotaSince)) : 0;
	return job.timing.quotaWaitMs + open;
}
