'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { findExecutable } = require('../out/node-runtime.js');

test('the real PATH of the test process resolves node to an existing executable', async () => {
  const found = await findExecutable('node', { env: process.env, platform: process.platform });
  assert.equal(typeof found, 'string'); assert.equal(path.isAbsolute(found), true);
});

test('POSIX lookup follows PATH order and ignores relative and empty entries', async () => {
  const seen = [];
  const found = await findExecutable('node', { platform: 'linux', env: { PATH: '.::bin:/opt/missing:/usr/local/bin:/usr/bin' },
    isExecutable: async file => { seen.push(file); return file === '/usr/local/bin/node' || file === '/usr/bin/node'; } });
  assert.equal(found, '/usr/local/bin/node');
  assert.deepEqual(seen, ['/opt/missing/node', '/usr/local/bin/node']);
});

test('Windows lookup uses the case-insensitive Path variable and PATHEXT', async () => {
  const seen = [];
  const found = await findExecutable('node', { platform: 'win32', env: { Path: 'C:\\Tools;relative;C:\\Program Files\\nodejs', PATHEXT: '.COM;.EXE' },
    isExecutable: async file => { seen.push(file); return file === 'C:\\Program Files\\nodejs\\node.EXE'; } });
  assert.equal(found, 'C:\\Program Files\\nodejs\\node.EXE');
  assert.deepEqual(seen, ['C:\\Tools\\node.COM', 'C:\\Tools\\node.EXE', 'C:\\Program Files\\nodejs\\node.COM', 'C:\\Program Files\\nodejs\\node.EXE']);
});

test('absence, an empty PATH and names with separators yield no executable and no lookup outside PATH', async () => {
  const seen = [], isExecutable = async file => { seen.push(file); return false; };
  assert.equal(await findExecutable('node', { platform: 'linux', env: { PATH: '/usr/bin' }, isExecutable }), undefined);
  assert.equal(await findExecutable('node', { platform: 'linux', env: {}, isExecutable }), undefined);
  for (const name of ['../node', 'bin/node', 'node;calc', '', 'a'.repeat(65)]) {
    assert.equal(await findExecutable(name, { platform: 'linux', env: { PATH: '/usr/bin' }, isExecutable: async () => true }), undefined);
  }
  assert.deepEqual(seen, ['/usr/bin/node']);
});
