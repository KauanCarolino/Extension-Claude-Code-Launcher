'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const OUT = process.env.LAUNCHER_TEST_OUT || path.resolve(__dirname, '../out');
const { makeCapturePolicy } = require(path.join(OUT, 'history.js'));
const { evaluateMetadataPolicy: evaluate, revalidateMetadataPermit: revalidate } = require(path.join(OUT, 'metadata-policy.js'));
function context(fields = {}, policyFields = {}) {
	return { canonicalRoot: '/workspace', canonicalFile: '/workspace/src/ordinary.txt', scopeVerified: true,
		policy: makeCapturePolicy({ generation: 'fixture', ...policyFields }), ...fields };
}

test('new metadata permits reuse capture exclusions and reject unknown policy or unverified scope', () => {
	assert.equal(evaluate(context()).allowed, true);
	assert.deepEqual(evaluate(context({ canonicalFile: '/workspace/.env' })), { allowed: false, reason: 'excludedByPolicy' });
	for (const policy of [undefined, null, { schemaVersion: 999 }, { ...context().policy, excludedPatterns: ['../outside'] },
		{ ...context().policy, excludedPatterns: ['x'.repeat(513)] }]) {
		assert.deepEqual(evaluate(context({ policy })), { allowed: false, reason: 'policyUnknown' });
	}
	assert.equal(evaluate(context({ scopeVerified: false })).reason, 'scopeUnknown');
	assert.equal(evaluate(context({ canonicalFile: '/workspace-other/ordinary.txt' })).reason, 'resourceOutsideScope');
	assert.equal(evaluate(context({}, { paused: true })).reason, 'policyPaused');
});

test('an exclusion or generation added across an await invalidates a permit without deleting existing metadata', async () => {
	const existing = { old: { reason: 'ordinary retained reason', request: { id: 'old', text: 'retained request' } } };
	const before = structuredClone(existing), original = context();
	const decision = evaluate(original); assert.equal(decision.allowed, true);
	await Promise.resolve();
	const excluded = context({}, { generation: 'next', excludedPatterns: ['src/*.txt'] });
	assert.deepEqual(revalidate(decision.permit, excluded), { allowed: false, reason: 'excludedByPolicy' });
	assert.equal(revalidate(decision.permit, context({}, { generation: 'next' })).reason, 'policyChanged');
	assert.equal(revalidate(decision.permit, context({}, { excludedPatterns: ['unrelated/*.txt'] })).reason, 'policyChanged');
	assert.equal(revalidate(decision.permit, context({ canonicalFile: '/workspace/src/other.txt' })).reason, 'resourceChanged');
	assert.equal(revalidate(decision.permit, original).allowed, true);
	assert.deepEqual(existing, before);
});

test('disk and current-settings permits compose conservatively without merging pattern budgets', () => {
	const disk = context({}, { generation: 'disk', excludedPatterns: ['disk-only/**'] });
	const current = context({}, { generation: 'settings', excludedPatterns: ['src/**'] });
	assert.equal(evaluate(disk).allowed, true);
	assert.equal(evaluate(current).allowed, false, 'a stale permissive disk policy cannot override a new exclusion');
	const permittedSettings = context({}, { generation: 'settings', excludedPatterns: ['another/**'] });
	const permit = evaluate(permittedSettings).permit;
	assert.equal(revalidate(permit, permittedSettings).allowed, true);
});

test('Windows roots use literal resource case and glob metacharacters keep capture semantics', () => {
	const windows = context({ canonicalRoot: String.raw`D:\Fixture\workspace`, canonicalFile: String.raw`d:\Fixture\workspace\Secrets\file.txt` },
		{ excludedPatterns: ['Secrets/*.txt'] });
	assert.equal(evaluate(windows).reason, 'excludedByPolicy');
	assert.equal(evaluate({ ...windows, canonicalFile: String.raw`d:\Fixture\workspace\secrets\file.txt` }).allowed, true);
	assert.equal(evaluate({ ...windows, canonicalFile: String.raw`E:\Fixture\workspace\Secrets\file.txt` }).reason, 'resourceOutsideScope');
	const literal = context({ canonicalFile: '/workspace/src/a[1]+(x).txt' }, { excludedPatterns: ['src/a[1]+(x).txt'] });
	assert.equal(evaluate(literal).reason, 'excludedByPolicy');
	assert.equal(evaluate({ ...literal, canonicalFile: '/workspace/src/a11x.txt' }).allowed, true);
	assert.equal(JSON.stringify(evaluate(context())).includes('/workspace'), false, 'permits carry fingerprints, not resource paths');
});
