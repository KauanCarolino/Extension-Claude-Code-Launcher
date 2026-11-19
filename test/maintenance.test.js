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
