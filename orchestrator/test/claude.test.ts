import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { buildArgs, ClaudeProvider, parseClaudeOutput, PROBE_FLAG, probeArgs, workerEnv } from '../src/providers/claude';
import { quoteForCmd } from '../src/proc';
import type { ProcResult } from '../src/proc';
import { bugRepo, cleanEnv, fakeBin, git, runCli } from './helpers';

function proc(partial: Partial<ProcResult>): ProcResult {
	return { exitCode: 0, timedOut: false, stdout: '', stderr: '', durationMs: 5, ...partial };
}

test('claude args: planner is read-only, worker edits, the prompt never goes in argv', () => {
	const plan = buildArgs({ maxTurns: 8, readOnly: true }, ['npm test -- *']);
	assert.deepEqual(plan, ['-p', '--output-format', 'json', '--max-turns', '8', '--no-session-persistence', '--permission-prompts', 'none', '--permission-mode', 'dontAsk', '--tools', 'Read,Glob,Grep']);
	const worker = buildArgs({ maxTurns: 4, readOnly: false }, []);
	assert.deepEqual(worker.slice(-4), ['--permission-mode', 'acceptEdits', '--tools', 'Read,Edit,Write,Glob,Grep']);
	assert.equal(worker.includes('Bash'), false);
	const withBash = buildArgs({ maxTurns: 10, readOnly: false }, ['npm test -- *']);
	assert.deepEqual(withBash.slice(-6), ['--tools', 'Read,Edit,Write,Glob,Grep,Bash', '--allowedTools', 'Bash(npm test -- *)', '--disallowedTools', 'Bash(git *),Bash(gh *)']);
	assert.equal(probeArgs().at(-1), PROBE_FLAG);
	assert.equal(quoteForCmd('Bash(git *),Bash(gh *)'), '"Bash(git *),Bash(gh *)"');
	assert.equal(quoteForCmd('-p'), '-p');
});

test('claude output: success, model error, max turns, no JSON and timeout', () => {
	const ok = parseClaudeOutput(proc({ stdout: '{"type":"result","subtype":"success","is_error":false,"result":"done","num_turns":3,"usage":{"input_tokens":10,"cache_read_input_tokens":5,"cache_creation_input_tokens":1,"output_tokens":7}}' }), 1000);
	assert.equal(ok.exitCode, 0);
	assert.equal(ok.output, 'done');
	assert.equal(ok.error, undefined);
	assert.deepEqual(ok.usage, { inputTokens: 16, outputTokens: 7 });
	assert.equal(ok.turns, 3);

	const err = parseClaudeOutput(proc({ exitCode: 1, stdout: 'warming up\n{"type":"result","subtype":"success","is_error":true,"result":"API Error: boom"}' }), 1000);
	assert.equal(err.exitCode, 1);
	assert.match(err.error ?? '', /API Error: boom/);

	const turns = parseClaudeOutput(proc({ stdout: '{"type":"result","subtype":"error_max_turns","is_error":false}' }), 1000);
	assert.equal(turns.exitCode, 1, 'running out of turns is a task failure');
	assert.match(turns.error ?? '', /error_max_turns/);

	const garbage = parseClaudeOutput(proc({ stdout: 'hello' }), 1000);
	assert.equal(garbage.exitCode, 1);
	assert.match(garbage.error ?? '', /no JSON result: hello/);

	const slow = parseClaudeOutput(proc({ exitCode: null, timedOut: true }), 90_000);
	assert.match(slow.error ?? '', /timed out after 90s/);
});

