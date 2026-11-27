// O dono do fluxo. Os modelos só executam o passo que ele entrega; quem commita e testa é ele.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildPacket } from './budget';
import { calibrationFile, loadCalibration, recordOutcome, saveCalibration } from './calibrate';
import * as g from './git';
import { acquireLock, jobsDir, loadJob, newJob, saveJob, transition } from './job';
import { parsePlan } from './plan';
import type { Publisher } from './pr';
import { isAllowed, isDenied } from './project';
import { choosePath, otherProvider, pickProvider } from './router';
import type { Job, ProjectConfig, Provider, ProviderId, RunResult, Step, WorkPacket } from './types';
import { runCommand, verify } from './verify';

/** Falhas de tarefa no mesmo passo antes de parar para a pessoa. */
export const MAX_STEP_ATTEMPTS = 2;
export const MAX_PLAN_ATTEMPTS = 2;

export interface Context {
	/** Raiz do repositório. */
	cwd: string;
	providers: Provider[];
	project: ProjectConfig;
	now?: () => Date;
	log?: (message: string) => void;
	calibrationPath?: string;
	/** Parada antes da primeira edição. Sem ela (ou com `false`), a tarefa espera em `planning`. */
	confirmPlan?: (job: Job) => Promise<boolean>;
	/** Push e PR depois do teste verde (fase 4). Só é usado quando a tarefa pediu `--pr`. */
	publisher?: Publisher;
}

export class DirtyTreeError extends Error {
	constructor(readonly files: string[], hint: string) {
		super(`The working tree has uncommitted changes (${files.slice(0, 5).join(', ')}${files.length > 5 ? ', …' : ''}). ${hint}`);
	}
}

type Outcome = 'continue' | 'halted';

const nowOf = (ctx: Context) => (ctx.now ? ctx.now() : new Date());

function log(ctx: Context, message: string): void {
	ctx.log?.(message);
}

function save(ctx: Context, job: Job): void {
	saveJob(ctx.cwd, job, nowOf(ctx));
}

function note(ctx: Context, job: Job, text: string): void {
	job.events.push({ at: nowOf(ctx).toISOString(), state: job.state, note: text });
	log(ctx, text);
}

function firstLine(result: RunResult): string {
	const text = [result.error, result.stderr, result.output].filter(Boolean).join('\n');
	const line = text.split(/\r?\n/).find((l) => l.trim()) ?? '';
	return line.trim().slice(0, 200) || `exit code ${String(result.exitCode)}`;
}

export async function createJob(ctx: Context, request: string, provider?: ProviderId): Promise<Job> {
	if (!request.trim()) throw new Error('The request is empty');
	await g.excludeJobsDir(ctx.cwd);
	const dirty = await g.changedFiles(ctx.cwd);
	if (dirty.length) throw new DirtyTreeError(dirty, 'Commit or stash your work before starting a job.');
	const job = newJob({
		request: request.trim(),
		baseBranch: ctx.project.baseBranch,
		baseCommit: await g.head(ctx.cwd),
		preferredProvider: provider ?? ctx.project.defaultProvider,
		now: nowOf(ctx),
	});
	save(ctx, job);
	log(ctx, `Job ${job.id} created.`);
	return job;
}

/** Conta o tempo de modelo à parte de cada provedor e a estimativa de entrada. */
async function callProvider(ctx: Context, job: Job, provider: Provider, packet: WorkPacket): Promise<RunResult> {
	const started = Date.now();
	let result: RunResult;
	try {
		result = await provider.run(packet);
	} catch (err) {
		result = { exitCode: null, output: '', stderr: '', durationMs: Date.now() - started, error: (err as Error).message };
	}
	const elapsed = Date.now() - started;
	job.timing.modelMs[provider.id] = (job.timing.modelMs[provider.id] ?? 0) + elapsed;
	job.budget.inputTokensEstimate += packet.estimatedTokens;
	job.budget.calls += 1;
	if (result.usage) {
		job.budget.reportedInputTokens = (job.budget.reportedInputTokens ?? 0) + result.usage.inputTokens;
		job.budget.reportedOutputTokens = (job.budget.reportedOutputTokens ?? 0) + result.usage.outputTokens;
	}
	if (result.error || result.exitCode !== 0) saveFailedRun(ctx, job, provider.id, packet, result);
	return result;
}

