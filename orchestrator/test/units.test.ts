import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPacket, CAPS, estimateTokens, tailLines } from '../src/budget';
import { bandIsDemoted, bandKey, isConfident, recordOutcome, type Calibration } from '../src/calibrate';
import { newJob, slugify, transition, wallMs } from '../src/job';
import { parsePlan } from '../src/plan';
import { DEFAULT_DENY, isAllowed, isDenied, parseProject } from '../src/project';
import { FakeProvider } from '../src/providers/fake';
import { PendingProvider } from '../src/providers/pending';
import { loadQuotaFixtures, matchesQuotaFixtures, quotaFixture } from '../src/providers/quota';
import { choosePath, pickProvider } from '../src/router';
import { formatStatus } from '../src/status';
import { step } from './helpers';

const empty = (): Calibration => ({ version: 1, bands: {} });

test('calibration: confidence bands of 0.2', () => {
	assert.equal(bandKey(0), '0.0');
	assert.equal(bandKey(0.19), '0.0');
	assert.equal(bandKey(0.2), '0.2');
	assert.equal(bandKey(0.82), '0.8');
	assert.equal(bandKey(1), '0.8');
});

test('calibration: a band with 8+ attempts and under 60% first-round success is treated as low', () => {
	const cal = empty();
	for (let i = 0; i < 7; i++) recordOutcome(cal, [0.85], i < 2);
	assert.equal(bandIsDemoted(cal, 0.9), false, '7 attempts is not enough history');
	recordOutcome(cal, [0.81], false);
	assert.equal(cal.bands['0.8'].attempts, 8);
	assert.equal(bandIsDemoted(cal, 0.9), true);
	assert.equal(isConfident(cal, 0.95), false, 'whatever the model said');
	assert.equal(isConfident(cal, 0.76), true, 'another band is not affected');

	const good = empty();
	for (let i = 0; i < 10; i++) recordOutcome(good, [0.9], i < 6);
	assert.equal(bandIsDemoted(good, 0.9), false, '60% is enough');
});

test('router: cheap path only for confident, low-risk, small steps', () => {
	const cal = empty();
	assert.equal(choosePath(step('1', ['a', 'b', 'c']), cal), 'cheap');
	assert.equal(choosePath(step('1', ['a', 'b', 'c', 'd']), cal), 'full');
	assert.equal(choosePath(step('1', ['a'], { confidence: 0.74 }), cal), 'full');
	assert.equal(choosePath(step('1', ['a'], { risk: 'high' }), cal), 'full');
	assert.equal(choosePath(step('1', ['a'], { risk: 'medium' }), cal), 'full');
	assert.equal(choosePath(step('1', []), cal), 'full');
	for (let i = 0; i < 8; i++) recordOutcome(cal, [0.9], false);
	assert.equal(choosePath(step('1', ['a']), cal), 'full', 'a demoted band loses the cheap path');
	assert.equal(CAPS.cheap.maxTurns, 4);
	assert.equal(CAPS.full.maxTurns, 10);
});

test('router: skips a model with quota and one that is unavailable', async () => {
	const job = newJob({ request: 'x', baseBranch: 'main', baseCommit: 'abc', preferredProvider: 'claude', now: new Date() });
	const claude = new FakeProvider({ id: 'claude', script: () => ({}) });
	const codex = new FakeProvider({ id: 'codex', script: () => ({}) });
	assert.equal((await pickProvider(job, [claude, codex])).provider?.id, 'claude');
	job.quota.claude = { at: '', reason: 'full' };
	assert.equal((await pickProvider(job, [claude, codex])).provider?.id, 'codex');
	codex.unavailable = 'not installed';
	const none = await pickProvider(job, [claude, codex]);
	assert.equal(none.provider, null);
	assert.deepEqual(!none.provider && none.reasons, ['claude: quota (full)', 'codex: not installed']);
	assert.equal((await pickProvider(job, [new PendingProvider('claude', 1)])).provider, null);
});

