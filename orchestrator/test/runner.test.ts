import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { stepCommits } from '../src/git';
import { acquireLock, loadJob, quotaWaitMs, saveJob } from '../src/job';
import { FakeProvider, type FakeScript } from '../src/providers/fake';
import { createJob, DirtyTreeError, resumeJob, runJob } from '../src/runner';
import type { WorkPacket } from '../src/types';
import { clock, context, git, makeRepo, planJson, project, read, step } from './helpers';

const twoSteps = planJson([step('1', ['a.txt']), step('2', ['b.txt'])]);
const stepCalls = (p: FakeProvider, id?: string) => p.calls.filter((c) => c.kind === 'step' && (!id || c.step?.id === id));

function writes(files: Record<string, string>): FakeScript {
	return (packet) => {
		if (packet.kind === 'plan') return { output: twoSteps };
		const id = packet.step?.id ?? '';
		return { files: id in files ? { [`${id === '1' ? 'a' : 'b'}.txt`]: files[id] } : {} };
	};
}

test('phase 0: a quota hit hands the step to the other model and the committed step never runs again', async () => {
	const cwd = makeRepo();
	const claude = new FakeProvider({
		id: 'claude',
		script: (p) => {
			if (p.kind === 'plan') return { output: twoSteps };
			if (p.step?.id === '1') return { files: { 'a.txt': 'A' } };
			// Edição pela metade e depois a cota: a metade não pode sobrar para o Codex.
			return { files: { 'b.txt': 'half' }, quota: true };
		},
	});
	const codex = new FakeProvider({ id: 'codex', script: writes({ '2': 'B' }) });
	const ctx = context(cwd, [claude, codex], project(['a.txt=A', 'b.txt=B']));

	const job = await runJob(ctx, await createJob(ctx, 'write a and b'));

	assert.equal(job.state, 'passed', job.reason);
	assert.deepEqual(stepCalls(claude).map((c) => c.step?.id), ['1', '2']);
	assert.deepEqual(stepCalls(codex).map((c) => c.step?.id), ['2']);
	assert.equal(job.steps[0].provider, 'claude');
	assert.equal(job.steps[1].provider, 'codex');
	assert.ok(job.quota.claude, 'claude quota is recorded');
	assert.ok(job.events.some((e) => e.state === 'blocked_quota'));
	// O Codex recebe o passo com os títulos já commitados, não a sessão do Claude.
	assert.deepEqual(stepCalls(codex)[0].doneTitles, ['Step 1']);
	assert.equal(git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), job.branch);
	assert.match(job.branch, /^orquestra\/\d{8}-[0-9a-f]{6}-write-a-and-b$/);
	const commits = await stepCommits(cwd, job.branch, job.baseCommit, job.id);
	assert.deepEqual(commits.map((c) => [c.stepId, c.subject]), [['1', 'Step 1'], ['2', 'Step 2']]);
	assert.equal(read(cwd, 'b.txt'), 'B');
	assert.equal(git(cwd, 'status', '--porcelain'), '', 'job files never dirty the tree');
	assert.ok((job.timing.modelMs.claude ?? -1) >= 0 && (job.timing.modelMs.codex ?? -1) >= 0);
	assert.ok(job.lastTest?.passed);
});

test('without the second model the job pauses, and resume retries the same model without redoing step 1', async () => {
	const cwd = makeRepo();
	let quotaOn = true;
	const claude = new FakeProvider({
		id: 'claude',
		script: (p) => {
			if (p.kind === 'plan') return { output: twoSteps };
			if (p.step?.id === '1') return { files: { 'a.txt': 'A' } };
			return quotaOn ? { quota: true } : { files: { 'b.txt': 'B' } };
		},
	});
	const codex = new FakeProvider({ id: 'codex', script: writes({}), unavailable: 'codex is not installed' });
	const c = clock();
	const ctx = context(cwd, [claude, codex], project(['a.txt=A', 'b.txt=B']), { now: c.now });

	let job = await runJob(ctx, await createJob(ctx, 'write a and b'));
	assert.equal(job.state, 'blocked_quota');
	assert.deepEqual(job.steps.map((s) => s.status), ['done', 'pending']);
	assert.equal(codex.calls.length, 0);
	assert.equal(git(cwd, 'status', '--porcelain'), '');

	c.advance(90_000);
	assert.equal(quotaWaitMs(job, c.now()), 90_000, 'waiting counts while paused');
	quotaOn = false;
	job = await resumeJob(ctx, job.id);

	assert.equal(job.state, 'passed', job.reason);
	assert.equal(stepCalls(claude, '1').length, 1, 'step 1 ran once');
	assert.equal(stepCalls(claude, '2').length, 2);
	assert.equal(job.timing.quotaWaitMs, 90_000);
	assert.equal(job.timing.quotaSince, undefined);
	assert.equal(loadJob(cwd, job.id).state, 'passed');
});

