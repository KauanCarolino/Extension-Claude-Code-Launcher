'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const h = require(path.join(process.env.LAUNCHER_TEST_OUT || path.join(__dirname, '..', 'out'), 'history.js'));

function entry(id = 'event-1', fields = {}) {
	return { id, time: '2026-11-19T12:00:00.000Z', file: '/workspace/project/a.txt', tool: 'Edit',
		before: { exists: true, large: false, text: 'before\n' }, after: { exists: true, large: false, text: 'after\n' }, ...fields };
}
const line = (value) => `${JSON.stringify(value)}\n`;

test('entry validation rejects incomplete types before consumer code and keeps existence separate', () => {
	for (const value of [null, {}, entry('a', { time: null }), entry('a', { reason: {} }), entry('a', { before: {} }),
		entry('a', { file: 'relative.txt' }), entry('a', { schemaVersion: 999 })]) {
		assert.equal(h.validateRawEntry(value).ok, false);
	}
	assert.equal(h.validateRawEntry(entry('a', { before: { exists: false, large: false, text: null } })).ok, true);
	assert.equal(h.validateRawEntry(entry('a', { before: { exists: true, large: false, text: '' } })).ok, true);
	assert.equal(h.validateRawEntry(entry('a', { before: null })).ok, true);
});

test('valid entries survive invalid JSON/metadata with redacted rejection evidence', () => {
	const marker = 'ordinary-private-fixture-not-for-diagnostics';
	const input = line(entry('a')) + line({ id: 'incomplete', file: '/workspace/x', reason: marker }) + 'invalid JSON\n' + line(entry('b'));
	const parsed = h.parseLog(input);
	assert.deepEqual(parsed.entries.map((item) => item.id), ['a', 'b']);
	assert.equal(parsed.rejections.length, 2);
	assert.equal(parsed.coverage.status, 'partial');
	assert.equal(JSON.stringify(parsed.rejections).includes(marker), false);
	assert.deepEqual(parsed.sources.map((item) => item.ordinal), [0, 3]);
});

test('an unfinished final line is retained at its initial byte offset then resumed', () => {
	const first = line(entry('a'));
	const second = JSON.stringify(entry('b'));
	const initial = h.parseLog(first + second.slice(0, 30));
	assert.equal(initial.coverage.reason, 'incompleteLine');
	assert.equal(initial.cursor.offset, Buffer.byteLength(first));
	const resumed = h.parseLog(first + second + '\n', { cursor: initial.cursor });
	assert.deepEqual(resumed.entries.map((item) => item.id), ['b']);
	assert.equal(resumed.coverage.status, 'complete');
});

test('line and cycle budgets defer rather than invent invalidity or decisions', () => {
	const input = line(entry('a')) + line(entry('b'));
	const first = h.parseLog(input, { maxEntries: 1 });
	assert.equal(first.coverage.reason, 'budget');
	assert.deepEqual(first.entries.map((item) => item.id), ['a']);
	assert.deepEqual(h.parseLog(input, { cursor: first.cursor }).entries.map((item) => item.id), ['b']);
	const deferred = h.parseLog(input, { maxLineBytes: 10 });
	assert.equal(deferred.coverage.reason, 'deferredByBudget');
	assert.equal(deferred.cursor.offset, 0);
	assert.equal(deferred.rejections.length, 0);
});

test('escaped inline legacy snapshots near the old byte cap remain valid through the compatibility path', () => {
	const text = '\u0001'.repeat(512 * 1024 - 4) + 'á';
	assert.ok(Buffer.byteLength(text, 'utf8') <= h.MAX_SNAPSHOT_BYTES);
	const input = line(entry('large', { before: { exists: true, large: false, text }, after: { exists: true, large: false, text } }));
	assert.ok(Buffer.byteLength(input) > 2 * 1024 * 1024);
	assert.equal(h.parseLog(input).coverage.reason, 'deferredByBudget');
	const parsed = h.parseLog(input, { allowLargeLines: true });
	assert.equal(parsed.entries.length, 1);
	assert.equal(parsed.rejections.length, 0);
	assert.equal(parsed.entries[0].before.text, text);
});

