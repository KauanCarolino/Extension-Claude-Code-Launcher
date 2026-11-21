'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const OUT = process.env.LAUNCHER_TEST_OUT || path.resolve(__dirname, '../../out');
const { ReviewStore } = require(path.join(OUT, 'review-store.js'));
const { ingestEntries } = require(path.join(OUT, 'review.js'));
const history = require(path.join(OUT, 'history.js'));
const hooks = require(path.join(OUT, 'hooks.js'));

/** Actual compiled controller, with only editor/IO boundaries replaced by explicit adapters. */
function fixture(t, options = {}) {
	const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-changes-'));
	// Match promises.realpath used by the real controller: Windows' JS realpath
	// can retain a TEMP 8.3 alias while native realpath expands its long name.
	const root = fs.realpathSync.native(temporaryRoot);
	const warnings = [], messages = [], executedCommands = [], memento = new Map(), settings = new Map([
		['claudeCodeLauncher.hookExecutionMode', options.mode || 'exec'],
		['claudeCodeLauncher.historyRetentionDays', 30],
	]);
	const disposable = () => ({ dispose() {} });
	class Uri {
		constructor(file, scheme = 'file') { this.fsPath = file; this.path = file; this.scheme = scheme; }
		toString() { return this.scheme + '://' + this.fsPath; }
		static file(file) { return new Uri(options.uriFilePath ? options.uriFilePath(file) : path.resolve(file)); }
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
	const configurationHandlers = [], workspaceHandlers = [], documentHandlers = [], watchers = [], quickPicks = [];
	const documents = new Map(), editor = { applyCalls: [], saveCalls: [], deleteCalls: [], saveResult: true, applyResult: true };
	class Range { constructor(...coordinates) { this.coordinates = coordinates; } }
	class WorkspaceEdit { edits = new Map(); set(uri, edits) { this.edits.set(uri.fsPath, edits); } }
	function openDocument(file) {
		if (documents.has(file)) { return documents.get(file); }
		const bytes = fs.readFileSync(file, 'utf8'), bom = bytes.startsWith('\uFEFF');
		const document = { uri: Uri.file(file), isClosed: false, isDirty: false, version: 1, content: bytes.replace(/^\uFEFF/, ''),
			getText() { return this.content; }, get lineCount() { return this.content.split('\n').length; }, validateRange(range) { return range; },
			async save() {
				editor.saveCalls.push(file); await editor.beforeSave?.(document);
				if (!editor.saveResult) { return false; }
				fs.writeFileSync(file, (bom ? '\uFEFF' : '') + document.content); document.isDirty = false;
				await editor.afterSave?.(document); return true;
			} };
		documents.set(file, document); vscode.workspace.textDocuments.push(document); return document;
	}
	const vscode = {
		Uri, EventEmitter, Range, WorkspaceEdit, EndOfLine: { LF: 1, CRLF: 2 },
		TextEdit: { replace: (range, newText) => ({ range, newText }), setEndOfLine: newEol => ({ newEol }) },
		StatusBarAlignment: { Right: 2 }, ThemeColor: class {},
		commands: { executeCommand: async (...args) => { executedCommands.push(args); return undefined; } },
		extensions: { getExtension: () => options.extension },
		window: {
			createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
			showWarningMessage: async (message, ...args) => { warnings.push(message); return options.confirm === false ? undefined : args.find((arg) => typeof arg === 'string'); },
			showInformationMessage: async (message) => { messages.push(message); return undefined; },
			showErrorMessage: async (message) => { warnings.push(message); return undefined; },
			showQuickPick: async (items) => { quickPicks.push(items); return undefined; },
		},
		workspace: {
			workspaceFolders: [folder], textDocuments: [], notebookDocuments: [],
			async openTextDocument(uri) { await editor.beforeOpen?.(uri); return openDocument(uri.fsPath); },
			async applyEdit(edit) {
				editor.applyCalls.push(edit); await editor.beforeApply?.(edit);
				if (!editor.applyResult) { return false; }
				for (const [file, changes] of edit.edits) {
					const document = openDocument(file), text = changes.find(item => typeof item.newText === 'string'), eol = changes.find(item => item.newEol);
					if (text) { document.content = text.newText; }
					if (eol?.newEol === 2) { document.content = document.content.replace(/\r?\n/g, '\r\n'); }
					document.version++; document.isDirty = true; documentHandlers.forEach(handler => handler({ document }));
				}
				await editor.afterApply?.(edit); return true;
			},
			fs: { async delete(uri, settings) { editor.deleteCalls.push({ file: uri.fsPath, options: settings }); if (editor.deleteError) { throw editor.deleteError; } fs.unlinkSync(uri.fsPath); } },
			getWorkspaceFolder: (uri) => uri.fsPath === root || uri.fsPath.startsWith(root + path.sep) ? folder : undefined,
			asRelativePath: (file) => path.relative(root, file),
			getConfiguration: (section) => ({ get: (key, fallback) => settings.has(section + '.' + key) ? settings.get(section + '.' + key) : fallback,
				// Scoped values only where a test declares them; otherwise the controller reads the effective value.
				inspect: (key) => options.inspect?.(section + '.' + key) }),
			createFileSystemWatcher: (pattern) => {
				const watcher = { pattern, created: [], changed: [], deleted: [] }; watchers.push(watcher);
				return { ...disposable(), onDidCreate: (fn) => { watcher.created.push(fn); return disposable(); },
					onDidChange: (fn) => { watcher.changed.push(fn); return disposable(); }, onDidDelete: (fn) => { watcher.deleted.push(fn); return disposable(); } };
			},
			onDidChangeWorkspaceFolders: (handler) => { workspaceHandlers.push(handler); return disposable(); },
			onDidChangeConfiguration: (handler) => { configurationHandlers.push(handler); return disposable(); },
			onDidChangeTextDocument: (handler) => { documentHandlers.push(handler); return disposable(); },
		},
	};
	const context = {
		extensionUri: Uri.file(path.resolve(__dirname, '../..')), globalStorageUri: Uri.file(path.join(root, 'global')), subscriptions: [],
		workspaceState: {
			get: (key, fallback) => memento.has(key) ? memento.get(key) : fallback,
			async update(key, value) {
				if (options.failMemento) { throw new Error('synthetic memento failure'); }
				memento.set(key, value);
			},
		},
	};
	const source = path.join(OUT, 'changes.js');
	const sourceRequire = createRequire(source);
	const sessionModule = sourceRequire('./sessions');
	const controllerHistory = { ...history, ...(options.history || {}) };
	const shim = (id) => {
		if (id === 'vscode') { return vscode; }
		if (id === './history') { return controllerHistory; }
		if (id === './sessions') { return { ...sessionModule, sessionsDir: () => path.join(root, 'sessions'), ...(options.sessions || {}) }; }
		if (id === 'node:fs' && options.nodeFs) { return options.nodeFs; }
		if (id === 'node:path' && options.nodePath) { return options.nodePath; }
		if (id === './changes-support') { return load('changes-support.js'); }
		return sourceRequire(id);
	};
	const loaded = new Map();
	// Carrega o módulo no mesmo sandbox, para que os falsos de vscode, fs e path valham também para o código extraído do controlador.
	function load(name) {
		if (loaded.has(name)) { return loaded.get(name).exports; }
		const file = path.join(OUT, name), mod = { exports: {} };
		loaded.set(name, mod);
		vm.runInThisContext('(function(require,module,exports){' + fs.readFileSync(file, 'utf8') + '\n})', { filename: file })(shim, mod, mod.exports);
		return mod.exports;
	}
	const module = { exports: load('changes.js') };
	class ControlledController extends module.exports.ChangesController {
		scheduleRefresh() { if (options.autoRefresh) { super.scheduleRefresh(); } }
		async refresh() { if (options.autoRefresh) { return super.refresh(); } }
		publish() { if (options.autoRefresh) { super.publish(); } }
	}
	const controllers = new Set();
	const newController = () => { const value = new ControlledController(context); controllers.add(value); return value; };
	const controller = newController();
	const stores = new Set();
	t.after(async () => {
		for (const value of controllers) { value.dispose(); await value.whenDisposed(); }
		for (const store of [...stores, ...[...controllers].flatMap(value => [...value.stores.values()])]) { await store.close(); }
		fs.rmSync(root, { recursive: true, force: true });
	});
	const dir = path.join(root, '.claude', 'launcher-changes');
	async function store() {
		let value = controller.stores.get(folder.uri.toString());
		if (!value) { value = await ReviewStore.open(root, {}, options.storeOptions); controller.stores.set(folder.uri.toString(), value); }
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
	return { root, temporaryRoot, dir, folder, controller, context, settings, warnings, messages, store, policy, configuredHooks,
		workspaceHandlers, configurationHandlers, documentHandlers, watchers, controllerHistory, executedCommands, quickPicks, vscode, Uri,
		editor, documents, openDocument, newController };
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
let diagnosticNumber = 0;
function writeDiagnostic(f, fields = {}) {
	const value = { schemaVersion: 2, id: (++diagnosticNumber).toString(16).padStart(32, '0'), kind: 'observation',
		phase: 'pre', stage: 'policy', code: 'capturePaused', contentCoverage: 'none',
		observedAt: new Date().toISOString(), ...fields };
	const directory = path.join(f.dir, ...history.CAPTURE_DIAGNOSTICS_DIR.split('/'), value.kind === 'completion' ? 'completions' : 'observations');
	fs.mkdirSync(directory, { recursive: true });
	fs.writeFileSync(path.join(directory, history.captureDiagnosticFilename(value)), JSON.stringify(value));
	return value;
}
async function until(predicate, message) {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) { if (predicate()) { return; } await new Promise((resolve) => setTimeout(resolve, 20)); }
	assert.fail(message);
}


module.exports = { fixture, entry, writeLog, readLog, writeDiagnostic, until, OUT };