test('quota: only full captured messages count, never a loose word', () => {
	const fixture = quotaFixture('fake.txt');
	assert.ok(matchesQuotaFixtures(`noise\n${fixture.toUpperCase()}  \nmore`, [fixture]));
	assert.equal(matchesQuotaFixtures('Error: usage limit', [fixture]), false);
	assert.equal(matchesQuotaFixtures('anything', []), false);
	assert.equal(matchesQuotaFixtures('anything', ['   ']), false);
	assert.equal(new PendingProvider('claude', 1).isQuotaError({ exitCode: 1, output: fixture, stderr: '', durationMs: 0 }), false);
});

test('quota: the Claude and Codex limit lines count; capacity errors and loose words do not', () => {
	const claude = loadQuotaFixtures('claude');
	const codex = loadQuotaFixtures('codex');
	assert.ok(claude.length >= 5 && codex.length >= 2);
	for (const text of [
		"You've hit your 5-hour limit · resets 3pm (America/Sao_Paulo)",
		"API Error: You've hit your weekly limit · resets Dec 1",
		"You've hit your session limit · /upgrade to keep using Claude Code",
		"You're out of usage credits. Switch to another model to continue.",
	]) {
		assert.ok(matchesQuotaFixtures(text, claude), text);
	}
	for (const text of [
		'You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 3:05 PM.',
		"You've hit your usage limit. Try again later.",
		'Quota exceeded. Check your plan and billing details.',
	]) {
		assert.ok(matchesQuotaFixtures(text, codex), text);
	}
	for (const text of [
		'Selected model is at capacity. Please try a different model.',
		'rate limit exceeded: 429 Too Many Requests',
		'Context limit reached · /compact or /clear to continue',
		'Subagent nesting limit reached (depth 3 of 3).',
		'error: usage limit',
	]) {
		assert.equal(matchesQuotaFixtures(text, [...claude, ...codex]), false, text);
	}
	// Um provedor não reconhece a cota do outro: o limite do Codex não pausa o Claude.
	assert.equal(matchesQuotaFixtures('You’ve hit your usage limit.', claude), false);
});

test('budget: the packet is cut to the cap of its path', () => {
	const hugeDiff = 'x'.repeat(200_000);
	const packet = buildPacket({
		jobId: 'j',
		kind: 'repair',
		cwd: '.',
		path: 'repair',
		goal: 'g',
		doneTitles: Array.from({ length: 20 }, (_, i) => `title ${i}`),
		allowedFiles: ['a'],
		deny: [...DEFAULT_DENY],
		diff: hugeDiff,
		testTail: Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n'),
	});
	assert.ok(packet.estimatedTokens <= CAPS.repair.maxTokens, `${packet.estimatedTokens} tokens`);
	assert.equal(packet.estimatedTokens, estimateTokens(packet.prompt));
	assert.match(packet.prompt, /characters cut by the orchestrator/);
	assert.match(packet.prompt, /line 299/);
	assert.doesNotMatch(packet.prompt, /line 219\n/, 'only the last 80 test lines');
	assert.match(packet.prompt, /Do not run git commit, git push/);
	assert.equal(tailLines('a\nb\nc\n', 2), 'b\nc');
});

test('plan: validation of the planner JSON', () => {
	const ok = parsePlan(`Here:\n\`\`\`json\n{"goal":"g","steps":[{"id":1,"title":"t","files":["./src\\\\a.ts"],"doneWhen":"d","confidence":0.8,"risk":"low"}]}\n\`\`\``, DEFAULT_DENY);
	assert.deepEqual(ok.steps[0], { id: '1', title: 't', files: ['src/a.ts'], doneWhen: 'd', confidence: 0.8, risk: 'low' });
	const base = { id: '1', title: 't', files: ['a'], doneWhen: '', confidence: 0.5, risk: 'low' };
	const bad = (s: object, why: RegExp) => assert.throws(() => parsePlan(JSON.stringify({ goal: 'g', steps: [s] }), DEFAULT_DENY), why);
	bad({ ...base, confidence: 1.2 }, /confidence/);
	bad({ ...base, risk: 'none' }, /risk/);
	bad({ ...base, files: ['../x'] }, /outside the repository/);
	bad({ ...base, files: ['C:/x'] }, /outside the repository/);
	bad({ ...base, files: ['app/.env'] }, /denied/);
	bad({ ...base, id: 'repair-1' }, /repair-/);
	assert.throws(() => parsePlan('{"goal":"g","steps":[]}', DEFAULT_DENY), /non-empty/);
	assert.throws(() => parsePlan('no json', DEFAULT_DENY), /invalid JSON/);
	assert.throws(() => parsePlan(JSON.stringify({ goal: 'g', steps: [base, base] }), DEFAULT_DENY), /repeated/);
});