/** Guarda a saída bruta de cada chamada que falhou: é dela que sai uma fixture de cota nova. */
function saveFailedRun(ctx: Context, job: Job, provider: ProviderId, packet: WorkPacket, result: RunResult): void {
	try {
		const dir = path.join(jobsDir(ctx.cwd), `${job.id}.runs`);
		fs.mkdirSync(dir, { recursive: true });
		const name = `${String(job.budget.calls).padStart(3, '0')}-${provider}-${packet.kind}${packet.step ? `-${packet.step.id}` : ''}.txt`;
		const body = [
			`exit: ${String(result.exitCode)}`,
			`error: ${result.error ?? ''}`,
			'--- raw',
			result.raw ?? [result.output, result.stderr].filter(Boolean).join('\n'),
		].join('\n');
		fs.writeFileSync(path.join(dir, name), body);
	} catch {
		// Falhar ao guardar o log nunca para a tarefa.
	}
}

function blockForQuota(ctx: Context, job: Job, provider: Provider, result: RunResult, where: string): void {
	const reason = firstLine(result);
	job.quota[provider.id] = { at: nowOf(ctx).toISOString(), reason };
	transition(job, 'blocked_quota', nowOf(ctx), `${provider.id} hit its quota during ${where}`);
	log(ctx, `${provider.id} hit its quota during ${where}.`);
}

/** Sem modelo para seguir: pausa por cota, ou para a pessoa se nenhum modelo sequer está instalado. */
function haltNoProvider(ctx: Context, job: Job, reasons: string[]): Outcome {
	const detail = reasons.join('; ') || 'no provider configured';
	if (Object.keys(job.quota).length) {
		if (job.state !== 'blocked_quota') transition(job, 'blocked_quota', nowOf(ctx), detail);
		else job.reason = detail;
		log(ctx, `Paused: ${detail}. Run \`orquestra resume ${job.id}\` later.`);
	} else {
		transition(job, 'needs_human', nowOf(ctx), `no provider available: ${detail}`);
		log(ctx, `Stopped: no provider available (${detail}).`);
	}
	save(ctx, job);
	return 'halted';
}

function stopForHuman(ctx: Context, job: Job, reason: string): Outcome {
	transition(job, 'needs_human', nowOf(ctx), reason);
	save(ctx, job);
	log(ctx, `Needs a person: ${reason}`);
	return 'halted';
}

// ---------------------------------------------------------------- plano

export async function planJob(ctx: Context, job: Job): Promise<Outcome> {
	let retryNote: string | undefined;
	while (!job.plan) {
		if (job.planAttempts >= MAX_PLAN_ATTEMPTS) {
			return stopForHuman(ctx, job, `the planner returned an invalid plan ${MAX_PLAN_ATTEMPTS} times${retryNote ? ` (${retryNote})` : ''}`);
		}
		const pick = await pickProvider(job, ctx.providers);
		if (!pick.provider) return haltNoProvider(ctx, job, pick.reasons);
		const provider = pick.provider;
		if (job.state !== 'planning') transition(job, 'planning', nowOf(ctx), `planning on ${provider.id}`);
		const packet = buildPacket({
			jobId: job.id,
			kind: 'plan',
			cwd: ctx.cwd,
			path: 'plan',
			goal: job.request,
			request: job.request,
			doneTitles: [],
			allowedFiles: [],
			deny: ctx.project.deny,
			retryNote,
		});
		log(ctx, `Planning with ${provider.id}…`);
		const result = await callProvider(ctx, job, provider, packet);
		// O planner é só leitura. A árvore ainda é o branch da pessoa, então nada é desfeito aqui.
		const touched = await g.changedFiles(ctx.cwd);
		if (touched.length) {
			return stopForHuman(ctx, job, `the planner edited files in read-only mode (${touched.join(', ')}); review and revert them, then resume`);
		}
		if (provider.isQuotaError(result)) {
			blockForQuota(ctx, job, provider, result, 'planning');
			save(ctx, job);
			continue;
		}
		if (result.error || result.exitCode !== 0) {
			job.planAttempts += 1;
			retryNote = `planner failed: ${firstLine(result)}`;
			save(ctx, job);
			continue;
		}
		try {
			const plan = parsePlan(result.output, ctx.project.deny);
			job.plan = plan;
			job.steps = plan.steps.map((s): Step => ({ ...s, status: 'pending', attempts: 0 }));
			note(ctx, job, `plan ready with ${plan.steps.length} step(s)`);
		} catch (err) {
			job.planAttempts += 1;
			retryNote = (err as Error).message;
		}
		save(ctx, job);
	}
	return 'continue';
}

