'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ReviewStore } = require('../out/review-store.js');
const { activeReview, ingestEntries, copyReview, sameContent, ReviewError } = require('../out/review.js');
const { executeDecision, undoItem, reconcileResource, executeDecisionDetailed, undoItemDetailed } = require('../out/reversal.js');
const { ReviewResultError, summarizeReviewResults } = require('../out/review-results.js');
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

test('detailed save=false exposes buffer/decision dimensions and recovery identifies the original action', async t => {
	const f = await fixture(t), file = await f.add('a', 'before', 'after'); f.setSaving(false);
	const first = await executeDecisionDetailed(f.store, file, { action: 'reject' }, f.adapter);
	assert.equal(first.result.outcome, 'partial'); assert.equal(first.result.content, 'buffer'); assert.equal(first.result.decision, 'failed');
	assert.equal(first.result.reason, 'saveReturnedFalse'); assert.equal(first.result.nextAction, 'retrySave'); assert.deepEqual(first.result.ids, ['a']);
	assert(first.error instanceof ReviewResultError); assert.equal(first.error.code, 'saveReturnedFalse');
	assert.equal(Object.prototype.propertyIsEnumerable.call(first.error, 'cause'), false);
	f.setSaving(true); const recovery = await executeDecisionDetailed(f.store, file, { action: 'accept' }, f.adapter);
	assert.equal(recovery.error, undefined); assert.equal(recovery.result.outcome, 'recovered');
	assert.equal(recovery.result.action, 'reject'); assert.equal(recovery.result.requestedAction, 'accept');
	assert.equal(recovery.result.operationId, first.result.operationId); assert.equal(recovery.result.decision, 'persisted');
	assert.equal(f.store.get().statuses.a, 'rejected'); assert.equal(f.store.get().undo.length, 1);
});

test('detailed state failure reports persisted content without exposing a private exception or repeating effects', async t => {
	let fail = false;
	const f = await fixture(t, { fault(stage) { if (fail && stage === 'state') throw new Error('PRIVATE content/path/exception'); } });
	const file = await f.add('a', 'before', 'after'), original = f.adapter.write; let writes = 0;
	f.adapter.write = async (...args) => { writes += 1; await original(...args); fail = true; };
	const failed = await executeDecisionDetailed(f.store, file, { action: 'reject' }, f.adapter);
	assert.equal(failed.result.content, 'persisted'); assert.equal(failed.result.decision, 'failed'); assert.equal(failed.result.outcome, 'partial');
	assert.equal(failed.result.reason, 'stateWriteFailed'); assert.equal(failed.result.nextAction, 'reconcile');
	assert.equal(failed.error.message.includes('PRIVATE'), false); assert.equal(JSON.stringify(failed.result).includes('PRIVATE'), false);
	fail = false; const recovered = await executeDecisionDetailed(f.store, file, { action: 'reject' }, f.adapter);
	assert.equal(recovered.result.outcome, 'recovered'); assert.equal(writes, 1); assert.equal(f.store.get().undo.length, 1);
});

test('detailed pre-effect failure and unavailable observations never announce a completed decision', async t => {
	let fail = false;
	const f = await fixture(t, { fault(stage) { if (fail && stage === 'state') throw new Error('PRIVATE'); } });
	const file = await f.add('a', 'before', 'after'); fail = true;
	const blocked = await executeDecisionDetailed(f.store, file, { action: 'reject' }, f.adapter);
	assert.equal(blocked.result.content, 'unchanged'); assert.equal(blocked.result.decision, 'notPersisted'); assert.equal(blocked.result.operationId, null);
	assert.equal(f.store.get().statuses.a, undefined); assert.deepEqual(f.disk.get(file), text('after'));
	fail = false; f.adapter.read = f.adapter.readPersisted = async () => { throw new Error('PRIVATE'); };
	const unknown = await executeDecisionDetailed(f.store, file, { action: 'reject' }, f.adapter);
	assert.equal(unknown.result.content, 'unknown'); assert.equal(unknown.result.outcome, 'failed');
	assert.equal(unknown.result.decision, 'notPersisted'); assert.equal(unknown.error.message.includes('PRIVATE'), false);
});

