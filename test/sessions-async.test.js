'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
function fixture(t, fileSystem = fs) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-async-sessions-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.resolve(__dirname, '../out/sessions.js'), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, Buffer,
    process: { env: { CLAUDE_CONFIG_DIR: directory } },
    require: name => name === 'fs' ? fileSystem : name.startsWith('./') ? require(path.join(path.dirname(filename), name)) : require(name) }, { filename });
  const api = module.exports;
  const write = (workspace, number, title, time = number + 1000) => {
    const dir = api.sessionsDir(workspace); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, id(number) + '.jsonl');
    fs.writeFileSync(file, JSON.stringify(title === null ? { type: 'system' }
      : { type: 'user', message: { content: title } }) + '\n');
    fs.utimesSync(file, time, time); return file;
  };
  return { api, write };
}

test('async listing preserves ordered titles and excludes empty and unrelated files', async t => {
  const f = fixture(t), workspace = '/synthetic/order';
  f.write(workspace, 1, 'first'); f.write(workspace, 2, 'second'); f.write(workspace, 3, null);
  fs.writeFileSync(path.join(f.api.sessionsDir(workspace), 'unrelated.jsonl'), '{}');
  const result = await f.api.listSessionsAsync(workspace, 15);
  assert.deepEqual(Array.from(result.sessions, item => item.title), ['second', 'first']);
  assert.equal(result.partial, false); assert.equal(result.scanned, 3); assert.equal(result.total, 3);
  assert.equal(JSON.stringify(result.sessions), JSON.stringify(f.api.listSessions(workspace, 15)));
});

test('title cache is isolated by path and invalidated by size even with identical mtime', async t => {
  const f = fixture(t), a = '/synthetic/a', b = '/synthetic/b';
  const file = f.write(a, 1, 'title A', 1000); f.write(b, 1, 'title B', 1000);
  assert.equal((await f.api.listSessionsAsync(a, 15)).sessions[0].title, 'title A');
  assert.equal((await f.api.listSessionsAsync(b, 15)).sessions[0].title, 'title B');
  fs.appendFileSync(file, JSON.stringify({ type: 'custom-title', customTitle: 'changed title' }) + '\n');
  fs.utimesSync(file, 1000, 1000);
  assert.equal((await f.api.listSessionsAsync(a, 15)).sessions[0].title, 'changed title');
});

test('cancellation stops after the active bounded stat batch and avoids reading titles', async t => {
  let calls = 0, opens = 0, active = 0, maximum = 0;
  const fileSystem = { ...fs, promises: { ...fs.promises,
    async lstat(file) {
      calls++; maximum = Math.max(maximum, ++active);
      await new Promise(resolve => setImmediate(resolve));
      try { return await fs.promises.lstat(file); } finally { active--; }
    },
    async open(...args) { opens++; return fs.promises.open(...args); },
  } };
  const f = fixture(t, fileSystem), workspace = '/synthetic/cancel';
  for (let n = 0; n < 30; n++) f.write(workspace, n, 'session ' + n);
  const result = await f.api.listSessionsAsync(workspace, 15, () => calls >= 8);
  assert.equal(calls, 8); assert(maximum > 1 && maximum <= 8); assert.equal(opens, 0);
  assert.equal(result.sessions.length, 0);
});

test('title scan budget is explicit and does not claim complete coverage', async t => {
  const f = fixture(t), workspace = '/synthetic/budget';
  f.write(workspace, 0, 'old valid conversation');
  for (let n = 1; n <= 280; n++) f.write(workspace, n, null);
  const result = await f.api.listSessionsAsync(workspace, 15);
  assert.equal(result.partial, true); assert.equal(result.scanned, 256); assert.equal(result.sessions.length, 0);
});

test('missing session directory and pre-cancelled listing are safe empty results', async t => {
  const f = fixture(t);
  assert.equal((await f.api.listSessionsAsync('/absent', 15)).sessions.length, 0);
  f.write('/present', 1, 'session');
  const result = await f.api.listSessionsAsync('/present', 15, () => true);
  assert.equal(result.scanned, 0); assert.equal(result.sessions.length, 0);
});

test('an inaccessible directory is reported as partial instead of an empty complete history', async t => {
  const fileSystem = { ...fs, promises: { ...fs.promises, async readdir() {
    throw Object.assign(new Error('denied'), { code: 'EACCES' });
  } } };
  const f = fixture(t, fileSystem);
  const result = await f.api.listSessionsAsync('/synthetic/denied', 15);
  assert.equal(result.partial, true); assert.equal(result.sessions.length, 0);
});

test('transient read failures do not poison the title cache for an unchanged file', async t => {
  let fail = true;
  const fileSystem = { ...fs, promises: { ...fs.promises, async open(...args) {
    if (fail) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return fs.promises.open(...args);
  } } };
  const f = fixture(t, fileSystem), workspace = '/synthetic/retry'; f.write(workspace, 1, 'recovered title');
  const failed = await f.api.listSessionsAsync(workspace, 15);
  assert.equal(failed.partial, true); assert.equal(failed.sessions.length, 0);
  fail = false;
  const recovered = await f.api.listSessionsAsync(workspace, 15);
  assert.equal(recovered.sessions[0]?.title, 'recovered title'); assert.equal(recovered.partial, false);
});

test('aliases list every title the official tab may show, newest first, bounded and identical in both listings', async t => {
  const f = fixture(t), workspace = '/synthetic/aliases';
  const file = f.write(workspace, 1, 'pode ajustar o painel?\n');
  const line = value => fs.appendFileSync(file, JSON.stringify(value) + '\n');
  line({ type: 'ai-title', aiTitle: 'Ajuste inicial' });
  line({ type: 'ai-title', aiTitle: 'Ajustar o painel de mudanças por conversa' });
  line({ type: 'ai-title', aiTitle: 'Ajuste inicial' });
  line({ type: 'summary', summary: 'x'.repeat(300) });
  fs.utimesSync(file, 1001, 1001);
  let [session] = (await f.api.listSessionsAsync(workspace, 15)).sessions;
  assert.equal(session.title, 'Ajuste inicial');
  assert.deepEqual(Array.from(session.aliases), ['x'.repeat(200), 'Ajuste inicial', 'Ajustar o painel de mudanças por conversa', 'pode ajustar o painel?']);
  assert.equal(JSON.stringify(f.api.listSessions(workspace, 15)), JSON.stringify((await f.api.listSessionsAsync(workspace, 15)).sessions));
  line({ type: 'custom-title', customTitle: 'Meu título' });
  for (let index = 0; index < 12; index++) line({ type: 'ai-title', aiTitle: 'gerado ' + index });
  fs.utimesSync(file, 1002, 1002);
  [session] = (await f.api.listSessionsAsync(workspace, 15)).sessions;
  assert.equal(session.title, 'Meu título');
  assert.equal(session.aliases.length, 8);
  assert.equal(session.aliases[0], 'gerado 11');
});
