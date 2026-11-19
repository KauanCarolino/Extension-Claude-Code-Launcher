'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { collectReviewFailureDiagnostics: collect, projectState, MAX_BYTES } = require('../scripts/host-state-diagnostics.cjs');
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
function state(root, text = 'after\r\nline\r\n') {
  const file = path.join(root, 'crlf.txt');
  return { schemaVersion: 1, generation: 2, contextId: root, statuses: {}, operations: {}, undo: [], legacyProjection: {}, reviews: {
    [file]: [{ file, revision: 1, ids: ['host-crlf.txt'], firstId: 'host-crlf.txt', lastId: 'host-crlf.txt', phase: 'pending',
      base: { kind: 'text' }, expected: { kind: 'text', contentRef: { algorithm: 'sha256', digest: sha(text) },
        byteLength: Buffer.byteLength(text), encoding: 'utf8', bom: false, eol: 'CRLF', finalNewline: true },
      accepted: 0, rejected: 0, reason: 'private-marker' }],
  } };
}
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-host-diagnostics-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, '.claude/launcher-changes'); await fs.mkdir(directory, { recursive: true });
  const context = { workspace: root, workspaceSyncRealpath: root, fixture: 'crlf.txt', documentFsPath: path.join(root, 'crlf.txt'),
    inlineEnabled: true, trusted: true, documentText: 'after\r\nline\r\n',
    document: { scheme: 'file', eol: 2, dirty: false, closed: false, lineCount: 3, uriEqualsRequested: true, editorVisible: true },
    lensCount: 0, lensCommands: [] };
  const put = (name, text) => fs.writeFile(path.join(directory, name), text);
  await put('review-state.v1.json', JSON.stringify(state(root)));
  await put('log.jsonl', JSON.stringify({ id: 'host-crlf.txt', file: 'private-marker', reason: 'private-marker' }) + '\n');
  return { root, context, put };
}

test('fixture diagnostics distinguish persisted review and buffer without exporting paths or source content', async t => {
  const f = await fixture(t), result = await collect(f.context);
  assert.equal(result.stage, 'codelens-timeout'); assert.equal(result.canonicalState.read, 'present');
  assert.equal(result.canonicalState.targetReviewCount, 1); assert.equal(result.canonicalState.targetReview.phase, 'pending');
  assert.equal(result.canonicalState.targetReview.expectedDigestMatchesBuffer, true);
  assert.equal(result.canonicalState.targetReview.expectedByteLengthMatchesBuffer, true);
  assert.equal(result.canonicalState.targetReview.expectedEol, 'CRLF');
  assert.equal(result.canonicalState.contextEqualsSyncRoot, true); assert.equal(result.canonicalState.contextEqualsAsyncRoot, true);
  assert.equal(result.canonicalState.targetReview.keyToDocument, 'exact'); assert.equal(result.log.targetEntries, 1);
  assert.equal(result.document.sha256, sha(f.context.documentText));
  for (const marker of [f.root, 'private-marker', f.context.documentText]) assert.equal(JSON.stringify(result).includes(marker), false);
  assert.equal((await collect({ ...f.context, documentText: 'different' })).canonicalState.targetReview.expectedDigestMatchesBuffer, false);
});

test('unknown payloads and enums are recorded conservatively without echoing private values', async t => {
  const f = await fixture(t), value = state(f.root);
  value.privateField = 'private-marker'; value.reviews[path.join(f.root, 'crlf.txt')][0].blockReason = 'private-marker';
  value.reviews[path.join(f.root, 'crlf.txt')][0].phase = 'private-marker';
  await f.put('review-state.v1.json', JSON.stringify(value));
  await f.put('log.jsonl', '{invalid-private-marker}\n' + JSON.stringify({ schemaVersion: 999, id: 'host-crlf.txt' }) + '\n');
  const result = await collect({ ...f.context, lensCommands: ['private-marker'], lensCount: 1 });
  assert.equal(result.canonicalState.unknownFields, true); assert.equal(result.canonicalState.targetReview.phase, 'unknown');
  assert.equal(result.canonicalState.targetReview.blockReason, 'unknown'); assert.equal(result.lenses.unknownCommandCount, 1);
  assert.equal(result.log.invalidJson, 1); assert.equal(result.log.unsupportedSchema, 1);
  assert.equal(JSON.stringify(result).includes('private-marker'), false);
  await f.put('review-state.v1.json', '{"schemaVersion":999}');
  assert.equal((await collect(f.context)).canonicalState.schema, 'unknown');
  assert.equal((await collect({ ...f.context, fixture: 'private-marker' })).fixture, 'unknown');
});

test('byte, shape and record budgets plus read/type failures remain bounded and redacted', async t => {
  const f = await fixture(t);
  await f.put('review-state.v1.json', ' '.repeat(MAX_BYTES + 1));
  assert.equal((await collect(f.context)).canonicalState.read, 'byteBudget');
  await f.put('review-state.v1.json', JSON.stringify({ nested: Array(2050).fill(1) }));
  assert.equal((await collect(f.context)).canonicalState.shape, 'shapeBudget');
  await f.put('log.jsonl', '{}\n'.repeat(129));
  assert.equal((await collect(f.context)).log.shape, 'recordBudget');
  const denied = await collect(f.context, { ...fs, realpath: async () => { throw Object.assign(new Error('private-marker'), { code: 'EACCES' }); } });
  assert.equal(denied.canonicalState.read, 'permissionDenied'); assert.equal(JSON.stringify(denied).includes('private-marker'), false);
  let opens = 0;
  const unsafe = await collect(f.context, { ...fs, lstat: async () => ({ isSymbolicLink: () => true }), open: async () => { opens += 1; } });
  assert.equal(unsafe.canonicalState.read, 'unsafeType'); assert.equal(opens, 0);
});

test('Windows identity diagnosis distinguishes drive-only spelling without conflating segments or outside roots', () => {
  const root = String.raw`C:\Fixture`, file = String.raw`C:\Fixture\crlf.txt`, value = state(root);
  const review = Object.values(value.reviews)[0]; value.reviews = { [file]: review };
  const identity = { syncRoot: root, asyncRoot: root, documentFsPath: String.raw`c:\Fixture\crlf.txt` };
  assert.equal(projectState(value, 'host-crlf.txt', null, null, identity).targetReview.keyToDocument, 'driveOnly');
  assert.equal(projectState(value, 'host-crlf.txt', null, null, { ...identity, documentFsPath: String.raw`c:\fixture\CRLF.txt` }).targetReview.keyToDocument, 'caseOnly');
  assert.equal(projectState(value, 'host-crlf.txt', null, null, { ...identity, documentFsPath: String.raw`D:\Fixture\crlf.txt` }).targetReview.keyToDocument, 'outside');
  assert.equal(projectState(value, 'host-crlf.txt', null, null, { ...identity, documentFsPath: String.raw`C:\Fixture-sibling\crlf.txt` }).targetReview.keyToDocument, 'outside');
});
