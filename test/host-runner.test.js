'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  parseArguments, assertHookNode, hostEnvironment, provisionEditor, cliScript, editorFixtureArguments, run,
  validDiagnosticEvent, createEvidenceDirectory, exportEvidence,
} = require('../scripts/host-tooling.cjs');

async function temporary(t) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-host-tooling-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('host runner requires exact editor pins and rejects ambiguous or unsupported provisioning', () => {
  const args = ['--vsix', 'candidate.vsix', '--download-version', '1.94.0', '--report-dir', 'evidence'];
  assert.deepEqual(parseArguments(args), {
    editor: 'code', keep: false, vsix: 'candidate.vsix', 'download-version': '1.94.0', 'report-dir': 'evidence',
  });
  assert.equal(args.length, 6, 'Parsing must not mutate caller arguments.');
  for (const invalid of [
    ['--download-version', 'stable'], ['--download-version', '1.94'],
    ['--download-version', '1.94.0', '--editor', 'cursor'],
    ['--download-version', '1.94.0', '--executable', 'code'],
    ['--download-version', '1.94.0', '--cli', 'cli.js'],
    ['--editor', 'code', '--editor', 'cursor'], ['--vsix', '--keep'], ['--unknown'],
    ['--no-sandbox'], ['--disable-gpu-sandbox'],
  ]) assert.throws(() => parseArguments(invalid));
  assert.equal(parseArguments(['--editor', 'cursor', '--executable', 'Cursor', '--keep']).keep, true);
});

test('hook Node is external >=22 and isolated host environment clears stale authority', async t => {
  const directory = await temporary(t);
  assertHookNode('v22.0.0');
  assertHookNode('v26.8.1');
  for (const version of ['v20.18.0', 'v21.9.0', '', '22', 'garbage']) assert.throws(() => assertHookNode(version));
  const inherited = {
    PATH: process.env.PATH, CLAUDE_CONFIG_DIR: 'real-profile', ELECTRON_RUN_AS_NODE: '1',
    NODE_OPTIONS: '--require=unrelated.js', VSCODE_IPC_HOOK_CLI: 'real-ipc',
    LAUNCHER_HOST_ARTIFACT_SHA256: 'stale', LAUNCHER_HOST_HOOK_SHA256: 'stale',
    LAUNCHER_HOST_ARTIFACT_VERSION: 'stale', LAUNCHER_HOST_EXPECTED_VERSION: 'stale',
  };
  const env = hostEnvironment(directory, path.join(directory, 'workspace'), path.join(directory, 'report.json'), inherited);
  assert.equal(env.CLAUDE_CONFIG_DIR, path.join(directory, 'claude'));
  assert.equal(env.LAUNCHER_HOST_HOOK_NODE, process.execPath);
  assert.equal(env.LAUNCHER_HOST_HOOK_NODE_VERSION, process.version);
  for (const name of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'VSCODE_IPC_HOOK_CLI',
    'LAUNCHER_HOST_ARTIFACT_SHA256', 'LAUNCHER_HOST_HOOK_SHA256', 'LAUNCHER_HOST_ARTIFACT_VERSION',
    'LAUNCHER_HOST_EXPECTED_VERSION']) assert.equal(Object.hasOwn(env, name), false);
  assert.equal(inherited.CLAUDE_CONFIG_DIR, 'real-profile');
  assert.throws(() => hostEnvironment(directory, directory, directory, {}, 'node', 'v22.0.0'));
  assert.throws(() => hostEnvironment(directory, directory, directory, {}, process.execPath, 'v20.0.0'));
});

test('official provision receives exact target and external cache; failures never select installed editor', async t => {
  const directory = await temporary(t);
  const executable = path.join(directory, 'downloaded-editor');
  let attempts = 0;
  const options = parseArguments(['--download-version', '1.94.0']);
  assert.equal(await provisionEditor(options, directory, async requested => {
    attempts += 1;
    assert.equal(requested.version, '1.94.0');
    assert.equal(requested.cachePath, path.join(directory, 'editor'));
    assert.equal(requested.timeout, 30000);
    return executable;
  }), executable);
  assert.equal(attempts, 1);
  await assert.rejects(provisionEditor(options, directory, async () => { throw new Error('offline fixture'); }), /offline fixture/);
});

test('CLI JS layouts remain explicit on all OSes without spawning Windows command shells', () => {
  assert.equal(cliScript('/tmp/Visual Studio Code.app/Contents/MacOS/Electron', 'darwin'),
    '/tmp/Visual Studio Code.app/Contents/Resources/app/out/cli.js');
  assert.equal(cliScript('/tmp/vscode/code', 'linux'), '/tmp/vscode/resources/app/out/cli.js');
  assert.equal(cliScript('C:\\fixture folder\\Code.exe', 'win32'), 'C:\\fixture folder\\resources\\app\\out\\cli.js');
});

