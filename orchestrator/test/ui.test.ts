// O que a aba do editor usa da CLI: pedido pelo stdin, saída em JSON, descartar um plano e parar no meio.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import type { Job } from '../src/types';
import { bugRepo, CLI, cleanEnv, fakeBin, git, logLines, runCli } from './helpers';

function home(cwd: string): string {
	return path.join(cwd, '..', `${path.basename(cwd)}-home`);
}

function runWithInput(cwd: string, args: string[], env: NodeJS.ProcessEnv, input: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [CLI, ...args], { cwd, env });
		let stdout = '', stderr = '';
		child.stdout.on('data', (b: Buffer) => { stdout += b.toString('utf8'); });
		child.stderr.on('data', (b: Buffer) => { stderr += b.toString('utf8'); });
		child.stdin.end(input);
		child.on('close', (code) => resolve({ code, stdout, stderr }));
	});
}

test('ui: plan --stdin keeps a multi-line request intact, list/status --json give the job, drop removes an unconfirmed plan', async () => {
	const cwd = bugRepo('node --test');
	const log = path.join(cwd, '..', `${path.basename(cwd)}.log`);
	const env = cleanEnv({ ORQUESTRA_CLAUDE_BIN: fakeBin('claude'), ORQUESTRA_HOME: home(cwd), FAKE_CLAUDE_LOG: log });
	const request = 'fix add so the test passes\nkeep "quotes" & pipes | intact\n';

	const plan = await runWithInput(cwd, ['plan', '--stdin'], env, request);
	assert.equal(plan.code, 0, plan.stderr);
	const [call] = logLines<{ prompt: string }>(log);
	assert.ok(call.prompt.includes(`Request: ${request.trim()}`), call.prompt);

	const list = await runCli(cwd, ['list', '--json'], env);
	const jobs = JSON.parse(list.stdout) as Job[];
	assert.equal(jobs.length, 1);
	assert.equal(jobs[0].request, request.trim());
	assert.equal(jobs[0].planConfirmed, false);
	assert.equal(jobs[0].plan?.steps.length, 1);
	const status = JSON.parse((await runCli(cwd, ['status', jobs[0].id, '--json'], env)).stdout) as Job;
	assert.equal(status.id, jobs[0].id);

	const dropped = await runCli(cwd, ['drop', jobs[0].id], env);
	assert.equal(dropped.code, 0, dropped.stderr);
	assert.deepEqual(JSON.parse((await runCli(cwd, ['list', '--json'], env)).stdout), []);
	assert.equal(git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'nothing was ever edited');
});

test('ui: a job that already started editing cannot be dropped', async () => {
	const cwd = bugRepo('node --test');
	const env = cleanEnv({ ORQUESTRA_CLAUDE_BIN: fakeBin('claude'), ORQUESTRA_HOME: home(cwd) });
	assert.equal((await runCli(cwd, ['run', 'fix add', '--yes'], env)).code, 0);
	const [job] = JSON.parse((await runCli(cwd, ['list', '--json'], env)).stdout) as Job[];
	const r = await runCli(cwd, ['drop', job.id], env);
	assert.equal(r.code, 1);
	assert.match(r.stderr, /already started editing/);
});

test('ui: providers --json reports each CLI and gh', async () => {
	const cwd = bugRepo('node --test');
	const r = await runCli(cwd, ['providers', '--json'], cleanEnv({ ORQUESTRA_CLAUDE_BIN: fakeBin('claude'), FAKE_CODEX_LOGIN: 'none' }));
	assert.equal(r.code, 0, r.stderr);
	const out = JSON.parse(r.stdout) as { providers: Array<{ id: string; ok: boolean; reason?: string }>; gh: { ok: boolean }; defaultProvider: string };
	assert.deepEqual(out.providers.map((p) => [p.id, p.ok]), [['claude', true], ['codex', false]]);
	assert.match(out.providers[1].reason ?? '', /not logged in/);
	assert.equal(out.gh.ok, true);
	assert.equal(out.defaultProvider, 'claude');
});

test('ui: Stop (SIGTERM) also kills the model the CLI started, and resume plans again', { skip: process.platform === 'win32' && 'Windows stops the tree with taskkill' }, async () => {
	const cwd = bugRepo('node --test');
	const pidFile = path.join(cwd, '..', `${path.basename(cwd)}-claude.pid`);
	const env = cleanEnv({ ORQUESTRA_CLAUDE_BIN: fakeBin('claude'), ORQUESTRA_HOME: home(cwd), FAKE_CLAUDE_MODE: 'hang', FAKE_CLAUDE_PIDFILE: pidFile });
	const child = spawn(process.execPath, [CLI, 'plan', 'fix add'], { cwd, env });
	let stderr = '';
	child.stderr.on('data', (b: Buffer) => { stderr += b.toString('utf8'); });
	const closed = new Promise<number | null>((resolve) => child.on('close', resolve));

	const deadline = Date.now() + 15_000;
	while (!fs.existsSync(pidFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
	const modelPid = Number(fs.readFileSync(pidFile, 'utf8'));
	assert.ok(modelPid > 0);
	child.kill('SIGTERM');
	assert.equal(await closed, 130);
	assert.match(stderr, /orquestra: stopped \(SIGTERM\)/);

	const alive = () => { try { process.kill(modelPid, 0); return true; } catch { return false; } };
	const until = Date.now() + 5000;
	while (alive() && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
	assert.equal(alive(), false, 'the model process does not keep running on its own');

	const resumed = await runCli(cwd, ['resume', '--yes'], cleanEnv({ ORQUESTRA_CLAUDE_BIN: fakeBin('claude'), ORQUESTRA_HOME: home(cwd) }));
	assert.equal(resumed.code, 0, resumed.stderr + resumed.stdout);
	assert.match(resumed.stdout, /passed/);
});
