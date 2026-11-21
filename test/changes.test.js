'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { fixture, entry, writeLog, readLog, writeDiagnostic, until, OUT } = require('./helpers/changes-fixture.cjs');
const { ReviewStore } = require(path.join(OUT, 'review-store.js'));
const { ingestEntries } = require(path.join(OUT, 'review.js'));
const { describeReason } = require(path.join(OUT, 'messages.js'));
const history = require(path.join(OUT, 'history.js'));
const hooks = require(path.join(OUT, 'hooks.js'));

function windowsProjection(t) {
	const root = String.raw`d:\Fixture\workspace`;
	const uriFilePath = file => /^[A-Za-z]:[\\/]/.test(file) ? file.replace(/^[A-Z]:/, drive => drive.toLowerCase()) : path.resolve(file);
	const f = fixture(t, { nodePath: path.win32, uriFilePath, history: {
		// This test models Windows identity in memory, not a Windows filesystem.
		// Explicitly model absence of the new durable purge guard at the IO boundary.
		safeReadText: async (file, ...args) => /^[A-Za-z]:[\\/]/.test(file) && file.endsWith('purge-state.v1.json')
			? { kind: 'absent' } : history.safeReadText(file, ...args),
	} });
	f.folder.uri = new f.Uri(root);
	return { ...f, windowsRoot: root };
}
/** Pure store boundary; decisions still execute the real reversal module. */
function projectedStore(root, file, id = 'windows-entry') {
	const state = { schemaVersion: 1, generation: 0, contextId: root, reviews: {}, statuses: {}, operations: {}, undo: [],
		legacyProjection: { phase: 'complete', observedHash: null, targetHash: null, targetGeneration: 0 } };
	ingestEntries(state, [{ id, time: '2026-11-19T12:00:00.000Z', file,
		before: { exists: true, large: false, text: 'before\r\n' }, after: { exists: true, large: false, text: 'after\r\n' } }]);
	return { root, writable: true, get: () => structuredClone(state), update: async mutate => { mutate(state); state.generation += 1; }, close: async () => {}, state };
}

test('Windows URI drive aliases resolve persisted reviews without new entries and dispatch the canonical decision', async t => {
	const f = windowsProjection(t), canonical = String.raw`D:\Fixture\workspace\crlf.txt`, document = String.raw`d:\Fixture\workspace\crlf.txt`;
	const store = projectedStore(f.windowsRoot, canonical);
	f.controller.stores.set(f.folder.uri.toString(), store);
	f.controller.synchronizeViews();
	assert.deepEqual(f.controller.getEntries(), [], 'the alias is also rebuilt for persisted state without a new log entry');
	assert.equal(f.controller.getSharedReview(document).file, canonical);
	assert.equal(f.controller.getSharedReview(document).phase, 'pending');
	let content = { kind: 'text', text: 'after\r\n' }; const writes = [];
	f.controller.resourceAdapter = () => ({ read: async file => { assert.equal(file, canonical); return content; },
		readPersisted: async file => { assert.equal(file, canonical); return content; },
		write: async (file, target) => { writes.push(file); content = target; } });
	await f.controller.executeReviewDecision(document, { action: 'reject', revision: 1 });
	assert.deepEqual(writes, [canonical]);
	assert.equal(content.text, 'before\r\n');
	assert.equal(store.state.statuses['windows-entry'], 'rejected');
	assert.equal(store.state.contextId, f.windowsRoot);
	assert.deepEqual(Object.keys(store.state.reviews), [canonical]);
});

test('Windows URI aliases preserve directory and filename case and reject unrelated resources', async t => {
	const f = windowsProjection(t), upper = String.raw`D:\Fixture\workspace\Case\File.txt`, lower = String.raw`D:\Fixture\workspace\case\file.txt`;
	const store = projectedStore(f.windowsRoot, upper, 'upper');
	const other = projectedStore(f.windowsRoot, lower, 'lower');
	store.state.reviews[lower] = other.state.reviews[lower];
	f.controller.stores.set(f.folder.uri.toString(), store); f.controller.synchronizeViews();
	assert.equal(f.controller.getSharedReview(String.raw`d:\Fixture\workspace\Case\File.txt`).firstId, 'upper');
	assert.equal(f.controller.getSharedReview(String.raw`d:\Fixture\workspace\case\file.txt`).firstId, 'lower');
	let effects = 0; f.controller.resourceAdapter = () => { effects += 1; throw new Error('unrelated resource must not reach the executor'); };
	for (const file of [String.raw`d:\Fixture\workspace\Case\file.txt`, String.raw`E:\Fixture\workspace\Case\File.txt`, String.raw`D:\Fixture\workspace-other\Case\File.txt`]) {
		assert.equal(f.controller.getSharedReview(file), undefined);
		await assert.rejects(f.controller.executeReviewDecision(file, { action: 'reject' }), /reviewUnavailable/);
	}
	assert.equal(effects, 0);
});

