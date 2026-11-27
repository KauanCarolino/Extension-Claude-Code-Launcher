// Aba do orquestrador: achar a CLI, montar os argumentos, ler os jobs e validar o que a página manda.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const OUT = process.env.LAUNCHER_TEST_OUT || path.resolve(__dirname, '../out');
const o = require(path.join(OUT, 'orchestra.js'));
const h = require(path.join(OUT, 'history.js'));

const base = { setting: undefined, extensionPath: '/ext', onPath: undefined, node: '/usr/bin/node', fallbackNode: '/opt/Code/code', platform: 'linux' };

test('cli lookup: machine setting, then the orchestrator next to the extension, then PATH; never a shell', () => {
	const exists = (files) => (file) => files.includes(file);
	const bundled = path.join('/ext', 'orchestrator', 'out', 'src', 'cli.js');

	assert.deepEqual(o.resolveCli({ ...base, setting: '/home/me/orq/cli.js', exists: exists(['/home/me/orq/cli.js', bundled]) }),
		{ file: '/usr/bin/node', prefix: ['/home/me/orq/cli.js'], source: 'setting' });
	assert.equal(o.resolveCli({ ...base, setting: 'relative/cli.js', exists: () => true }), undefined, 'a relative path is refused');
	assert.equal(o.resolveCli({ ...base, setting: '/missing/cli.js', exists: exists([bundled]) }), undefined, 'a wrong setting is not silently replaced');
	assert.deepEqual(o.resolveCli({ ...base, setting: '/usr/local/bin/orquestra-bin', exists: () => true }),
		{ file: '/usr/local/bin/orquestra-bin', prefix: [], source: 'setting' });

	assert.deepEqual(o.resolveCli({ ...base, exists: exists([bundled]) }), { file: '/usr/bin/node', prefix: [bundled], source: 'workspace' });

	const linked = o.resolveCli({ ...base, onPath: '/usr/bin/orquestra', exists: () => false, realpath: () => '/usr/lib/node_modules/orquestra/out/src/cli.js' });
	assert.deepEqual(linked, { file: '/usr/bin/node', prefix: ['/usr/lib/node_modules/orquestra/out/src/cli.js'], source: 'path' });

	const shim = 'C:\\Users\\me\\AppData\\Roaming\\npm\\orquestra.cmd';
	const target = 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\orquestra\\out\\src\\cli.js';
	assert.deepEqual(o.resolveCli({ ...base, platform: 'win32', node: 'C:\\node\\node.exe', onPath: shim, exists: exists([target]), realpath: (f) => f }),
		{ file: 'C:\\node\\node.exe', prefix: [target], source: 'path' }, 'the .cmd shim is skipped: cmd.exe never runs');
	assert.equal(o.resolveCli({ ...base, platform: 'win32', onPath: shim, exists: () => false, realpath: (f) => f }), undefined);

	assert.deepEqual(o.resolveCli({ ...base, node: undefined, exists: exists([bundled]) }),
		{ file: '/opt/Code/code', prefix: [bundled], source: 'workspace', electronAsNode: true }, 'without node on PATH the editor runs as node');
	assert.equal(o.resolveCli({ ...base, exists: () => false }), undefined);
});

test('actions: the request goes through stdin, ids never become options', () => {
	assert.deepEqual(o.actionArgs({ kind: 'plan' }), ['plan', '--stdin']);
	assert.deepEqual(o.actionArgs({ kind: 'plan', provider: 'codex' }), ['plan', '--stdin', '--provider', 'codex']);
	assert.deepEqual(o.actionArgs({ kind: 'confirm', id: '20261126-a1b2c3', pr: true }), ['resume', '20261126-a1b2c3', '--yes', '--pr']);
	assert.deepEqual(o.actionArgs({ kind: 'confirm', id: 'x', pr: false }), ['resume', 'x', '--yes']);
	assert.deepEqual(o.actionArgs({ kind: 'resume', id: 'x', discard: true }), ['resume', 'x', '--yes', '--discard']);
	assert.deepEqual(o.actionArgs({ kind: 'pr', id: 'x' }), ['resume', 'x', '--yes', '--pr']);
	assert.deepEqual(o.actionArgs({ kind: 'drop', id: 'x' }), ['drop', 'x']);
	assert.deepEqual(o.actionArgs({ kind: 'providers' }), ['providers', '--json']);
	for (const bad of ['--discard', '-x', '../a', 'a b', '', 'a'.repeat(65), 3]) { assert.equal(o.validJobId(bad), false, String(bad)); }
	assert.equal(o.validJobId('20261126-a1b2c3'), true);
	assert.equal(o.validRequest('fix it\nwith "quotes" & pipes |'), true);
	for (const bad of ['', '   \n', 'a\u0000b', 'a\u001bb', 'x'.repeat(o.MAX_REQUEST + 1), 42]) { assert.equal(o.validRequest(bad), false); }
});