test('duplicate IDs with equal contents are idempotent; divergent contents are isolated', () => {
	const parsed = h.parseLog(line(entry('same')) + line(entry('same')) + line(entry('same', { reason: 'different metadata' })));
	assert.equal(parsed.entries.length, 1);
	assert.equal(parsed.rejections[0].code, 'conflictingEntryId');
});

test('raw bytes are validated as UTF-8 and cursors use bytes instead of string units', () => {
	const first = line(entry('unicode', { reason: 'ação' }));
	const invalid = Buffer.from([0xff, 10]);
	const parsed = h.parseLog(Buffer.concat([Buffer.from(first), invalid, Buffer.from(line(entry('after')))]));
	assert.equal(parsed.rejections[0].code, 'invalidUtf8');
	assert.equal(parsed.sources[1].offset, Buffer.byteLength(first) + 2);
});

function virtualPaths(linkAt, denialAt) {
	return {
		realpath: async (file) => { if (file === denialAt) { throw { code: 'EACCES' }; } return file; },
		lstat: async (file) => ({ isSymbolicLink: () => file === linkAt, isFile: () => file.endsWith('.txt'), isDirectory: () => !file.endsWith('.txt') }),
	};
}
test('resource and storage policies evaluate simulated scope and links without external effects', async () => {
	const root = path.resolve(path.sep, 'workspace');
	const file = path.join(root, 'a.txt');
	const data = path.join(root, 'data');
	const stored = path.join(data, 'a.txt');
	assert.equal((await h.assessResourceScope(path.resolve(path.sep, 'other', 'a.txt'), root, virtualPaths())).allowed, false);
	assert.equal((await h.assessResourceScope(file, root, virtualPaths())).allowed, true);
	assert.equal((await h.assessResourceScope(file, root, virtualPaths(undefined, root))).allowed, false);
	assert.equal((await h.assessStoragePath(stored, root, virtualPaths(data))).code, 'unsafeStorageType');
	assert.equal((await h.assessStoragePath(stored, root, virtualPaths())).allowed, true);
});

test('blob digest mismatch never resolves a snapshot reference', () => {
	const text = 'ordinary snapshot';
	const hash = crypto.createHash('sha1').update(text).digest('hex');
	assert.equal(h.verifyBlob(text, hash), true);
	assert.equal(h.verifyBlob(text + ' changed', hash), false);
	assert.equal(h.verifyBlob(text, 'not-a-reference'), false);
});

test('metadata and webview messages validate shape, known operations and stale-click revision types', () => {
	assert.deepEqual(Object.keys(h.validateSavedMeta({ okay: { reason: 'ordinary reason', request: { id: 'p', text: 'request' } }, bad: { reason: {} } })), ['okay']);
	for (const message of [null, [], { command: 'unknown' }, { command: 'compare' }, { command: 'rejectFile', key: 'a', revision: -1 },
		{ command: 'rejectFile', key: 'a', revision: 1.5 }]) { assert.equal(h.validateMessage(message), undefined); }
	assert.equal(h.validateMessage({ command: 'rejectFile', key: 'a', revision: 2 }).revision, 2);
	assert.equal(h.validateMessage({ command: 'clearAllReviewData' }).command, 'clearAllReviewData');
	assert.equal(h.validateMessage({ command: 'openSession', id: 'session' }, 'home').id, 'session');
});

test('capture-policy defaults match private-file exclusions and invalid versions fail validation', () => {
	const policy = h.makeCapturePolicy({ generation: 'fixture' });
	assert.equal(policy.maxStorageBytes, 128 * 1024 * 1024);
	assert.equal(h.validateCapturePolicy(policy), true);
	assert.equal(h.validateCapturePolicy({ ...policy, schemaVersion: 2 }), false);
	for (const file of ['.env', 'nested/.env.local', 'nested/server.key', 'id_ed25519']) {
		assert.equal(h.matchesExcludedPath(file, policy.excludedPatterns), true);
	}
	assert.equal(h.matchesExcludedPath('src/ordinary.ts', policy.excludedPatterns), false);
	assert.equal(h.validateCapturePolicy({ ...policy, excludedPatterns: ['../outside'] }), false);
});

