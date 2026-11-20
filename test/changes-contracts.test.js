'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { fixture, entry, writeLog, until, OUT } = require('./helpers/changes-fixture.cjs');
const { activeReview } = require(path.join(OUT, 'review.js'));
const { diffLines, groupsOf, groupSignature } = require(path.join(OUT, 'diff.js'));
const { ReviewResultError, summarizeReviewResults, blockedReviewResult } = require(path.join(OUT, 'review-results.js'));
const sessions = require(path.join(OUT, 'sessions.js'));
const snapshot = text => text === undefined ? { exists: false, text: null, large: false } : { exists: true, text, large: false };
const captured = (f, id, name, before = 'before', after = 'after') => ({ ...entry(f.root, id, name), before: snapshot(before), after: snapshot(after) });
function gate() { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; }
async function bounded(promise) { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('fixture checkpoint not reached')), 3000); })]); } finally { clearTimeout(timer); } }
async function seed(f, entries) {
  for (const item of entries) { if (item.after.exists) { fs.mkdirSync(path.dirname(item.file), { recursive: true }); fs.writeFileSync(item.file, item.after.text); } }
  writeLog(f, entries); const store = await f.store(); f.controller.entries = await f.controller.loadEntries(); return store;
}
function published(controller) { let result; controller.post({ postMessage: async value => { result = value; } }, false); return result; }
function metadataEntry(f, id, name = id + '.txt', transcriptName = 'shared.jsonl') {
  const directory = path.join(f.root, 'sessions'); fs.mkdirSync(directory, { recursive: true });
  const transcript = path.join(directory, transcriptName); fs.writeFileSync(transcript, '{}\n');
  return { ...captured(f, id, name), transcript, toolUseId: 'tool-' + id, session: 'synthetic-session' };
}
function metadataFor(ids) { return { reasons: new Map(ids.map(id => [id, 'Synthetic reason'])), requests: new Map(ids.map(id => [id, { id: 'synthetic-request', text: 'Synthetic request' }])) }; }

test('fixture root matches native async identity while Windows short-name aliases remain subject to the real scope guard', async t => {
  const f = fixture(t);
  assert.equal(f.root, fs.realpathSync.native(f.temporaryRoot)); assert.equal(await fs.promises.realpath(f.root), f.root);
  t.diagnostic(JSON.stringify({ nativeAsyncRootMatch: true, legacyEqualsNative: fs.realpathSync(f.temporaryRoot) === f.root }));
  // Run the actual guard with Win32 paths and explicit native-alias IO, even on
  // another OS. This is an adapter regression, not a claim of Windows execution.
  const filename = path.join(OUT, 'history.js'), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports,
    require: id => id === 'node:path' ? path.win32 : require(id) }, { filename });
  const shortRoot = String.raw`C:\Users\RUNNER~1\AppData\Local\Temp\LauncherFixture`;
  const nativeRoot = String.raw`C:\Users\runneradmin\AppData\Local\Temp\LauncherFixture`, file = path.win32.join(nativeRoot, 'SubDir', 'Case.txt');
  let reads = 0;
  const io = { async realpath(value) { reads++; return value === shortRoot ? nativeRoot : value.replace(/^[a-z]:/, drive => drive.toUpperCase()); } };
  const before = await module.exports.assessResourceScope(file, shortRoot, io);
  assert.equal(before.allowed, false); assert.equal(before.code, 'resourceOutsideScope'); assert.equal(reads, 0, 'lexically different namespaces are rejected before native IO');
  const native = await module.exports.assessResourceScope(file, nativeRoot, io);
  assert.equal(native.allowed, true); assert.equal(native.canonicalPath, file, 'directory and filename case must remain unchanged');
  assert.equal((await module.exports.assessResourceScope(file, nativeRoot.replace(/^C:/, 'c:'), io)).allowed, true, 'drive-letter case alone is already supported by the guard');
  for (const outside of [path.win32.join(nativeRoot + '-sibling', 'Case.txt'), file.replace(/^C:/, 'D:')]) {
    assert.equal((await module.exports.assessResourceScope(outside, nativeRoot, io)).allowed, false);
  }
});