test('an unknown error is not quota: it stays on the same model and then stops for a person', async () => {
	const cwd = makeRepo();
	const claude = new FakeProvider({
		id: 'claude',
		script: (p) => (p.kind === 'plan' ? { output: twoSteps } : { exitCode: 1, stderr: 'Error: rate limit of something unexpected (429)' }),
	});
	const codex = new FakeProvider({ id: 'codex', script: writes({ '1': 'A', '2': 'B' }) });
	const ctx = context(cwd, [claude, codex], project(['a.txt=A', 'b.txt=B']));

	const job = await runJob(ctx, await createJob(ctx, 'x'));

	assert.equal(job.state, 'needs_human');
	assert.match(job.reason ?? '', /step 1 failed 2 times/);
	assert.equal(stepCalls(claude, '1').length, 2);
	assert.equal(codex.calls.length, 0, 'the other model is not spent on a bug');
	assert.deepEqual(job.quota, {});
	// A segunda tentativa leva o motivo da primeira.
	assert.match(stepCalls(claude, '1')[1].prompt, /Previous attempt failed: worker failed/);
});

test('a dirty tree aborts before anything is created', async () => {
	const cwd = makeRepo();
	fs.writeFileSync(path.join(cwd, 'README.md'), 'mine\n');
	const claude = new FakeProvider({ id: 'claude', script: writes({}) });
	const ctx = context(cwd, [claude], project([]));
	await assert.rejects(createJob(ctx, 'x'), DirtyTreeError);
	assert.equal(claude.calls.length, 0);
	assert.equal(fs.existsSync(path.join(cwd, '.orquestra', 'jobs')), false);
});

