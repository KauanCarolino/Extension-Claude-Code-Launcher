'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const history = require('../out/history.js');
const { captureHealth, captureEventView, retainCaptureEvidence } = require('../out/capture-health.js');

function event(fields = {}) {
	return { schemaVersion: 2, id: 'a'.repeat(32), kind: 'observation', phase: 'pre', stage: 'pending',
		code: 'capturePrepared', contentCoverage: 'complete', observedAt: '2026-11-19T12:00:00.000Z', ...fields };
}
const configured = { status: 'confirmed', harness: 'anthropic.claude-code', version: '2.1.326' };

test('configuration and declared exec capability never become observed or completed capture evidence', () => {
	const health = captureHealth('configured', configured, history.projectCaptureDiagnostics([]));
	assert.equal(health.configuration, 'configured');
	assert.equal(health.observation, null);
	assert.equal(health.completion, null);
	assert.match(health.evidenceLabel, /Nenhum evento/);
	assert.match(health.capabilityLabel, /evidência distinta/);
	const prepared = captureHealth('configured', configured, history.projectCaptureDiagnostics([event()]));
	assert.equal(prepared.observation.code, 'capturePrepared');
	assert.equal(prepared.completion, null);
});

test('a later failed observation retains prior completion and older concurrent evidence cannot regress either timestamp', () => {
	const completion = event({ kind: 'completion', phase: 'post', stage: 'append', code: 'captureRecorded' });
	const failed = event({ id: 'b'.repeat(32), phase: 'post', stage: 'snapshot', code: 'storagePermissionDenied', observedAt: '2026-11-19T12:00:01.000Z' });
	const previous = history.projectCaptureDiagnostics([completion, failed]);
	const next = retainCaptureEvidence(previous, history.projectCaptureDiagnostics([event({ observedAt: '2026-11-19T11:00:00.000Z' })]));
	assert.deepEqual(next.lastCompletion, completion);
	assert.deepEqual(next.latestObservation, failed);
	const health = captureHealth('configured', configured, next);
	assert.match(health.observation.guidance, /permissões/);
	assert.equal(health.completion.at, completion.observedAt);
});

test('incompatible or disappeared diagnostics preserve dated proof without claiming current complete coverage', () => {
	const completion = event({ kind: 'completion', phase: 'post', stage: 'append', code: 'captureRecorded' });
	const previous = history.projectCaptureDiagnostics([completion]);
	const next = retainCaptureEvidence(previous, history.projectCaptureDiagnostics([], ['unsupportedVersion']));
	assert.equal(next.lastCompletion.observedAt, completion.observedAt);
	assert.equal(next.coverage, 'partial');
	assert.match(captureHealth('configured', configured, next).evidenceLabel, /não comprovam atividade atual/);
	assert.equal(retainCaptureEvidence(previous, history.projectCaptureDiagnostics([])).coverage, 'partial');
});

test('unknown payloads, arbitrary harness names and invalid versions never reach the redacted presentation', () => {
	const secret = '/absolute/private/fixture-source-or-exception';
	const bad = event({ code: secret, source: secret });
	assert.equal(captureEventView(bad), null);
	const health = captureHealth('unknown', { status: 'unknown', harness: secret, version: secret }, history.projectCaptureDiagnostics([bad]));
	assert.equal(JSON.stringify(health).includes(secret), false);
	assert.equal(health.version, null);
	assert.equal(health.completion, null);
	assert.match(health.capabilityLabel, /desconhecida/);
});

test('limited content and operator-selected exec do not imply full reversibility or tested Claude execution', () => {
	const completion = event({ kind: 'completion', phase: 'post', stage: 'append', code: 'captureRecorded', contentCoverage: 'limited' });
	const health = captureHealth('configured', { status: 'confirmed', harness: 'operator-selected-exec' }, history.projectCaptureDiagnostics([completion]));
	assert.match(health.completion.content, /não comprova reversão integral/);
	assert.match(health.capabilityLabel, /não comprova execução/);
	assert.match(health.coverageLabel, /Bash, PowerShell, MCP e alterações externas não são abrangidos/);
});