test('detailed batch undo retains every result and never consumes a conflicting item', async t => {
	const f = await fixture(t), a = await f.add('a', 'before-a', 'after-a', 'a.txt'), b = await f.add('b', 'before-b', 'after-b', 'b.txt');
	await executeDecisionDetailed(f.store, a, { action: 'reject' }, f.adapter, { batchId: 'batch' });
	await executeDecisionDetailed(f.store, b, { action: 'reject' }, f.adapter, { batchId: 'batch' });
	const items = f.store.get().undo;
	f.buffer.set(b, text('HUMAN')); f.disk.set(b, text('HUMAN'));
	const first = await undoItemDetailed(f.store, items.find(item => item.file === a).id, f.adapter);
	const second = await undoItemDetailed(f.store, items.find(item => item.file === b).id, f.adapter);
	const batch = summarizeReviewResults([first.result, second.result]);
	assert.equal(batch.total, 2); assert.equal(batch.complete, 1); assert.equal(batch.blocked, 1); assert.equal(batch.items.length, 2);
	assert.equal(second.result.conflict, true); assert.equal(second.result.reason, 'externalChange'); assert.deepEqual(second.result.ids, ['b']);
	assert.equal(f.store.get().statuses.b, 'rejected'); assert.notEqual(f.store.get().undo.find(item => item.file === b).phase, 'consumed');
	assert.deepEqual(f.buffer.get(b), text('HUMAN'));
});

test('detailed cancellation distinguishes before-effect and applied-buffer interruptions', async t => {
	const f = await fixture(t), file = await f.add('a', 'before', 'after'), originalRead = f.adapter.read;
	let stop = true;
	f.adapter.read = async target => { if (stop) { stop = false; throw new ReviewError('cancelledBeforeEffect'); } return originalRead(target); };
	const before = await executeDecisionDetailed(f.store, file, { action: 'reject' }, f.adapter);
	assert.equal(before.result.cancellation, 'beforeEffect'); assert.equal(before.result.content, 'unchanged');
	f.adapter.write = async (target, content) => { f.buffer.set(target, content); throw new ReviewError('cancelledAfterEffect'); };
	const after = await executeDecisionDetailed(f.store, file, { action: 'reject' }, f.adapter);
	assert.equal(after.result.cancellation, 'afterEffect'); assert.equal(after.result.content, 'buffer'); assert.equal(after.result.outcome, 'partial');
	assert.equal(after.result.decision, 'failed'); assert.equal(f.store.get().statuses.a, undefined);
});

test('detailed concurrent requests stay associated with their operation and no-effect acceptance never saves', async t => {
	const f = await fixture(t), before = 'one\ntwo\nthree\n', after = 'ONE\ntwo\nTHREE\n', file = await f.add('a', before, after);
	const group = groupsOf(diffLines(before, after).lines)[0];
	const [accepted, rejected] = await Promise.all([
		executeDecisionDetailed(f.store, file, { action: 'accept', index: 0, signature: groupSignature(group) }, f.adapter),
		executeDecisionDetailed(f.store, file, { action: 'reject' }, f.adapter),
	]);
	assert.equal(accepted.result.action, 'accept'); assert.equal(accepted.result.content, 'unchanged');
	assert.equal(rejected.result.action, 'reject'); assert.equal(rejected.result.content, 'persisted');
	assert.notEqual(accepted.result.operationId, rejected.result.operationId);
	assert.deepEqual(f.disk.get(file), text('ONE\ntwo\nthree\n')); assert.equal(f.store.get().statuses.a, 'mixed');
	const g = await fixture(t), other = await g.add('b', 'before', 'after');
	g.buffer.set(other, text('HUMAN unsaved')); g.adapter.write = async () => { assert.fail('no-effect acceptance must not save'); };
	const decision = await executeDecisionDetailed(g.store, other, { action: 'accept' }, g.adapter);
	assert.equal(decision.result.content, 'unchanged'); assert.equal(decision.result.decision, 'persisted');
	assert.deepEqual(g.disk.get(other), text('after'));
});