// ---------------------------------------------------------------- passos

/** O branch é a verdade: commit do passo presente, passo feito. Passo rodando sem commit volta para pending. */
export async function reconcile(ctx: Context, job: Job): Promise<void> {
	const commits = await g.stepCommits(ctx.cwd, job.branch, job.baseCommit, job.id);
	const byStep = new Map(commits.map((c) => [c.stepId, c.sha]));
	for (const step of job.steps) {
		const sha = byStep.get(step.id);
		if (sha) {
			step.status = 'done';
			step.commit = sha;
		} else if (step.status !== 'pending') {
			step.status = 'pending';
			step.commit = undefined;
		}
	}
	const repairs = commits.filter((c) => c.stepId.startsWith('repair-')).length;
	job.repairCycles = Math.max(job.repairCycles, repairs);
}

async function shortCheck(ctx: Context): Promise<string | undefined> {
	if (!ctx.project.check) return undefined;
	const r = await runCommand(ctx.project.check, ctx.cwd, ctx.project.testTimeoutSec * 1000);
	if (r.exitCode === 0 && !r.timedOut) return undefined;
	const tail = r.output.trim().split(/\r?\n/).slice(-5).join(' | ');
	return `short check failed (${r.timedOut ? 'timeout' : `exit ${String(r.exitCode)}`}): ${tail}`;
}

async function executeSteps(ctx: Context, job: Job): Promise<Outcome> {
	const cal = loadCalibration(ctx.calibrationPath ?? calibrationFile());
	const retryNotes = new Map<string, string>();
	for (;;) {
		const step = job.steps.find((s) => s.status === 'pending');
		if (!step) return 'continue';
		const pick = await pickProvider(job, ctx.providers, { sticky: step.attempts > 0 ? step.provider : undefined });
		if (!pick.provider) return haltNoProvider(ctx, job, pick.reasons);
		const provider = pick.provider;
		if (job.state !== 'running') transition(job, 'running', nowOf(ctx), `step ${step.id} on ${provider.id}`);
		step.status = 'running';
		step.provider = provider.id;
		save(ctx, job);

		const before = await g.head(ctx.cwd);
		const path = choosePath(step, cal);
		const packet = buildPacket({
			jobId: job.id,
			kind: 'step',
			cwd: ctx.cwd,
			path,
			goal: job.plan?.goal ?? job.request,
			step,
			doneTitles: job.steps.filter((s) => s.status === 'done').map((s) => s.title),
			allowedFiles: step.files,
			deny: ctx.project.deny,
			retryNote: retryNotes.get(step.id),
		});
		log(ctx, `Step ${step.id} "${step.title}" on ${provider.id} (${path}, ${packet.maxTurns} turns, ~${packet.estimatedTokens} tokens)…`);
		const result = await callProvider(ctx, job, provider, packet);

		if ((await g.head(ctx.cwd)) !== before) {
			step.status = 'pending';
			return stopForHuman(ctx, job, `a commit appeared on ${job.branch} that the orchestrator did not create (step ${step.id}, ${provider.id})`);
		}

		if (provider.isQuotaError(result)) {
			await g.discardChanges(ctx.cwd);
			step.status = 'pending';
			blockForQuota(ctx, job, provider, result, `step ${step.id}`);
			save(ctx, job);
			continue;
		}

		const changed = await g.changedFiles(ctx.cwd);
		const denied = changed.filter((f) => isDenied(f, ctx.project.deny));
		if (denied.length) {
			await g.discardChanges(ctx.cwd);
			step.status = 'pending';
			return stopForHuman(ctx, job, `step ${step.id} touched denied files (${denied.join(', ')}); changes discarded`);
		}

		let failure: string | undefined;
		if (result.error || result.exitCode !== 0) failure = `worker failed: ${firstLine(result)}`;
		else if (!changed.length) failure = 'worker changed no files';
		else {
			const outside = step.files.length ? changed.filter((f) => !isAllowed(f, step.files)) : [];
			if (outside.length) failure = `changed files outside the step: ${outside.join(', ')}`;
			else failure = await shortCheck(ctx);
		}

		if (failure) {
			await g.discardChanges(ctx.cwd);
			step.status = 'pending';
			step.attempts += 1;
			retryNotes.set(step.id, failure);
			note(ctx, job, `step ${step.id} failed on ${provider.id}: ${failure}`);
			if (step.attempts >= MAX_STEP_ATTEMPTS) {
				return stopForHuman(ctx, job, `step ${step.id} failed ${step.attempts} times: ${failure}`);
			}
			save(ctx, job);
			continue;
		}

		step.commit = await g.commitFiles(ctx.cwd, changed, step.title, job.id, step.id);
		step.status = 'done';
		note(ctx, job, `step ${step.id} committed ${step.commit.slice(0, 8)}`);
		save(ctx, job);
	}
}