test('claude env: no API key (subscription login only) and no nested-session markers', () => {
	const env = workerEnv({ ANTHROPIC_API_KEY: 'sk', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', PATH: 'x' });
	assert.deepEqual(env, { PATH: 'x' });
	assert.equal(workerEnv({ ANTHROPIC_API_KEY: 'sk', ORQUESTRA_ALLOW_API_KEY: '1' }).ANTHROPIC_API_KEY, 'sk');
});

test('claude availability: reads the version, probes the flags, refuses what it does not know', async () => {
	const bin = fakeBin();
	const mk = (env: Record<string, string>) => new ClaudeProvider({ bin, timeoutMs: 30_000, allowBash: [], env: cleanEnv(env) });
	assert.deepEqual(await mk({}).available(), { ok: true });

	const future = await mk({ FAKE_CLAUDE_VERSION: '3.0.0 (Claude Code)' }).available();
	assert.equal(future.ok, false);
	assert.match(future.reason ?? '', /claude 3\.0\.0 is a version this adapter does not know/);
	assert.equal((await mk({ FAKE_CLAUDE_VERSION: '3.0.0 (Claude Code)', ORQUESTRA_CLAUDE_ANY_VERSION: '1' }).available()).ok, true);

	const renamed = await mk({ FAKE_CLAUDE_REJECT: '--max-turns' }).available();
	assert.equal(renamed.ok, false);
	assert.match(renamed.reason ?? '', /rejected a flag the adapter uses: error: unknown option '--max-turns'/);

	const missing = new ClaudeProvider({ bin: path.join(os.tmpdir(), 'no-such-claude.exe'), timeoutMs: 5000, allowBash: [] });
	assert.equal((await missing.available()).ok, false);
});

test('claude run: prompt through stdin, args survive cmd.exe quoting, unknown errors are not quota', async () => {
	const bin = fakeBin();
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'orquestra-cw-'));
	fs.writeFileSync(path.join(cwd, 'math.js'), 'exports.add = (a, b) => a - b;\n');
	const log = path.join(cwd, '..', `${path.basename(cwd)}.log`);
	const p = new ClaudeProvider({ bin, timeoutMs: 30_000, allowBash: ['npm test -- *'], env: cleanEnv({ FAKE_CLAUDE_LOG: log, ANTHROPIC_API_KEY: 'sk-should-not-pass' }) });
	const prompt = 'Fix it. Quotes " and & | < > ^ % stay intact\nsecond line';
	const r = await p.run({ jobId: 'j', kind: 'step', cwd, path: 'full', maxTurns: 10, readOnly: false, goal: 'g', doneTitles: [], allowedFiles: ['math.js'], deny: [], prompt, estimatedTokens: 1 });
	assert.equal(r.exitCode, 0, r.error);
	assert.equal(r.output, 'Fixed add in math.js.');
	assert.match(fs.readFileSync(path.join(cwd, 'math.js'), 'utf8'), /a \+ b/);
	const call = JSON.parse(fs.readFileSync(log, 'utf8').trim()) as { args: string[]; prompt: string; apiKey: boolean };
	assert.equal(call.prompt, prompt);
	assert.ok(call.args.includes('Bash(git *),Bash(gh *)'));
	assert.ok(call.args.includes('Bash(npm test -- *)'));
	assert.equal(call.apiKey, false);

	const failing = new ClaudeProvider({ bin, timeoutMs: 30_000, allowBash: [], env: cleanEnv({ FAKE_CLAUDE_MODE: 'error' }) });
	const bad = await failing.run({ jobId: 'j', kind: 'step', cwd, path: 'full', maxTurns: 10, readOnly: false, goal: 'g', doneTitles: [], allowedFiles: [], deny: [], prompt: 'x', estimatedTokens: 1 });
	assert.equal(bad.exitCode, 1);
	assert.equal(failing.isQuotaError(bad), false, 'loose words such as limit or 429 are not quota');

	const limited = new ClaudeProvider({ bin, timeoutMs: 30_000, allowBash: [], env: cleanEnv({ FAKE_CLAUDE_MODE: 'quota' }) });
	const hit = await limited.run({ jobId: 'j', kind: 'step', cwd, path: 'full', maxTurns: 10, readOnly: false, goal: 'g', doneTitles: [], allowedFiles: [], deny: [], prompt: 'x', estimatedTokens: 1 });
	assert.equal(hit.exitCode, 1);
	assert.equal(limited.isQuotaError(hit), true, 'the 5-hour limit line is quota');
});