test('controller projects each captured segment and observes a human buffer without rewriting its canonical decision', async t => {
  const f = fixture(t), before = 'one\ntwo\nthree\n', first = 'ONE\ntwo\nthree\n', human = 'ONE\nHUMAN\nthree\n', after = 'CHANGED\nHUMAN\nTHREE\n';
  const a = captured(f, 'a', 'same.txt', before, first), b = captured(f, 'b', 'same.txt', human, after);
  const store = await seed(f, [a, b]), document = f.openDocument(b.file);
  const group = groupsOf(diffLines(human, after).lines)[0];
  await f.controller.executeReviewDecision(b.file, { action: 'accept', index: 0, signature: groupSignature(group) });
  let state = published(f.controller), older = state.entries.find(item => item.id === 'a'), current = state.entries.find(item => item.id === 'b');
  assert.equal(older.phase, 'blocked'); assert.equal(older.acceptedParts, 0); assert.match(older.blockedReason, /mudou/);
  assert.equal(current.phase, 'pending'); assert.equal(current.acceptedParts, 1); assert.equal(current.pendingParts, 1);
  document.content += 'MANUAL'; document.isDirty = true; f.documentHandlers.forEach(handler => handler({ document }));
  state = published(f.controller); current = state.entries.find(item => item.id === 'b');
  assert.equal(current.phase, 'blocked'); assert.equal(current.acceptedParts, 1); assert.match(current.blockedReason, /mudou/);
  assert.equal(state.files[0].phase, 'blocked'); assert.equal(state.files[0].canAcceptCurrent, true);
  assert.equal(activeReview(store.get(), b.file).phase, 'pending'); assert.equal(document.content, after + 'MANUAL');
  document.content = after; document.isDirty = false; f.documentHandlers.forEach(handler => handler({ document }));
  fs.writeFileSync(path.join(f.dir, 'purge-state.v1.json'), JSON.stringify({ schemaVersion: 1, phase: 'prepared', id: '12345678-1234-4234-8234-123456789abc', startedAt: new Date().toISOString() }));
  f.controller.entries = await f.controller.loadEntries(); state = published(f.controller);
  assert.equal(state.files[0].phase, 'blocked'); assert.equal(state.entries.find(item => item.id === 'b').phase, 'blocked');
  assert.match(state.entries.find(item => item.id === 'b').blockedReason, /limpeza interrompida/);
  await assert.rejects(f.controller.executeReviewDecision(b.file, { action: 'reject' }), error => error.result.reason === 'purgeNeedsRecovery');
  assert.equal(fs.readFileSync(b.file, 'utf8'), after); assert.equal(store.get().statuses.b, undefined);
});

