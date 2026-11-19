'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const review = require('../out/review.js');
const diff = require('../out/diff.js');

function fixture(before = 'one\ntwo\nthree\n', after = 'ONE\ntwo\nTHREE\n', created = false, options = {}) {
	const commands = new Map(), messages = [], opened = [], decorations = [], disposable = { dispose() {} };
	class Uri {
		constructor(file) { this.fsPath = file; this.scheme = 'file'; }
		toString() { return 'file://' + this.fsPath; }
		static file(file) { return new Uri(file); }
		static parse(value) { return new Uri(value.replace(/^file:\/\//, '')); }
	}
	class Range { constructor(...args) { this.args = args; this.end = { line: args[2] || 0, character: args[3] || 0 }; } }
	const document = options.document || { uri: Uri.file('/fixture/a.txt'), content: after, languageId: 'text', eol: 1,
		getText() { return this.content; }, get lineCount() { return this.content.split('\n').length; },
		lineAt(index) { return { range: new Range(index, 0, index, (this.content.split('\n')[index] || '').length) }; } };
	if (!document.lineAt) { document.lineAt = index => ({ range: new Range(index, 0, index, (document.getText().split(/\r\n|\n|\r/)[index] || '').length) }); }
	const state = { schemaVersion: 1, generation: 0, contextId: '/fixture', reviews: {}, statuses: {}, operations: {}, undo: [], legacyProjection: { phase: 'complete', observedHash: null, targetHash: null, targetGeneration: 0 } };
	const snap = text => text === undefined ? { exists: false, text: null, large: false } : { exists: true, text, large: false };
	const entries = [{ id: 'a', file: document.uri.fsPath, time: '', before: snap(created ? undefined : before), after: snap(after) }];
	review.ingestEntries(state, entries);
	const calls = [];
	const source = options.source || { onDidChangeEntries: () => disposable, getEntries: () => entries, isReviewed: id => Object.hasOwn(state.statuses, id),
		setStatus() { throw new Error('inline must not change legacy statuses'); }, pendingFiles: () => [document.uri.fsPath],
		getSharedReview: file => review.activeReview(state, file),
		async executeReviewDecision(file, request) {
			calls.push({ file, request });
			const plan = review.planReviewDecision(review.activeReview(state, file), { kind: 'text', text: document.getText() }, request);
			review.commitReviewDecision(state, plan);
		}, async compareReview(file) { calls.push({ compare: file }); } };
	const editor = { document, setDecorations(type, values) { decorations.push({ type, values }); }, revealRange() {} };
	const vscode = { Uri, Range, ThemeColor: class { constructor(id) { this.id = id; } }, CodeLens: class { constructor(range, command) { this.range = range; this.command = command; } },
		MarkdownString: class { constructor(value) { this.value = value; } }, OverviewRulerLane: { Left: 1 }, TextEditorRevealType: { InCenterIfOutsideViewport: 1 },
		EventEmitter: class { event = () => disposable; fire() {} dispose() {} },
		window: { visibleTextEditors: [editor], activeTextEditor: editor, createTextEditorDecorationType: options => ({ options, dispose() {} }),
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
	return { commands, source, document, state, calls, inline, editor, messages, opened, decorations, dispose() { inline.dispose(); } };
}

async function bomFixture(t, before, after) {
	const { fixture: controllerFixture, entry, writeLog } = require('./helpers/changes-fixture.cjs');
	const f = controllerFixture(t), item = { ...entry(f.root, 'bom', 'bom.txt'), before: { exists: true, text: before, large: false }, after: { exists: true, text: after, large: false } };
	fs.writeFileSync(item.file, after); writeLog(f, [item]); const store = await f.store(); f.controller.entries = await f.controller.loadEntries();
	const document = f.openDocument(item.file); document.languageId = 'plaintext';
	const submitted = [], source = { onDidChangeEntries: f.controller.onDidChangeEntries,
		getEntries: () => f.controller.getEntries(), isReviewed: id => f.controller.isReviewed(id), setStatus: (...args) => f.controller.setStatus(...args),
		pendingFiles: () => f.controller.pendingFiles(), getSharedReview: file => f.controller.getSharedReview(file),
		executeReviewDecision: async (...args) => { submitted.push(args); return f.controller.executeReviewDecision(...args); } };
	const projection = fixture(before, after, false, { document, source }); t.after(() => projection.dispose());
	return { ...f, item, store, document, projection, submitted };
}

test('UTF-8 BOM lenses retain canonical hunk signatures and visual columns through partial acceptance and rejection', async t => {
	const before = '\uFEFFconst left = 100;\nmiddle\nconst right = 100;\n', after = '\uFEFFconst left = 200;\nmiddle\nconst right = 200;\n';
	const f = await bomFixture(t, before, after), p = f.projection;
	assert.equal(f.document.getText(), after.slice(1), 'The editor adapter strips the encoding BOM as the real host does');
	const accepts = p.inline.provideCodeLenses(f.document).filter(lens => lens.command.command === 'claude-code-launcher.acceptChange');
	assert.equal(accepts.length, 2, 'An unchanged UTF-8 BOM document must expose both real hunk actions');
	const groups = diff.groupsOf(diff.diffLines(before, after).lines);
	assert.deepEqual(Array.from(accepts, lens => lens.command.arguments[2]), groups.map(diff.groupSignature));
	assert.deepEqual([...p.inline.anchors(p.editor)], [0, 2]);
	const words = p.decorations.filter(item => item.type.options.backgroundColor?.id === 'diffEditor.insertedTextBackground').at(-1).values;
	const first = words.find(range => range.args[0] === 0); assert(first); assert.deepEqual(first.args, [0, 13, 0, 16], 'Hidden encoding BOM must not shift visual UTF-16 columns');
	await p.commands.get(accepts[0].command.command)(...accepts[0].command.arguments);
	const partial = review.activeReview(f.store.get(), f.item.file); assert.equal(partial.accepted, 1); assert.equal(partial.base.text, '\uFEFFconst left = 200;\nmiddle\nconst right = 100;\n');
	const reject = p.inline.provideCodeLenses(f.document).find(lens => lens.command.command === 'claude-code-launcher.rejectChange'); assert(reject);
	assert.equal(reject.command.arguments[2], diff.groupSignature(diff.groupsOf(diff.diffLines(partial.base.text, after).lines)[0]));
	await p.commands.get(reject.command.command)(...reject.command.arguments);
	assert.deepEqual(fs.readFileSync(f.item.file), Buffer.from('\uFEFFconst left = 200;\nmiddle\nconst right = 100;\n'));
	assert.equal(f.store.get().statuses.bom, 'mixed'); assert.equal(f.store.get().undo.length, 1); assert.equal(p.messages.length, 0);
	assert.equal(f.controller.getEntries()[0].before.text, before); assert.equal(f.controller.getEntries()[0].after.text, after);
});

test('UTF-8 BOM partial rejection and whole-file decisions use the shared executor and preserve exact saved bytes', async t => {
	const before = '\uFEFFconst left = 100;\nmiddle\nconst right = 100;\n', after = '\uFEFFconst left = 200;\nmiddle\nconst right = 200;\n';
	for (const mode of ['partial-reject-then-accept', 'reject-all', 'accept-all']) await t.test(mode, async sub => {
		const f = await bomFixture(sub, before, after), p = f.projection;
		const lensFor = command => p.inline.provideCodeLenses(f.document).find(lens => lens.command.command === command)?.command;
		if (mode === 'partial-reject-then-accept') {
			const partial = lensFor('claude-code-launcher.rejectChange'); assert(partial);
			await p.commands.get(partial.command)(...partial.arguments);
			assert.equal(review.activeReview(f.store.get(), f.item.file).rejected, 1);
			await p.commands.get('claude-code-launcher.acceptAllChanges')(f.document.uri.toString());
		} else {
			const command = lensFor(mode === 'accept-all' ? 'claude-code-launcher.acceptAllChanges' : 'claude-code-launcher.rejectAllChanges'); assert(command);
			await p.commands.get(command.command)(...command.arguments);
		}
		const expected = mode === 'partial-reject-then-accept' ? '\uFEFFconst left = 100;\nmiddle\nconst right = 200;\n' : mode === 'accept-all' ? after : before;
		assert.deepEqual(fs.readFileSync(f.item.file), Buffer.from(expected)); assert.equal(f.document.getText(), expected.slice(1));
		assert.equal(f.store.get().statuses.bom, mode === 'partial-reject-then-accept' ? 'mixed' : mode === 'accept-all' ? 'accepted' : 'rejected');
		assert.equal(f.editor.applyCalls.length, mode === 'accept-all' ? 0 : 1); assert.equal(f.editor.saveCalls.length, mode === 'accept-all' ? 0 : 1);
		assert.equal(p.messages.length, 0);
	});
});

test('BOM projection never equates changed presence, mixed EOL or a human buffer with the captured fingerprint', async t => {
	for (const mode of ['external-bom-removal', 'captured-bom-removal', 'captured-bom-addition', 'mixed-eol', 'human-buffer']) await t.test(mode, async sub => {
		let before = '\uFEFFconst left = 100;\nmiddle\nconst right = 100;\n', after = '\uFEFFconst left = 200;\nmiddle\nconst right = 200;\n';
		if (mode === 'captured-bom-removal') { before = '\uFEFFsame\n'; after = 'same\n'; }
		if (mode === 'captured-bom-addition') { before = 'same\n'; after = '\uFEFFsame\n'; }
		if (mode === 'mixed-eol') { before = before.replace('100;\n', '100;\r\n'); after = after.replace('200;\n', '200;\r\n'); }
		const f = await bomFixture(sub, before, after), p = f.projection;
		assert(p.inline.provideCodeLenses(f.document).some(lens => lens.command.command === 'claude-code-launcher.rejectChange'));
		if (mode === 'human-buffer') {
			f.document.content += 'HUMAN'; f.document.isDirty = true;
			assert.deepEqual([...p.inline.anchors(p.editor)], []); assert.equal(p.inline.provideCodeLenses(f.document).length, 0);
		} else {
			if (mode === 'external-bom-removal') { fs.writeFileSync(f.item.file, after.slice(1)); }
			await p.commands.get('claude-code-launcher.rejectAllChanges')(f.document.uri.toString());
			assert.equal(f.controller.lastOperationResults.get(f.item.file).reason, mode === 'external-bom-removal' ? 'externalChange' : 'unsupportedEncoding');
			assert.equal(p.messages.length, 1);
		}
		assert.deepEqual(fs.readFileSync(f.item.file), Buffer.from(mode === 'external-bom-removal' ? after.slice(1) : after));
		assert.equal(f.store.get().statuses.bom, undefined); assert.equal(f.store.get().undo.length, 0); assert.equal(f.editor.applyCalls.length, 0); assert.equal(f.editor.saveCalls.length, 0);
	});
});

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

test('inline reports the detailed applied-buffer failure without claiming that nothing changed or exposing a cause', async t => {
	const f = fixture(); t.after(() => f.dispose());
	const { blockedReviewResult, ReviewResultError } = require('../out/review-results.js');
	const result = { ...blockedReviewResult(f.document.uri.fsPath, ['a'], 'reject', 'saveReturnedFalse'),
		outcome: 'partial', content: 'buffer', decision: 'failed', nextAction: 'retrySave' };
	f.source.executeReviewDecision = async () => { throw new ReviewResultError(result, new Error('PRIVATE exception')); };
	await f.commands.get('claude-code-launcher.rejectAllChanges')(f.document.uri.toString());
	assert.equal(f.messages.length, 1); assert.match(f.messages[0], /aplicado no editor.*salvamento não foi confirmado/);
	assert.match(f.messages[0], /Salve o arquivo/); assert.doesNotMatch(f.messages[0], /inalterado|PRIVATE/);
	assert.deepEqual(f.state.statuses, {});
});

test('inline treats an untyped callback failure as unknown instead of inventing an unchanged document', async t => {
	const f = fixture(); t.after(() => f.dispose());
	f.source.executeReviewDecision = async () => { throw new Error('PRIVATE exception'); };
	await f.commands.get('claude-code-launcher.rejectAllChanges')(f.document.uri.toString());
	assert.equal(f.messages.length, 1); assert.match(f.messages[0], /Não foi possível confirmar/);
	assert.doesNotMatch(f.messages[0], /inalterado|PRIVATE/); assert.deepEqual(f.state.statuses, {});
});

test('inline identifies a virtual provider before looking up review state or invoking the executor', async t => {
	const f = fixture(); t.after(() => f.dispose()); f.document.uri.scheme = 'synthetic';
	f.source.getSharedReview = () => { assert.fail('unsupported provider must not resolve a file review'); };
	f.source.executeReviewDecision = async () => { assert.fail('unsupported provider must not mutate content or state'); };
	await f.commands.get('claude-code-launcher.rejectAllChanges')();
	assert.equal(f.messages.length, 1); assert.match(f.messages[0], /recurso não possui um adaptador de reversão validado/);
	assert.deepEqual(f.state.statuses, {}); assert.equal(f.document.content, 'ONE\ntwo\nTHREE\n');
});
