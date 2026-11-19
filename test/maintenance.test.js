'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { ReviewStore } = require('../out/review-store.js');
const { CAPTURE_MAINTENANCE_FILE } = require('../out/history.js');
const maintenance = require('../out/maintenance.js');

async function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-maintenance-')));
  const store = await ReviewStore.open(root);
  t.after(async () => { await store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, store, guard: path.join(store.directory, CAPTURE_MAINTENANCE_FILE) };
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function loadWithFs(fileSystem) {
  const filename = path.resolve(__dirname, '../out/maintenance.js'), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, setTimeout, clearTimeout,
    require: name => name === 'node:fs' ? fileSystem : name.startsWith('.') ? require(path.resolve(path.dirname(filename), name)) : require(name) }, { filename });
  return module.exports;
}

test('maintenance holds its guard through the effect and removes it only after completion', async t => {
  const f = await fixture(t);
  const result = await maintenance.withCaptureMaintenance(f.store, async () => {
    const record = JSON.parse(fs.readFileSync(f.guard, 'utf8'));
    assert.equal(record.pid, process.pid); assert.equal(typeof record.token, 'string');
    return 'effect completed';
  });
  assert.equal(result, 'effect completed'); assert.equal(fs.existsSync(f.guard), false);
});

test('active producer leases and pending post captures prevent the maintenance effect', async t => {
  const f = await fixture(t), active = path.join(f.store.directory, 'active'), pending = path.join(f.store.directory, 'pending');
  fs.mkdirSync(active); fs.mkdirSync(pending);
  fs.writeFileSync(path.join(active, 'producer'), 'synthetic lease'); let calls = 0;
  assert.equal(await maintenance.captureQuiescent(f.store), false);
  await assert.rejects(maintenance.withCaptureMaintenance(f.store, async () => { calls++; }, 0), { code: 'captureInProgress' });
  assert.equal(calls, 0); assert.equal(fs.existsSync(f.guard), false);
  fs.unlinkSync(path.join(active, 'producer'));
  fs.writeFileSync(path.join(pending, 'capture.pre'), '{}');
  assert.equal(await maintenance.captureQuiescent(f.store), true);
  fs.writeFileSync(path.join(pending, 'capture.post'), '{}');
  assert.equal(await maintenance.captureQuiescent(f.store), false);
});

test('a read-only review window cannot start maintenance', async t => {
  const f = await fixture(t), reader = await ReviewStore.open(f.root);
  t.after(() => reader.close()); let called = false;
  await assert.rejects(maintenance.withCaptureMaintenance(reader, async () => { called = true; }), { code: 'readOnlyOwner' });
  assert.equal(called, false); assert.equal(fs.existsSync(f.guard), false);
});

test('a failed effect releases its own guard and does not poison the next operation', async t => {
  const f = await fixture(t);
  await assert.rejects(maintenance.withCaptureMaintenance(f.store, async () => { throw new Error('effect failed'); }), /effect failed/);
  assert.equal(fs.existsSync(f.guard), false);
  assert.equal(await maintenance.withCaptureMaintenance(f.store, async () => 42), 42);
});

test('loss of the maintenance token preserves the replacement guard and reports failure', async t => {
  const f = await fixture(t), replacement = { schemaVersion: 1, pid: process.pid, token: 'replacement-owner' };
  await assert.rejects(maintenance.withCaptureMaintenance(f.store, async () => {
    fs.writeFileSync(f.guard, JSON.stringify(replacement));
  }), { code: 'captureMaintenanceOwnerLost' });
  assert.deepEqual(JSON.parse(fs.readFileSync(f.guard, 'utf8')), replacement);
});

test('cleanup IO failure cannot return a successful maintenance result', async t => {
  const f = await fixture(t);
  const module = loadWithFs({ ...fs, promises: { ...fs.promises, async unlink(file) {
    if (file === f.guard) throw Object.assign(new Error('cleanup denied'), { code: 'EACCES' });
    return fs.promises.unlink(file);
  } } });
  await assert.rejects(module.withCaptureMaintenance(f.store, async () => 'effect completed'), { code: 'EACCES' });
  assert.equal(fs.existsSync(f.guard), true);
});

test('recovery never removes a guard owned by a live process', async t => {
  const f = await fixture(t), original = JSON.stringify({ schemaVersion: 1, pid: process.pid, token: 'live-owner' });
  fs.writeFileSync(f.guard, original);
  await assert.rejects(maintenance.recoverCaptureMaintenance(f.store), { code: 'captureMaintenanceStillAlive' });
  assert.equal(fs.readFileSync(f.guard, 'utf8'), original);
});

test('two recovery requests serialize and preserve a backup of a proven exited producer', async t => {
  const f = await fixture(t);
  const child = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  assert.equal(child.status, 0); assert(child.pid > 0);
  const original = JSON.stringify({ schemaVersion: 1, pid: child.pid, token: 'exited-producer' });
  fs.writeFileSync(f.guard, original);
  await Promise.all([maintenance.recoverCaptureMaintenance(f.store), maintenance.recoverCaptureMaintenance(f.store)]);
  assert.equal(fs.existsSync(f.guard), false);
  const backups = path.join(f.store.directory, 'review-migration-backups');
  const files = fs.readdirSync(backups).filter(name => name.startsWith('capture-maintenance-'));
  assert.equal(files.length, 1); assert.equal(fs.readFileSync(path.join(backups, files[0]), 'utf8'), original);
});