test('review comparison uses the partially accepted baseline and live resource while historical comparison retains original snapshots', async t => {
  const f = fixture(t), before = 'one\nstable\nthree\n', after = 'ONE\nstable\nTHREE\n';
  const item = captured(f, 'comparison', 'comparison.txt', before, after), store = await seed(f, [item]), document = f.openDocument(item.file);
  const group = groupsOf(diffLines(before, after).lines)[0];
  await f.controller.executeReviewDecision(item.file, { action: 'accept', index: 0, signature: groupSignature(group) });
  const baseline = 'ONE\nstable\nthree\n'; assert.equal(activeReview(store.get(), item.file).base.text, baseline);
  document.content = after + 'HUMAN UNSAVED\n'; document.isDirty = true; document.version++;
  f.documentHandlers.forEach(handler => handler({ document }));
  const canonical = fs.readFileSync(path.join(f.dir, 'review-state.v1.json')), applied = f.editor.applyCalls.length, saved = f.editor.saveCalls.length;
  await f.controller.compareReview(item.file);
  const current = f.executedCommands.filter(([command]) => command === 'vscode.diff').at(-1);
  assert(current); assert.equal(current[1].scheme, 'claude-launcher-change'); assert.match(current[1].path, /^\/review\//);
  assert.equal(f.controller.provideTextDocumentContent(current[1]), baseline);
  assert.equal(current[2].scheme, 'file'); assert.equal(current[2].fsPath, item.file);
  assert.equal(f.vscode.workspace.textDocuments.find(value => value.uri.toString() === current[2].toString()).getText(), after + 'HUMAN UNSAVED\n');
  assert.match(current[3], /revisão pendente ↔ arquivo atual/);
  await f.controller.compare(item.id);
  const historical = f.executedCommands.filter(([command]) => command === 'vscode.diff').at(-1);
  assert.equal(historical[1].scheme, 'claude-launcher-change'); assert.equal(historical[2].scheme, 'claude-launcher-change');
  assert.equal(f.controller.provideTextDocumentContent(historical[1]), before); assert.equal(f.controller.provideTextDocumentContent(historical[2]), after);
  assert.match(historical[3], /antes ↔ depois/); assert.notEqual(historical[3], current[3]);
  assert.notEqual(historical[1].toString(), current[1].toString()); assert.notEqual(historical[2].toString(), current[2].toString());
  assert.deepEqual(fs.readFileSync(path.join(f.dir, 'review-state.v1.json')), canonical);
  assert.equal(fs.readFileSync(item.file, 'utf8'), after); assert.equal(document.getText(), after + 'HUMAN UNSAVED\n'); assert.equal(document.isDirty, true);
  assert.equal(f.editor.applyCalls.length, applied); assert.equal(f.editor.saveCalls.length, saved); assert.equal(store.get().statuses[item.id], undefined);
});

test('controller reports save=false as an applied buffer and recovers the prior rejection instead of accepting a new request', async t => {
  const f = fixture(t), item = captured(f, 'save', 'save.txt'), store = await seed(f, [item]); f.editor.saveResult = false;
  await assert.rejects(f.controller.executeReviewDecision(item.file, { action: 'reject' }), error => {
    assert(error instanceof ReviewResultError); assert.equal(error.result.content, 'buffer'); assert.equal(error.result.decision, 'failed');
    assert.equal(error.result.reason, 'saveReturnedFalse'); assert.doesNotMatch(error.message, /inalterado/); return true;
  });
  assert.equal(f.documents.get(item.file).getText(), 'before'); assert.equal(fs.readFileSync(item.file, 'utf8'), 'after');
  assert.equal(store.get().statuses.save, undefined); assert.equal(store.get().undo.length, 0);
  const visible = published(f.controller).entries[0].lastOperation;
  assert.equal(visible.content, 'buffer'); assert.match(visible.message, /salvamento não foi confirmado/);
  f.editor.saveResult = true;
  await assert.rejects(f.controller.executeReviewDecision(item.file, { action: 'accept' }), error => error.result.outcome === 'recovered' && error.result.action === 'reject');
  assert.equal(store.get().statuses.save, 'rejected'); assert.equal(fs.readFileSync(item.file, 'utf8'), 'before');
  assert.equal(store.get().undo.length, 1);
});

test('controller distinguishes saved content from a failed state commit and recovers without applying the edit twice', async t => {
  let fail = false;
  const f = fixture(t, { storeOptions: { fault(stage) { if (fail && stage === 'state') throw new Error('PRIVATE state failure'); } } });
  const item = captured(f, 'state', 'state.txt'), store = await seed(f, [item]); f.editor.afterSave = () => { fail = true; };
  await assert.rejects(f.controller.executeReviewDecision(item.file, { action: 'reject' }), error => {
    assert.equal(error.result.content, 'persisted'); assert.equal(error.result.decision, 'failed'); assert.equal(error.result.outcome, 'partial');
    assert.match(error.message, /conteúdo foi salvo/i); assert.doesNotMatch(error.message, /inalterado|PRIVATE/); return true;
  });
  assert.equal(fs.readFileSync(item.file, 'utf8'), 'before'); assert.equal(store.get().statuses.state, undefined);
  assert.equal(published(f.controller).entries[0].lastOperation.content, 'persisted');
  fail = false;
  await assert.rejects(f.controller.executeReviewDecision(item.file, { action: 'reject' }), error => error.result.outcome === 'recovered');
  assert.equal(f.editor.applyCalls.length, 1); assert.equal(f.editor.saveCalls.length, 1); assert.equal(store.get().undo.length, 1);
});

test('a human edit arriving after application is preserved in the buffer and never saved as part of the rejection', async t => {
  const f = fixture(t), item = captured(f, 'manual-during-apply', 'manual-during-apply.txt'), store = await seed(f, [item]);
  f.editor.afterApply = () => { const document = f.documents.get(item.file); document.content += '\nSYNTHETIC MANUAL'; document.version++; document.isDirty = true; };
  await assert.rejects(f.controller.executeReviewDecision(item.file, { action: 'reject' }), error => {
    assert(error instanceof ReviewResultError); assert.equal(error.result.reason, 'externalChange'); assert.equal(error.result.conflict, true);
    assert.notEqual(error.result.decision, 'persisted'); return true;
  });
  assert.equal(f.documents.get(item.file).content, 'before\nSYNTHETIC MANUAL'); assert.equal(f.documents.get(item.file).isDirty, true);
  assert.equal(f.editor.applyCalls.length, 1); assert.equal(f.editor.saveCalls.length, 0); assert.equal(fs.readFileSync(item.file, 'utf8'), 'after');
  assert.equal(store.get().statuses[item.id], undefined); assert.equal(store.get().undo.length, 0);
  assert(Object.values(store.get().operations).some(operation => operation.ids.includes(item.id) && operation.stage !== 'complete' && operation.reason === 'externalChange'));
});

test('controller mixed batch retains coalesced IDs, reports each file and undoes only successful items', async t => {
  const f = fixture(t), a = captured(f, 'a1', 'a.txt', 'base', 'first'), next = captured(f, 'a2', 'a.txt', 'first', 'second'), b = captured(f, 'b', 'b.txt');
  const store = await seed(f, [a, next, b]); f.openDocument(b.file).content = 'HUMAN';
  const results = await f.controller.revert(f.controller.pendingGroups()), summary = summarizeReviewResults(results);
  assert.equal(summary.total, 2); assert.equal(summary.complete, 1); assert.equal(summary.blocked, 1);
  assert.deepEqual(results.find(result => result.file === a.file).ids, ['a1', 'a2']); assert.deepEqual(results.find(result => result.file === b.file).ids, ['b']);
  f.controller.report(results); await until(() => f.quickPicks.length > 0, 'per-file details missing'); assert.equal(f.quickPicks[0].length, 2);
  assert.equal(store.get().statuses.a1, 'rejected'); assert.equal(store.get().statuses.a2, 'rejected'); assert.equal(store.get().statuses.b, undefined);
  await f.controller.undoReject(); assert.equal(fs.readFileSync(a.file, 'utf8'), 'second'); assert.equal(f.documents.get(b.file).content, 'HUMAN');
  assert.equal(store.get().statuses.a1, undefined); assert.equal(store.get().statuses.a2, undefined); assert.equal(store.get().undo[0].phase, 'consumed');
});

test('excluded metadata causes no new transcript read, cache or metadata write and preserves already saved fields', async t => {
  let reads = 0;
  const f = fixture(t, { sessions: { async readTranscriptMeta() { reads++; return metadataFor(['tool-excluded']); } } });
  const item = metadataEntry(f, 'excluded', 'secret.txt'); f.policy({ excludedPatterns: ['secret.txt'] });
  const old = JSON.stringify({ excluded: { reason: 'Already saved', request: null } }) + '\n', file = path.join(f.dir, 'meta.json'); fs.writeFileSync(file, old);
  await seed(f, [item]); await f.controller.fillMeta(); await f.controller.writeChain;
  assert.equal(reads, 0); assert.equal(f.controller.reasonCache.get('excluded'), 'Already saved'); assert.equal(f.controller.requestCache.size, 0);
  assert.equal(f.controller.pendingMetadata.size, 0); assert.equal(fs.readFileSync(file, 'utf8'), old);
});

test('an exclusion introduced while transcript IO awaits prevents new metadata from being cached or persisted', async t => {
  const entered = gate(), release = gate(); let reads = 0;
  const f = fixture(t, { sessions: { async readTranscriptMeta() { reads++; entered.release(); await release.promise; return metadataFor(['tool-race']); } } });
  const item = metadataEntry(f, 'race'); f.policy(); await seed(f, [item]); const filling = f.controller.fillMeta();
  try { await bounded(entered.promise); f.policy({ generation: 'changed-generation', excludedPatterns: ['race.txt'] }); }
  finally { release.release(); }
  await filling; await f.controller.writeChain;
  assert.equal(reads, 1); assert.equal(f.controller.reasonCache.size, 0); assert.equal(f.controller.requestCache.size, 0);
  assert.equal(f.controller.pendingMetadata.size, 0); assert.equal(fs.existsSync(path.join(f.dir, 'meta.json')), false);
});

test('an exclusion introduced after metadata temp creation is rechecked before rename and before cache publication', async t => {
  const entered = gate(), release = gate(); let f;
  const nodeFs = { ...fs, promises: { ...fs.promises, async open(file, ...args) {
    const handle = await fs.promises.open(file, ...args);
    if (!String(file).includes('meta.json.') || !String(file).endsWith('.tmp')) { return handle; }
    return new Proxy(handle, { get(target, key) {
      if (key === 'writeFile') { return async (...values) => { await target.writeFile(...values); entered.release(); await release.promise; }; }
      const member = Reflect.get(target, key, target); return typeof member === 'function' ? member.bind(target) : member;
    } });
  } } };
  f = fixture(t, { nodeFs, sessions: { async readTranscriptMeta() { return metadataFor(['tool-temp']); } } });
  const item = metadataEntry(f, 'temp'); f.policy(); await seed(f, [item]); await f.controller.fillMeta();
  try { await bounded(entered.promise); f.settings.set('claudeCodeLauncher.historyExcludedPatterns', ['temp.txt']); }
  finally { release.release(); }
  await f.controller.writeChain;
  assert.equal(fs.existsSync(path.join(f.dir, 'meta.json')), false); assert.equal(f.controller.reasonCache.size, 0); assert.equal(f.controller.requestCache.size, 0);
  assert.equal(fs.readdirSync(f.dir).some(name => name.startsWith('meta.json.') && name.endsWith('.tmp')), false);
});

test('failed owned metadata temp IO cleans only the newly created file and preserves preexisting collision data', async t => {
  for (const mode of ['partial-write', 'preexisting-collision']) await t.test(mode, async sub => {
    let temporary, closes = 0;
    const nodeFs = { ...fs, promises: { ...fs.promises, async open(file, ...args) {
      if (!String(file).includes('meta.json.') || !String(file).endsWith('.tmp')) { return fs.promises.open(file, ...args); }
      temporary = file; assert.equal(args[0], 'wx');
      if (mode === 'preexisting-collision') { fs.writeFileSync(file, 'PREEXISTING SYNTHETIC DATA', { flag: 'wx' }); return fs.promises.open(file, ...args); }
      const handle = await fs.promises.open(file, ...args);
      return new Proxy(handle, { get(target, key) {
        if (key === 'writeFile') { return async () => { await target.writeFile('PARTIAL'); throw Object.assign(new Error('PRIVATE partial IO'), { code: 'EIO' }); }; }
        if (key === 'close') { return async () => { closes++; await target.close(); }; }
        const member = Reflect.get(target, key, target); return typeof member === 'function' ? member.bind(target) : member;
      } });
    } } };
    const f = fixture(sub, { nodeFs, sessions: { async readTranscriptMeta() { return metadataFor(['tool-io']); } } }), item = metadataEntry(f, 'io'); f.policy();
    const original = JSON.stringify({ io: { reason: 'Already saved', request: null } }) + '\n'; fs.writeFileSync(path.join(f.dir, 'meta.json'), original);
    await seed(f, [item]); await f.controller.fillMeta(); await f.controller.writeChain;
    assert(temporary); assert.equal(fs.readFileSync(path.join(f.dir, 'meta.json'), 'utf8'), original); assert.equal(f.controller.requestCache.size, 0);
    if (mode === 'partial-write') { assert.equal(fs.existsSync(temporary), false); assert.equal(closes, 1); }
    else { assert.equal(fs.readFileSync(temporary, 'utf8'), 'PREEXISTING SYNTHETIC DATA'); assert.equal(closes, 0); }
  });
});

test('a shared transcript is read only for permitted tool IDs without using or repopulating the global metadata cache', async t => {
  const calls = [];
  const f = fixture(t, { sessions: { async readTranscriptMeta(file, options) { calls.push({ file, options }); return sessions.readTranscriptMeta(file, options); } } });
  const allowed = metadataEntry(f, 'allowed', 'allowed.txt'), excluded = { ...metadataEntry(f, 'excluded', 'secret.txt'), transcript: allowed.transcript };
  fs.writeFileSync(allowed.transcript, [
    { type: 'user', uuid: 'request', message: { content: 'Synthetic request' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Synthetic reason' }, { type: 'tool_use', id: 'tool-allowed' }, { type: 'tool_use', id: 'tool-excluded' }] } },
  ].map(value => JSON.stringify(value)).join('\n') + '\n');
  f.policy({ excludedPatterns: ['secret.txt'] });
  const legacy = { reason: 'Already saved legacy metadata', request: { id: 'legacy-request', text: 'Already saved request' } };
  fs.writeFileSync(path.join(f.dir, 'meta.json'), JSON.stringify({ 'legacy-not-in-current-log-page': legacy }) + '\n');
  await seed(f, [allowed, excluded]); await f.controller.fillMeta(); await f.controller.writeChain;
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].options.toolUseIds, ['tool-allowed']); assert.equal(calls[0].options.cache, false);
  const saved = JSON.parse(fs.readFileSync(path.join(f.dir, 'meta.json'), 'utf8'));
  assert.equal(saved.allowed.reason, 'Synthetic reason'); assert.equal(saved.excluded, undefined);
  assert.deepEqual(saved['legacy-not-in-current-log-page'], legacy, 'new permitted enrichment must not purge valid legacy metadata outside the loaded log page');
  assert.equal(f.controller.reasonCache.has('excluded'), false); assert.equal(f.controller.requestCache.has('excluded'), false);
  assert.equal(sessions.transcriptMetadataCacheCount([path.join(f.root, 'sessions')]), 0);
});

test('partial purge retains an explicit recovery marker across reload and repair; explicit retry completes without changing project files', async t => {
  let fail = true, markerAtEffect;
  const nodeFs = { ...fs, promises: { ...fs.promises, async unlink(file) {
    if (path.basename(file) === 'meta.json' && fail) { markerAtEffect = JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'purge-state.v1.json'), 'utf8')).phase; throw Object.assign(new Error('PRIVATE unlink'), { code: 'EACCES' }); }
    return fs.promises.unlink(file);
  } } };
  const f = fixture(t, { nodeFs }), item = captured(f, 'purge', 'project.txt'); f.policy(); f.configuredHooks(); await seed(f, [item]);
  fs.writeFileSync(path.join(f.dir, 'meta.json'), JSON.stringify({ purge: { reason: 'Synthetic saved metadata', request: null } }) + '\n');
  await f.controller.clearAllReviewData();
  assert.equal(markerAtEffect, 'prepared'); const marker = path.join(f.dir, 'purge-state.v1.json'); assert.equal(JSON.parse(fs.readFileSync(marker, 'utf8')).phase, 'partial');
  assert.equal(fs.existsSync(path.join(f.dir, 'review-state.v1.json')), false); assert.equal(fs.existsSync(path.join(f.dir, 'meta.json')), true);
  const metadata = f.controller.lastPurgeReports[0].report.categories.find(category => category.category === 'metadata');
  assert.equal(metadata.outcome, 'failed'); assert.equal(metadata.remainingCount, 1); assert.equal(f.controller.lastPurgeReports[0].report.outcome, 'partial');
  await f.controller.whenDisposed(); const restarted = f.newController(); restarted.entries = await restarted.loadEntries(); await restarted.repairHooks();
  assert.equal(fs.existsSync(path.join(f.dir, 'review-state.v1.json')), false, 'reload/repair must not recreate removed canonical state while purge is incomplete');
  assert.equal(restarted.storeErrors.get(f.folder.uri.toString()), 'purgeNeedsRecovery');
  assert.match(restarted.readOnlyReason(), /limpeza foi interrompida/); assert.equal(published(restarted).readOnlyAction, 'clearAllReviewData');
  assert.equal(fs.readFileSync(item.file, 'utf8'), 'after');
  fail = false; await restarted.clearAllReviewData();
  assert.equal(fs.existsSync(marker), false); assert.equal(fs.existsSync(path.join(f.dir, 'meta.json')), false); assert.equal(fs.existsSync(path.join(f.dir, 'review-state.v1.json')), false);
  assert.equal(fs.readFileSync(item.file, 'utf8'), 'after'); assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'capture-policy.json'), 'utf8')).paused, true);
});

