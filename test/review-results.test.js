'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { blockedReviewResult, formatReviewItemResult, ReviewResultError, operationView,
  pendingOperationView, projectReview, summarizeReviewResults } = require('../out/review-results.js');
const { ingestEntries, activeReview, planReviewDecision, commitReviewDecision } = require('../out/review.js');
const { diffLines, groupsOf, groupSignature } = require('../out/diff.js');
function review() {
  const before = 'one\ntwo\nthree\n', after = 'ONE\ntwo\nTHREE\n';
  const state = { reviews: {}, statuses: {}, operations: {}, undo: [] };
  ingestEntries(state, [{ id: 'fixture', file: '/synthetic/a.txt', before: { exists: true, text: before, large: false }, after: { exists: true, text: after, large: false } }]);
  return { state, before, after, current: () => activeReview(state, '/synthetic/a.txt') };
}
test('review projection retains partial decisions and explains barriers without inventing pending counts', () => {
  const f = review(), group = groupsOf(diffLines(f.before, f.after).lines)[0];
  commitReviewDecision(f.state, planReviewDecision(f.current(), { kind: 'text', text: f.after }, { action: 'accept', index: 0, signature: groupSignature(group) }));
  const projected = projectReview(f.current());
  assert.equal(projected.acceptedParts, 1); assert.equal(projected.pendingParts, 1); assert.equal(projected.phase, 'pending');
  const human = projectReview(f.current(), { kind: 'text', text: f.after + 'HUMAN' });
  assert.equal(human.phase, 'blocked'); assert.match(human.blockedReason, /mudou/); assert.equal(human.canAcceptCurrent, true);
  assert.equal(f.current().phase, 'pending', 'presentation must not mutate the canonical model');
  const unavailable = projectReview({ ...f.current(), phase: 'blocked', blockReason: 'unknownSnapshot', base: { kind: 'unavailable', reason: 'PRIVATE' } });
  assert.equal(unavailable.pendingParts, null); assert.equal(unavailable.canAcceptCurrent, false);
  assert.equal(JSON.stringify(unavailable).includes('PRIVATE'), false); assert.equal(projectReview(undefined).pendingParts, null);
});
test('item messages distinguish saved content, buffer-only application, unknown effect and recovered prior work', () => {
  const base = blockedReviewResult('/PRIVATE/path', ['PRIVATE-id'], 'reject', 'saveReturnedFalse');
  const buffer = { ...base, outcome: 'partial', content: 'buffer', decision: 'failed', nextAction: 'retrySave' };
  assert.match(formatReviewItemResult(buffer), /editor.*salvamento não foi confirmado/);
  const persisted = { ...buffer, content: 'persisted', nextAction: 'reconcile' };
  assert.match(formatReviewItemResult(persisted), /salvo.*registro.*pendente/);
  assert.match(formatReviewItemResult({ ...base, content: 'unknown' }), /Não foi possível confirmar/);
  assert.match(formatReviewItemResult({ ...base, outcome: 'recovered', decision: 'persisted', nextAction: 'reviewAgain' }), /nova ação.*não foi executada/);
  const error = new ReviewResultError(buffer, new Error('PRIVATE-exception'));
  assert.equal(error.message.includes('PRIVATE'), false); assert.equal(Object.keys(error).includes('cause'), false);
  assert.equal(JSON.stringify(operationView(buffer)).includes('PRIVATE'), false);
  const legacy = { ...base, outcome: 'complete', decision: 'persisted', reason: 'legacyProjectionPending', nextAction: 'reconcile' };
  assert.match(formatReviewItemResult(legacy), /Atualizar mudanças/); assert.doesNotMatch(formatReviewItemResult(legacy), /repita/);
  assert.match(formatReviewItemResult({ ...buffer, cancellation: 'afterEffect' }), /cancelada após a aplicação/);
  const committedConflict = { ...persisted, decision: 'persisted', reason: 'legacyWriterConflict' };
  assert.match(formatReviewItemResult(committedConflict), /conteúdo foi salvo e a decisão canônica foi registrada/);
  assert.doesNotMatch(formatReviewItemResult(committedConflict), /inalterado|decisão continua pendente/);
});
test('empty creation and deletion retain a structural pending part without turning absence into empty text', () => {
  for (const [base, expected] of [[{ kind: 'absent' }, { kind: 'text', text: '' }], [{ kind: 'text', text: '' }, { kind: 'absent' }]]) {
    const current = { ...review().current(), base, expected };
    assert.equal(projectReview(current).pendingParts, 1); assert.equal(current.phase, 'pending');
    assert.equal(projectReview({ ...current, phase: 'complete' }).pendingParts, 0);
  }
});
test('unknown reasons stay redacted and blocked guards retain explicit cancellation and writer recovery', () => {
  const unknown = blockedReviewResult('/fixture', ['id'], 'accept', new Error('PRIVATE-error'));
  assert.equal(unknown.reason, 'operationFailed'); assert.equal(formatReviewItemResult(unknown).includes('PRIVATE'), false);
  assert.equal(blockedReviewResult('/fixture', [], 'reject', 'cancelledBeforeEffect').cancellation, 'beforeEffect');
  assert.equal(blockedReviewResult('/fixture', [], 'reject', { code: 'anotherWriter' }).nextAction, 'recoverWriter');
});
test('interrupted purge has a redacted explicit recovery action without suggesting a decision retry or manual marker removal', () => {
  const result = blockedReviewResult('/PRIVATE/file', ['PRIVATE-id'], 'reject', { code: 'purgeNeedsRecovery', message: 'PRIVATE exception' });
  assert.equal(result.reason, 'purgeNeedsRecovery'); assert.equal(result.outcome, 'blocked'); assert.equal(result.nextAction, 'reconcile');
  assert.equal(result.decision, 'notPersisted'); assert.equal(result.content, 'unchanged');
  const message = formatReviewItemResult(result);
  assert.match(message, /Apagar todos os dados locais de revisão/); assert.match(message, /não remova o marcador manualmente/);
  assert.doesNotMatch(message, /PRIVATE|repita a ação/); assert.equal(JSON.stringify(operationView(result)).includes('PRIVATE'), false);
  assert.match(projectReview({ ...review().current(), phase: 'blocked', blockReason: 'purgeNeedsRecovery' }).blockedReason, /limpeza interrompida/);
});
test('reload projection states only historical journal knowledge and never asserts current persisted contents', () => {
  const view = pendingOperationView({ id: 'PRIVATE-op', file: '/PRIVATE/file', ids: ['PRIVATE-id'], stage: 'bufferApplied',
    reason: 'saveReturnedFalse', expected: { kind: 'text', text: 'PRIVATE' }, target: { kind: 'text', text: 'PRIVATE' } });
  assert.equal(view.content, 'unknown'); assert.equal(view.outcome, 'partial'); assert.equal(view.lastKnownStage, 'bufferApplied');
  assert.match(view.message, /Último estágio registrado/); assert.equal(JSON.stringify(view).includes('PRIVATE'), false);
  assert.equal(pendingOperationView({ stage: 'complete' }), undefined);
});
test('batch aggregation retains all item identities and every result category', () => {
  const base = blockedReviewResult('/fixture', ['a'], 'reject', 'externalChange');
  const results = ['complete', 'partial', 'blocked', 'failed', 'recovered'].map((outcome, index) => ({ ...base, outcome, ids: [String(index)] }));
  const summary = summarizeReviewResults(results);
  assert.equal(summary.total, 5); for (const outcome of ['complete', 'partial', 'blocked', 'failed', 'recovered']) assert.equal(summary[outcome], 1);
  assert.deepEqual(summary.items.map(item => item.ids[0]), ['0', '1', '2', '3', '4']);
});
