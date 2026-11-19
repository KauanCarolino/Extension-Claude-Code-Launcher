'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { activeReview, contentOfSnapshot, sameContent, ingestEntries, planReviewDecision, commitReviewDecision } = require('../out/review.js');
const { diffLines, groupsOf, groupSignature } = require('../out/diff.js');
const file = '/fixture/review.txt';
const snap = text => text === undefined ? { exists: false, text: null, large: false } : { exists: true, text, large: false };
const entry = (id, before, after) => ({ id, file, time: '2026-11-19T00:00:00Z', before: snap(before), after: snap(after) });
const text = value => ({ kind: 'text', text: value });
function state() { return { schemaVersion: 1, generation: 0, contextId: '/fixture', reviews: {}, statuses: {}, operations: {}, undo: [], legacyProjection: { phase: 'complete', observedHash: null, targetHash: null, targetGeneration: 0 } }; }

test('C01: a human barrier prevents rejecting across the earlier baseline', () => {
	const s = state();
	ingestEntries(s, [entry('a', 'base\n', 'claude\n')]);
	ingestEntries(s, [entry('b', 'claude\nMANUAL\n', 'claude2\nMANUAL\n')]);
	assert.equal(s.reviews[file][0].phase, 'blocked');
	const plan = planReviewDecision(activeReview(s, file), text('claude2\nMANUAL\n'), { action: 'reject' });
	assert.equal(plan.target.text, 'claude\nMANUAL\n');
	commitReviewDecision(s, plan);
	assert.equal(s.statuses.b, 'rejected');
	assert.equal(s.statuses.a, undefined);
	assert.throws(() => planReviewDecision(s.reviews[file][0], text('claude\nMANUAL\n'), { action: 'reject' }), /externalChange/);
});

test('C01: a manual edit after capture blocks content mutation and never becomes a Claude hunk', () => {
	const s = state(); ingestEntries(s, [entry('a', 'base\n', 'claude\n')]);
	assert.throws(() => planReviewDecision(activeReview(s, file), text('claude\nMANUAL\n'), { action: 'reject' }), /externalChange/);
	assert.deepEqual(s.statuses, {});
});

test('explicit whole-context acceptance can settle a human barrier without writing its text', () => {
	const s = state(); ingestEntries(s, [entry('a', 'base', 'claude'), entry('b', 'claude+human', 'next+human')]);
	const blocked = s.reviews[file][0];
	const plan = planReviewDecision(blocked, text('next+human'), { action: 'accept', revision: blocked.revision });
	assert.deepEqual(plan.expected, plan.target);
	assert.equal(plan.next.phase, 'complete');
	const unknown = { ...blocked, base: { kind: 'unavailable', reason: 'missingSnapshot' }, blockReason: 'unknownSnapshot' };
	assert.throws(() => planReviewDecision(unknown, text('next+human'), { action: 'accept' }), /unknownSnapshot/);
});

test('C02: the planned full restoration preserves CRLF without CRCRLF', () => {
	const s = state(); ingestEntries(s, [entry('a', 'old\r\nline\r\n', 'new\r\nline\r\n')]);
	const plan = planReviewDecision(activeReview(s, file), text('new\r\nline\r\n'), { action: 'reject' });
	assert.equal(plan.target.text, 'old\r\nline\r\n');
	assert.ok(!plan.target.text.includes('\r\r\n'));
});

test('C03: an accepted hunk survives rejection by another projection; mixed is explicit', () => {
	const before = 'one\ntwo\nthree\n', after = 'ONE\ntwo\nTHREE\n';
	const s = state(); ingestEntries(s, [entry('a', before, after)]);
	const group = groupsOf(diffLines(before, after).lines)[0];
	const accepted = planReviewDecision(activeReview(s, file), text(after), { action: 'accept', index: 0, signature: groupSignature(group) });
	commitReviewDecision(s, accepted);
	const rejected = planReviewDecision(activeReview(s, file), text(after), { action: 'reject' });
	assert.equal(rejected.target.text, 'ONE\ntwo\nthree\n');
	commitReviewDecision(s, rejected);
	assert.equal(s.statuses.a, 'mixed');
});