test('cancelling destructive confirmation preserves file bytes, canonical generation and metadata', async t => {
  const f = fixture(t, { confirm: false }), item = captured(f, 'cancel', 'cancel.txt'), store = await seed(f, [item]);
  const original = fs.readFileSync(path.join(f.dir, 'review-state.v1.json'));
  await f.controller.rejectEverything(); await f.controller.clearAllReviewData();
  assert.deepEqual(fs.readFileSync(path.join(f.dir, 'review-state.v1.json')), original); assert.equal(fs.readFileSync(item.file, 'utf8'), 'after');
  assert.equal(store.get().statuses.cancel, undefined); assert.equal(f.editor.applyCalls.length, 0); assert.equal(fs.existsSync(path.join(f.dir, 'purge-state.v1.json')), false);
  const delayedChoice = gate(); f.vscode.window.showWarningMessage = () => delayedChoice.promise;
  f.controller.report([blockedReviewResult(item.file, [item.id], 'reject', 'externalChange')]);
  f.controller.dispose(); delayedChoice.release('Detalhes'); await f.controller.whenDisposed();
  assert.equal(f.quickPicks.length, 0, 'a delayed native result action must not publish another UI after controller disposal');
});

test('trash failure and an open dirty notebook are explicit blocked results without filesystem fallback or completed status', async t => {
  const f = fixture(t), created = captured(f, 'created', 'created.txt', undefined, 'created'), notebook = captured(f, 'notebook', 'open.launcher-nb');
  created.before = snapshot(undefined); const store = await seed(f, [created, notebook]);
  f.editor.deleteError = Object.assign(new Error('PRIVATE trash failure'), { code: 'EACCES' });
  await assert.rejects(f.controller.executeReviewDecision(created.file, { action: 'reject' }), error => error.result.reason === 'permissionDenied' && error.result.content === 'unchanged');
  assert.equal(f.editor.deleteCalls.length, 1); assert.deepEqual(f.editor.deleteCalls[0].options, { useTrash: true }); assert.equal(fs.readFileSync(created.file, 'utf8'), 'created');
  const dirtyNotebook = { uri: f.Uri.file(notebook.file), isDirty: true, cellText: 'HUMAN_NOTEBOOK' }; f.vscode.workspace.notebookDocuments.push(dirtyNotebook);
  await assert.rejects(f.controller.executeReviewDecision(notebook.file, { action: 'reject' }), error => error.result.reason === 'unsupportedNotebook');
  assert.equal(dirtyNotebook.cellText, 'HUMAN_NOTEBOOK'); assert.equal(dirtyNotebook.isDirty, true); assert.equal(fs.readFileSync(notebook.file, 'utf8'), 'after');
  assert.equal(f.editor.applyCalls.length, 0); assert.equal(store.get().statuses.created, undefined); assert.equal(store.get().statuses.notebook, undefined); assert.equal(store.get().undo.length, 0);
});

test('controller disposal at editor boundaries distinguishes cancellation before application, buffer-only and already saved effects', async t => {
  for (const stage of ['beforeOpen', 'afterApply', 'afterSave']) await t.test(stage, async sub => {
    const f = fixture(sub), item = captured(f, stage, stage + '.txt'), store = await seed(f, [item]);
    f.editor[stage] = () => { f.controller.dispose(); };
    await assert.rejects(f.controller.executeReviewDecision(item.file, { action: 'reject' }), error => {
      assert(error instanceof ReviewResultError); assert.equal(error.result.cancellation, stage === 'beforeOpen' ? 'beforeEffect' : 'afterEffect');
      assert.equal(error.result.content, stage === 'beforeOpen' ? 'unchanged' : stage === 'afterApply' ? 'buffer' : 'persisted');
      assert.notEqual(error.result.decision, 'persisted'); return true;
    });
    await f.controller.whenDisposed(); assert.equal(store.get().statuses[stage], undefined);
    assert.equal(fs.readFileSync(item.file, 'utf8'), stage === 'afterSave' ? 'before' : 'after');
  });
});
