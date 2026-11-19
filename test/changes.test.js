'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { ReviewStore } = require('../out/review-store.js');
const { ingestEntries } = require('../out/review.js');
const history = require('../out/history.js');
const hooks = require('../out/hooks.js');

/** Actual compiled controller, with only editor/IO boundaries replaced by explicit adapters. */
function fixture(t, options = {}) {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-changes-')));
	const warnings = [], messages = [], memento = new Map(), settings = new Map([
		['claudeCodeLauncher.hookExecutionMode', options.mode || 'exec'],
		['claudeCodeLauncher.historyRetentionDays', 30],
	]);
	const disposable = () => ({ dispose() {} });
	class Uri {
		constructor(file, scheme = 'file') { this.fsPath = file; this.path = file; this.scheme = scheme; }
		toString() { return this.scheme + '://' + this.fsPath; }
		static file(file) { return new Uri(path.resolve(file)); }
		static joinPath(base, ...parts) { return new Uri(path.join(base.fsPath, ...parts), base.scheme); }
		static from(value) { return new Uri(value.path, value.scheme); }
	}
	class EventEmitter {
		listeners = [];
		event = (fn) => { this.listeners.push(fn); return disposable(); };
		fire(value) { this.listeners.forEach((fn) => fn(value)); }
		dispose() { this.listeners = []; }
	}
	const folder = { uri: Uri.file(root), name: 'fixture', index: 0 };
	const configurationHandlers = [], workspaceHandlers = [];
	const vscode = {
		Uri, EventEmitter, StatusBarAlignment: { Right: 2 }, ThemeColor: class {},
		commands: { executeCommand: async () => undefined },
		extensions: { getExtension: () => undefined },
		window: {
			createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
			showWarningMessage: async (message, ...args) => { warnings.push(message); return options.confirm === false ? undefined : args.find((arg) => typeof arg === 'string'); },
			showInformationMessage: async (message) => { messages.push(message); return undefined; },
			showErrorMessage: async (message) => { warnings.push(message); return undefined; },
		},
		workspace: {
			workspaceFolders: [folder], textDocuments: [], notebookDocuments: [],
			getWorkspaceFolder: (uri) => uri.fsPath === root || uri.fsPath.startsWith(root + path.sep) ? folder : undefined,
			asRelativePath: (file) => path.relative(root, file),
			getConfiguration: (section) => ({ get: (key, fallback) => settings.has(section + '.' + key) ? settings.get(section + '.' + key) : fallback }),
			createFileSystemWatcher: () => ({ ...disposable(), onDidCreate: () => disposable(), onDidChange: () => disposable(), onDidDelete: () => disposable() }),
			onDidChangeWorkspaceFolders: (handler) => { workspaceHandlers.push(handler); return disposable(); },
			onDidChangeConfiguration: (handler) => { configurationHandlers.push(handler); return disposable(); },
		},
	};
	const context = {
		extensionUri: Uri.file(path.resolve(__dirname, '..')), globalStorageUri: Uri.file(path.join(root, 'global')), subscriptions: [],
		workspaceState: {
			get: (key, fallback) => memento.has(key) ? memento.get(key) : fallback,
			async update(key, value) {
				if (options.failMemento) { throw new Error('synthetic memento failure'); }
				memento.set(key, value);
			},
		},
	};
	const source = path.resolve(__dirname, '../out/changes.js');
	const sourceRequire = createRequire(source);
	const sessionModule = sourceRequire('./sessions');
	const module = { exports: {} };
	const controllerHistory = { ...history, ...(options.history || {}) };
	const run = vm.runInThisContext('(function(require,module,exports){' + fs.readFileSync(source, 'utf8') + '\n})', { filename: source });
	run((id) => {
		if (id === 'vscode') { return vscode; }
		if (id === './history') { return controllerHistory; }
		if (id === './sessions') { return { ...sessionModule, sessionsDir: () => path.join(root, 'sessions'), ...(options.sessions || {}) }; }
		if (id === 'node:fs' && options.nodeFs) { return options.nodeFs; }
		return sourceRequire(id);
	}, module, module.exports);
	class ControlledController extends module.exports.ChangesController {
		scheduleRefresh() { /* Each test explicitly drives a refresh or a method. */ }
		async refresh() { /* No autonomous IO outside this test's scenario. */ }
		publish() { /* post() is exercised explicitly by the state tests. */ }
	}
	const controller = new ControlledController(context);
	const stores = new Set();
	t.after(async () => {
		controller.dispose();
		await controller.whenDisposed();
		for (const store of [...stores, ...controller.stores.values()]) { await store.close(); }
		fs.rmSync(root, { recursive: true, force: true });
	});
	const dir = path.join(root, '.claude', 'launcher-changes');
	async function store() {
		let value = controller.stores.get(folder.uri.toString());
		if (!value) { value = await ReviewStore.open(root); controller.stores.set(folder.uri.toString(), value); }
		stores.add(value); return value;
	}
	function policy(fields = {}) {
		fs.mkdirSync(dir, { recursive: true });
		const value = { ...history.makeCapturePolicy({ generation: 'fixture-generation' }), ...fields };
		fs.writeFileSync(path.join(dir, history.CAPTURE_POLICY_FILE), JSON.stringify(value) + '\n');
		return value;
	}
	function configuredHooks() {
		const plan = hooks.planHooks({ read: { kind: 'absent' }, scriptPath: controller.scriptPath(folder), enable: true,
			capability: { status: 'confirmed', harness: 'fixture-contract' } });
		fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
		fs.writeFileSync(path.join(root, '.claude', 'settings.local.json'), plan.nextText);
		return plan.nextText;
	}
	return { root, dir, folder, controller, context, settings, warnings, messages, store, policy, configuredHooks,
		workspaceHandlers, controllerHistory, Uri };
}

