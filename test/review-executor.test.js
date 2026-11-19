'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ReviewStore } = require('../out/review-store.js');
const { activeReview, ingestEntries, copyReview, sameContent, ReviewError } = require('../out/review.js');
const { executeDecision, undoItem, reconcileResource } = require('../out/reversal.js');
const { diffLines, groupsOf, groupSignature } = require('../out/diff.js');
const text = value => ({ kind: 'text', text: value });
const absent = () => ({ kind: 'absent' });
async function fixture(t, options) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-review-executor-'));
	const store = await ReviewStore.open(root, {}, options);
	t.after(async () => { await store.close(); fs.rmSync(root, { recursive: true, force: true }); });
	const buffer = new Map(), disk = new Map(); let saving = true;
	const adapter = { async read(file) { return copyReview(buffer.get(file) ?? absent()); }, async readPersisted(file) { return copyReview(disk.get(file) ?? absent()); },
		async write(file, target, expected) {
			if (!sameContent(buffer.get(file) ?? absent(), expected)) { throw new ReviewError('externalChange'); }
			buffer.set(file, copyReview(target));
			if (!saving) { throw new ReviewError('saveReturnedFalse'); }
			disk.set(file, copyReview(target));
		} };
	async function add(id, before, after, name = 'a.txt') {
		const file = path.join(root, name), snapshot = value => value === undefined ? { exists: false, text: null, large: false } : { exists: true, text: value, large: false };
		await store.update(s => ingestEntries(s, [{ id, file, time: '2026-11-19T00:00:00Z', before: snapshot(before), after: snapshot(after) }]));
		buffer.set(file, after === undefined ? absent() : text(after)); disk.set(file, after === undefined ? absent() : text(after)); return file;
	}
	return { store, adapter, buffer, disk, add, setSaving(value) { saving = value; } };
}

test('C05: save=false records buffer-only failure and never completes status or undo', async t => {
	const f = await fixture(t), file = await f.add('a', 'before\n', 'after\n'); f.setSaving(false);
	await assert.rejects(executeDecision(f.store, file, { action: 'reject' }, f.adapter), /saveReturnedFalse/);
	assert.deepEqual(f.buffer.get(file), text('before\n')); assert.deepEqual(f.disk.get(file), text('after\n'));
	assert.equal(f.store.get().statuses.a, undefined); assert.equal(f.store.get().undo.length, 0);
	assert.equal(Object.values(f.store.get().operations)[0].stage, 'bufferApplied');
	f.setSaving(true); await reconcileResource(f.store, file, f.adapter);
	assert.equal(f.store.get().statuses.a, 'rejected'); assert.deepEqual(f.disk.get(file), text('before\n')); assert.equal(f.store.get().undo.length, 1);
});

test('C06: undo of a two-resource batch updates only the restored item and retains the conflicting recovery', async t => {
	const f = await fixture(t), a = await f.add('a', 'before-a', 'after-a', 'a.txt'), b = await f.add('b', 'before-b', 'after-b', 'b.txt');
	await executeDecision(f.store, a, { action: 'reject' }, f.adapter, { batchId: 'fixture-batch' }); await executeDecision(f.store, b, { action: 'reject' }, f.adapter, { batchId: 'fixture-batch' });
	const aUndo = f.store.get().undo.find(item => item.file === a), bUndo = f.store.get().undo.find(item => item.file === b);
	assert.equal(aUndo.batchId, 'fixture-batch'); assert.equal(bUndo.batchId, 'fixture-batch');
	f.buffer.set(b, text('HUMAN')); f.disk.set(b, text('HUMAN'));
	await undoItem(f.store, aUndo.id, f.adapter); await assert.rejects(undoItem(f.store, bUndo.id, f.adapter), /externalChange/);
	assert.equal(f.store.get().statuses.a, undefined); assert.equal(f.store.get().statuses.b, 'rejected');
	assert.equal(f.store.get().undo.find(item => item.id === aUndo.id).phase, 'consumed');
	assert.notEqual(f.store.get().undo.find(item => item.id === bUndo.id).phase, 'consumed');
	assert.deepEqual(f.buffer.get(b), text('HUMAN'));
});

test('C03: persisted hunk acceptance survives a file-wide rejection through the common executor', async t => {
	const f = await fixture(t), before = 'one\ntwo\nthree\n', after = 'ONE\ntwo\nTHREE\n', file = await f.add('a', before, after);
	const group = groupsOf(diffLines(before, after).lines)[0];
	await executeDecision(f.store, file, { action: 'accept', index: 0, signature: groupSignature(group), revision: activeReview(f.store.get(), file).revision }, f.adapter);
	await executeDecision(f.store, file, { action: 'reject' }, f.adapter);
	assert.deepEqual(f.disk.get(file), text('ONE\ntwo\nthree\n')); assert.equal(f.store.get().statuses.a, 'mixed');
});