test('view messages: the request text is accepted only on the home view, with newlines but no other controls', () => {
	const ok = h.validateMessage({ command: 'orchestra.plan', text: 'line 1\nline 2\tend', key: 'claude' }, 'home');
	assert.equal(ok.text, 'line 1\nline 2\tend');
	assert.equal(ok.key, 'claude');
	assert.equal(h.validateMessage({ command: 'orchestra.plan', text: 'a\u0007b' }, 'home'), undefined);
	assert.equal(h.validateMessage({ command: 'orchestra.plan', text: 'x'.repeat(8001) }, 'home'), undefined);
	assert.equal(h.validateMessage({ command: 'orchestra.plan', text: 5 }, 'home'), undefined);
	assert.equal(h.validateMessage({ command: 'orchestra.plan', text: 'x' }), undefined, 'the changes view never takes a request');
	for (const command of h.ORCHESTRA_COMMANDS) { assert.ok(h.validateMessage({ command }, 'home'), command); }
	assert.equal(h.validateMessage({ command: 'orchestra.exec' }, 'home'), undefined);
});

function job(extra) {
	return {
		version: 1, id: '20261126-a1b2c3', state: 'planning', request: 'fix add', branch: 'orquestra/20261126-a1b2c3-fix-add',
		createdAt: '2026-11-26T12:00:00.000Z', updatedAt: '2026-11-26T12:01:00.000Z', planConfirmed: false, steps: [], repairCycles: 0,
		quota: {}, timing: { modelMs: { claude: 5000 }, testMs: 0, quotaWaitMs: 0 }, budget: { inputTokensEstimate: 1, calls: 1 }, events: [], ...extra,
	};
}

test('jobs: only the fields the page shows, checked; PR links only over https', () => {
	const v = o.jobView(job({
		plan: { goal: 'add returns the sum', steps: [] },
		steps: [{ id: '1', title: 'Fix add', files: ['math.js', 7], status: 'done', provider: 'codex', commit: '0123456789abcdef', confidence: 0.9, risk: 'low', attempts: 0 }],
		pr: { url: 'https://github.com/o/r/pull/1' }, wantPr: true, lastTest: { passed: true, command: 'npm test', exitCode: 0, timedOut: false, durationMs: 1200 },
	}));
	assert.equal(v.goal, 'add returns the sum');
	assert.deepEqual(v.steps[0], { id: '1', title: 'Fix add', files: ['math.js'], status: 'done', provider: 'codex', commit: '01234567', confidence: 0.9, risk: 'low' });
	assert.deepEqual(v.providers, ['codex']);
	assert.equal(v.prUrl, 'https://github.com/o/r/pull/1');
	assert.equal(o.jobView(job({ pr: { url: 'javascript:alert(1)' } })).prUrl, undefined);
	assert.equal(o.jobView(job({ pr: { url: 'http://github.com/o/r/pull/1' } })).prUrl, undefined);
	assert.equal(o.jobView(job({ version: 2 })), undefined);
	assert.equal(o.jobView(job({ id: '--evil' })), undefined);
	assert.equal(o.jobView(null), undefined);
});

test('jobs: buttons follow the state', () => {
	const v = (extra) => o.jobActions(o.jobView(job(extra)));
	assert.deepEqual(v({ plan: { goal: 'g', steps: [] } }), ['confirm', 'drop'], 'a plan waiting for confirmation');
	assert.deepEqual(v({ state: 'needs_human' }), ['resume', 'drop'], 'the planner failed: try again or drop');
	assert.deepEqual(v({ state: 'blocked_quota', planConfirmed: true, plan: { goal: 'g', steps: [] } }), ['resume', 'discard']);
	assert.deepEqual(v({ state: 'passed', planConfirmed: true }), ['pr']);
	assert.deepEqual(v({ state: 'passed', planConfirmed: true, wantPr: true, prError: 'gh failed' }), ['pr']);
	assert.deepEqual(v({ state: 'pr_open', planConfirmed: true, pr: { url: 'https://github.com/o/r/pull/1' } }), ['openPr']);
});

test('jobs: read from .orquestra/jobs, newest first; broken or foreign files are skipped', async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-orq-'));
	const dir = path.join(root, '.orquestra', 'jobs');
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify(job({ id: 'a', createdAt: '2026-11-26T10:00:00.000Z' })));
	fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify(job({ id: 'b', createdAt: '2026-11-26T11:00:00.000Z' })));
	fs.writeFileSync(path.join(dir, 'c.json'), '{ not json');
	fs.writeFileSync(path.join(dir, 'a.lock'), '123');
	fs.mkdirSync(path.join(dir, 'a.runs'));
	assert.deepEqual((await o.readJobs(root)).map((j) => j.id), ['b', 'a']);
	assert.deepEqual(await o.readJobs(path.join(root, 'nothing-here')), []);
});

test('providers, errors and the project template', () => {
	const p = o.parseProviders('{"providers":[{"id":"claude","ok":true},{"id":"codex","ok":false,"reason":"not logged in"}],"gh":{"ok":true},"defaultProvider":"claude"}\n');
	assert.deepEqual(p, { providers: [{ id: 'claude', ok: true, reason: undefined }, { id: 'codex', ok: false, reason: 'not logged in' }], gh: { ok: true, reason: undefined }, defaultProvider: 'claude' });
	assert.equal(o.parseProviders('garbage'), undefined);
	assert.equal(o.cliError('Planning with claude…\norquestra: The working tree has uncommitted changes (a.txt).\n'), 'The working tree has uncommitted changes (a.txt).');
	assert.equal(o.cliError('just logs'), undefined);
	assert.equal(JSON.parse(o.projectTemplate('{"scripts":{"test":"node --test"}}')).test, 'npm test');
	assert.match(JSON.parse(o.projectTemplate('{"scripts":{}}')).test, /set the test command/);
	assert.equal(JSON.parse(o.projectTemplate(undefined)).baseBranch, 'main');
});
