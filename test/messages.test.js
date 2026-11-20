'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describeReason, knownReason } = require('../out/messages.js');

// Codes that reach notifications, the read-only banner or the coverage message through the controller.
const OUT = path.resolve(__dirname, '../out');
function codesIn(file, pattern) {
  return [...fs.readFileSync(path.join(OUT, file), 'utf8').matchAll(pattern)].map(match => match[1]);
}

test('every reason the hook planner, the store and maintenance can report has a user explanation', () => {
  const codes = new Set([
    ...codesIn('hooks.js', /code: '([A-Za-z]+)'/g),
    ...codesIn('maintenance.js', /ReviewError\('([A-Za-z]+)'/g),
    ...codesIn('review-store.js', /ReviewError\('([A-Za-z]+)'/g),
    ...codesIn('changes.js', /ReviewError\('([A-Za-z]+)'/g),
    // Guarded reads in history.js; its log-rejection codes are counted, never shown.
    'readBudgetOrType', 'readBudgetExceeded', 'readFailed', 'storageOutsideScope', 'storageIdentityUnavailable', 'unsafeStorage',
    'EACCES', 'EPERM', 'EROFS', 'ENOSPC',
  ]);
  // Reasons of a review decision are explained by review-results.js, with the next action.
  const { REVIEW_REASONS } = require('../out/review-results.js');
  const missing = [...codes].filter(code => !knownReason(code) && !REVIEW_REASONS.includes(code));
  assert.deepEqual(missing, []);
  assert.ok(codes.size > 30);
});

test('explanations are sentences for composition and never echo the internal code', () => {
  for (const code of ['execArgumentsNotConfirmed', 'captureInProgress', 'anotherWriter', 'unsupportedCapturePolicy', 'stateChanged', 'ENOSPC']) {
    const text = describeReason(code);
    assert.equal(text.includes(code), false, code); assert.equal(/[.!?]$/.test(text), false, code);
    assert.match(text, /^[a-zà-ú."]/);
  }
});

test('unknown, malformed and non-string codes degrade to a generic sentence without injecting text', () => {
  assert.equal(describeReason('operationFailed'), 'ocorreu uma falha não classificada');
  assert.equal(describeReason('newFailureKind'), 'ocorreu uma falha não classificada (referência: newFailureKind)');
  for (const value of [undefined, null, 42, {}, 'with space', 'a'.repeat(65), '__proto__', 'constructor\n']) {
    assert.equal(describeReason(value), 'ocorreu uma falha não classificada');
  }
  assert.equal(knownReason('toString'), false);
});