test('recovery waits for maintenance in this store instead of racing with its guard', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  const work = maintenance.withCaptureMaintenance(f.store, async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  let settled = false;
  const recovery = maintenance.recoverCaptureMaintenance(f.store).finally(() => { settled = true; });
  // Attach a rejection observer immediately; the assertion below must describe the race.
  recovery.catch(() => undefined);
  await new Promise(resolve => setTimeout(resolve, 30));
  try { assert.equal(settled, false); assert.equal(fs.existsSync(f.guard), true); }
  finally { release.resolve(); await work; }
  await recovery; assert.equal(fs.existsSync(f.guard), false);
});

function exitedPid() {
  const child = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  assert.equal(child.status, 0); assert(child.pid > 0);
  return child.pid;
}
function age(file, milliseconds) { const time = new Date(Date.now() - milliseconds); fs.utimesSync(file, time, time); }

test('an orphaned lease of an exited hook and its post marker stop blocking maintenance', async t => {
  const f = await fixture(t), active = path.join(f.store.directory, 'active'), pending = path.join(f.store.directory, 'pending');
  fs.mkdirSync(active); fs.mkdirSync(pending);
  const pid = exitedPid(), old = maintenance.STALE_PRODUCER_MS + 5000;
  const lease = path.join(active, pid + '-0123456789abcdef.json'), status = path.join(active, pid + '-status-fedcba9876543210.json');
  const truncated = path.join(active, pid + '-aaaaaaaaaaaaaaaa.json');
  fs.writeFileSync(lease, JSON.stringify({ schemaVersion: 1, operation: 'a'.repeat(32), pid }));
  fs.writeFileSync(status, JSON.stringify({ schemaVersion: 1, pid, diagnostic: true }));
  fs.writeFileSync(truncated, '');
  const post = path.join(pending, 'b'.repeat(32) + '.post'), pre = path.join(pending, 'b'.repeat(32) + '.json');
  fs.writeFileSync(post, '{}'); fs.writeFileSync(pre, '{"before":null,"schemaVersion":1,"generation":"g"}');
  for (const file of [lease, status, truncated, post, pre]) age(file, old);
  assert.equal(await maintenance.captureQuiescent(f.store), false);
  assert.equal(await maintenance.withCaptureMaintenance(f.store, async () => 'effect completed', 0), 'effect completed');
  assert.deepEqual(fs.readdirSync(active), []);
  // Only the in-progress marker is orphaned evidence; the prepared "pre" record is not this function's to judge.
  assert.deepEqual(fs.readdirSync(pending), ['b'.repeat(32) + '.json']);
  assert.equal(fs.existsSync(f.guard), false);
});

test('recent, live, mismatched and unknown leases keep blocking and are never removed', async t => {
  const old = maintenance.STALE_PRODUCER_MS + 5000;
  const cases = {
    'a lease newer than the hook timeout': f => { const file = path.join(f.active, exitedPid() + '-0123456789abcdef.json'); fs.writeFileSync(file, '{}'); return file; },
    'a lease of a live process': f => { const file = path.join(f.active, process.ppid + '-0123456789abcdef.json'); fs.writeFileSync(file, JSON.stringify({ pid: process.ppid })); age(file, old); return file; },
    'a lease of this process': f => { const file = path.join(f.active, process.pid + '-0123456789abcdef.json'); fs.writeFileSync(file, JSON.stringify({ pid: process.pid })); age(file, old); return file; },
    'a record naming another process': f => { const pid = exitedPid(), file = path.join(f.active, pid + '-0123456789abcdef.json'); fs.writeFileSync(file, JSON.stringify({ pid: pid + 1 })); age(file, old); return file; },
    'a name the hook does not create': f => { const file = path.join(f.active, exitedPid() + '-lease.json'); fs.writeFileSync(file, '{}'); age(file, old); return file; },
    'a link in the lease directory': f => { const file = path.join(f.active, exitedPid() + '-0123456789abcdef.json'); fs.symlinkSync(f.guard + '.target', file); return file; },
  };
  for (const [name, arrange] of Object.entries(cases)) await t.test(name, async sub => {
    if (name.includes('link') && process.platform === 'win32') { sub.skip('symlink creation needs privileges on Windows'); return; }
    const f = await fixture(sub); f.active = path.join(f.store.directory, 'active'); fs.mkdirSync(f.active);
    const pending = path.join(f.store.directory, 'pending'); fs.mkdirSync(pending);
    const post = path.join(pending, 'c'.repeat(32) + '.post'); fs.writeFileSync(post, '{}'); age(post, old);
    const file = arrange(f); let calls = 0;
    await assert.rejects(maintenance.withCaptureMaintenance(f.store, async () => { calls++; }, 0), { code: 'captureInProgress' });
    assert.equal(calls, 0); assert.equal(fs.lstatSync(file).isSymbolicLink() || fs.existsSync(file), true);
    // A marker is orphaned only when no lease at all remains.
    assert.equal(fs.existsSync(post), true); assert.equal(fs.existsSync(f.guard), false);
  });
});

test('post markers are kept while recent or unknown even with no lease present', async t => {
  const f = await fixture(t), pending = path.join(f.store.directory, 'pending'); fs.mkdirSync(pending);
  const recent = path.join(pending, 'd'.repeat(32) + '.post'), unknown = path.join(pending, 'capture.post');
  fs.writeFileSync(recent, '{}'); fs.writeFileSync(unknown, '{}'); age(unknown, maintenance.STALE_PRODUCER_MS + 5000);
  assert.equal(await maintenance.reapStaleProducers(f.store), 0);
  assert.deepEqual(fs.readdirSync(pending).sort(), ['capture.post', 'd'.repeat(32) + '.post']);
  await assert.rejects(maintenance.withCaptureMaintenance(f.store, async () => undefined, 0), { code: 'captureInProgress' });
});