// ---------------------------------------------------------------- teste e reparo

type RepairResult = 'committed' | 'nochange' | 'halted';

async function repairOnce(ctx: Context, job: Job, cycle: number): Promise<RepairResult> {
	const last = [...job.steps].reverse().find((s) => s.provider)?.provider ?? job.preferredProvider;
	// No segundo reparo, o outro modelo vê só o diff, se estiver disponível.
	const prefer = cycle >= 2 ? otherProvider(last, ctx.providers) ?? last : last;
	for (;;) {
		const pick = await pickProvider(job, ctx.providers, { prefer });
		if (!pick.provider) {
			haltNoProvider(ctx, job, pick.reasons);
			return 'halted';
		}
		const provider = pick.provider;
		if (job.state === 'blocked_quota') transition(job, 'blocked_test', nowOf(ctx), `repair ${cycle} on ${provider.id}`);
		const before = await g.head(ctx.cwd);
		const allowed = [...new Set(job.steps.flatMap((s) => s.files))];
		const packet = buildPacket({
			jobId: job.id,
			kind: 'repair',
			cwd: ctx.cwd,
			path: 'repair',
			goal: job.plan?.goal ?? job.request,
			doneTitles: cycle >= 2 ? [] : job.steps.filter((s) => s.status === 'done').map((s) => s.title),
			allowedFiles: allowed,
			deny: ctx.project.deny,
			diff: await g.diffSince(ctx.cwd, job.baseCommit),
			testTail: job.lastTest?.tail,
		});
		log(ctx, `Repair ${cycle} on ${provider.id} (~${packet.estimatedTokens} tokens)…`);
		const result = await callProvider(ctx, job, provider, packet);

		if ((await g.head(ctx.cwd)) !== before) {
			stopForHuman(ctx, job, `a commit appeared on ${job.branch} that the orchestrator did not create (repair ${cycle}, ${provider.id})`);
			return 'halted';
		}
		if (provider.isQuotaError(result)) {
			await g.discardChanges(ctx.cwd);
			blockForQuota(ctx, job, provider, result, `repair ${cycle}`);
			save(ctx, job);
			continue;
		}
		const changed = await g.changedFiles(ctx.cwd);
		const denied = changed.filter((f) => isDenied(f, ctx.project.deny));
		if (denied.length) {
			await g.discardChanges(ctx.cwd);
			stopForHuman(ctx, job, `repair ${cycle} touched denied files (${denied.join(', ')}); changes discarded`);
			return 'halted';
		}
		if (result.error || result.exitCode !== 0 || !changed.length) {
			await g.discardChanges(ctx.cwd);
			note(ctx, job, `repair ${cycle} on ${provider.id} produced no usable change: ${changed.length ? firstLine(result) : 'no files changed'}`);
			return 'nochange';
		}
		const sha = await g.commitFiles(ctx.cwd, changed, `Repair ${cycle}: fix failing test`, job.id, `repair-${cycle}`);
		note(ctx, job, `repair ${cycle} committed ${sha.slice(0, 8)}`);
		return 'committed';
	}
}

