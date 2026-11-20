'use strict';

// Test-fixture evidence only. Never import this helper from extension runtime.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const MAX_BYTES = 256 * 1024;
const MAX_NODES = 2048;
const FIXTURES = new Set(['crlf.txt', 'created.txt', 'partial.txt', 'manual.txt']);
const COMMANDS = ['claude-code-launcher.acceptChange', 'claude-code-launcher.rejectChange',
  'claude-code-launcher.acceptAllChanges', 'claude-code-launcher.rejectAllChanges',
  'claude-code-launcher.showChanges', 'claude-code-launcher.compareInline'];
const BLOCKS = ['externalChange', 'unknownSnapshot', 'ambiguousContext', 'anotherWriter',
  'ownerLost', 'readOnlyOwner', 'releasedWriter', 'legacyProjectionPending', 'legacyWriterConflict'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const bool = value => typeof value === 'boolean' ? value : 'unknown';
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : 'unknown';
const category = (value, allowed) => allowed.includes(value) ? value : 'unknown';
const digest = value => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
function boundedShape(value) {
  const queue = [[value, 0]];
  let nodes = 0;
  while (queue.length) {
    const [item, depth] = queue.pop();
    if (++nodes > MAX_NODES || depth > 16) return false;
    if (item && typeof item === 'object') {
      const children = Object.values(item);
      if (children.length + queue.length + nodes > MAX_NODES) return false;
      for (const child of children) queue.push([child, depth + 1]);
    }
  }
  return true;
}
async function readFixture(workspace, filename, io) {
  let handle;
  try {
    let current = await io.realpath(workspace);
    for (const part of ['.claude', 'launcher-changes', filename]) {
      current = path.join(current, part);
      const stat = await io.lstat(current);
      if (stat.isSymbolicLink() || (part === filename ? !stat.isFile() : !stat.isDirectory())) return { read: 'unsafeType' };
    }
    handle = await io.open(current, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    const stat = await handle.stat();
    if (!stat.isFile()) return { read: 'unsafeType' };
    if (stat.size > MAX_BYTES) return { read: 'byteBudget' };
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const part = await handle.read(bytes, length, bytes.length - length, length);
      if (!part.bytesRead) break;
      length += part.bytesRead;
    }
    if (length > MAX_BYTES) return { read: 'byteBudget' };
    return { read: 'present', text: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)) };
  } catch (error) {
    return { read: error?.code === 'ENOENT' ? 'absent' : ['EACCES', 'EPERM'].includes(error?.code)
      ? 'permissionDenied' : error?.code === 'ERR_ENCODING_INVALID_ENCODED_DATA' ? 'invalidUtf8' : 'readUnavailable' };
  } finally { await handle?.close().catch(() => undefined); }
}
function pathRelation(first, second, root) {
  if (![first, second, root].every(value => typeof value === 'string')) return 'unknown';
  const paths = /^[A-Za-z]:[\\/]/.test(root) ? path.win32 : path.posix;
  const relative = paths.relative(root, second);
  if (relative === '..' || relative.startsWith('..' + paths.sep) || paths.isAbsolute(relative)) return 'outside';
  if (first === second) return 'exact';
  if (/^[A-Za-z]:/.test(first) && /^[A-Za-z]:/.test(second) && first.slice(1) === second.slice(1)
    && first[0].toLowerCase() === second[0].toLowerCase()) return 'driveOnly';
  return first.toLowerCase() === second.toLowerCase() ? 'caseOnly' : 'different';
}
function projectState(value, targetId, bufferHash, bufferBytes, identity) {
  if (!object(value)) return { shape: 'unknown' };
  if (!boundedShape(value)) return { shape: 'shapeBudget' };
  const known = ['schemaVersion', 'generation', 'contextId', 'reviews', 'statuses', 'operations', 'undo', 'legacyProjection', 'entryFingerprints'];
  const result = { schema: value.schemaVersion === 1 ? 'v1' : 'unknown',
    unknownFields: Object.keys(value).some(key => !known.includes(key)), generation: count(value.generation) };
  result.contextEqualsSyncRoot = typeof value.contextId === 'string' && typeof identity.syncRoot === 'string' ? value.contextId === identity.syncRoot : null;
  result.contextEqualsAsyncRoot = typeof value.contextId === 'string' && typeof identity.asyncRoot === 'string' ? value.contextId === identity.asyncRoot : null;
  if (value.schemaVersion !== 1 || !object(value.reviews) || !object(value.statuses) || !object(value.operations) || !Array.isArray(value.undo)) {
    return { ...result, shape: 'unknown' };
  }
  const lists = Object.values(value.reviews);
  if (lists.some(list => !Array.isArray(list))) return { ...result, shape: 'unknown' };
  const reviews = lists.flat();
  const matches = Object.entries(value.reviews).flatMap(([key, list]) => list
    .filter(item => object(item) && Array.isArray(item.ids) && item.ids.includes(targetId)).map(item => ({ key, item })));
  Object.assign(result, { shape: 'known', fileCount: lists.length, reviewCount: reviews.length,
    statusCount: Object.keys(value.statuses).length, operationCount: Object.keys(value.operations).length,
    undoCount: value.undo.length, targetReviewCount: matches.length,
    targetStatus: Object.hasOwn(value.statuses, targetId) ? category(value.statuses[targetId], ['accepted', 'rejected', 'mixed']) : 'absent' });
  if (matches.length !== 1) return result;
  const review = matches[0].item, expected = object(review.expected) ? review.expected : {};
  const ref = object(expected.contentRef) ? expected.contentRef : {};
  const refValid = ref.algorithm === 'sha256' && typeof ref.digest === 'string' && /^[a-f0-9]{64}$/.test(ref.digest);
  const contentKeys = ['kind', 'contentRef', 'byteLength', 'encoding', 'bom', 'eol', 'finalNewline', 'reason'];
  result.targetReview = { phase: category(review.phase, ['pending', 'blocked', 'complete']),
    keyToDocument: pathRelation(matches[0].key, identity.documentFsPath, identity.asyncRoot),
    unknownFields: Object.keys(review).some(key => !['file', 'revision', 'ids', 'firstId', 'lastId', 'base', 'expected', 'phase', 'accepted', 'rejected', 'reason', 'blockReason', 'resolution'].includes(key)),
    blockReason: review.blockReason === undefined ? 'absent' : category(review.blockReason, BLOCKS), revision: count(review.revision),
    baseKind: category(review.base?.kind, ['text', 'absent', 'unavailable']),
    expectedKind: category(expected.kind, ['text', 'absent', 'unavailable']),
    expectedUnknownFields: Object.keys(expected).some(key => !contentKeys.includes(key)) || Object.keys(ref).some(key => !['algorithm', 'digest'].includes(key)),
    expectedEncoding: category(expected.encoding, ['utf8']), expectedEol: category(expected.eol, ['CRLF', 'LF', 'mixed', 'none']),
    expectedBom: bool(expected.bom), expectedFinalNewline: bool(expected.finalNewline),
    expectedDigestMatchesBuffer: expected.kind === 'text' && refValid && bufferHash ? ref.digest === bufferHash : null,
    expectedByteLengthMatchesBuffer: expected.kind === 'text' && Number.isSafeInteger(expected.byteLength) && bufferBytes !== null
      ? expected.byteLength === bufferBytes : null };
  return result;
}
function projectLog(text, targetId) {
  const lines = text.split('\n').filter(line => line.trim());
  if (lines.length > 128) return { shape: 'recordBudget' };
  const result = { lines: lines.length, parsed: 0, invalidJson: 0, unsupportedSchema: 0, unknownFields: 0, targetEntries: 0 };
  for (const line of lines) {
    let value;
    try { value = JSON.parse(line); } catch { result.invalidJson += 1; continue; }
    if (!boundedShape(value)) return { ...result, shape: 'shapeBudget' };
    if (!object(value) || value.schemaVersion !== undefined && value.schemaVersion !== 1) { result.unsupportedSchema += 1; continue; }
    if (Object.keys(value).some(key => !['schemaVersion', 'id', 'time', 'file', 'tool', 'session', 'toolUseId', 'transcript', 'reason', 'before', 'after'].includes(key))) result.unknownFields += 1;
    result.parsed += 1;
    if (value.id === targetId) result.targetEntries += 1;
  }
  return { ...result, shape: 'known' };
}
async function collectReviewFailureDiagnostics(context, io = fs) {
  if (!FIXTURES.has(context.fixture)) return { stage: 'codelens-timeout', fixture: 'unknown', collection: 'unsupportedFixture' };
  const text = typeof context.documentText === 'string' && Buffer.byteLength(context.documentText, 'utf8') <= MAX_BYTES ? context.documentText : null;
  const bufferHash = text === null ? null : digest(text), bufferBytes = text === null ? null : Buffer.byteLength(text, 'utf8');
  const document = context.document || {}, lensCommands = Array.isArray(context.lensCommands) ? context.lensCommands.slice(0, 128) : [];
  let asyncRoot;
  try { asyncRoot = await io.realpath(context.workspace); } catch { /* Only a boolean comparison may leave this scope. */ }
  const result = { stage: 'codelens-timeout', fixture: context.fixture, source: 'synthetic bounded projection; not runtime state validation or proof that controller/store opened',
    inlineEnabled: bool(context.inlineEnabled), trusted: bool(context.trusted),
    syncRootEqualsAsyncRoot: typeof context.workspaceSyncRealpath === 'string' && typeof asyncRoot === 'string' ? context.workspaceSyncRealpath === asyncRoot : null,
    document: { scheme: category(document.scheme, ['file', 'untitled', 'vscode-notebook-cell']),
      eol: category(document.eol, [1, 2]), dirty: bool(document.dirty), closed: bool(document.closed),
      lineCount: count(document.lineCount), length: text === null ? 'unknown' : text.length,
      sha256: bufferHash, textCoverage: text === null ? 'budgetOrUnknown' : 'complete',
      uriEqualsRequested: bool(document.uriEqualsRequested), editorVisible: bool(document.editorVisible) },
    lenses: { count: count(context.lensCount), commands: Object.fromEntries(COMMANDS.map(command => [command, lensCommands.filter(value => value === command).length])),
      unknownCommandCount: lensCommands.filter(value => !COMMANDS.includes(value)).length,
      coverage: Array.isArray(context.lensCommands) && context.lensCommands.length <= 128 ? 'complete' : 'partial' } };
  for (const [key, name] of [['canonicalState', 'review-state.v1.json'], ['log', 'log.jsonl']]) {
    const read = await readFixture(context.workspace, name, io);
    result[key] = { read: read.read };
    if (read.read !== 'present') continue;
    if (key === 'log') Object.assign(result[key], projectLog(read.text, 'host-' + context.fixture));
    else {
      try { Object.assign(result[key], projectState(JSON.parse(read.text), 'host-' + context.fixture, bufferHash, bufferBytes,
        { syncRoot: context.workspaceSyncRealpath, asyncRoot, documentFsPath: context.documentFsPath })); }
      catch { result[key].shape = 'invalidJson'; }
    }
  }
  return result;
}
module.exports = { collectReviewFailureDiagnostics, projectState, MAX_BYTES };
