'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const review = require('../out/review.js');
const diff = require('../out/diff.js');

function fixture(before = 'one\ntwo\nthree\n', after = 'ONE\ntwo\nTHREE\n', created = false) {
	const commands = new Map(), messages = [], opened = [], disposable = { dispose() {} };
	class Uri {
		constructor(file) { this.fsPath = file; this.scheme = 'file'; }
		toString() { return 'file://' + this.fsPath; }
		static file(file) { return new Uri(file); }
		static parse(value) { return new Uri(value.replace(/^file:\/\//, '')); }
	}
	class Range { constructor(...args) { this.args = args; this.end = { line: args[2] || 0, character: args[3] || 0 }; } }
	const document = { uri: Uri.file('/fixture/a.txt'), content: after, languageId: 'text', eol: 1,
		getText() { return this.content; }, get lineCount() { return this.content.split('\n').length; },
		lineAt(index) { return { range: new Range(index, 0, index, (this.content.split('\n')[index] || '').length) }; } };
	const state = { schemaVersion: 1, generation: 0, contextId: '/fixture', reviews: {}, statuses: {}, operations: {}, undo: [], legacyProjection: { phase: 'complete', observedHash: null, targetHash: null, targetGeneration: 0 } };
	const snap = text => text === undefined ? { exists: false, text: null, large: false } : { exists: true, text, large: false };
	const entries = [{ id: 'a', file: document.uri.fsPath, time: '', before: snap(created ? undefined : before), after: snap(after) }];
	review.ingestEntries(state, entries);
	const calls = [];
	const source = { onDidChangeEntries: () => disposable, getEntries: () => entries, isReviewed: id => Object.hasOwn(state.statuses, id),
		setStatus() { throw new Error('inline must not change legacy statuses'); }, pendingFiles: () => [document.uri.fsPath],
		getSharedReview: file => review.activeReview(state, file),
		async executeReviewDecision(file, request) {
			calls.push({ file, request });
			const plan = review.planReviewDecision(review.activeReview(state, file), { kind: 'text', text: document.getText() }, request);
			review.commitReviewDecision(state, plan);
		}, async compareReview(file) { calls.push({ compare: file }); } };
	const editor = { document, setDecorations() {}, revealRange() {} };
	const vscode = { Uri, Range, ThemeColor: class {}, CodeLens: class { constructor(range, command) { this.range = range; this.command = command; } },
		MarkdownString: class { constructor(value) { this.value = value; } }, OverviewRulerLane: { Left: 1 }, TextEditorRevealType: { InCenterIfOutsideViewport: 1 },
		EventEmitter: class { event = () => disposable; fire() {} dispose() {} },
		window: { visibleTextEditors: [editor], activeTextEditor: editor, createTextEditorDecorationType: () => disposable,
			onDidChangeVisibleTextEditors: () => disposable, showWarningMessage: message => { messages.push(message); return Promise.resolve(); },
			async showTextDocument(uri) { opened.push(uri.fsPath); return editor; } },
		languages: { registerCodeLensProvider: () => disposable },
		workspace: { textDocuments: [document], getConfiguration: () => ({ get: () => true }),
			onDidChangeTextDocument: () => disposable, onDidChangeConfiguration: () => disposable,
			applyEdit() { throw new Error('inline must delegate content effects'); } },
		commands: { registerCommand(name, handler) { commands.set(name, handler); return disposable; } } };
	const filename = path.resolve(__dirname, '../out/inline.js'), module = { exports: {} };
	vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, setTimeout, clearTimeout,
		require: id => id === 'vscode' ? vscode : id === './changes' ? { DROP_REVIEW_COMMAND: 'drop' } : require(path.resolve(__dirname, '../out', id)) }, { filename });
	const context = { subscriptions: [] }; module.exports.registerInline(context, source);
	const inline = context.subscriptions.find(item => typeof item.provideCodeLenses === 'function');
	return { commands, source, document, state, calls, inline, messages, opened, dispose() { inline.dispose(); } };
}

test('inline hunk acceptance awaits the shared durable callback and carries a revision token', async t => {
	const f = fixture(); t.after(() => f.dispose());
	const lens = f.inline.provideCodeLenses(f.document).find(l => l.command.command === 'claude-code-launcher.acceptChange');
	assert.equal(lens.command.arguments[3], review.activeReview(f.state, f.document.uri.fsPath).revision);
	let finish; const gate = new Promise(resolve => { finish = resolve; }); const real = f.source.executeReviewDecision;
	f.source.executeReviewDecision = async (...args) => { await gate; return real(...args); };
	let settled = false;
	const operation = f.commands.get(lens.command.command)(...lens.command.arguments).then(() => { settled = true; });
	await Promise.resolve(); assert.equal(settled, false); assert.equal(review.activeReview(f.state, f.document.uri.fsPath).accepted, 0);
	finish(); await operation;
	assert.equal(review.activeReview(f.state, f.document.uri.fsPath).accepted, 1);
});

test('inline passes created-resource rejection to the common executor and never writes an empty file itself', async t => {
	const f = fixture('', 'created\n', true); t.after(() => f.dispose());
	let target;
	f.source.executeReviewDecision = async (file, request) => { target = review.planReviewDecision(review.activeReview(f.state, file), { kind: 'text', text: f.document.content }, request).target; };
	await f.commands.get('claude-code-launcher.rejectAllChanges')(f.document.uri.toString());
	assert.deepEqual(target, { kind: 'absent' }); assert.equal(f.document.content, 'created\n');
});

test('stale lens and failed callback do not complete a local shadow review', async t => {
	const f = fixture(); t.after(() => f.dispose());
	const lens = f.inline.provideCodeLenses(f.document).find(l => l.command.command === 'claude-code-launcher.rejectChange');
	review.activeReview(f.state, f.document.uri.fsPath).revision += 1;
	await f.commands.get(lens.command.command)(...lens.command.arguments);
	assert.equal(review.activeReview(f.state, f.document.uri.fsPath).rejected, 0); assert.deepEqual(f.state.statuses, {});
	assert.equal(f.messages.length, 1);
	assert.equal(f.document.content, 'ONE\ntwo\nTHREE\n');
});

test('show validates read scope before opening a historical resource; denial or policy failure does not call the editor', async t => {
	const f = fixture(); t.after(() => f.dispose());
	const files = [];
	f.source.canOpenResource = async file => { files.push(file); return false; };
	await f.commands.get('claude-code-launcher.showInlineChanges')('a');
	assert.deepEqual(files, ['/fixture/a.txt']); assert.deepEqual(f.opened, []);
	assert.match(f.messages[0], /fora do escopo autorizado/);
	f.source.canOpenResource = async () => { throw new Error('scope unavailable'); };
	await f.commands.get('claude-code-launcher.showInlineChanges')('a');
	assert.deepEqual(f.opened, []); assert.equal(f.messages.length, 2);
});

test('show opens a permitted resource and remains compatible with sources without a policy callback', async t => {
	const f = fixture(); t.after(() => f.dispose());
	f.source.canOpenResource = async () => true;
	await f.commands.get('claude-code-launcher.showInlineChanges')('a');
	delete f.source.canOpenResource;
	await f.commands.get('claude-code-launcher.showInlineChanges')('a');
	assert.deepEqual(f.opened, ['/fixture/a.txt', '/fixture/a.txt']); assert.equal(f.messages.length, 0);
});
