'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork, spawnSync } = require('node:child_process');
const { ReviewStore } = require('../out/review-store.js');
const { ingestEntries, activeReview, planReviewDecision, commitReviewDecision } = require('../out/review.js');
const { groupsOf, diffLines, groupSignature } = require('../out/diff.js');
async function fixture(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-review-store-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	return root;
}
function entry(root, id, before, after) {
	return { id, file: path.join(root, 'a.txt'), time: '2026-11-19T00:00:00Z', before: { exists: true, text: before, large: false }, after: { exists: true, text: after, large: false } };
}

test('store migrates legacy decisions, backs up, and persists verified SHA256 snapshots', async t => {
	const root = await fixture(t), directory = path.join(root, '.claude/launcher-changes'); fs.mkdirSync(directory, { recursive: true });
	fs.writeFileSync(path.join(directory, 'status.json'), '{"old":"rejected"}\n');
	const store = await ReviewStore.open(root); t.after(() => store.close());
	await store.update(s => ingestEntries(s, [entry(root, 'new', 'before\r\n', 'after\r\n')]));
	assert.equal(store.get().statuses.old, 'rejected');
	const raw = JSON.parse(fs.readFileSync(path.join(directory, 'review-state.v1.json'), 'utf8'));
	const encoded = raw.reviews[path.join(root, 'a.txt')][0].base;
	assert.equal(encoded.text, undefined); assert.match(encoded.contentRef.digest, /^[a-f0-9]{64}$/);
	assert.ok(fs.readdirSync(path.join(directory, 'review-migration-backups')).length > 0);
	await store.close();
	const reopened = await ReviewStore.open(root); t.after(() => reopened.close());
	assert.equal(activeReview(reopened.get(), path.join(root, 'a.txt')).base.text, 'before\r\n');
});

test('two instances have exactly one writer; reload never silently reacquires after release', async t => {
	const root = await fixture(t), a = await ReviewStore.open(root), b = await ReviewStore.open(root);
	t.after(() => a.close()); t.after(() => b.close());
	assert.equal(a.writable, true); assert.equal(b.writable, false);
	await assert.rejects(b.update(s => { s.statuses.b = 'accepted'; }), /anotherWriter/);
	await a.update(s => { s.statuses.a = 'accepted'; }); await b.reload(); assert.equal(b.get().statuses.a, 'accepted');
	await assert.rejects(b.recoverWriter(), /writerStillAlive/);
	await a.close(); await a.reload(); assert.equal(a.writable, false);
	assert.equal(await b.recoverWriter(), true); assert.equal(b.writable, true);
});

test('partial acceptance survives close/reopen and mixed does not fabricate a legacy status', async t => {
	const root = await fixture(t), e = entry(root, 'a', 'one\ntwo\nthree\n', 'ONE\ntwo\nTHREE\n');
	let store = await ReviewStore.open(root);
	await store.update(s => ingestEntries(s, [e]));
	const group = groupsOf(diffLines(e.before.text, e.after.text).lines)[0];
	await store.update(s => commitReviewDecision(s, planReviewDecision(activeReview(s, e.file), { kind: 'text', text: e.after.text }, { action: 'accept', index: 0, signature: groupSignature(group) })));
	await store.close(); store = await ReviewStore.open(root); t.after(() => store.close());
	const plan = planReviewDecision(activeReview(store.get(), e.file), { kind: 'text', text: e.after.text }, { action: 'reject' });
	assert.equal(plan.target.text, 'ONE\ntwo\nthree\n');
	await store.update(s => commitReviewDecision(s, plan));
	assert.equal(store.get().statuses.a, 'mixed');
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(store.directory, 'status.json'), 'utf8')), {});
});

test('state write failure does not confirm an acceptance and leaves a recoverable previous generation', async t => {
	const root = await fixture(t); let fail = false;
	const store = await ReviewStore.open(root, {}, { fault(stage) { if (fail && stage === 'state') { throw new Error('simulated state write failure'); } } }); t.after(() => store.close());
	const previous = store.get().generation; fail = true;
	await assert.rejects(store.update(s => { s.statuses.failed = 'accepted'; }), /simulated state write failure/);
	assert.equal(store.get().generation, previous); assert.equal(store.get().statuses.failed, undefined);
	fail = false; await store.reload(); assert.equal(store.get().statuses.failed, undefined);
});

test('projection failure preserves the canonical decision and retries only projection', async t => {
	const root = await fixture(t); let fail = false;
	const store = await ReviewStore.open(root, {}, { fault(stage) { if (fail && stage === 'projection') { throw new Error('simulated projection failure'); } } }); t.after(() => store.close());
	fail = true; await store.update(s => { s.statuses.a = 'accepted'; });
	assert.equal(store.get().statuses.a, 'accepted'); assert.equal(store.get().legacyProjection.phase, 'pending');
	fail = false; await store.reload();
	assert.equal(store.get().legacyProjection.phase, 'complete');
	assert.equal(JSON.parse(fs.readFileSync(path.join(store.directory, 'status.json'), 'utf8')).a, 'accepted');
});

