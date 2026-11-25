'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { planHooks, inspectHookConfiguration, applyHookPlan, configFingerprint, HOOK_MATCHER } = require(
	path.join(process.env.LAUNCHER_TEST_OUT || path.join(__dirname, '..', 'out'), 'hooks.js'));
const scriptPath = '/workspace/Example Project/.claude/launcher-changes/launcher-record-change.js';
const confirmed = { status: 'confirmed', harness: 'synthetic-contract', version: 'fixture', evidence: 'schema fixture' };
const options = (text, enable = true, extra = {}) => ({
	read: text === undefined ? { kind: 'absent' } : { kind: 'content', text }, scriptPath, enable, capability: confirmed, ...extra,
});

test('hook configuration passes a literal path with spaces as one argument, without a shell string', () => {
	const plan = planHooks(options(undefined));
	assert.equal(plan.kind, 'ready');
	const hook = JSON.parse(plan.nextText).hooks.PreToolUse[0].hooks[0];
	assert.equal(hook.command, 'node');
	assert.deepEqual(hook.args, [scriptPath, 'pre']);
	assert.equal(hook.shell, undefined);
	assert.equal(inspectHookConfiguration({ kind: 'content', text: plan.nextText }, scriptPath).active, true);
});

test('unknown capability blocks generation and error reads never become an empty configuration', () => {
	const unknown = planHooks(options('{}', true, { capability: { status: 'unknown', harness: 'unknown' } }));
	assert.equal(unknown.kind, 'blocked');
	assert.equal(unknown.code, 'execArgumentsNotConfirmed');
	assert.equal(unknown.nextText, undefined);
	assert.equal(planHooks({ ...options(undefined), read: { kind: 'error' } }).code, 'settingsReadFailed');
});

test('activation and deactivation preserve siblings and unrelated group fields', () => {
	const third = { type: 'command', command: 'ordinary-validator', args: ['check'] };
	const source = JSON.stringify({ permissions: { ask: ['ordinary-tool'] }, hooks: {
		PreToolUse: [{ matcher: HOOK_MATCHER, description: 'keep group', hooks: [
			{ type: 'command', command: `node "${scriptPath}" pre`, timeout: 10 }, third,
		] }], Notification: [{ matcher: 'idle', hooks: [{ type: 'command', command: 'notify', args: [] }] }],
	} });
	const plan = planHooks(options(source));
	const configured = JSON.parse(plan.nextText);
	assert.equal(configured.hooks.PreToolUse[0].description, 'keep group');
	assert.deepEqual(configured.hooks.PreToolUse[0].hooks, [third]);
	assert.deepEqual(configured.permissions, JSON.parse(source).permissions);
	assert.deepEqual(configured.hooks.Notification, JSON.parse(source).hooks.Notification);
	const disabled = planHooks(options(plan.nextText, false, { capability: { status: 'unknown', harness: 'inspection' } }));
	assert.deepEqual(JSON.parse(disabled.nextText).hooks.PreToolUse[0].hooks, [third]);
	assert.equal(JSON.parse(disabled.nextText).hooks.PostToolUse, undefined);
});

test('repeated enable is idempotent and a mere filename mention has no ownership', () => {
	const first = planHooks(options(JSON.stringify({ note: 'launcher-record-change.js is documentation', hooks: {
		PreToolUse: [{ matcher: 'Other', hooks: [{ type: 'command', command: 'launcher-record-change.js', args: ['readme'] }] }],
	} })));
	const next = planHooks(options(first.nextText));
	assert.equal(next.changed, false);
	assert.equal(JSON.parse(first.nextText).hooks.PreToolUse[0].matcher, 'Other');
	assert.equal(inspectHookConfiguration({ kind: 'content', text: '{"note":"launcher-record-change.js"}' }, scriptPath).active, false);
});

test('invalid JSON, root, hook group and version-like unknown data are preserved rather than normalized', () => {
	for (const text of ['not json', 'null', '[]', '{"hooks":[]}', '{"hooks":{"PreToolUse":{}}}', '{"hooks":{"PreToolUse":[{"hooks":"invalid"}]}}']) {
		const plan = planHooks(options(text));
		assert.equal(plan.kind, 'blocked');
		assert.equal(plan.originalText, text);
		assert.equal(plan.nextText, undefined);
	}
	// Unknown inert properties are preserved; this module does not invent a harness schema version.
	const valid = planHooks(options('{"customVersion":2}'));
	assert.equal(JSON.parse(valid.nextText).customVersion, 2);
});

test('a single phase is not reported as a fully active pair', () => {
	const enabled = JSON.parse(planHooks(options(undefined)).nextText);
	delete enabled.hooks.PostToolUse;
	assert.equal(inspectHookConfiguration({ kind: 'content', text: JSON.stringify(enabled) }, scriptPath).active, false);
});

test('a known script with an unrecognized matcher needs explicit resolution instead of falsely reporting disabled', () => {
	const text = JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'node', args: [scriptPath, 'pre'] }] }] } });
	const plan = planHooks(options(text, false));
	assert.equal(plan.kind, 'blocked');
	assert.equal(plan.code, 'ambiguousHookOwnership');
	assert.equal(plan.nextText, undefined);
});

