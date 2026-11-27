import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { newJob } from '../src/job';
import { parsePrUrl, prBody, prTitle, TITLE_MAX } from '../src/pr';
import type { ProcResult } from '../src/proc';
import { buildArgs, codexEnv, CodexProvider, parseCodexOutput, PROBE_FLAG, probeArgs } from '../src/providers/codex';
import type { Job, WorkPacket } from '../src/types';
import { addBareRemote, bugRepo, cleanEnv, fakeBin, git, logLines, runCli } from './helpers';

function proc(partial: Partial<ProcResult>): ProcResult {
	return { exitCode: 0, timedOut: false, stdout: '', stderr: '', durationMs: 5, ...partial };
}

const jsonl = (...events: object[]) => events.map((e) => JSON.stringify(e)).join('\n');

function packet(cwd: string, extra: Partial<WorkPacket> = {}): WorkPacket {
	return { jobId: 'j', kind: 'step', cwd, path: 'full', maxTurns: 10, readOnly: false, goal: 'g', doneTitles: [], allowedFiles: ['math.js'], deny: [], prompt: 'x', estimatedTokens: 1, ...extra };
}

function home(cwd: string): string {
	return path.join(cwd, '..', `${path.basename(cwd)}-home`);
}

function readJob(cwd: string): Job {
	const dir = path.join(cwd, '.orquestra', 'jobs');
	const name = fs.readdirSync(dir).find((n) => n.endsWith('.json')) as string;
	return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as Job;
}

// ---------------------------------------------------------------- fase 3: Codex

test('codex args: read-only sandbox for the planner, workspace-write for the worker, prompt from stdin', () => {
	assert.deepEqual(buildArgs({ readOnly: true }), ['exec', '--json', '--ephemeral', '--color', 'never', '--sandbox', 'read-only', '-c', 'approval_policy=never', '-']);
	const worker = buildArgs({ readOnly: false });
	assert.equal(worker[worker.indexOf('--sandbox') + 1], 'workspace-write');
	assert.equal(worker.at(-1), '-', 'the prompt never goes in argv');
	assert.ok(!worker.some((a) => a.includes('danger')), 'never the full-access sandbox');
	assert.equal(probeArgs().at(-2), PROBE_FLAG, 'the fake flag comes after every real one');
});

test('codex output: success with usage, failed turn, no JSON and timeout', () => {
	const ok = parseCodexOutput(
		proc({
			stdout: jsonl(
				{ type: 'thread.started', thread_id: 't' },
				{ type: 'turn.started' },
				{ type: 'item.completed', item: { type: 'agent_message', text: 'first' } },
				{ type: 'error', message: 'Reconnecting... 1/5' },
				{ type: 'item.completed', item: { type: 'agent_message', text: 'Fixed it.' } },
				{ type: 'turn.completed', usage: { input_tokens: 24763, cached_input_tokens: 24448, output_tokens: 122 } },
			),
		}),
		1000,
	);
	assert.equal(ok.exitCode, 0, ok.error);
	assert.equal(ok.output, 'Fixed it.', 'the last agent message is the answer');
	assert.deepEqual(ok.usage, { inputTokens: 24763, outputTokens: 122 });
	assert.equal(ok.turns, 1);

	const failed = parseCodexOutput(proc({ exitCode: 1, stdout: jsonl({ type: 'turn.started' }, { type: 'turn.failed', error: { message: 'stream disconnected before completion' } }) }), 1000);
	assert.equal(failed.exitCode, 1);
	assert.match(failed.error ?? '', /codex failed: stream disconnected/);

	const unfinished = parseCodexOutput(proc({ exitCode: 0, stdout: jsonl({ type: 'turn.started' }) }), 1000);
	assert.equal(unfinished.exitCode, 1, 'exit 0 without a completed turn is a failure');

	const garbage = parseCodexOutput(proc({ exitCode: 2, stdout: '', stderr: 'error: unexpected argument' }), 1000);
	assert.equal(garbage.exitCode, 2);
	assert.match(garbage.error ?? '', /no JSON events: error: unexpected argument/);

	assert.match(parseCodexOutput(proc({ exitCode: null, timedOut: true }), 60_000).error ?? '', /timed out after 60s/);
});

test('codex env: no API key (ChatGPT login only) and no nested-sandbox markers', () => {
	assert.deepEqual(codexEnv({ OPENAI_API_KEY: 'sk', CODEX_API_KEY: 'sk', CODEX_SANDBOX: 'seatbelt', PATH: 'x' }), { PATH: 'x' });
	assert.equal(codexEnv({ CODEX_API_KEY: 'sk', ORQUESTRA_ALLOW_API_KEY: '1' }).CODEX_API_KEY, 'sk');
});