test('legacy writer changes are blocked rather than imported over partial canonical decisions', async t => {
	const root = await fixture(t), store = await ReviewStore.open(root); t.after(() => store.close());
	fs.writeFileSync(path.join(store.directory, 'status.json'), '{"external":"accepted"}\n');
	await assert.rejects(store.update(s => { s.statuses.a = 'accepted'; }), /legacyWriterConflict/);
	assert.equal(store.get().statuses.a, undefined); assert.equal(store.writable, false);
});

test('unknown schema and corrupted blobs never migrate or normalize silently', async t => {
	const root = await fixture(t), store = await ReviewStore.open(root);
	const e = entry(root, 'a', 'before', 'after'); await store.update(s => ingestEntries(s, [e])); await store.close();
	const canonical = path.join(store.directory, 'review-state.v1.json'), original = fs.readFileSync(canonical, 'utf8'), raw = JSON.parse(original);
	raw.schemaVersion = 99; fs.writeFileSync(canonical, JSON.stringify(raw));
	await assert.rejects(ReviewStore.open(root), /unsupportedSchema/);
	assert.equal(JSON.parse(fs.readFileSync(canonical, 'utf8')).schemaVersion, 99);
	fs.writeFileSync(canonical, original);
	const digest = raw.reviews[e.file][0].base.contentRef.digest; fs.writeFileSync(path.join(store.directory, 'review-blobs/v1', digest + '.txt'), 'different');
	await assert.rejects(ReviewStore.open(root), /invalidSnapshot/);
});

test('operations and undo keep individual IDs/snapshots across a real reopen', async t => {
	const root = await fixture(t); let store = await ReviewStore.open(root);
	await store.update(s => {
		s.operations.op = { id: 'op', file: path.join(root, 'a.txt'), ids: ['a'], expected: { kind: 'text', text: 'after' }, target: { kind: 'text', text: 'before' }, stage: 'bufferApplied' };
		s.undo.push({ id: 'undo', operationId: 'op', file: path.join(root, 'a.txt'), ids: ['a'], previous: { kind: 'text', text: 'after' }, restored: { kind: 'text', text: 'before' }, phase: 'retryable' });
	});
	await store.close(); store = await ReviewStore.open(root); t.after(() => store.close());
	assert.equal(store.get().operations.op.stage, 'bufferApplied'); assert.deepEqual(store.get().undo[0].ids, ['a']);
	assert.equal(store.get().undo[0].previous.text, 'after'); assert.equal(store.get().statuses.a, undefined);
});

test('queued updates retain independent decisions and malformed drafts never replace a valid generation', async t => {
	const root = await fixture(t), store = await ReviewStore.open(root); t.after(() => store.close());
	await Promise.all([store.update(s => { s.statuses.a = 'accepted'; }), store.update(s => { s.statuses.b = 'rejected'; })]);
	assert.deepEqual(store.get().statuses, { a: 'accepted', b: 'rejected' });
	const generation = store.get().generation;
	await assert.rejects(store.update(s => { s.reviews.invalid = [{}]; }), /invalidReviewState/);
	assert.equal(store.get().generation, generation); assert.equal(store.get().reviews.invalid, undefined);
});

test('separate Node processes cannot both become writer for the same local context', async t => {
	const root = await fixture(t), childScript = path.join(root, 'writer.cjs');
	const modulePath = require.resolve('../out/review-store.js');
	fs.writeFileSync(childScript, `const {ReviewStore}=require(${JSON.stringify(modulePath)});(async()=>{const s=await ReviewStore.open(process.argv[2]);await s.update(d=>{d.statuses.child='accepted'});process.send({ready:s.writable});process.on('message',async()=>{await s.close();process.exit(0)})})().catch(e=>{console.error(e);process.exit(1)})`);
	const child = fork(childScript, [root], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
	t.after(() => { if (child.exitCode === null) { child.kill(); } });
	const ready = await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); child.once('exit', code => reject(new Error('writer exited before ready: ' + code))); });
	assert.equal(ready.ready, true);
	const reader = await ReviewStore.open(root); t.after(() => reader.close());
	assert.equal(reader.writable, false); assert.equal(reader.get().statuses.child, 'accepted');
	const exited = new Promise(resolve => child.once('exit', resolve)); child.send('release'); await exited;
	assert.equal(await reader.recoverWriter(), true); assert.equal(reader.writable, true);
});