async function verifyAndRepair(ctx: Context, job: Job): Promise<Outcome> {
	let runTest = true;
	for (;;) {
		if (runTest) {
			log(ctx, `Running the project test: ${Array.isArray(ctx.project.test) ? ctx.project.test.join(' ') : ctx.project.test}`);
			const test = await verify(ctx.project.test, ctx.cwd, ctx.project.testTimeoutSec, () => nowOf(ctx));
			job.lastTest = test;
			job.timing.testMs += test.durationMs;
			if (!job.calibrationRecorded) {
				// Só a primeira rodada conta: é ela que diz se a confiança declarada acertou.
				const file = ctx.calibrationPath ?? calibrationFile();
				saveCalibration(recordOutcome(loadCalibration(file), job.steps.map((s) => s.confidence), test.passed), file);
				job.calibrationRecorded = true;
			}
			save(ctx, job);
			if (test.passed) {
				transition(job, 'passed', nowOf(ctx), `test passed: ${test.command}`);
				save(ctx, job);
				log(ctx, `Test passed. Branch ${job.branch} is ready.`);
				return 'continue';
			}
			log(ctx, `Test failed (${test.timedOut ? 'timeout' : `exit ${String(test.exitCode)}`}).`);
		}
		if (job.repairCycles >= ctx.project.maxRepairCycles) {
			return stopForHuman(ctx, job, `the test still fails after ${job.repairCycles} repair cycle(s); branch ${job.branch} is kept`);
		}
		const cycle = job.repairCycles + 1;
		if (job.state !== 'blocked_test') transition(job, 'blocked_test', nowOf(ctx), `test failed; repair ${cycle}`);
		save(ctx, job);
		const outcome = await repairOnce(ctx, job, cycle);
		if (outcome === 'halted') return 'halted';
		job.repairCycles = cycle;
		save(ctx, job);
		runTest = outcome === 'committed';
	}
}

// ---------------------------------------------------------------- entradas

export interface RunOptions {
	/** Descarta mudanças deixadas por um passo interrompido, só no branch da própria tarefa. */
	discard?: boolean;
	/** Abre o PR depois do teste verde. Fica gravado na tarefa, então `resume` continua pedindo. */
	pr?: boolean;
}

// ---------------------------------------------------------------- PR

/** Recusa antes de qualquer chamada de modelo: sem `gh` com login, `--pr` gastaria cota à toa. */
async function ensurePublisher(ctx: Context): Promise<void> {
	if (!ctx.publisher) throw new Error('--pr needs a publisher, and none is configured');
	const status = await ctx.publisher.available();
	if (!status.ok) throw new Error(`--pr cannot open a pull request: ${status.reason ?? 'gh is unavailable'}`);
}

/** Envia o branch e abre o PR. Uma falha deixa a tarefa em `passed`, com o motivo, para `resume --pr`. */
async function publish(ctx: Context, job: Job): Promise<void> {
	const started = Date.now();
	try {
		if (!ctx.publisher) throw new Error('no publisher configured');
		log(ctx, `Pushing ${job.branch} and opening the pull request…`);
		const { url, reused } = await ctx.publisher.open(job, ctx.cwd);
		job.pr = { url };
		job.prError = undefined;
		transition(job, 'pr_open', nowOf(ctx), `${reused ? 'pull request already open' : 'pull request opened'}: ${url}`);
		log(ctx, `${reused ? 'Pull request already open' : 'Pull request opened'}: ${url}`);
	} catch (err) {
		job.prError = (err as Error).message;
		note(ctx, job, `could not open the pull request: ${job.prError}`);
		log(ctx, `The branch is tested; run \`orquestra resume ${job.id} --pr\` to try the pull request again.`);
	} finally {
		job.timing.testMs += Date.now() - started;
		save(ctx, job);
	}
}