test('the plan comes before any edit: without confirmation nothing is edited and no branch is created', async () => {
	const cwd = makeRepo();
	const claude = new FakeProvider({ id: 'claude', script: writes({ '1': 'A', '2': 'B' }) });
	const ctx = context(cwd, [claude], project(['a.txt=A', 'b.txt=B']), { confirmPlan: async () => false });

	let job = await runJob(ctx, await createJob(ctx, 'x'));
	assert.equal(job.state, 'planning');
	assert.equal(job.planConfirmed, false);
	assert.equal(job.steps.length, 2);
	assert.deepEqual(claude.calls.map((c) => [c.kind, c.readOnly, c.maxTurns]), [['plan', true, 8]]);
	assert.equal(git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
	assert.equal(git(cwd, 'branch', '--list', 'orquestra/*'), '');

	job = await resumeJob({ ...ctx, confirmPlan: async () => true }, job.id);
	assert.equal(job.state, 'passed', job.reason);
	assert.equal(claude.calls.filter((c) => c.kind === 'plan').length, 1, 'confirming does not re-plan');
});

test('resume after a crash: the step with a commit stays done, the running one returns to pending', async () => {
	const cwd = makeRepo();
	let quotaOn = true;
	const claude = new FakeProvider({
		id: 'claude',
		script: (p) => {
			if (p.kind === 'plan') return { output: twoSteps };
			if (p.step?.id === '1') return { files: { 'a.txt': 'A' } };
			return quotaOn ? { quota: true } : { files: { 'b.txt': 'B' } };
		},
	});
	const ctx = context(cwd, [claude], project(['a.txt=A', 'b.txt=B']));
	const first = await runJob(ctx, await createJob(ctx, 'x'));
	assert.equal(first.state, 'blocked_quota');

	// Simula o processo morto: o job em disco ficou atrasado (passo 1 ainda "running") e o passo 2 deixou edição.
	const stale = loadJob(cwd, first.id);
	stale.state = 'running';
	stale.steps[0].status = 'running';
	stale.steps[0].commit = undefined;
	stale.steps[1].status = 'running';
	saveJob(cwd, stale, new Date());
	fs.writeFileSync(path.join(cwd, 'b.txt'), 'leftover');
	quotaOn = false;

	await assert.rejects(resumeJob(ctx, first.id), (err: unknown) => err instanceof DirtyTreeError && /--discard/.test((err as Error).message));
	assert.equal(read(cwd, 'b.txt'), 'leftover', 'nothing is discarded without --discard');

	const job = await resumeJob(ctx, first.id, { discard: true });
	assert.equal(job.state, 'passed', job.reason);
	assert.equal(stepCalls(claude, '1').length, 1, 'the commit on the branch marks step 1 done');
	assert.equal(job.steps[0].commit, first.steps[0].commit);
	assert.equal(read(cwd, 'b.txt'), 'B');
});

test('a red test gets a repair; the second repair goes to the other model with only the diff', async () => {
	const cwd = makeRepo();
	const plan = planJson([step('1', ['a.txt'])]);
	const claude = new FakeProvider({
		id: 'claude',
		script: (p) => (p.kind === 'plan' ? { output: plan } : p.kind === 'step' ? { files: { 'a.txt': 'broken' } } : { files: { 'a.txt': 'still broken' } }),
	});
	const codex = new FakeProvider({ id: 'codex', script: () => ({ files: { 'a.txt': 'fixed' } }) });
	const ctx = context(cwd, [claude, codex], project(['a.txt=fixed']));

	const job = await runJob(ctx, await createJob(ctx, 'x'));

	assert.equal(job.state, 'passed', job.reason);
	assert.equal(job.repairCycles, 2);
	const r1 = claude.calls.find((c) => c.kind === 'repair') as WorkPacket;
	const r2 = codex.calls.find((c) => c.kind === 'repair') as WorkPacket;
	assert.deepEqual(r1.doneTitles, ['Step 1']);
	assert.deepEqual(r2.doneTitles, [], 'the other model sees only the diff');
	assert.match(r2.prompt, /still broken/);
	assert.match(r1.testTail ?? '', /FAIL a\.txt/);
	const commits = await stepCommits(cwd, job.branch, job.baseCommit, job.id);
	assert.deepEqual(commits.map((c) => c.stepId), ['1', 'repair-1', 'repair-2']);
});

test('two failed repairs stop for a person and keep the branch', async () => {
	const cwd = makeRepo();
	const plan = planJson([step('1', ['a.txt'])]);
	let n = 0;
	const worker: FakeScript = (p) => (p.kind === 'plan' ? { output: plan } : { files: { 'a.txt': `wrong ${++n}` } });
	const claude = new FakeProvider({ id: 'claude', script: worker });
	const codex = new FakeProvider({ id: 'codex', script: worker });
	const ctx = context(cwd, [claude, codex], project(['a.txt=right']));

	const job = await runJob(ctx, await createJob(ctx, 'x'));

	assert.equal(job.state, 'needs_human');
	assert.match(job.reason ?? '', /after 2 repair cycle/);
	assert.equal(job.lastTest?.passed, false);
	assert.notEqual(git(cwd, 'branch', '--list', job.branch), '');
	assert.equal(job.events.filter((e) => e.state === 'passed').length, 0);
});

test('invalid planner JSON gets one more try; the second failure stops the job', async () => {
	const cwd = makeRepo();
	const bad = new FakeProvider({ id: 'claude', script: () => ({ output: 'Sure! Here is the plan: step one, step two.' }) });
	const ctx = context(cwd, [bad], project([]));
	const job = await runJob(ctx, await createJob(ctx, 'x'));
	assert.equal(job.state, 'needs_human');
	assert.equal(bad.calls.length, 2);
	assert.match(bad.calls[1].prompt, /previous answer was rejected/);

	const cwd2 = makeRepo();
	let first = true;
	const flaky = new FakeProvider({
		id: 'claude',
		script: (p) => {
			if (p.kind !== 'plan') return { files: { 'a.txt': 'A' } };
			const out = first ? '{"goal": "x", "steps": []}' : '```json\n' + planJson([step('1', ['a.txt'])]) + '\n```';
			first = false;
			return { output: out };
		},
	});
	const ctx2 = context(cwd2, [flaky], project(['a.txt=A']));
	const job2 = await runJob(ctx2, await createJob(ctx2, 'x'));
	assert.equal(job2.state, 'passed', job2.reason);
});

test('a worker that touches a denied file or commits by itself is stopped and nothing of it is committed', async () => {
	const cwd = makeRepo();
	const plan = planJson([step('1', ['a.txt'])]);
	const sneaky = new FakeProvider({ id: 'claude', script: (p) => (p.kind === 'plan' ? { output: plan } : { files: { 'a.txt': 'A', 'config/.env': 'SECRET=1' } }) });
	const ctx = context(cwd, [sneaky], project(['a.txt=A']));
	const job = await runJob(ctx, await createJob(ctx, 'x'));
	assert.equal(job.state, 'needs_human');
	assert.match(job.reason ?? '', /denied files \(config\/\.env\)/);
	assert.equal(read(cwd, 'config/.env'), null);
	assert.equal((await stepCommits(cwd, job.branch, job.baseCommit, job.id)).length, 0);

	const cwd2 = makeRepo();
	const committer = new FakeProvider({ id: 'claude', script: (p) => (p.kind === 'plan' ? { output: plan } : { files: { 'a.txt': 'A' }, commit: true }) });
	const ctx2 = context(cwd2, [committer], project(['a.txt=A']));
	const job2 = await runJob(ctx2, await createJob(ctx2, 'x'));
	assert.equal(job2.state, 'needs_human');
	assert.match(job2.reason ?? '', /did not create/);
});

test('files outside the step are a task failure, not a commit', async () => {
	const cwd = makeRepo();
	const plan = planJson([step('1', ['a.txt'])]);
	let n = 0;
	const claude = new FakeProvider({
		id: 'claude',
		script: (p) => (p.kind === 'plan' ? { output: plan } : ++n === 1 ? { files: { 'a.txt': 'A', 'other.txt': 'x' } } : { files: { 'a.txt': 'A' } }),
	});
	const ctx = context(cwd, [claude], project(['a.txt=A']));
	const job = await runJob(ctx, await createJob(ctx, 'x'));
	assert.equal(job.state, 'passed', job.reason);
	assert.equal(read(cwd, 'other.txt'), null);
	assert.match(stepCalls(claude)[1].prompt, /outside the step: other\.txt/);
});

test('two runs of the same job cannot hold the lock at once', () => {
	const cwd = makeRepo();
	const lock = acquireLock(cwd, 'abc');
	assert.throws(() => acquireLock(cwd, 'abc'), /already running/);
	lock.release();
	acquireLock(cwd, 'abc').release();
});