function entry(root, id, name = id + '.txt', time = '2026-11-19T12:00:00.000Z') {
	return { id, time, file: path.join(root, name), before: { exists: true, text: 'before', large: false }, after: { exists: true, text: 'after', large: false }, reason: null };
}
function writeLog(f, entries) {
	fs.mkdirSync(f.dir, { recursive: true });
	fs.writeFileSync(path.join(f.dir, 'log.jsonl'), entries.map((value) => JSON.stringify(value) + '\n').join(''));
}
function readLog(f) {
	return fs.readFileSync(path.join(f.dir, 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('controller preflight blocks unknown capability before writing a policy or hook script', async (t) => {
	const f = fixture(t, { mode: 'auto' });
	await f.controller.setEnabled(true);
	assert.equal(fs.existsSync(path.join(f.dir, history.CAPTURE_POLICY_FILE)), false);
	assert.equal(fs.existsSync(path.join(f.dir, hooks.HOOK_NAME)), false);
	assert.ok(f.warnings.some((message) => message.includes('execArgumentsNotConfirmed')));
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
	assert.ok(f.warnings.some((message) => message.includes('unsupportedCapturePolicy')));
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
	const status = path.join(f.dir, history.CAPTURE_STATUS_FILE);
	fs.writeFileSync(status, JSON.stringify({ schemaVersion: 1, state: 'quotaExceeded', code: 'quotaExceeded' }));
	f.controller.entries = await f.controller.loadEntries();
	assert.equal(await f.controller.hooksEnabled(), false);
	const states = []; f.controller.post({ postMessage: async (state) => { states.push(state); } }, false);
	assert.ok(states[0].coverageMessage.includes('quotaExceeded'));
	assert.ok(states[0].coverageMessage.includes('configuration warning retained'));
	fs.writeFileSync(status, JSON.stringify({ schemaVersion: 1, state: 'active', code: 'captureReady' }));
	f.controller.entries = await f.controller.loadEntries();
	assert.equal(f.controller.captureWarnings.has(key), false);
	assert.equal(f.controller.hookWarnings.get(key), 'configuration warning retained');
	assert.equal(await f.controller.hooksEnabled(), true);
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