test('ambiguous URI aliases and two or three owners stay blocked and a removed conflict is recomputed', async t => {
	const f = windowsProjection(t), canonical = String.raw`D:\Fixture\workspace\crlf.txt`, document = String.raw`d:\Fixture\workspace\crlf.txt`;
	let effects = 0; f.controller.resourceAdapter = () => { effects += 1; throw new Error('ambiguous review must not reach the executor'); };
	for (const count of [2, 3]) {
		f.controller.stores.clear();
		for (let index = 0; index < count; index += 1) { f.controller.stores.set('context-' + index, projectedStore(f.windowsRoot, canonical, 'entry-' + index)); }
		f.controller.synchronizeViews();
		assert.equal(f.controller.getSharedReview(canonical).blockReason, 'ambiguousContext');
		assert.equal(f.controller.getSharedReview(document).phase, 'blocked');
		assert.equal(f.controller.fileStores.has(canonical), false);
		await assert.rejects(f.controller.executeReviewDecision(document, { action: 'reject' }), /ambiguousContext/);
	}
	f.controller.stores.clear();
	f.controller.stores.set('upper-context', projectedStore(f.windowsRoot, canonical, 'upper'));
	f.controller.stores.set('lower-context', projectedStore(f.windowsRoot, document, 'lower'));
	f.controller.synchronizeViews();
	for (const file of [canonical, document]) {
		assert.equal(f.controller.getSharedReview(file).blockReason, 'ambiguousContext');
		assert.equal(f.controller.fileStores.has(file), false);
		await assert.rejects(f.controller.executeReviewDecision(file, { action: 'reject' }), /ambiguousContext/);
	}
	assert.equal(effects, 0);
	f.controller.stores.delete('lower-context'); f.controller.synchronizeViews();
	assert.equal(f.controller.getSharedReview(document).phase, 'pending');
	assert.equal(f.controller.fileStores.has(canonical), true);
	// A prior alias whose review left the projection must not keep a false conflict alive.
	f.controller.stores.clear(); f.controller.stores.set('lower-context', projectedStore(f.windowsRoot, document, 'only-lower'));
	f.controller.synchronizeViews();
	assert.equal(f.controller.getSharedReview(document).firstId, 'only-lower');
	assert.equal(f.controller.getSharedReview(document).phase, 'pending');
});

test('controller preflight blocks unknown capability before writing a policy or hook script', async (t) => {
	const f = fixture(t, { mode: 'auto' });
	await f.controller.setEnabled(true);
	assert.equal(fs.existsSync(path.join(f.dir, history.CAPTURE_POLICY_FILE)), false);
	assert.equal(fs.existsSync(path.join(f.dir, hooks.HOOK_NAME)), false);
	// The user reads the explanation of this specific reason, never the internal code.
	assert.ok(f.warnings.some((message) => message.includes(describeReason('execArgumentsNotConfirmed'))));
	assert.ok(f.warnings.every((message) => !message.includes('execArgumentsNotConfirmed')));
});

test('controller preflight preserves invalid settings without installing script or policy', async (t) => {
	const f = fixture(t);
	fs.mkdirSync(path.join(f.root, '.claude'));
	const settings = path.join(f.root, '.claude', 'settings.local.json');
	fs.writeFileSync(settings, 'ordinary invalid JSON');
	await f.controller.setEnabled(true);
	assert.equal(fs.readFileSync(settings, 'utf8'), 'ordinary invalid JSON');
	assert.equal(fs.existsSync(path.join(f.dir, history.CAPTURE_POLICY_FILE)), false);
	assert.equal(fs.existsSync(path.join(f.dir, hooks.HOOK_NAME)), false);
});

test('unknown capture-policy version is preserved, and cannot be reset by activation', async (t) => {
	const f = fixture(t); f.policy({ schemaVersion: 2, paused: true });
	const file = path.join(f.dir, history.CAPTURE_POLICY_FILE), prior = fs.readFileSync(file, 'utf8');
	await f.controller.setEnabled(true);
	assert.equal(fs.readFileSync(file, 'utf8'), prior);
	assert.equal(fs.existsSync(path.join(f.dir, hooks.HOOK_NAME)), false);
	assert.ok(f.warnings.some((message) => message.includes(describeReason('unsupportedCapturePolicy'))));
	assert.ok(f.warnings.every((message) => !message.includes('unsupportedCapturePolicy')));
});

test('repair preserves an explicit pause across reload and effective capture is not reported active', async (t) => {
	const f = fixture(t); f.configuredHooks(); f.policy({ paused: true });
	const file = path.join(f.dir, history.CAPTURE_POLICY_FILE), prior = fs.readFileSync(file, 'utf8');
	await f.controller.repairHooks();
	assert.equal(fs.readFileSync(file, 'utf8'), prior);
	assert.equal(await f.controller.hooksEnabled(), false);
});

test('clear keeps policy pause and pending entries while dropping eligible reviewed history', async (t) => {
	const f = fixture(t); const store = await f.store(); f.policy({ paused: true });
	const done = entry(f.root, 'done'), pending = entry(f.root, 'pending'); writeLog(f, [done, pending]);
	await store.update((state) => { state.statuses.done = 'accepted'; ingestEntries(state, [pending]); });
	const prior = fs.readFileSync(path.join(f.dir, history.CAPTURE_POLICY_FILE), 'utf8');
	await f.controller.clear();
	assert.deepEqual(readLog(f).map((row) => row.id), ['pending']);
	assert.equal(fs.readFileSync(path.join(f.dir, history.CAPTURE_POLICY_FILE), 'utf8'), prior);
	assert.equal(f.controller.maintenance, false);
	assert.equal(fs.existsSync(path.join(f.dir, history.CAPTURE_MAINTENANCE_FILE)), false);
});

test('purge leaves capture paused on later repair, and preserves current files and control directories', async (t) => {
	const f = fixture(t); await f.store(); f.configuredHooks(); f.policy();
	fs.writeFileSync(path.join(f.root, 'ordinary.txt'), 'current user content');
	writeLog(f, [entry(f.root, 'ordinary')]);
	fs.mkdirSync(path.join(f.dir, 'active'));
	await f.controller.clearAllReviewData();
	assert.equal(f.controller.maintenance, false);
	assert.equal(fs.existsSync(path.join(f.dir, 'log.jsonl')), false);
	assert.equal(fs.existsSync(path.join(f.dir, 'review-writer.lock')), false);
	assert.equal(fs.existsSync(path.join(f.dir, history.CAPTURE_MAINTENANCE_FILE)), false);
	assert.equal(fs.statSync(path.join(f.dir, 'active')).isDirectory(), true);
	assert.equal(fs.readFileSync(path.join(f.root, 'ordinary.txt'), 'utf8'), 'current user content');
	assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, history.CAPTURE_POLICY_FILE), 'utf8')).paused, true);
	await f.controller.repairHooks();
	assert.equal(await f.controller.hooksEnabled(), false);
	assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, history.CAPTURE_POLICY_FILE), 'utf8')).paused, true);
});