test('codex availability: version, flag probe and login type, all without a model call', async () => {
	const bin = fakeBin('codex');
	const mk = (env: Record<string, string>) => new CodexProvider({ bin, timeoutMs: 30_000, env: cleanEnv(env) });
	assert.deepEqual(await mk({}).available(), { ok: true });

	const renamed = await mk({ FAKE_CODEX_REJECT: '--ephemeral' }).available();
	assert.equal(renamed.ok, false);
	assert.match(renamed.reason ?? '', /codex 0\.98\.0 rejected a flag the adapter uses: error: unexpected argument '--ephemeral' found/);

	const out = await mk({ FAKE_CODEX_LOGIN: 'none' }).available();
	assert.match(out.reason ?? '', /not logged in \(run `codex login`\)/);

	const apiKey = await mk({ FAKE_CODEX_LOGIN: 'apikey' }).available();
	assert.equal(apiKey.ok, false);
	assert.match(apiKey.reason ?? '', /API key, not a ChatGPT plan/);
	assert.equal((await mk({ FAKE_CODEX_LOGIN: 'apikey', ORQUESTRA_ALLOW_API_KEY: '1' }).available()).ok, true);

	const missing = new CodexProvider({ bin: path.join(os.tmpdir(), 'no-such-codex.exe'), timeoutMs: 5000 });
	assert.equal((await missing.available()).ok, false);
});

test('codex run: prompt through stdin, the real limit text is quota, other errors are not', async () => {
	const bin = fakeBin('codex');
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'orquestra-cx-'));
	fs.writeFileSync(path.join(cwd, 'math.js'), 'exports.add = (a, b) => a - b;\n');
	const log = path.join(cwd, '..', `${path.basename(cwd)}.log`);
	const p = new CodexProvider({ bin, timeoutMs: 30_000, env: cleanEnv({ FAKE_CODEX_LOG: log, OPENAI_API_KEY: 'sk-should-not-pass' }) });
	const prompt = 'Fix it. Quotes " and & | < > ^ % stay intact\nsecond line';
	const r = await p.run(packet(cwd, { prompt }));
	assert.equal(r.exitCode, 0, r.error);
	assert.equal(r.output, 'Fixed add in math.js.');
	assert.deepEqual(r.usage, { inputTokens: 200, outputTokens: 30 });
	assert.match(fs.readFileSync(path.join(cwd, 'math.js'), 'utf8'), /a \+ b/);
	const [call] = logLines<{ args: string[]; prompt: string; apiKey: boolean }>(log);
	assert.equal(call.prompt, prompt);
	assert.equal(call.apiKey, false);
	assert.ok(call.args.includes('workspace-write'));

	const limited = new CodexProvider({ bin, timeoutMs: 30_000, env: cleanEnv({ FAKE_CODEX_MODE: 'quota' }) });
	const hit = await limited.run(packet(cwd));
	assert.equal(hit.exitCode, 1);
	assert.equal(limited.isQuotaError(hit), true);

	const failing = new CodexProvider({ bin, timeoutMs: 30_000, env: cleanEnv({ FAKE_CODEX_MODE: 'error' }) });
	const bad = await failing.run(packet(cwd));
	assert.equal(bad.exitCode, 1);
	assert.equal(failing.isQuotaError(bad), false);
});