test('sandbox test arguments are confined to the downloaded Linux editor fixture', () => {
  assert.deepEqual(editorFixtureArguments('linux', true), ['--no-sandbox', '--disable-gpu-sandbox']);
  for (const [platform, downloaded] of [
    ['linux', false], ['darwin', true], ['win32', true], ['darwin', false], ['win32', false],
    ['linux', undefined], ['linux', 'true'], ['unknown', true],
  ]) assert.deepEqual(editorFixtureArguments(platform, downloaded), []);
  const installed = parseArguments(['--executable', '/synthetic/installed-editor']);
  assert.deepEqual(editorFixtureArguments('linux', Boolean(installed['download-version'])), []);
});

test('process execution preserves literal arguments/stdin and reports nonzero exit without fallback', async t => {
  const directory = await temporary(t);
  const literal = '$(not-a-shell); & literal';
  const result = await run(process.execPath, ['-e',
    'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{console.log(JSON.stringify({arg:process.argv[1],input:s,cwd:process.cwd()}));process.exitCode=7;});',
    literal], process.env, { cwd: directory, input: '{"synthetic":true}', timeout: 10000 });
  assert.equal(result.code, 7);
  assert.equal(result.timedOut, false);
  assert.deepEqual(JSON.parse(result.output), { arg: literal, input: '{"synthetic":true}', cwd: directory });
});

test('missing executable and timeout remain failing evidence', async t => {
  const directory = await temporary(t);
  await assert.rejects(run(path.join(directory, 'missing-executable'), [], process.env), { code: 'ENOENT' });
  const result = await run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], process.env, { timeout: 100 });
  assert.equal(result.timedOut, true);
  assert.notEqual(result.code, 0);
});

test('reusing an evidence base keeps old results separate from an early failing runner execution', async t => {
  const directory = await temporary(t);
  const base = path.join(directory, 'evidence');
  const firstDirectory = await createEvidenceDirectory(base);
  const successfulTemporary = path.join(directory, 'successful-synthetic-run');
  await fs.mkdir(successfulTemporary);
  await fs.writeFile(path.join(successfulTemporary, 'result.json'), '{"status":"passed","synthetic":true}');
  await fs.writeFile(path.join(base, 'user-note.txt'), 'preserve this user file');
  const first = await exportEvidence(successfulTemporary, firstDirectory, { status: 'passed' });
  assert.equal(first.resultFile, 'result.json');

  const execution = await run(process.execPath, [path.join(__dirname, '../scripts/test-host.cjs'),
    '--executable', path.join(directory, 'missing-editor'), '--report-dir', base], process.env, { timeout: 10000 });
  assert.equal(execution.code, 1);
  const runs = (await fs.readdir(base)).filter(name => name.startsWith('run-'));
  assert.equal(runs.length, 2);
  const currentDirectory = path.join(base, runs.find(name => name !== path.basename(firstDirectory)));
  const current = JSON.parse(await fs.readFile(path.join(currentDirectory, 'runner.json'), 'utf8'));
  assert.equal(current.status, 'failed');
  assert.equal(current.editorSandboxPolicy, 'editor-default');
  assert.equal(current.resultFile, null);
  assert.equal(current.evidenceDirectory, currentDirectory);
  assert(current.files.includes('runner-failure.json'));
  await assert.rejects(fs.access(path.join(currentDirectory, 'result.json')), { code: 'ENOENT' });
  assert.equal(JSON.parse(await fs.readFile(path.join(firstDirectory, 'result.json'), 'utf8')).status, 'passed');
  assert.equal(await fs.readFile(path.join(base, 'user-note.txt'), 'utf8'), 'preserve this user file');
  const summaryPrefix = 'Evidências desta execução: ';
  const summaries = execution.output.split(/\r?\n/).filter(line => line.startsWith(summaryPrefix));
  assert.equal(summaries.length, 1, 'The runner must publish exactly one current-run summary.');
  const announced = JSON.parse(summaries[0].slice(summaryPrefix.length));
  assert.deepEqual(announced, current, 'The published summary must identify the current run and match runner.json.');
  // The runner intentionally retains failures. Remove only this test's own
  // isolated fixture profile after checking the exported current-run identity.
  const retained = execution.output.match(/Evidências do perfil isolado: ([^\r\n]+)/)?.[1];
  assert(retained && path.basename(retained).startsWith('launcher-host-'));
  await fs.rm(retained, { recursive: true, force: true });
});

test('diagnostic export rejects extra private fields and invalid schema before redaction', () => {
  const event = { schemaVersion: 2, id: 'a'.repeat(32), kind: 'completion', phase: 'post',
    stage: 'append', code: 'captureRecorded', observedAt: '2020-01-01T00:00:00.000Z', contentCoverage: 'complete' };
  const filename = '20200101T000000000Z-' + event.id + '.json';
  assert.equal(validDiagnosticEvent(event, 'completion', filename), true);
  for (const invalid of [null, [], { ...event, path: 'private fixture' }, { ...event, schemaVersion: 3 },
    { ...event, stage: 'arbitrary' }, { ...event, code: 'private exception' }, { ...event, contentCoverage: 'all' },
    { ...event, phase: 'pre' }, { ...event, observedAt: 'not-a-date' },
    { ...event, observedAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() },
  ]) assert.equal(validDiagnosticEvent(invalid, 'completion', filename), false);
  assert.equal(validDiagnosticEvent(event, 'observation', filename), false);
  assert.equal(validDiagnosticEvent(event, 'completion', 'unrelated.json'), false);
});