test('a memento failure during purge releases controller maintenance and reports a partial result', async (t) => {
	const f = fixture(t, { failMemento: true }); await f.store(); f.policy();
	writeLog(f, [entry(f.root, 'ordinary')]);
	await f.controller.clearAllReviewData();
	assert.equal(f.controller.maintenance, false);
	assert.ok(f.warnings.some((message) => message.includes('parcial/bloqueada')));
	assert.equal(f.messages.some((message) => message.startsWith('Dados locais de revisão removidos.')), false);
});

test('metadata resolving after purge cannot repopulate caches from the earlier epoch', async (t) => {
	let resolveMeta, signalRead;
	const began = new Promise((resolve) => { signalRead = resolve; });
	const pending = new Promise((resolve) => { resolveMeta = resolve; });
	const f = fixture(t, { history: { transcriptAllowed: async () => true }, sessions: {
		readTranscriptMeta: async () => { signalRead(); return pending; },
	} });
	await f.store(); f.policy();
	const row = { ...entry(f.root, 'ordinary'), transcript: path.join(f.root, 'sessions', 'ordinary.jsonl'), toolUseId: 'tool-1' };
	writeLog(f, [row]); f.controller.entries = [row];
	const loading = f.controller.fillMeta(); await began;
	await f.controller.clearAllReviewData();
	resolveMeta({ reasons: new Map([['tool-1', 'ordinary reason']]), requests: new Map([['tool-1', { id: 'request-1', text: 'ordinary request' }]]) });
	await loading;
	assert.equal(f.controller.reasonCache.size, 0);
	assert.equal(f.controller.requestCache.size, 0);
	assert.equal(fs.existsSync(path.join(f.dir, 'meta.json')), false);
});

test('metadata read failures and incompatible documents cannot become an empty writable metadata file', async (t) => {
	const f = fixture(t); await f.store();
	const file = path.join(f.dir, 'meta.json'); fs.writeFileSync(file, '{"schemaVersion":999}');
	await assert.rejects(f.controller.writeIfChanged(f.Uri.file(file), { ordinary: { reason: 'reason', request: null } }), /invalidMetadata/);
	assert.equal(fs.readFileSync(file, 'utf8'), '{"schemaVersion":999}');
	fs.unlinkSync(file); fs.mkdirSync(file);
	assert.equal(await f.controller.readState(f.Uri.file(file)), undefined);
	assert.ok(f.controller.coverageMessage);
});

test('GC keeps unknown files, canonical namespaces and simulated links, removing only old unreferenced legacy blobs', async (t) => {
	let simulatedLink;
	const nodeFs = { ...fs, promises: { ...fs.promises,
		async lstat(file) {
			const stat = await fs.promises.lstat(file);
			if (file === simulatedLink) { return { isFile: () => true, isSymbolicLink: () => true, mtimeMs: stat.mtimeMs }; }
			return stat;
		},
	} };
	const f = fixture(t, { nodeFs }); await f.store();
	const blobs = path.join(f.dir, 'blobs'); fs.mkdirSync(blobs);
	const old = 'a'.repeat(40), live = 'b'.repeat(40), linked = 'c'.repeat(40);
	simulatedLink = path.join(blobs, linked + '.txt');
	for (const name of [old + '.txt', live + '.txt', linked + '.txt', 'ordinary-not-a-blob.txt']) {
		const file = path.join(blobs, name); fs.writeFileSync(file, 'ordinary snapshot'); fs.utimesSync(file, new Date(1000), new Date(1000));
	}
	const canonical = path.join(f.dir, 'review-blobs', 'v1', 'd'.repeat(64) + '.txt'); fs.writeFileSync(canonical, 'canonical recovery');
	await f.controller.collectBlobs(f.folder.uri, [JSON.stringify({ before: { hash: live } })]);
	assert.equal(fs.existsSync(path.join(blobs, old + '.txt')), false);
	for (const name of [live + '.txt', linked + '.txt', 'ordinary-not-a-blob.txt']) { assert.equal(fs.existsSync(path.join(blobs, name)), true); }
	assert.equal(fs.readFileSync(canonical, 'utf8'), 'canonical recovery');
	assert.equal(fs.existsSync(path.join(f.dir, 'review-writer.lock')), true);
});

test('GC refuses an unsafe directory identity supplied by the IO boundary before deletion', async (t) => {
	let blocked;
	const f = fixture(t, { history: {
		assessStoragePath: async (file, ...args) => file === blocked ? { allowed: false, code: 'unsafeStorageType' } : history.assessStoragePath(file, ...args),
	} });
	await f.store(); blocked = path.join(f.dir, 'blobs'); fs.mkdirSync(blocked);
	const file = path.join(blocked, 'a'.repeat(40) + '.txt'); fs.writeFileSync(file, 'ordinary snapshot');
	await assert.rejects(f.controller.collectBlobs(f.folder.uri, []), /unsafeStorageType/);
	assert.equal(fs.readFileSync(file, 'utf8'), 'ordinary snapshot');
});