async function ensureCleanOnBranch(ctx: Context, job: Job, opts: RunOptions): Promise<void> {
	const dirty = await g.changedFiles(ctx.cwd);
	if (!dirty.length) {
		await g.switchToBranch(ctx.cwd, job.branch, job.baseCommit);
		return;
	}
	const onJobBranch = (await g.currentBranch(ctx.cwd)) === job.branch;
	if (opts.discard && onJobBranch) {
		await g.discardChanges(ctx.cwd);
		note(ctx, job, `discarded leftover changes: ${dirty.join(', ')}`);
		return;
	}
	throw new DirtyTreeError(
		dirty,
		onJobBranch
			? `They may be left over from an interrupted step. Commit or stash them, or run \`orquestra resume ${job.id} --discard\` to drop them.`
			: 'Commit or stash your work before running the job.',
	);
}

/** Leva a tarefa até onde der: teste verde, pausa por cota ou parada para a pessoa. */
export async function runJob(ctx: Context, job: Job, opts: RunOptions = {}): Promise<Job> {
	const lock = acquireLock(ctx.cwd, job.id);
	try {
		return await drive(ctx, job, opts);
	} finally {
		lock.release();
	}
}

async function drive(ctx: Context, job: Job, opts: RunOptions): Promise<Job> {
	if (job.state === 'pr_open') return job;
	if (opts.pr && !job.wantPr) {
		job.wantPr = true;
		save(ctx, job);
	}
	if (job.wantPr) await ensurePublisher(ctx);
	if (job.state === 'passed') {
		if (job.wantPr && !job.pr) {
			await ensureCleanOnBranch(ctx, job, opts);
			await publish(ctx, job);
		}
		return job;
	}
	await g.excludeJobsDir(ctx.cwd);
	if (!job.plan) {
		if ((await g.changedFiles(ctx.cwd)).length) {
			throw new DirtyTreeError(await g.changedFiles(ctx.cwd), 'Commit or stash your work before planning.');
		}
		if ((await planJob(ctx, job)) === 'halted') return job;
	}
	if (!job.planConfirmed) {
		const ok = ctx.confirmPlan ? await ctx.confirmPlan(job) : false;
		if (!ok) {
			save(ctx, job);
			log(ctx, `Plan saved. Nothing was edited. Run \`orquestra resume ${job.id}\` to confirm and start.`);
			return job;
		}
		job.planConfirmed = true;
		note(ctx, job, 'plan confirmed');
		save(ctx, job);
	}
	await ensureCleanOnBranch(ctx, job, opts);
	await reconcile(ctx, job);
	save(ctx, job);
	if ((await executeSteps(ctx, job)) === 'halted') return job;
	if ((await verifyAndRepair(ctx, job)) === 'halted') return job;
	if (job.wantPr) await publish(ctx, job);
	return job;
}

/** Retomar: tenta de novo o mesmo modelo, nada é apagado e nenhum passo `done` é refeito. */
export async function resumeJob(ctx: Context, id: string, opts: RunOptions = {}): Promise<Job> {
	const lock = acquireLock(ctx.cwd, id);
	try {
		const job = loadJob(ctx.cwd, id);
		if (job.state === 'pr_open' || (job.state === 'passed' && !(opts.pr || job.wantPr))) {
			log(ctx, `Job ${id} is already ${job.state}.`);
			return job;
		}
		if (job.state === 'passed') {
			// Teste já verde: só falta o PR. Nada de modelo, nada de teste de novo.
			return await drive(ctx, job, opts);
		}
		job.quota = {};
		for (const step of job.steps) if (step.status !== 'done') step.attempts = 0;
		if (job.state === 'needs_human' && !job.plan) job.planAttempts = 0;
		note(ctx, job, 'resumed');
		save(ctx, job);
		return await drive(ctx, job, opts);
	} finally {
		lock.release();
	}
}