test('project: defaults, limits and a deny list that cannot release secrets', () => {
	const p = parseProject({ test: 'npm test', deny: ['secrets/**'], maxRepairCycles: 1 });
	assert.equal(p.maxRepairCycles, 1);
	assert.ok(p.deny.includes('**/.env') && p.deny.includes('secrets/**'));
	assert.throws(() => parseProject({ maxRepairCycles: 3 }), /0 to 2/);
	assert.throws(() => parseProject({ test: '' }), /test/);
	assert.throws(() => parseProject({ defaultProvider: 'gpt' }), /defaultProvider/);
	assert.equal(p.remote, 'origin');
	assert.equal(p.prDraft, false);
	assert.deepEqual([parseProject({ remote: 'upstream', prDraft: true }).remote, parseProject({ prDraft: true }).prDraft], ['upstream', true]);
	assert.throws(() => parseProject({ remote: '--upload-pack=x' }), /remote/);
	assert.throws(() => parseProject({ remote: 'a b' }), /remote/);
	assert.throws(() => parseProject({ prDraft: 'yes' }), /prDraft/);
	assert.ok(isDenied('.env', DEFAULT_DENY));
	assert.ok(isDenied('a/b/.env.local', DEFAULT_DENY));
	assert.ok(isDenied('certs\\server.PEM', DEFAULT_DENY));
	assert.ok(isDenied('config/aws_credentials.json', DEFAULT_DENY));
	assert.equal(isDenied('src/environment.ts', DEFAULT_DENY), false);
	assert.ok(isAllowed('src/A.ts', ['src/a.ts']));
	assert.ok(isAllowed('src/x/y.ts', ['src/']));
	assert.ok(isAllowed('test/a.test.ts', ['test/*.test.ts']));
	assert.equal(isAllowed('src/b.ts', ['src/a.ts']), false);
});

test('job: slug, quota wait kept apart and the four times in status', () => {
	assert.equal(slugify('Corrigir o botão de Revisão!'), 'corrigir-o-botao-de-revisao');
	assert.equal(slugify('!!!'), 'tarefa');
	const t0 = new Date('2026-11-26T12:00:00Z');
	const job = newJob({ request: 'x', baseBranch: 'main', baseCommit: 'abc', preferredProvider: 'claude', now: t0 });
	transition(job, 'running', t0);
	transition(job, 'blocked_quota', new Date(t0.getTime() + 10_000), 'claude full');
	assert.equal(job.reason, 'claude full');
	transition(job, 'running', new Date(t0.getTime() + 70_000));
	assert.equal(job.timing.quotaWaitMs, 60_000);
	assert.equal(job.reason, undefined);
	job.timing.modelMs = { claude: 5_000, codex: 125_000 };
	job.timing.testMs = 3_000;
	transition(job, 'passed', new Date(t0.getTime() + 200_000));
	assert.equal(wallMs(job, new Date(t0.getTime() + 999_999)), 200_000, 'wall stops at the end');
	const out = formatStatus(job, new Date());
	assert.match(out, /wall {4}3m20s/);
	assert.match(out, /model {3}claude 5s, codex 2m05s/);
	assert.match(out, /test {4}3s/);
	assert.match(out, /quota {3}1m00s/);
});