test('retention removes only old reviewed records without undo, and log replacement is protected by maintenance', async (t) => {
	let logFile, guardObserved = false;
	const nodeFs = { ...fs, promises: { ...fs.promises,
		async rename(source, target) {
			if (target === logFile) { assert.equal(fs.existsSync(path.join(path.dirname(logFile), history.CAPTURE_MAINTENANCE_FILE)), true); guardObserved = true; }
			return fs.promises.rename(source, target);
		},
	} };
	const f = fixture(t, { nodeFs }); const store = await f.store(); f.policy();
	const old = entry(f.root, 'old', 'old.txt', '2020-01-01T00:00:00.000Z');
	const undo = entry(f.root, 'undo', 'undo.txt', '2020-01-01T00:00:00.000Z');
	const pending = entry(f.root, 'pending', 'pending.txt', '2020-01-01T00:00:00.000Z');
	writeLog(f, [old, undo, pending]); logFile = path.join(f.dir, 'log.jsonl');
	await store.update((state) => {
		state.statuses.old = 'accepted'; state.statuses.undo = 'rejected'; ingestEntries(state, [pending]);
		state.undo.push({ id: 'undo-item', operationId: 'undo-operation', file: undo.file, ids: ['undo'], previous: { kind: 'text', text: 'after' }, restored: { kind: 'text', text: 'before' }, phase: 'available' });
	});
	f.controller.entries = [old, undo, pending]; f.controller.status.set('old', 'accepted'); f.controller.status.set('undo', 'rejected');
	for (const row of f.controller.entries) { f.controller.entryFolder.set(row.id, f.folder.uri.toString()); }
	await f.controller.applyRetention();
	assert.equal(guardObserved, true);
	assert.deepEqual(readLog(f).map((row) => row.id), ['undo', 'pending']);
	assert.equal(store.get().undo[0].phase, 'available');
	assert.equal(fs.existsSync(path.join(f.dir, history.CAPTURE_MAINTENANCE_FILE)), false);
});

test('capture quota is reflected in effective state, while active capture does not erase configuration warnings', async (t) => {
	const f = fixture(t); f.configuredHooks(); f.policy(); writeLog(f, [entry(f.root, 'ordinary')]);
	const key = f.folder.uri.toString(); f.controller.hookWarnings.set(key, 'configuration warning retained');
	writeDiagnostic(f, { stage: 'inventory', code: 'quotaExceeded' });
	f.controller.entries = await f.controller.loadEntries();
	assert.equal(await f.controller.hooksEnabled(), false);
	const states = []; f.controller.post({ postMessage: async (state) => { states.push(state); } }, false);
	assert.equal(states[0].captureHealth[0].observation.code, 'quotaExceeded');
	assert.ok(states[0].coverageMessage.includes('Orçamento atingido'));
	assert.ok(states[0].coverageMessage.includes('configuration warning retained'));
	writeDiagnostic(f, { phase: 'post', stage: 'append', code: 'captureRecorded', contentCoverage: 'complete' });
	f.controller.entries = await f.controller.loadEntries();
	assert.equal(f.controller.captureWarnings.has(key), false);
	assert.equal(f.controller.hookWarnings.get(key), 'configuration warning retained');
	assert.equal(await f.controller.hooksEnabled(), true);
});

test('configured hooks without an event do not publish a completed capture and unknown capability remains distinct', async (t) => {
	const f = fixture(t); f.configuredHooks(); f.policy();
	await f.controller.loadEntries();
	const states = []; f.controller.post({ postMessage: async (state) => { states.push(state); } }, false);
	assert.equal(states[0].captureHealth[0].configuration, 'configured');
	assert.equal(states[0].captureHealth[0].completion, null);
	assert.equal(states[0].captureHealth[0].observation, null);
	f.settings.set('claudeCodeLauncher.hookExecutionMode', 'auto');
	await f.controller.loadEntries();
	states.length = 0; f.controller.post({ postMessage: async (state) => { states.push(state); } }, false);
	assert.equal(states[0].captureHealth[0].capability, 'unknown');
	assert.equal(states[0].captureHealth[0].configuration, 'configured');
	assert.equal(states[0].captureHealth[0].completion, null);
});

test('native view title and menu context identify configuration without asserting observed capture', async (t) => {
	const f = fixture(t); f.configuredHooks(); f.policy();
	await f.controller.loadEntries();
	f.controller.view = { webview: { postMessage: async () => undefined } };
	f.controller.enabled = false;
	f.controller.updateViewChrome(); f.controller.updateViewContexts();
	assert.equal(f.controller.view.description, 'Registro configurado');
	assert.equal(f.controller.captureHealthStates.get(f.folder.uri.toString()).completion, null);
	assert.ok(f.executedCommands.some(([command, context, value]) => command === 'setContext'
		&& context === 'claudeCodeLauncher.changeLogEnabled' && value === true));
});

test('diagnostic-only watcher events refresh the published state without appending a history record', async (t) => {
	const f = fixture(t, { autoRefresh: true }); f.configuredHooks(); f.policy();
	const states = []; f.controller.view = { webview: { postMessage: async (state) => { states.push(state); } } };
	await until(() => states.length > 0, 'initial capture state did not publish');
	const watcher = f.watchers.find((item) => item.pattern.includes('capture-diagnostics/v2'));
	assert.ok(watcher && watcher.created.length && watcher.changed.length && watcher.deleted.length);
	writeDiagnostic(f, { stage: 'snapshot', code: 'storagePermissionDenied', contentCoverage: 'unknown' });
	watcher.created.forEach((handler) => handler());
	await until(() => states.some((state) => state.captureHealth[0]?.observation?.code === 'storagePermissionDenied'), 'diagnostic-only update was not published');
	assert.equal(fs.existsSync(path.join(f.dir, 'log.jsonl')), false);
	assert.equal(states.at(-1).captureHealth[0].completion, null);
});

