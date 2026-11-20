'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const OUT = process.env.LAUNCHER_TEST_OUT || path.resolve(__dirname, '../out');
const { inventoryPurge: inventory, planPurge: plan, summarizePurge: summarize, PURGE_MEMORY_PATHS } = require(path.join(OUT, 'purge-plan.js'));
const emptyMemory = { undoCount: 0, cacheCount: 0, complete: true };
async function fixture(t) {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-purge-plan-')));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const directory = path.join(root, '.claude', 'launcher-changes'); await fs.mkdir(directory, { recursive: true });
	return { root, directory, async put(relative, text = 'ordinary private fixture') {
		const file = path.join(directory, ...relative.split('/')); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); return file;
	}, scan: options => inventory(directory, root, { memory: emptyMemory, ...options }) };
}

test('purge inventory plans only known data, preserves controls and unknowns, and never performs effects', async t => {
	const f = await fixture(t), sha1 = 'a'.repeat(40), sha256 = 'b'.repeat(64), uuid = '12345678-1234-1234-1234-123456789abc';
	for (const relative of ['log.jsonl', 'status.json', 'meta.json', 'review-state.v1.json', 'review-state.v1.json.prev',
		`blobs/${sha1}.txt`, `review-blobs/v1/${sha256}.txt`, `pending/${'c'.repeat(32)}.json`,
		`settings-backups/${sha256}.json`, `review-migration-backups/${uuid}/review-writer.lock`, `review-migration-backups/${uuid}/manifest.json`,
		'capture-policy.json', 'launcher-record-change.js', 'review-writer.lock', 'review-recovery.lock', 'capture-maintenance.lock', 'purge-state.v1.json', '.gitignore',
		'blobs/user-note.txt', 'unmanaged-private-name.txt']) { await f.put(relative); }
	await fs.mkdir(path.join(f.directory, 'active'));
	const before = await f.scan(), planned = plan(before, { owned: true, quiescent: true });
	assert.equal(planned.kind, 'ready');
	const paths = planned.items.map(item => item.relativePath);
	for (const relative of ['log.jsonl', `blobs/${sha1}.txt`, `review-blobs/v1/${sha256}.txt`, `review-migration-backups/${uuid}/review-writer.lock`]) assert(paths.includes(relative));
	for (const relative of ['blobs', 'active', 'review-writer.lock', 'review-recovery.lock', 'capture-maintenance.lock', 'purge-state.v1.json', 'capture-policy.json', 'launcher-record-change.js', 'blobs/user-note.txt', 'unmanaged-private-name.txt']) assert.equal(paths.includes(relative), false);
	assert.equal(before.unknown.length, 2);
	assert.equal(await fs.readFile(path.join(f.directory, 'meta.json'), 'utf8'), 'ordinary private fixture');
	assert.equal(await fs.readFile(path.join(f.directory, 'purge-state.v1.json'), 'utf8'), 'ordinary private fixture');
	const report = summarize(before, before);
	assert.equal(report.outcome, 'partial'); assert.equal(report.unknownPreserved, 2);
	assert.equal(report.categories.find(item => item.category === 'unknown').remainingCount, 1);
	assert.equal(report.categories.find(item => item.category === 'blobs').reasons.includes('unknownPreserved'), true);
	for (const marker of [f.root, 'ordinary private fixture', 'user-note', 'unmanaged-private-name', uuid, sha1, sha256]) assert.equal(JSON.stringify(report).includes(marker), false);
});

test('partial purge reports removed and retained categories with redacted reasons and explicit memory state', async t => {
	const f = await fixture(t); await f.put('log.jsonl'); await f.put('meta.json');
	const before = await f.scan({ memory: { undoCount: 2, cacheCount: 3, complete: true } });
	await fs.unlink(path.join(f.directory, 'log.jsonl'));
	const after = await f.scan({ memory: { undoCount: 2, cacheCount: 0, complete: true } });
	const report = summarize(before, after, [
		{ relativePath: 'log.jsonl', category: 'history', outcome: 'removed', reason: 'none' },
		{ relativePath: 'meta.json', category: 'metadata', outcome: 'failed', reason: 'private raw exception' },
		{ relativePath: PURGE_MEMORY_PATHS.cache, category: 'cache', outcome: 'removed' },
	]);
	assert.equal(report.outcome, 'partial');
	const categories = Object.fromEntries(report.categories.map(item => [item.category, item]));
	assert.equal(categories.history.outcome, 'removed'); assert.equal(categories.history.removedCount, 1);
	assert.equal(categories.metadata.outcome, 'failed'); assert.equal(categories.metadata.remainingCount, 1);
	assert.deepEqual(categories.metadata.reasons, ['operationFailed']);
	assert.equal(categories.undo.outcome, 'remaining'); assert.equal(categories.undo.remainingCount, 2);
	assert.equal(categories.cache.removedCount, 3);
	assert.equal(JSON.stringify(report).includes('private raw exception'), false);
});