test('an unknown former installation path is preserved and blocks duplicate installation until ownership is resolved', () => {
	const text = JSON.stringify({ hooks: { PreToolUse: [{ matcher: HOOK_MATCHER,
		hooks: [{ type: 'command', command: 'node', args: ['/former/installation/launcher-record-change.js', 'pre'] }] }] } });
	assert.equal(planHooks(options(text)).code, 'ambiguousHookOwnership');
	assert.equal(inspectHookConfiguration({ kind: 'content', text }, scriptPath).code, 'ambiguousHookOwnership');
	assert.equal(planHooks(options(text, true, { knownScriptPaths: ['/former/installation/launcher-record-change.js'] })).kind, 'ready');
});

test('application backs up exact original text, verifies ownership and confirms the persisted file', async () => {
	const source = '{ "other": true }\n';
	const plan = planHooks(options(source));
	let current = source;
	const calls = [];
	const result = await applyHookPlan(plan, {
		read: async () => ({ kind: 'content', text: current }),
		assertOwnership: async () => calls.push('owner'),
		backup: async (text, hash) => { assert.equal(text, source); assert.equal(hash, configFingerprint(source)); calls.push('backup'); },
		write: async (text, hash) => { assert.equal(hash, configFingerprint(source)); current = text; calls.push('write'); },
	});
	assert.equal(result.kind, 'persisted');
	assert.deepEqual(calls, ['owner', 'backup', 'owner', 'write']);
});

test('external fingerprint changes or failed verification never report configuration success', async () => {
	const plan = planHooks(options('{}'));
	let writes = 0;
	const io = {
		read: async () => ({ kind: 'content', text: '{"changed":true}' }),
		assertOwnership: async () => {}, backup: async () => {}, write: async () => { writes += 1; },
	};
	assert.equal((await applyHookPlan(plan, io)).kind, 'conflict');
	assert.equal(writes, 0);
	io.read = async () => ({ kind: 'content', text: '{}' });
	assert.equal((await applyHookPlan(plan, io)).code, 'settingsVerificationFailed');
	assert.equal(writes, 1);
});

test('ownership loss or backup failure blocks the write', async () => {
	let writes = 0;
	const result = await applyHookPlan(planHooks(options('{}')), {
		read: async () => ({ kind: 'content', text: '{}' }),
		assertOwnership: async () => {}, backup: async () => { throw new Error('synthetic IO failure'); },
		write: async () => { writes += 1; },
	});
	assert.equal(result.kind, 'failed');
	assert.equal(writes, 0);
});

test('a captura do turno adiciona UserPromptSubmit e Stop sem matcher, é idempotente e sai quando desligada', () => {
	const third = { matcher: undefined, hooks: [{ type: 'command', command: 'notify-done', args: [] }] };
	const source = JSON.stringify({ hooks: { Stop: [third] } });
	const plan = planHooks(options(source, true, { turnCapture: true }));
	const configured = JSON.parse(plan.nextText);
	assert.deepEqual(configured.hooks.UserPromptSubmit, [{ hooks: [{ type: 'command', command: 'node', args: [scriptPath, 'turn-start'], timeout: 10 }] }]);
	assert.deepEqual(configured.hooks.Stop[0].hooks, third.hooks, 'o hook de terceiros fica');
	assert.deepEqual(configured.hooks.Stop.at(-1), { hooks: [{ type: 'command', command: 'node', args: [scriptPath, 'turn-end'], timeout: 10 }] });
	const inspected = inspectHookConfiguration({ kind: 'content', text: plan.nextText }, scriptPath);
	assert.deepEqual([inspected.active, inspected.turn], [true, true]);
	assert.equal(planHooks(options(plan.nextText, true, { turnCapture: true })).changed, false);
	// Desligar só a captura do turno mantém o registro por edição e o hook de terceiros.
	const withoutTurn = JSON.parse(planHooks(options(plan.nextText, true, { turnCapture: false })).nextText);
	assert.equal(withoutTurn.hooks.UserPromptSubmit, undefined);
	assert.deepEqual(withoutTurn.hooks.Stop, [{ hooks: third.hooks }]);
	assert.equal(inspectHookConfiguration({ kind: 'content', text: JSON.stringify(withoutTurn) }, scriptPath).turn, false);
	const disabled = JSON.parse(planHooks(options(plan.nextText, false)).nextText);
	assert.deepEqual(Object.keys(disabled.hooks), ['Stop']);
});

test('um handler de turno próprio dentro de um grupo com matcher é ambíguo', () => {
	const source = JSON.stringify({ hooks: { Stop: [{ matcher: 'x', hooks: [{ type: 'command', command: 'node', args: [scriptPath, 'turn-end'] }] }] } });
	assert.equal(planHooks(options(source, true, { turnCapture: true })).code, 'ambiguousHookOwnership');
	assert.equal(inspectHookConfiguration({ kind: 'content', text: source }, scriptPath).code, 'ambiguousHookOwnership');
});