test('C02/C07: the executor restores CRLF exactly and deletes a created resource instead of emptying it', async t => {
	const f = await fixture(t), crlf = await f.add('crlf', 'old\r\nline\r\n', 'new\r\nline\r\n', 'crlf.txt');
	await executeDecision(f.store, crlf, { action: 'reject' }, f.adapter); assert.deepEqual(f.disk.get(crlf), text('old\r\nline\r\n'));
	const created = await f.add('created', undefined, 'created\n', 'created.txt');
	await executeDecision(f.store, created, { action: 'reject' }, f.adapter); assert.deepEqual(f.disk.get(created), absent());
	assert.equal(f.store.get().statuses.created, 'rejected');
});

test('persisted content followed by state failure reconciles without a duplicate write or undo item', async t => {
	let fail = false;
	const f = await fixture(t, { fault(stage) { if (fail && stage === 'state') { throw new Error('state unavailable'); } } });
	const file = await f.add('a', 'before', 'after'); const realWrite = f.adapter.write; let writes = 0;
	f.adapter.write = async (...args) => { writes++; await realWrite(...args); fail = true; };
	await assert.rejects(executeDecision(f.store, file, { action: 'reject' }, f.adapter), /state unavailable/);
	assert.deepEqual(f.disk.get(file), text('before')); assert.equal(f.store.get().statuses.a, undefined);
	fail = false; await reconcileResource(f.store, file, f.adapter);
	assert.equal(writes, 1); assert.equal(f.store.get().statuses.a, 'rejected'); assert.equal(f.store.get().undo.length, 1);
	await reconcileResource(f.store, file, f.adapter); assert.equal(f.store.get().undo.length, 1);
});

test('undo with save=false remains recoverable when its restored buffer is finally saved', async t => {
	const f = await fixture(t), file = await f.add('a', 'before', 'after');
	await executeDecision(f.store, file, { action: 'reject' }, f.adapter); const item = f.store.get().undo[0];
	f.setSaving(false); await assert.rejects(undoItem(f.store, item.id, f.adapter), /saveReturnedFalse/);
	assert.equal(f.store.get().statuses.a, 'rejected'); assert.notEqual(f.store.get().undo[0].phase, 'consumed');
	f.setSaving(true); await reconcileResource(f.store, file, f.adapter);
	assert.deepEqual(f.disk.get(file), text('after')); assert.equal(f.store.get().statuses.a, undefined); assert.equal(f.store.get().undo[0].phase, 'consumed');
});

test('two partial rejections can be undone newest-first without stale predecessor tokens', async t => {
	const f = await fixture(t), before = 'one\ntwo\nthree\n', after = 'ONE\ntwo\nTHREE\n', file = await f.add('a', before, after);
	let current = after;
	for (let step = 0; step < 2; step++) {
		const group = groupsOf(diffLines(before, current).lines)[0];
		await executeDecision(f.store, file, { action: 'reject', index: 0, signature: groupSignature(group), revision: activeReview(f.store.get(), file).revision }, f.adapter);
		current = f.buffer.get(file).text;
	}
	assert.deepEqual(f.disk.get(file), text(before)); assert.equal(f.store.get().statuses.a, 'rejected');
	const items = f.store.get().undo;
	await undoItem(f.store, items[1].id, f.adapter); assert.deepEqual(f.disk.get(file), text('one\ntwo\nTHREE\n'));
	await undoItem(f.store, items[0].id, f.adapter); assert.deepEqual(f.disk.get(file), text(after));
	assert.equal(f.store.get().statuses.a, undefined); assert.ok(f.store.get().undo.every(item => item.phase === 'consumed'));
});

test('a new acceptance request recovering an unfinished rejection is reported as recovered, never accepted', async t => {
	const f = await fixture(t), file = await f.add('a', 'before', 'after');
	f.setSaving(false); await assert.rejects(executeDecision(f.store, file, { action: 'reject' }, f.adapter), /saveReturnedFalse/);
	f.setSaving(true); const outcome = await executeDecision(f.store, file, { action: 'accept' }, f.adapter);
	assert.equal(outcome, 'recovered'); assert.equal(f.store.get().statuses.a, 'rejected'); assert.deepEqual(f.disk.get(file), text('before'));
	assert.equal(Object.values(f.store.get().operations).length, 1);
});