test('an orphan recovery guard is diagnosed with an explicit offline procedure, never taken by age', async t => {
	const root = await fixture(t), owner = await ReviewStore.open(root), reader = await ReviewStore.open(root);
	t.after(() => owner.close()); t.after(() => reader.close());
	const completed = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
	assert.equal(completed.status, 0);
	const guard = path.join(owner.directory, 'review-recovery.lock');
	const original = JSON.stringify({ schemaVersion: 1, token: 'interrupted-fixture', pid: completed.pid, started: '1970-01-01T00:00:00Z' });
	fs.writeFileSync(guard, original);
	await assert.rejects(reader.recoverWriter(), error => error.code === 'orphanedRecoveryGuard' && error.message.includes('Feche todas as janelas'));
	assert.equal(fs.readFileSync(guard, 'utf8'), original);
	await owner.close(); await reader.close();
	// Explicit offline cleanup in this isolated fixture, after both instances released.
	fs.unlinkSync(guard);
	const reopened = await ReviewStore.open(root); t.after(() => reopened.close()); assert.equal(reopened.writable, true);
});

test('snapshot and nesting budgets reject excess without changing the canonical generation', async t => {
	const root = await fixture(t), store = await ReviewStore.open(root, {}, { maxBlobBytes: 4, maxDepth: 16 }); t.after(() => store.close());
	const generation = store.get().generation;
	await assert.rejects(store.update(s => ingestEntries(s, [entry(root, 'a', 'before', 'after')])), /storeBudgetExceeded/);
	assert.equal(store.get().generation, generation);
	let nested = {}; const extra = nested;
	for (let i = 0; i < 25; i++) { nested.next = {}; nested = nested.next; }
	await assert.rejects(store.update(s => { s.operations.op = { id: 'op', file: path.join(root, 'a.txt'), ids: [], expected: { kind: 'absent' }, target: { kind: 'absent' }, stage: 'prepared', extra }; }), /storeDepthExceeded/);
	assert.equal(store.get().generation, generation);
});

test('an unchanged draft proves ownership without rewriting or advancing the canonical state', async t => {
	const root = await fixture(t), store = await ReviewStore.open(root), reader = await ReviewStore.open(root);
	t.after(() => store.close()); t.after(() => reader.close());
	await store.update(s => ingestEntries(s, [entry(root, 'a', 'before', 'after')]));
	const canonical = path.join(store.directory, 'review-state.v1.json'), bytes = fs.readFileSync(canonical), generation = store.get().generation;
	const identity = fs.statSync(canonical);
	await store.update(() => undefined); await store.update(s => { s.statuses = { ...s.statuses }; });
	assert.equal(store.get().generation, generation); assert.deepEqual(fs.readFileSync(canonical), bytes);
	assert.equal(fs.statSync(canonical).ino, identity.ino); assert.equal(fs.statSync(canonical).mtimeMs, identity.mtimeMs);
	// The checks that make the no-op meaningful still run: a reader, a lost lock and a foreign generation are refused.
	await assert.rejects(reader.update(() => undefined), /anotherWriter/);
	const raw = JSON.parse(bytes.toString('utf8')); raw.generation += 5; fs.writeFileSync(canonical, JSON.stringify(raw));
	await assert.rejects(store.update(() => undefined), /stateChanged/);
});

test('an update that leaves status.json unchanged commits once; a decision still goes through the pending projection', async t => {
	const root = await fixture(t); const stages = [];
	const store = await ReviewStore.open(root, {}, { fault(stage) { stages.push(stage); } }); t.after(() => store.close());
	stages.length = 0; const generation = store.get().generation;
	await store.update(s => ingestEntries(s, [entry(root, 'a', 'before', 'after')]));
	assert.equal(store.get().generation, generation + 1); assert.equal(store.get().legacyProjection.phase, 'complete');
	assert.equal(stages.filter(stage => stage === 'state').length, 1); assert.equal(stages.includes('projection'), false);
	stages.length = 0;
	await store.update(s => { s.statuses.a = 'accepted'; });
	assert.equal(store.get().generation, generation + 3); assert.equal(store.get().legacyProjection.phase, 'complete');
	assert.equal(stages.filter(stage => stage === 'state').length, 2); assert.equal(stages.filter(stage => stage === 'projection').length, 1);
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(store.directory, 'status.json'), 'utf8')), { a: 'accepted' });
	await store.close(); const reopened = await ReviewStore.open(root); t.after(() => reopened.close());
	assert.equal(reopened.writable, true); assert.equal(reopened.get().statuses.a, 'accepted');
});