test('a failed, blocked or remaining memory effect cannot become complete because both counts are zero', () => {
	const empty = { coverage: 'complete', issues: [], items: [], unknown: [], protectedDirectories: [], activeProducer: false, memory: emptyMemory };
	for (const outcome of ['failed', 'blocked', 'remaining']) {
		const report = summarize(empty, empty, [{ relativePath: PURGE_MEMORY_PATHS.undo, category: 'undo', outcome, reason: 'memoryUnavailable' }]);
		const undo = report.categories.find(item => item.category === 'undo');
		assert.equal(undo.outcome, outcome); assert.equal(undo.remainingCount, 0);
		assert.deepEqual(undo.reasons, ['memoryUnavailable']); assert.equal(report.outcome, 'partial');
	}
	assert.equal(summarize(empty, empty, [{ relativePath: 'unmanaged', category: 'undo', outcome: 'failed' }]).outcome, 'complete', 'unvalidated effect identities never become authority');
});

test('ownership, producer activity, missing memory knowledge and scan limits block every planned effect', async t => {
	const f = await fixture(t); await f.put('log.jsonl'); await f.put('meta.json');
	const complete = await f.scan();
	for (const ownership of [{ owned: false, quiescent: true }, { owned: true, quiescent: false }]) {
		const result = plan(complete, ownership); assert.equal(result.kind, 'blocked'); assert.deepEqual(result.items, []);
	}
	assert.equal(plan(await inventory(f.directory, f.root), { owned: true, quiescent: true }).reason, 'memoryUnavailable');
	const limited = await f.scan({ maxEntries: 1 });
	assert.equal(limited.coverage, 'partial'); assert.equal(plan(limited, { owned: true, quiescent: true }).kind, 'blocked');
	assert.equal(summarize(complete, limited).coverage, 'partial'); assert.notEqual(summarize(complete, limited).outcome, 'complete');
	await f.put(`active/ordinary-producer.json`);
	const active = plan(await f.scan(), { owned: true, quiescent: true });
	assert.equal(active.reason, 'captureInProgress'); assert.deepEqual(active.items, []);
	assert.equal(await fs.readFile(path.join(f.directory, 'log.jsonl'), 'utf8'), 'ordinary private fixture');
	assert.equal(plan({ ...complete, items: [...complete.items, { relativePath: '../unmanaged', category: 'history', kind: 'file' }] },
		{ owned: true, quiescent: true }).reason, 'changedSincePlan');
});

test('unsafe parents and simulated links are never traversed or offered for deletion', async t => {
	const f = await fixture(t); const file = await f.put('meta.json');
	const io = { ...fs, lstat: async target => target === file ? { isSymbolicLink: () => true, isFile: () => true, isDirectory: () => false } : fs.lstat(target) };
	const unsafe = await f.scan({ io });
	assert.equal(unsafe.coverage, 'partial'); assert.equal(plan(unsafe, { owned: true, quiescent: true }).reason, 'unsafeType');
	let opened = 0;
	const parentIo = { ...fs, lstat: async target => target === path.join(f.root, '.claude')
		? { isSymbolicLink: () => true, isFile: () => false, isDirectory: () => true } : fs.lstat(target),
		opendir: async () => { opened += 1; throw new Error('must not traverse unsafe parent'); } };
	assert.equal((await f.scan({ io: parentIo })).coverage, 'partial'); assert.equal(opened, 0);
	assert.equal((await inventory(f.root, f.root, { memory: emptyMemory })).issues[0], 'scopeUnknown');
	const missingRoot = path.join(f.root, 'missing');
	assert.equal((await inventory(path.join(missingRoot, '.claude', 'launcher-changes'), missingRoot, { memory: emptyMemory })).issues[0], 'scopeUnknown');
	const changedIo = { ...fs, lstat: async target => {
		if (target === file) { const error = new Error('ordinary disappeared file'); error.code = 'ENOENT'; throw error; }
		return fs.lstat(target);
	} };
	const changed = await f.scan({ io: changedIo });
	assert.equal(plan(changed, { owned: true, quiescent: true }).reason, 'changedSincePlan');
});

test('unknown subtrees stay preserved and a depth-limited inventory never certifies complete cleanup', async t => {
	const f = await fixture(t); await f.put('review-blobs/v1/' + 'd'.repeat(64) + '.txt');
	await f.put('capture-diagnostics/v3/unmanaged.json');
	const before = await f.scan(), result = plan(before, { owned: true, quiescent: true });
	assert.equal(result.kind, 'ready'); assert.equal(result.items.some(item => item.relativePath === 'capture-diagnostics'), false);
	const report = summarize(before, before);
	assert.equal(report.unknownCountIsLowerBound, true); assert.notEqual(report.outcome, 'complete');
	const limited = await f.scan({ maxDepth: 1 }); assert.equal(limited.coverage, 'partial');
	assert.equal(plan(limited, { owned: true, quiescent: true }).kind, 'blocked');
});