test('phase 3: claude hits its 5-hour limit mid-job and codex finishes the step to a green test', async () => {
	const cwd = bugRepo('node --test');
	const claudeLog = path.join(cwd, '..', `${path.basename(cwd)}-claude.log`);
	const codexLog = path.join(cwd, '..', `${path.basename(cwd)}-codex.log`);
	const env = cleanEnv({
		ORQUESTRA_CLAUDE_BIN: fakeBin('claude'),
		ORQUESTRA_HOME: home(cwd),
		FAKE_CLAUDE_MODE: 'quota-worker',
		FAKE_CLAUDE_LOG: claudeLog,
		FAKE_CODEX_LOG: codexLog,
	});
	const run = await runCli(cwd, ['run', 'fix add so the test passes', '--yes'], env);
	assert.equal(run.code, 0, run.stderr + run.stdout);
	assert.match(run.stdout, /^Job \S+ {2}passed/m);
	assert.match(run.stdout, /\[x\] 1\. Fix add in math\.js \(codex, [0-9a-f]{8}/);
	assert.match(run.stdout, /model {3}claude \d+\S*, codex \d/);
	assert.match(run.stderr, /claude hit its quota during step 1/);
	assert.equal(logLines(claudeLog).length, 2, 'claude planned, then hit the limit on the step');
	const codexCalls = logLines<{ prompt: string; args: string[] }>(codexLog);
	assert.equal(codexCalls.length, 1, 'codex took over only the step');
	assert.match(codexCalls[0].prompt, /Current step 1: Fix add in math\.js/);
	const job = readJob(cwd);
	assert.match(job.quota.claude?.reason ?? '', /5-hour limit/);
	assert.ok(job.events.some((e) => e.state === 'blocked_quota'));
	assert.equal(git(cwd, 'status', '--porcelain'), '');
});

test('phase 3: with both models at their limit the job pauses in blocked_quota, and the raw text is kept', async () => {
	const cwd = bugRepo('node --test');
	const env = cleanEnv({ ORQUESTRA_CLAUDE_BIN: fakeBin('claude'), ORQUESTRA_HOME: home(cwd), FAKE_CLAUDE_MODE: 'quota-worker', FAKE_CODEX_MODE: 'quota' });
	const run = await runCli(cwd, ['run', 'fix add', '--yes'], env);
	assert.equal(run.code, 1);
	assert.match(run.stdout, /blocked_quota/);
	assert.match(run.stderr, /Paused: .*claude: quota.*codex: quota/);
	const job = readJob(cwd);
	assert.equal(job.steps[0].status, 'pending');
	assert.equal(job.steps[0].attempts, 0, 'quota is not a task failure');
	const runs = fs.readdirSync(path.join(cwd, '.orquestra', 'jobs', `${job.id}.runs`));
	assert.ok(runs.some((n) => n.includes('codex-step-1')), runs.join(', '));
	assert.match(fs.readFileSync(path.join(cwd, 'math.js'), 'utf8'), /a - b/, 'no half edit is left behind');
});

// ---------------------------------------------------------------- fase 4: PR

test('pr text: title from the goal, body with steps, commits and the test', () => {
	const job = newJob({ request: 'fix add\nmore detail', baseBranch: 'main', baseCommit: 'abc', preferredProvider: 'claude', now: new Date('2026-11-26T12:00:00Z') });
	assert.equal(prTitle(job), 'fix add');
	job.plan = { goal: 'x'.repeat(100), steps: [] };
	assert.equal(prTitle(job).length, TITLE_MAX);
	job.steps = [{ id: '1', title: 'Fix add', files: ['math.js'], doneWhen: '', confidence: 0.9, risk: 'low', status: 'done', attempts: 0, provider: 'codex', commit: '0123456789abcdef' }];
	job.lastTest = { command: 'node --test', exitCode: 0, timedOut: false, passed: true, durationMs: 1200, at: '', tail: '' };
	const body = prBody(job);
	assert.match(body, /- `01234567` Fix add \(codex\)/);
	assert.match(body, /`node --test` passed \(exit 0, 1s\)/);
	assert.match(body, /Orquestra-Job/);
	assert.equal(parsePrUrl('\nCreating pull request\n\nhttps://github.com/o/r/pull/12\n'), 'https://github.com/o/r/pull/12');
	assert.equal(parsePrUrl('warning: something'), undefined);
});

test('phase 4: run --pr pushes the tested branch and opens the PR; resume does not open a second one', async () => {
	const cwd = bugRepo('node --test', { prDraft: true });
	const bare = addBareRemote(cwd);
	const ghLog = path.join(cwd, '..', `${path.basename(cwd)}-gh.log`);
	const env = cleanEnv({
		ORQUESTRA_CLAUDE_BIN: fakeBin('claude'),
		ORQUESTRA_HOME: home(cwd),
		FAKE_GH_LOG: ghLog,
		FAKE_GH_STATE: path.join(cwd, '..', `${path.basename(cwd)}-gh.state`),
	});
	const run = await runCli(cwd, ['run', 'fix add so the test passes', '--yes', '--pr'], env);
	assert.equal(run.code, 0, run.stderr + run.stdout);
	assert.match(run.stdout, /^Job \S+ {2}pr_open/m);
	assert.match(run.stdout, /^PR: {6}https:\/\/github\.com\/example\/repo\/pull\/7$/m);

	const job = readJob(cwd);
	assert.equal(git(bare, 'rev-parse', `refs/heads/${job.branch}`), git(cwd, 'rev-parse', 'HEAD'), 'the remote has the tested commit');
	assert.equal(git(cwd, 'rev-parse', '--abbrev-ref', '@{upstream}'), `origin/${job.branch}`);

	const calls = logLines<{ args: string[]; input: string }>(ghLog);
	const create = calls.find((c) => c.args[1] === 'create');
	assert.ok(create, 'gh pr create was called');
	assert.deepEqual(create.args.slice(0, 6), ['pr', 'create', '--base', 'main', '--head', job.branch]);
	assert.ok(create.args.includes('--draft'));
	assert.equal(create.args[create.args.indexOf('--title') + 1], 'add() returns the sum');
	assert.match(create.input, /## Request\n\nfix add so the test passes/);
	assert.match(create.input, /`node --test` passed/);

	const again = await runCli(cwd, ['resume', job.id, '--pr'], env);
	assert.equal(again.code, 0, again.stderr);
	assert.match(again.stderr, /already pr_open/);
	assert.equal(logLines<{ args: string[] }>(ghLog).filter((c) => c.args[1] === 'create').length, 1);
});

test('phase 4: a failed gh pr create keeps the tested branch, and resume --pr opens the PR without models or tests', async () => {
	const cwd = bugRepo('node --test');
	addBareRemote(cwd);
	const claudeLog = path.join(cwd, '..', `${path.basename(cwd)}-claude.log`);
	const base = {
		ORQUESTRA_CLAUDE_BIN: fakeBin('claude'),
		ORQUESTRA_HOME: home(cwd),
		FAKE_CLAUDE_LOG: claudeLog,
		FAKE_GH_STATE: path.join(cwd, '..', `${path.basename(cwd)}-gh.state`),
	};
	const run = await runCli(cwd, ['run', 'fix add', '--yes', '--pr'], cleanEnv({ ...base, FAKE_GH_FAIL: 'GraphQL: Head sha can\'t be blank' }));
	assert.equal(run.code, 1, 'asked for a PR and did not get one');
	assert.match(run.stdout, /^Job \S+ {2}passed/m);
	assert.match(run.stdout, /PR: {6}not opened — gh pr create failed \(exit 1\): GraphQL/);
	assert.match(run.stderr, /resume \S+ --pr/);
	const before = readJob(cwd);
	assert.equal(logLines(claudeLog).length, 2);

	const resumed = await runCli(cwd, ['resume', '--pr'], cleanEnv(base));
	assert.equal(resumed.code, 0, resumed.stderr + resumed.stdout);
	assert.match(resumed.stdout, /pr_open/);
	assert.equal(logLines(claudeLog).length, 2, 'no model call to open the PR');
	const after = readJob(cwd);
	assert.equal(after.lastTest?.at, before.lastTest?.at, 'the test did not run again');
	assert.equal(after.prError, undefined);
	assert.equal(after.pr?.url, 'https://github.com/example/repo/pull/7');
});

test('phase 4: an existing open PR for the branch is reused', async () => {
	const cwd = bugRepo('node --test');
	addBareRemote(cwd);
	const state = path.join(cwd, '..', `${path.basename(cwd)}-gh.state`);
	fs.writeFileSync(state, 'https://github.com/example/repo/pull/3');
	const ghLog = path.join(cwd, '..', `${path.basename(cwd)}-gh.log`);
	const env = cleanEnv({ ORQUESTRA_CLAUDE_BIN: fakeBin('claude'), ORQUESTRA_HOME: home(cwd), FAKE_GH_STATE: state, FAKE_GH_LOG: ghLog });
	const run = await runCli(cwd, ['run', 'fix add', '--yes', '--pr'], env);
	assert.equal(run.code, 0, run.stderr);
	assert.match(run.stderr, /Pull request already open: https:\/\/github\.com\/example\/repo\/pull\/3/);
	assert.equal(logLines<{ args: string[] }>(ghLog).filter((c) => c.args[1] === 'create').length, 0);
});

test('phase 4: without a gh login, run --pr refuses before any job or model call', async () => {
	const cwd = bugRepo('node --test');
	const claudeLog = path.join(cwd, '..', `${path.basename(cwd)}-claude.log`);
	const env = cleanEnv({ ORQUESTRA_CLAUDE_BIN: fakeBin('claude'), ORQUESTRA_HOME: home(cwd), FAKE_CLAUDE_LOG: claudeLog, FAKE_GH_AUTH: 'none' });
	const run = await runCli(cwd, ['run', 'fix add', '--yes', '--pr'], env);
	assert.equal(run.code, 1);
	assert.match(run.stderr, /--pr cannot open a pull request: gh is not logged in/);
	assert.equal(fs.existsSync(path.join(cwd, '.orquestra', 'jobs')), false);
	assert.equal(logLines(claudeLog).length, 0);
});

test('phase 4: without the remote, the PR step fails with a clear reason and the branch stays local', async () => {
	const cwd = bugRepo('node --test');
	const env = cleanEnv({ ORQUESTRA_CLAUDE_BIN: fakeBin('claude'), ORQUESTRA_HOME: home(cwd) });
	const run = await runCli(cwd, ['run', 'fix add', '--yes', '--pr'], env);
	assert.equal(run.code, 1);
	assert.match(run.stdout, /PR: {6}not opened — the remote "origin" does not exist in this repository/);
});