test('incompatible reloads retain prior completion and late diagnostic reads cannot repopulate a new epoch', async (t) => {
	const f = fixture(t); f.configuredHooks(); f.policy();
	const completed = writeDiagnostic(f, { kind: 'completion', phase: 'post', stage: 'append', code: 'captureRecorded', contentCoverage: 'complete' });
	await f.controller.loadEntries();
	const bucket = path.join(f.dir, ...history.CAPTURE_DIAGNOSTICS_DIR.split('/'), 'completions');
	fs.writeFileSync(path.join(bucket, 'unknown.json'), JSON.stringify({ schemaVersion: 99, text: '/private/never-publish-this' }));
	await f.controller.loadEntries();
	let state; f.controller.post({ postMessage: async (value) => { state = value; } }, false);
	assert.equal(state.captureHealth[0].completion.at, completed.observedAt);
	assert.equal(state.captureHealth[0].partial, true);
	assert.equal(JSON.stringify(state.captureHealth).includes('never-publish-this'), false);
	let release, started;
	const began = new Promise((resolve) => { started = resolve; });
	f.controllerHistory.readCaptureDiagnostics = async () => { started(); return new Promise((resolve) => { release = resolve; }); };
	const loading = f.controller.loadCaptureHealth(f.folder); await began;
	f.controller.metaEpoch += 1; f.controller.captureEvidence.clear(); f.controller.captureHealthStates.clear();
	release(history.projectCaptureDiagnostics([completed])); await loading;
	assert.equal(f.controller.captureEvidence.size, 0);
	assert.equal(f.controller.captureHealthStates.size, 0);
});

test('configuration and wrapper changes refresh capability without relying on hook or log writes', async (t) => {
	const options = { autoRefresh: true, mode: 'auto' }; const f = fixture(t, options);
	const extensionPath = path.join(f.root, 'official-fixture'); fs.mkdirSync(extensionPath);
	fs.writeFileSync(path.join(extensionPath, 'claude-code-settings.schema.json'), JSON.stringify({ properties: {
		hooks: { additionalProperties: { items: { properties: { hooks: { items: { anyOf: [{ properties: {
			type: { const: 'command' }, command: { type: 'string' }, args: { type: 'array', items: { type: 'string' } },
		} }] } } } } } },
	} }));
	options.extension = { extensionPath, packageJSON: { version: '2.1.326' } };
	const states = []; f.controller.view = { webview: { postMessage: async (state) => { states.push(state); } } };
	await until(() => states.at(-1)?.captureHealth[0]?.capability === 'confirmed', 'installed schema capability did not publish');
	f.settings.set('claudeCodeLauncher.hookExecutionMode', 'disabled');
	f.configurationHandlers.forEach((handler) => handler({ affectsConfiguration: (name) => name === 'claudeCodeLauncher' }));
	await until(() => states.at(-1)?.captureHealth[0]?.capability === 'unsupported', 'configuration-only change did not refresh');
	f.settings.set('claudeCodeLauncher.hookExecutionMode', 'auto');
	f.settings.set('claudeCode.claudeProcessWrapper', '/private/fixture-wrapper');
	f.configurationHandlers.forEach((handler) => handler({ affectsConfiguration: (name) => name === 'claudeCode.claudeProcessWrapper' }));
	await until(() => states.at(-1)?.captureHealth[0]?.capability === 'unknown', 'wrapper-only change did not refresh');
	assert.equal(JSON.stringify(states.at(-1).captureHealth).includes('fixture-wrapper'), false);
	assert.equal(fs.existsSync(path.join(f.dir, 'log.jsonl')), false);
	assert.equal(fs.existsSync(path.join(f.root, '.claude', 'settings.local.json')), false);
});

test('blocked purge preserves dated capture evidence for the root whose data could not be removed', async (t) => {
	const f = fixture(t); f.configuredHooks(); f.policy(); const store = await f.store();
	const completed = writeDiagnostic(f, { kind: 'completion', phase: 'post', stage: 'append', code: 'captureRecorded', contentCoverage: 'complete' });
	await f.controller.loadEntries(); await store.close();
	await f.controller.clearAllReviewData();
	assert.equal(f.controller.captureEvidence.get(f.folder.uri.toString()).lastCompletion.observedAt, completed.observedAt);
	f.controllerHistory.readCaptureDiagnostics = async () => history.projectCaptureDiagnostics([], ['readUnavailable']);
	await f.controller.loadCaptureHealth(f.folder);
	let state; f.controller.post({ postMessage: async (value) => { state = value; } }, false);
	assert.equal(state.captureHealth[0].completion.at, completed.observedAt);
	assert.equal(state.captureHealth[0].partial, true);
	assert.ok(f.warnings.some((message) => message.includes('Limpeza parcial/bloqueada')));
});

test('dispose retains writer ownership until the registered maintenance completes', async (t) => {
	const f = fixture(t); const store = await f.store();
	const lock = path.join(f.dir, 'review-writer.lock');
	f.controller.beginMaintenance();
	f.controller.dispose();
	let finished = false;
	const disposed = f.controller.whenDisposed().then(() => { finished = true; });
	try {
		await Promise.resolve(); await Promise.resolve();
		assert.equal(finished, false);
		assert.equal(fs.existsSync(lock), true);
		assert.equal(store.writable, true);
		f.controller.endMaintenance();
		await disposed;
		assert.equal(fs.existsSync(lock), false);
		assert.equal(store.writable, false);
	} finally {
		if (f.controller.maintenance) { f.controller.endMaintenance(); }
		await f.controller.whenDisposed();
	}
});