test('C04: coalesced entries, including equal timestamps, retain every represented ID', () => {
	const s = state(); ingestEntries(s, [entry('a', 'v0', 'v1')]);
	ingestEntries(s, [entry('b', 'v1', 'v2'), entry('c', 'v2', 'v3')]);
	assert.deepEqual(activeReview(s, file).ids, ['a', 'b', 'c']);
	commitReviewDecision(s, planReviewDecision(activeReview(s, file), text('v3'), { action: 'accept' }));
	assert.deepEqual(s.statuses, { a: 'accepted', b: 'accepted', c: 'accepted' });
});

test('C07: rejecting a created resource restores absence, while existing empty text stays a file', () => {
	const created = state(); ingestEntries(created, [entry('a', undefined, 'created\n')]);
	assert.deepEqual(planReviewDecision(activeReview(created, file), text('created\n'), { action: 'reject' }).target, { kind: 'absent' });
	const empty = state(); ingestEntries(empty, [entry('b', '', 'created\n')]);
	assert.deepEqual(planReviewDecision(activeReview(empty, file), text('created\n'), { action: 'reject' }).target, text(''));
});

test('stale revision/signature and unavailable snapshots do not authorize a plan', () => {
	const s = state(); ingestEntries(s, [entry('a', 'old', 'new')]);
	const review = activeReview(s, file);
	assert.throws(() => planReviewDecision(review, text('new'), { action: 'accept', revision: review.revision - 1 }), /staleRevision/);
	assert.throws(() => planReviewDecision(review, text('new'), { action: 'reject', index: 0, signature: 'old' }), /staleRevision/);
	assert.equal(contentOfSnapshot(null).kind, 'unavailable');
	assert.equal(sameContent(contentOfSnapshot(null), { kind: 'absent' }), false);
});

test('ingestion is idempotent and exact integrity equality includes final newline and EOL', () => {
	const s = state(); const e = entry('a', 'old\n', 'new\n');
	assert.equal(ingestEntries(s, []), false); assert.equal(s.entryFingerprints, undefined);
	assert.equal(ingestEntries(s, [e, e]), true); assert.equal(ingestEntries(s, [e]), false);
	assert.deepEqual(activeReview(s, file).ids, ['a']);
	assert.throws(() => planReviewDecision(activeReview(s, file), text('new'), { action: 'reject' }), /externalChange/);
	assert.equal(sameContent(text('a\r\n'), text('a\n')), false);
	assert.throws(() => ingestEntries(s, [entry('a', 'old\n', 'different')]), /conflictingEntry/);
});

test('late explanations and resolved immutable legacy blobs update the same review safely', () => {
	const crypto = require('node:crypto'); const s = state();
	const e = entry('blob', 'before', 'after');
	e.before.hash = crypto.createHash('sha1').update('before').digest('hex');
	e.after.hash = crypto.createHash('sha1').update('after').digest('hex');
	const unresolved = JSON.parse(JSON.stringify(e)); unresolved.before.text = null; unresolved.after.text = null;
	ingestEntries(s, [unresolved]); assert.equal(activeReview(s, file).phase, 'blocked');
	e.reason = 'Atualiza a regra'; assert.equal(ingestEntries(s, [e]), true); assert.equal(ingestEntries(s, [e]), false);
	assert.equal(activeReview(s, file).phase, 'pending'); assert.equal(activeReview(s, file).reason, e.reason);
	assert.deepEqual(activeReview(s, file).ids, ['blob']);
	const altered = JSON.parse(JSON.stringify(e)); altered.after.text = 'different';
	assert.throws(() => ingestEntries(s, [altered]), /invalidSnapshot/);
});