test('a verified snapshot is reused only while its file is unchanged: replaced content is rejected and a deleted copy is rewritten', async t => {
	const root = await fixture(t), store = await ReviewStore.open(root); t.after(() => store.close());
	const e = entry(root, 'a', 'before text', 'after text'); await store.update(s => ingestEntries(s, [e]));
	const raw = JSON.parse(fs.readFileSync(path.join(store.directory, 'review-state.v1.json'), 'utf8'));
	const blob = path.join(store.directory, 'review-blobs/v1', raw.reviews[e.file][0].base.contentRef.digest + '.txt');
	await store.reload(); assert.equal(activeReview(store.get(), e.file).base.text, 'before text');
	fs.unlinkSync(blob);
	await store.update(s => { s.statuses.other = 'accepted'; });
	assert.equal(fs.readFileSync(blob, 'utf8'), 'before text');
	fs.writeFileSync(blob, 'tampered text of another size');
	await assert.rejects(store.reload(), /invalidSnapshot/);
	// Same size, later timestamp: identity changed, so the content is read and hashed again.
	fs.writeFileSync(blob, 'BEFORE TEXT'); const later = new Date(Date.now() + 60000); fs.utimesSync(blob, later, later);
	await assert.rejects(store.reload(), /invalidSnapshot/);
	fs.writeFileSync(blob, 'before text'); await store.reload();
	assert.equal(activeReview(store.get(), e.file).base.text, 'before text');
});

test('blob collection removes only old copies that no canonical, previous or backed-up state mentions', async t => {
	const root = await fixture(t), store = await ReviewStore.open(root), reader = await ReviewStore.open(root);
	t.after(() => store.close()); t.after(() => reader.close());
	const blobs = path.join(store.directory, 'review-blobs/v1'), names = () => fs.readdirSync(blobs).sort();
	const digestOf = text => require('node:crypto').createHash('sha256').update(text, 'utf8').digest('hex') + '.txt';
	const old = file => { const time = new Date(Date.now() - 3600000); fs.utimesSync(path.join(blobs, file), time, time); };
	const e = entry(root, 'a', 'first base', 'first expected');
	await store.update(s => ingestEntries(s, [e]));
	// Replace the review content twice: the first texts leave the canonical state, then also the previous one.
	const replace = (base, expected) => store.update(s => { const review = s.reviews[e.file][0]; review.base = { kind: 'text', text: base }; review.expected = { kind: 'text', text: expected }; review.revision += 1; });
	await replace('second base', 'second expected');
	const backup = path.join(store.directory, 'review-migration-backups', 'manual-backup'); fs.mkdirSync(backup, { recursive: true });
	fs.copyFileSync(path.join(store.directory, 'review-state.v1.json'), path.join(backup, 'review-state.v1.json'));
	await replace('third base', 'third expected'); await replace('fourth base', 'fourth expected');
	fs.writeFileSync(path.join(blobs, 'notes.txt'), 'unknown file'); fs.writeFileSync(path.join(blobs, digestOf('recent orphan')), 'recent orphan');
	fs.writeFileSync(path.join(blobs, digestOf('old orphan')), 'old orphan');
	for (const name of names()) { if (name !== digestOf('recent orphan')) old(name); }
	await assert.rejects(reader.collectUnreferencedBlobs(0), /anotherWriter/);
	const before = names(); assert.equal(await store.collectUnreferencedBlobs(), 3);
	const removed = before.filter(name => !names().includes(name)).sort();
	assert.deepEqual(removed, [digestOf('first base'), digestOf('first expected'), digestOf('old orphan')].sort());
	for (const kept of ['second base', 'second expected', 'third base', 'third expected', 'fourth base', 'fourth expected', 'recent orphan']) assert.ok(names().includes(digestOf(kept)), kept);
	assert.ok(names().includes('notes.txt'));
	// What remains is sufficient for the canonical state, its previous generation and the backup.
	await store.reload(); assert.equal(activeReview(store.get(), e.file).base.text, 'fourth base');
	await store.close(); const reopened = await ReviewStore.open(root); t.after(() => reopened.close());
	assert.equal(activeReview(reopened.get(), e.file).expected.text, 'fourth expected');
});

test('blob collection is cancelled, deleting nothing, when a reference source cannot be read', async t => {
	if (process.platform === 'win32') { t.skip('symlink creation needs privileges on Windows'); return; }
	const root = await fixture(t), store = await ReviewStore.open(root); t.after(() => store.close());
	await store.update(s => ingestEntries(s, [entry(root, 'a', 'before', 'after')]));
	const blobs = path.join(store.directory, 'review-blobs/v1'), orphan = path.join(blobs, 'f'.repeat(64) + '.txt');
	fs.writeFileSync(orphan, 'orphan'); const time = new Date(Date.now() - 3600000); fs.utimesSync(orphan, time, time);
	const backups = path.join(store.directory, 'review-migration-backups'); fs.mkdirSync(backups, { recursive: true });
	fs.symlinkSync(root, path.join(backups, 'linked'));
	await assert.rejects(store.collectUnreferencedBlobs(), /unsupportedStore/);
	assert.equal(fs.existsSync(orphan), true);
});