test('dispose drains an active operation while rejecting new decisions before releasing the writer', async (t) => {
	const f = fixture(t); await f.store();
	const lock = path.join(f.dir, 'review-writer.lock');
	let release, effectFinished = false;
	const gate = new Promise((resolve) => { release = resolve; });
	const operation = gate.then(() => { effectFinished = true; });
	f.controller.activeOperations.add(operation);
	f.controller.dispose();
	let finished = false;
	const disposed = f.controller.whenDisposed().then(() => { finished = true; });
	try {
		await assert.rejects(f.controller.executeReviewDecision(path.join(f.root, 'ordinary.txt'), { action: 'accept' }), /maintenanceInProgress/);
		assert.equal(finished, false);
		assert.equal(effectFinished, false);
		assert.equal(fs.existsSync(lock), true);
		release(); await operation; await disposed;
		assert.equal(effectFinished, true);
		assert.equal(fs.existsSync(lock), false);
	} finally {
		release(); await operation; await f.controller.whenDisposed();
		f.controller.activeOperations.delete(operation);
	}
});

function aged(file, hours) { const time = new Date(Date.now() - hours * 3600 * 1000); fs.utimesSync(file, time, time); }

test('housekeeping removes aged hook markers and unreferenced review copies, keeping recent, unknown and in-progress files', async (t) => {
	const f = fixture(t), store = await f.store();
	await store.update((state) => { ingestEntries(state, [entry(f.root, 'kept')]); });
	const completed = path.join(f.dir, 'completed'), pending = path.join(f.dir, 'pending'), blobs = path.join(f.dir, 'review-blobs', 'v1');
	fs.mkdirSync(completed); fs.mkdirSync(pending);
	const files = {
		oldCompleted: path.join(completed, 'a'.repeat(32) + '.json'), recentCompleted: path.join(completed, 'b'.repeat(32) + '.json'),
		unknownCompleted: path.join(completed, 'notes.json'), oldPending: path.join(pending, 'c'.repeat(32) + '.json'),
		recentPending: path.join(pending, 'd'.repeat(32) + '.json'), oldPost: path.join(pending, 'e'.repeat(32) + '.post'),
		orphanBlob: path.join(blobs, 'f'.repeat(64) + '.txt'),
	};
	for (const file of Object.values(files)) { fs.writeFileSync(file, '{}'); }
	for (const name of ['oldCompleted', 'unknownCompleted', 'oldPending', 'oldPost', 'orphanBlob']) { aged(files[name], 25); }
	const referenced = fs.readdirSync(blobs).filter((name) => name !== 'f'.repeat(64) + '.txt');
	for (const name of referenced) { aged(path.join(blobs, name), 25); }
	await f.controller.applyHousekeeping();
	const exists = Object.fromEntries(Object.entries(files).map(([name, file]) => [name, fs.existsSync(file)]));
	assert.deepEqual(exists, { oldCompleted: false, recentCompleted: true, unknownCompleted: true, oldPending: false, recentPending: true, oldPost: true, orphanBlob: false });
	for (const name of referenced) { assert.equal(fs.existsSync(path.join(blobs, name)), true); }
	assert.equal(store.get().reviews[path.join(f.root, 'kept.txt')][0].base.text, 'before');
	// Within the interval a refresh does not scan the directories again.
	fs.writeFileSync(files.oldCompleted, '{}'); aged(files.oldCompleted, 25);
	await f.controller.applyHousekeeping(); assert.equal(fs.existsSync(files.oldCompleted), true);
	f.controller.nextHousekeeping.clear(); await f.controller.applyHousekeeping(); assert.equal(fs.existsSync(files.oldCompleted), false);
});

test('housekeeping belongs to the review owner and never follows an unsafe marker directory', async (t) => {
	await t.test('a read-only window removes nothing', async (sub) => {
		const f = fixture(sub), owner = await ReviewStore.open(f.root); sub.after(() => owner.close());
		const reader = await f.store(); assert.equal(reader.writable, false);
		const completed = path.join(f.dir, 'completed'), marker = path.join(completed, 'a'.repeat(32) + '.json');
		fs.mkdirSync(completed); fs.writeFileSync(marker, '{}'); aged(marker, 25);
		await f.controller.applyHousekeeping(); assert.equal(fs.existsSync(marker), true);
	});
	await t.test('a linked directory is refused and retried later', async (sub) => {
		if (process.platform === 'win32') { sub.skip('symlink creation needs privileges on Windows'); return; }
		const f = fixture(sub); await f.store();
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-outside-')); sub.after(() => fs.rmSync(outside, { recursive: true, force: true }));
		const marker = path.join(outside, 'a'.repeat(32) + '.json'); fs.writeFileSync(marker, '{}'); aged(marker, 25);
		fs.symlinkSync(outside, path.join(f.dir, 'completed'));
		const before = Date.now(); await f.controller.applyHousekeeping();
		assert.equal(fs.existsSync(marker), true);
		const next = f.controller.nextHousekeeping.get(f.folder.uri.toString());
		assert.ok(next > before && next < before + 60 * 60 * 1000);
	});
});

test('a hook script that differs from the packaged one is restored by the review owner and reported; a missing one is restored quietly', async (t) => {
	const f = fixture(t); f.configuredHooks(); f.policy(); await f.store();
	const script = path.join(f.dir, hooks.HOOK_NAME), packaged = fs.readFileSync(path.resolve(__dirname, '../hooks/record-change.js'), 'utf8');
	const key = f.folder.uri.toString();
	await f.controller.loadCaptureHealth(f.folder);
	assert.equal(fs.readFileSync(script, 'utf8'), packaged); assert.deepEqual(f.warnings, []);
	fs.writeFileSync(script, packaged + '\nrequire("node:fs").writeFileSync("/tmp/injected", "x");\n');
	await f.controller.loadCaptureHealth(f.folder);
	assert.equal(fs.readFileSync(script, 'utf8'), packaged);
	assert.equal(f.warnings.filter((message) => message.includes('foi restaurado')).length, 1);
	assert.equal(f.controller.runtimeWarnings.has(key), false);
	await f.controller.loadCaptureHealth(f.folder);
	assert.equal(f.warnings.length, 1);
});