test('detailed undo retry recovers the same journal item and never represents it as a second undo', async t => {
	const f = await fixture(t), file = await f.add('a', 'before', 'after');
	await executeDecisionDetailed(f.store, file, { action: 'reject' }, f.adapter); const item = f.store.get().undo[0];
	f.setSaving(false); const failed = await undoItemDetailed(f.store, item.id, f.adapter);
	assert.equal(failed.result.action, 'undo'); assert.equal(failed.result.content, 'buffer'); assert.equal(failed.result.decision, 'failed');
	f.setSaving(true); const recovered = await undoItemDetailed(f.store, item.id, f.adapter);
	assert.equal(recovered.result.outcome, 'recovered'); assert.equal(recovered.result.operationId, failed.result.operationId);
	assert.equal(recovered.result.decision, 'persisted'); assert.equal(f.store.get().undo[0].phase, 'consumed');
	assert.deepEqual(f.disk.get(file), text('after')); assert.equal(f.store.get().statuses.a, undefined);
	const repeated = await undoItemDetailed(f.store, item.id, f.adapter);
	assert.equal(repeated.result.reason, 'missingUndo'); assert.equal(repeated.result.decision, 'notPersisted');
});

test('a failed legacy projection does not hide an already durable canonical decision', async t => {
	let fail = false;
	const f = await fixture(t, { fault(stage) { if (fail && stage === 'projection') throw new Error('PRIVATE projection fault'); } });
	const file = await f.add('a', 'before', 'after'), original = f.adapter.write;
	f.adapter.write = async (...args) => { await original(...args); fail = true; };
	const result = await executeDecisionDetailed(f.store, file, { action: 'reject' }, f.adapter);
	assert.equal(result.error, undefined); assert.equal(result.result.outcome, 'complete'); assert.equal(result.result.content, 'persisted');
	assert.equal(result.result.decision, 'persisted'); assert.equal(result.result.reason, 'legacyProjectionPending');
	assert.equal(f.store.get().statuses.a, 'rejected'); assert.equal(f.store.get().legacyProjection.phase, 'pending');
	fail = false; await f.store.reload(); assert.equal(f.store.get().legacyProjection.phase, 'complete');
	assert.equal(f.store.get().undo.length, 1);
});

test('legacy conflict after canonical commit retains both persisted dimensions and reports the remaining barrier', async t => {
	let f, intercept = false;
	f = await fixture(t, { fault(stage) {
		if (intercept && stage === 'state' && f.store.get().legacyProjection.phase === 'complete'
			&& Object.values(f.store.get().operations).some(op => op.stage === 'contentVerified')) {
			intercept = false;
			fs.writeFileSync(path.join(f.store.directory, 'status.json'), JSON.stringify({ legacy: 'accepted' }));
		}
	} });
	const file = await f.add('a', 'before', 'after'), original = f.adapter.write;
	f.adapter.write = async (...args) => { await original(...args); intercept = true; };
	const result = await executeDecisionDetailed(f.store, file, { action: 'reject' }, f.adapter);
	assert.equal(result.result.outcome, 'partial'); assert.equal(result.result.content, 'persisted'); assert.equal(result.result.decision, 'persisted');
	assert.equal(result.result.reason, 'legacyWriterConflict'); assert.equal(result.result.conflict, true); assert.equal(result.result.lastKnownStage, 'complete');
	assert.equal(f.store.get().statuses.a, 'rejected'); assert.equal(f.store.get().undo.length, 1); assert.deepEqual(f.disk.get(file), text('before'));
	assert.match(result.error.message, /conteúdo foi salvo e a decisão canônica foi registrada/); assert.doesNotMatch(result.error.message, /inalterado/);
});