test('phase 1: one command takes a bug with a test from the request to a green test, with the four times on screen', async () => {
	const cwd = bugRepo('node --test');
	const log = path.join(cwd, '..', `${path.basename(cwd)}.log`);
	const env = cleanEnv({ ORQUESTRA_CLAUDE_BIN: fakeBin(), ORQUESTRA_HOME: path.join(cwd, '..', `${path.basename(cwd)}-home`), FAKE_CLAUDE_LOG: log });

	const run = await runCli(cwd, ['run', 'fix add so the test passes', '--yes'], env);
	assert.equal(run.code, 0, run.stderr + run.stdout);
	assert.match(run.stdout, /^Job \S+ {2}passed/m);
	for (const label of ['wall', 'model', 'test', 'quota']) assert.match(run.stdout, new RegExp(`^ {2}${label} +\\S`, 'm'));
	assert.match(run.stdout, /model {3}claude \d/);
	assert.match(run.stdout, /Last test: passed — node --test \(exit 0/);
	assert.match(run.stdout, /Usage: {3}300 in \/ 40 out/);
	assert.match(run.stderr, /Planning with claude/);

	const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { args: string[]; prompt: string });
	assert.equal(calls.length, 2, 'one planner call, one worker call');
	assert.ok(calls[0].args.includes('Read,Glob,Grep'), 'the planner gets read-only tools');
	assert.match(calls[0].prompt, /fix add so the test passes/);
	assert.match(calls[1].prompt, /Current step 1: Fix add in math\.js/);
	assert.ok(calls[1].args.includes('4'), 'confident small step takes the cheap path (4 turns)');

	const branch = git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD');
	assert.match(branch, /^orquestra\//);
	assert.equal(git(cwd, 'log', '-1', '--format=%s'), 'Fix add in math.js');
	assert.equal(git(cwd, 'status', '--porcelain'), '');

	const status = await runCli(cwd, ['status'], env);
	assert.equal(status.code, 0);
	assert.match(status.stdout, /\[x\] 1\. Fix add in math\.js \(claude, [0-9a-f]{8}/);
	const list = await runCli(cwd, ['list'], env);
	assert.match(list.stdout, /passed +1\/1 steps/);
});

test('phase 1: without --yes and no terminal, the plan is shown and nothing is edited until resume', async () => {
	const cwd = bugRepo('node --test');
	const env = cleanEnv({ ORQUESTRA_CLAUDE_BIN: fakeBin(), ORQUESTRA_HOME: path.join(cwd, '..', `${path.basename(cwd)}-home`) });
	const run = await runCli(cwd, ['run', 'fix add'], env);
	assert.equal(run.code, 0, run.stderr);
	assert.match(run.stdout, /1\. Fix add in math\.js/);
	assert.match(run.stdout, /planning/);
	assert.equal(git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
	assert.match(fs.readFileSync(path.join(cwd, 'math.js'), 'utf8'), /a - b/);

	const resumed = await runCli(cwd, ['resume', '--yes'], env);
	assert.equal(resumed.code, 0, resumed.stderr);
	assert.match(resumed.stdout, /passed/);
});

test('phase 1: a failing claude keeps its raw output for fixture capture and stops for a person', async () => {
	const cwd = bugRepo('node --test');
	const env = cleanEnv({ ORQUESTRA_CLAUDE_BIN: fakeBin(), ORQUESTRA_HOME: path.join(cwd, '..', `${path.basename(cwd)}-home`), FAKE_CLAUDE_MODE: 'error' });
	const run = await runCli(cwd, ['run', 'fix add', '--yes'], env);
	assert.equal(run.code, 1);
	assert.match(run.stdout, /needs_human/);
	const jobs = path.join(cwd, '.orquestra', 'jobs');
	const runsDir = fs.readdirSync(jobs).find((n) => n.endsWith('.runs')) as string;
	const saved = fs.readdirSync(path.join(jobs, runsDir));
	assert.deepEqual(saved.map((n) => n.replace(/^\d+-/, '')), ['claude-plan.txt', 'claude-plan.txt'], 'both planner attempts are kept');
	assert.match(fs.readFileSync(path.join(jobs, runsDir, saved[0]), 'utf8'), /Something unexpected went wrong/);
});

test('providers command reports readiness without calling a model', async () => {
	const cwd = bugRepo('node --test');
	const r = await runCli(cwd, ['providers'], cleanEnv({ ORQUESTRA_CLAUDE_BIN: fakeBin(), FAKE_CODEX_LOGIN: 'none' }));
	assert.equal(r.code, 0, r.stderr);
	assert.match(r.stdout, /^claude +ready$/m);
	assert.match(r.stdout, /^codex +unavailable — codex is not logged in \(run `codex login`\): Not logged in$/m);
	assert.match(r.stdout, /^gh +ready \(for --pr\)$/m);
});