test('a window that does not own the review reports a differing hook script without rewriting it', async (t) => {
	const f = fixture(t); f.configuredHooks(); f.policy();
	const owner = await ReviewStore.open(f.root); t.after(() => owner.close());
	const reader = await f.store(); assert.equal(reader.writable, false);
	const script = path.join(f.dir, hooks.HOOK_NAME); fs.writeFileSync(script, 'process.exit(0);\n');
	await f.controller.loadCaptureHealth(f.folder);
	assert.equal(fs.readFileSync(script, 'utf8'), 'process.exit(0);\n');
	let state; f.controller.post({ postMessage: async (value) => { state = value; } }, false);
	assert.match(state.coverageMessage, /script de captura .* diferente/);
	assert.equal(f.warnings.some((message) => message.includes('foi restaurado')), false);
});

test('a configured hook without node on PATH is reported until a capture event proves the executable exists', async (t) => {
	const f = fixture(t); f.configuredHooks(); f.policy(); await f.store();
	const key = f.folder.uri.toString();
	await f.controller.loadCaptureHealth(f.folder);
	assert.equal(f.controller.runtimeWarnings.has(key), false, 'node is on PATH in the test process');
	f.controller.nodeLookup = { at: Date.now(), found: false };
	await f.controller.loadCaptureHealth(f.folder);
	assert.match(f.controller.runtimeWarnings.get(key), /"node".*PATH/);
	let state; f.controller.post({ postMessage: async (value) => { state = value; } }, false);
	assert.match(state.coverageMessage, /"node"/);
	writeDiagnostic(f, { phase: 'pre', stage: 'pending', code: 'capturePrepared', contentCoverage: 'complete' });
	await f.controller.loadCaptureHealth(f.folder);
	assert.equal(f.controller.runtimeWarnings.has(key), false);
});

test('enabling the change log warns when node is not on PATH and stays quiet when hooks are not configured', async (t) => {
	const f = fixture(t); f.controller.nodeLookup = { at: Date.now(), found: false };
	await f.controller.loadCaptureHealth(f.folder);
	assert.equal(f.controller.runtimeWarnings.size, 0);
	await f.controller.setEnabled(true);
	assert.equal(f.warnings.filter((message) => message.includes('"node"')).length, 1);
	assert.equal(f.messages.some((message) => message.includes('Registro ativado')), true);
});

test('a recreated project file gets the default permissions, not the private mode of review storage', async (t) => {
	if (process.platform === 'win32') { t.skip('POSIX permission bits'); return; }
	const f = fixture(t), file = path.join(f.root, 'scripts', 'restored.sh'), sibling = path.join(f.root, 'sibling.txt');
	fs.writeFileSync(sibling, 'ordinary file');
	await f.controller.writeResource(file, f.root, { kind: 'text', text: '#!/bin/sh\n' }, { kind: 'absent' });
	assert.equal(fs.readFileSync(file, 'utf8'), '#!/bin/sh\n');
	assert.equal(fs.statSync(file).mode & 0o777, fs.statSync(sibling).mode & 0o777);
	await assert.rejects(f.controller.writeResource(file, f.root, { kind: 'text', text: 'other' }, { kind: 'absent' }), { code: 'externalChange' });
	assert.equal(fs.readFileSync(file, 'utf8'), '#!/bin/sh\n');
});

test('store and hook failures reach the user as explanations, and unknown codes only as a reference', async (t) => {
	const f = fixture(t), owner = await ReviewStore.open(f.root); t.after(() => owner.close());
	writeLog(f, [entry(f.root, 'a')]); await f.controller.loadEntries();
	const reason = f.controller.readOnlyReason();
	assert.equal(reason, 'Outra janela é a dona da revisão desta pasta');
	assert.equal(/anotherWriter|readOnlyOwner/.test(reason), false);
	assert.match(describeReason('somethingNew'), /não classificada \(referência: somethingNew\)/);
	assert.equal(describeReason('<script>'), 'ocorreu uma falha não classificada');
});

test('a capture stopped by the inventory budget of accumulated markers resumes after housekeeping', async (t) => {
	const hook = require('../hooks/record-change.js');
	const f = fixture(t); await f.store();
	const file = path.join(f.root, 'edited.txt'); fs.writeFileSync(file, 'one\n');
	const env = { CLAUDE_PROJECT_DIR: f.root };
	const input = (id) => ({ tool_name: 'Write', tool_input: { file_path: file }, tool_use_id: id, session_id: 'session', cwd: f.root });
	assert.equal(hook.run('pre', input('first'), { env }).state, 'prepared');
	fs.writeFileSync(file, 'two\n');
	assert.equal(hook.run('post', input('first'), { env }).state, 'recorded');
	// One marker per recorded edit, as the hook leaves them; all older than any open tool call.
	const completed = path.join(f.dir, 'completed'), old = new Date(Date.now() - 25 * 3600 * 1000);
	for (let index = 0; index < 10001; index += 1) {
		const marker = path.join(completed, index.toString(16).padStart(32, '0') + '.json');
		fs.writeFileSync(marker, '{}'); fs.utimesSync(marker, old, old);
	}
	const diagnostic = {};
	assert.equal(hook.run('pre', input('blocked'), { env }).state, 'blocked');
	const observations = path.join(f.dir, 'capture-diagnostics', 'v2', 'observations');
	const latest = fs.readdirSync(observations).sort().at(-1);
	assert.equal(JSON.parse(fs.readFileSync(path.join(observations, latest), 'utf8')).code, 'storageInventoryBudget');
	await f.controller.applyHousekeeping();
	// The marker of the edit recorded moments ago is recent and stays: it still deduplicates a repeated event.
	assert.equal(fs.readdirSync(completed).length, 1);
	assert.equal(hook.run('post', input('first'), { env, diagnostic }).state, 'duplicate');
	assert.equal(hook.run('pre', input('resumed'), { env }).state, 'prepared');
	fs.writeFileSync(file, 'three\n');
	assert.equal(hook.run('post', input('resumed'), { env }).state, 'recorded');
	assert.equal(readLog(f).length, 2);
});

