'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PreferenceManager } = require('../out/preferences.js');

function fixture(initial = {}) {
  const values = new Map(Object.entries(initial)), writes = [];
  let records = [], persistFailure = false, writeFailure;
  const adapter = {
    load: () => structuredClone(records),
    async persist(next) { if (persistFailure) throw new Error('persist failed'); records = structuredClone(next); },
    read: (section, key, target) => values.get([section, key, target].join('.')),
    async write(section, key, value, target) {
      if (writeFailure === key) throw new Error('write failed');
      writes.push({ section, key, value, target }); values.set([section, key, target].join('.'), value);
    },
  };
  return { values, writes, manager: scope => new PreferenceManager(adapter, scope),
    get records() { return structuredClone(records); },
    set persistFailure(value) { persistFailure = value; }, set writeFailure(value) { writeFailure = value; } };
}

test('workspace B opting out cannot restore global preferences owned by workspace A', async () => {
  const f = fixture({ 'claude.location.global': 'sidebar' }), a = f.manager('A'), b = f.manager('B');
  await a.set('claude', 'location', 'panel', 'global');
  await b.restore();
  assert.equal(f.values.get('claude.location.global'), 'panel'); assert.equal(f.records.length, 1);
  await a.restore();
  assert.equal(f.values.get('claude.location.global'), 'sidebar'); assert.equal(f.records.length, 0);
});

test('manual edit relinquishes ownership across reload and a later opt-out preserves it', async () => {
  const f = fixture({ 'claude.location.global': 'sidebar' }); let manager = f.manager('A');
  await manager.set('claude', 'location', 'panel', 'global');
  f.values.set('claude.location.global', 'manual');
  await manager.set('claude', 'location', 'panel', 'global');
  manager = f.manager('A'); await manager.set('claude', 'location', 'panel', 'global');
  assert.equal(f.writes.length, 1); assert.equal(f.records[0].relinquished, true);
  await manager.restore(); assert.equal(f.values.get('claude.location.global'), 'manual');
  await manager.set('claude', 'location', 'panel', 'global'); await manager.restore();
  assert.equal(f.values.get('claude.location.global'), 'manual');
});

test('matching values are observed without writes; a later owned edit becomes restorable', async () => {
  const f = fixture({ 'workbench.groups.global': { old: true } }), manager = f.manager('A');
  await manager.set('workbench', 'groups', { old: true }, 'global');
  assert.equal(f.writes.length, 0); assert.equal(f.records[0].observedOnly, true);
  await manager.set('workbench', 'groups', { old: true, new: true }, 'global');
  assert.equal(f.records[0].observedOnly, false);
  await manager.restore(); assert.deepEqual(f.values.get('workbench.groups.global'), { old: true });
});

test('failure to persist ownership prevents modifying the preference', async () => {
  const f = fixture({ 's.k.global': 'before' }), manager = f.manager('A');
  f.persistFailure = true;
  await assert.rejects(manager.set('s', 'k', 'after', 'global'), /persist failed/);
  assert.equal(f.writes.length, 0); assert.equal(f.values.get('s.k.global'), 'before');
});

test('partial restoration retains the failed record and unrelated contexts for retry', async () => {
  const f = fixture({ 's.a.global': 'oldA', 's.b.workspace': 'oldB', 's.c.global': 'oldC' });
  const a = f.manager('A'), b = f.manager('B');
  await a.set('s', 'a', 'newA', 'global'); await a.set('s', 'b', 'newB', 'workspace');
  await b.set('s', 'c', 'newC', 'global');
  f.writeFailure = 'b'; await assert.rejects(a.restore(), /write failed/);
  assert.equal(f.values.get('s.a.global'), 'oldA'); assert.equal(f.values.get('s.b.workspace'), 'newB');
  assert.deepEqual(f.records.map(record => record.key), ['b', 'c']);
  f.writeFailure = undefined; await a.restore();
  assert.equal(f.values.get('s.b.workspace'), 'oldB');
  assert.deepEqual(f.records.map(record => record.scope), ['B']);
});

test('a failed final restore commit does not overwrite a newer manual choice on retry', async () => {
  const f = fixture({ 's.k.global': 'old' }), manager = f.manager('A');
  await manager.set('s', 'k', 'new', 'global');
  f.persistFailure = true; await assert.rejects(manager.restore(), /persist failed/);
  assert.equal(f.values.get('s.k.global'), 'old');
  f.values.set('s.k.global', 'manual'); f.persistFailure = false;
  await manager.restore(); assert.equal(f.values.get('s.k.global'), 'manual');
  assert.equal(f.records.length, 0);
});