test('legacy GC never touches canonical namespaces, live blobs or an incomplete reference inventory', () => {
	const old = 'a'.repeat(40);
	const live = 'b'.repeat(40);
	const files = [`blobs/${old}.txt`, `blobs/${live}.txt`, 'review-state.v1.json', 'review-state.v1.json.prev',
		'review-writer.lock', `review-blobs/v1/${'c'.repeat(64)}.txt`, 'review-migration-backups/m/manifest.json']
		.map((relative) => ({ relative, mtime: 0 }));
	assert.deepEqual(h.planLegacyGc(files, new Set([live]), 1000000), [`blobs/${old}.txt`]);
	assert.deepEqual(h.planLegacyGc(files, new Set(), 1000000, { referencesComplete: false }), []);
	assert.equal(h.isCanonicalHistoryPath('review-state.v1.json.prev'), true);
	assert.equal(h.isCanonicalHistoryPath('review-blobs/v1/x.txt'), true);
	assert.equal(h.isCanonicalHistoryPath('capture-maintenance.lock'), true);
	assert.equal(h.isCanonicalHistoryPath('review-recovery.lock'), true);
});

test('cleanup requires coordinated ownership/quiescence and keeps locks, policy and user files', () => {
	const files = ['log.jsonl', 'meta.json', 'review-state.v1.json', 'review-writer.lock', 'capture-maintenance.lock',
		'review-recovery.lock', 'active', 'capture-policy.json', 'launcher-record-change.js', 'unrelated.txt']
		.map((relative) => ({ relative, mtime: 0 }));
	assert.equal(h.planFullCleanup(files, { owned: false, quiescent: true }).kind, 'blocked');
	assert.equal(h.planFullCleanup(files, { owned: true, quiescent: false }).kind, 'blocked');
	const plan = h.planFullCleanup(files, { owned: true, quiescent: true });
	assert.deepEqual(plan.paths, ['log.jsonl', 'meta.json', 'review-state.v1.json']);
	assert.equal(h.planFullCleanup([{ relative: 'active/ordinary-lease.json', type: 'file', mtime: 0 }],
		{ owned: true, quiescent: true }).code, 'captureInProgress');
	assert.equal(h.planFullCleanup([{ relative: 'blobs/ordinary.txt', type: 'link', mtime: 0 }],
		{ owned: true, quiescent: true }).code, 'cleanupUnsafeStorageType');
});

test('reference inventory fails conservatively and retention preserves pending IDs', () => {
	const sha = 'a'.repeat(64);
	assert.equal(h.collectContentHashes({ contentRef: `review-blobs/v1/${sha}.txt` }).hashes.has(sha), true);
	assert.equal(h.collectContentHashes({ one: {}, two: {} }, 1).complete, false);
	assert.deepEqual(h.retentionCandidates([entry('done'), entry('pending')], 30, Date.parse('2027-01-01'), (id) => id === 'done'), ['done']);
	assert.deepEqual(h.retentionCandidates([entry()], 0, Date.now(), () => true), []);
});

test('bounded local reads resume a normal log, preserve a BOM blob and distinguish missing from unreadable type', async (t) => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-history-')));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const file = path.join(root, 'log.jsonl');
	fs.writeFileSync(file, line(entry('a')) + line(entry('b')));
	const first = await h.readLogFile(file, root, { maxEntries: 1 });
	assert.deepEqual(first.entries.map((item) => item.id), ['a']);
	const second = await h.readLogFile(file, root, { cursor: first.cursor });
	assert.deepEqual(second.entries.map((item) => item.id), ['b']);
	assert.equal((await h.safeReadText(path.join(root, 'missing'), root)).kind, 'absent');
	assert.equal((await h.safeReadText(root, root)).kind, 'error');
	const text = '\uFEFFordinary content\r\n';
	const hash = crypto.createHash('sha1').update(text).digest('hex');
	const blob = path.join(root, 'blob.txt');
	fs.writeFileSync(blob, text);
	assert.equal(await h.readVerifiedBlob(blob, root, hash), text);
});