function deadWriterLock(f) {
	const child = require('node:child_process').spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
	assert.equal(child.status, 0);
	fs.mkdirSync(f.dir, { recursive: true });
	fs.writeFileSync(path.join(f.dir, 'review-writer.lock'), JSON.stringify({ schemaVersion: 1, token: 'exited-window', pid: child.pid, started: '2026-11-19T00:00:00.000Z' }));
}

test('a window that finds the lock of an exited owner offers recovery once and never takes it unasked', async (t) => {
	const f = fixture(t); writeLog(f, [entry(f.root, 'a')]); deadWriterLock(f);
	const offers = []; let answer;
	f.vscode.window.showInformationMessage = async (message, ...actions) => { offers.push({ message, actions }); return answer; };
	f.controller.entries = await f.controller.loadEntries();
	const store = f.controller.stores.get(f.folder.uri.toString());
	assert.equal(store.writable, false); assert.equal(offers.length, 1);
	assert.deepEqual(offers[0].actions, ['Recuperar revisão']); assert.match(offers[0].message, /não está mais em execução/);
	assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'review-writer.lock'), 'utf8')).token, 'exited-window');
	await f.controller.loadEntries(); assert.equal(offers.length, 1);
});

test('accepting the offer recovers the review; a live owner is never offered', async (t) => {
	await t.test('accepted offer', async (sub) => {
		const f = fixture(sub); writeLog(f, [entry(f.root, 'a')]); deadWriterLock(f);
		f.vscode.window.showInformationMessage = async (message, ...actions) => actions[0];
		f.controller.entries = await f.controller.loadEntries();
		const store = f.controller.stores.get(f.folder.uri.toString());
		await until(() => store.writable, 'the accepted offer did not recover the writer');
		assert.notEqual(JSON.parse(fs.readFileSync(path.join(f.dir, 'review-writer.lock'), 'utf8')).token, 'exited-window');
	});
	await t.test('live owner', async (sub) => {
		const f = fixture(sub); writeLog(f, [entry(f.root, 'a')]);
		const owner = await ReviewStore.open(f.root); sub.after(() => owner.close());
		const offers = []; f.vscode.window.showInformationMessage = async (message) => { offers.push(message); };
		f.controller.entries = await f.controller.loadEntries();
		assert.equal(f.controller.stores.get(f.folder.uri.toString()).writable, false); assert.deepEqual(offers, []);
	});
});

test('project exclusion patterns add to the user patterns and cannot remove them', async (t) => {
	const scoped = { defaultValue: ['**/.env', '**/*.pem'], globalValue: undefined, workspaceValue: [] };
	const f = fixture(t, { inspect: (key) => key === 'claudeCodeLauncher.historyExcludedPatterns' ? scoped : undefined });
	await f.controller.setEnabled(true);
	const policy = () => JSON.parse(fs.readFileSync(path.join(f.dir, history.CAPTURE_POLICY_FILE), 'utf8'));
	// A repository that empties the list still gets the defaults the user kept.
	assert.deepEqual(policy().excludedPatterns, ['**/.env', '**/*.pem']);
	scoped.workspaceValue = ['secrets/**', '**/.env']; await f.controller.setEnabled(true);
	assert.deepEqual(policy().excludedPatterns, ['**/.env', '**/*.pem', 'secrets/**']);
	// The user, not the project, decides to drop a default.
	scoped.globalValue = ['only-mine/**']; scoped.workspaceValue = undefined; await f.controller.setEnabled(true);
	assert.deepEqual(policy().excludedPatterns, ['only-mine/**']);
});

test('a hook left in the globalStorage of the pre-1.0 identifier is recognized as the launcher own and replaced', async (t) => {
	const f = fixture(t);
	// globalStorage/<id>: the fixture keeps the current one at <root>/global, so the legacy sibling is <root>/kauan.claude-code-launcher.
	const legacy = path.join(f.root, 'kauan.claude-code-launcher', hooks.HOOK_NAME);
	const plan = hooks.planHooks({ read: { kind: 'absent' }, scriptPath: legacy, enable: true, capability: { status: 'confirmed', harness: 'fixture-contract' } });
	fs.mkdirSync(path.join(f.root, '.claude'), { recursive: true });
	const settings = path.join(f.root, '.claude', 'settings.local.json');
	fs.writeFileSync(settings, plan.nextText);
	await f.controller.setEnabled(true);
	const text = fs.readFileSync(settings, 'utf8');
	assert.equal(text.includes(legacy), false, 'the legacy entry is replaced, not duplicated');
	assert.equal(text.includes(f.controller.scriptPath(f.folder)), true);
	assert.ok(f.warnings.every((message) => !message.includes(describeReason('ambiguousHookOwnership'))));
	assert.equal(await f.controller.hooksEnabled(), true);
});
