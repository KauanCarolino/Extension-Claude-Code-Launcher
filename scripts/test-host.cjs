'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { parseArguments, hostEnvironment, provisionEditor, cliScript, editorFixtureArguments, run,
  createEvidenceDirectory, exportEvidence } = require('./host-tooling.cjs');
const { verifyPackage } = require('./verify-package.cjs');

const root = path.resolve(__dirname, '..');

async function seedWorkspace(workspace) {
  const cases = [
    ['crlf.txt', 'before\r\nline\r\n', 'after\r\nline\r\n'],
    ['created.txt', undefined, 'created\n'],
    ['partial.txt', 'one\ntwo\nthree\n', 'ONE\ntwo\nTHREE\n'],
    ['manual.txt', 'base\nstable\n', 'claude\nstable\n'],
  ];
  const snapshot = text => text === undefined
    ? { exists: false, text: null, large: false }
    : { exists: true, text, large: false };
  const entries = [];
  for (const [name, before, after] of cases) {
    const file = path.join(workspace, name);
    await fs.writeFile(file, after);
    entries.push({
      id: 'host-' + name, time: '2026-11-19T12:00:00.000Z', file,
      tool: before === undefined ? 'Write' : 'Edit', session: 'host-fixture',
      toolUseId: 'host-' + name, transcript: null, reason: null,
      before: snapshot(before), after: snapshot(after),
    });
  }
  const history = path.join(workspace, '.claude/launcher-changes');
  await fs.mkdir(history, { recursive: true });
  await fs.writeFile(path.join(history, 'log.jsonl'), entries.map(x => JSON.stringify(x)).join('\n') + '\n');
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const fixtureArguments = editorFixtureArguments(process.platform, Boolean(options['download-version']));
  const editorSandboxPolicy = fixtureArguments.length ? 'disabled-for-downloaded-linux-synthetic-fixture' : 'editor-default';
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-host-')));
  const workspace = path.join(temporary, 'workspace');
  const profile = path.join(temporary, 'profile');
  const extensions = path.join(temporary, 'extensions');
  const reportPath = path.join(temporary, 'result.json');
  let reportDirectory;
  let passed = false;
  let env;
  try {
    if (options['report-dir']) reportDirectory = await createEvidenceDirectory(options['report-dir']);
    env = hostEnvironment(temporary, workspace, reportPath);
    const executable = await provisionEditor(options, temporary);
    await fs.access(executable);
    if (options['download-version']) env.LAUNCHER_HOST_EXPECTED_VERSION = options['download-version'];
    for (const dir of [workspace, path.join(profile, 'User'), extensions, env.CLAUDE_CONFIG_DIR]) {
      await fs.mkdir(dir, { recursive: true });
    }
    await fs.writeFile(path.join(profile, 'User/settings.json'), JSON.stringify({
      'telemetry.telemetryLevel': 'off', 'update.mode': 'none',
      'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false,
      'workbench.startupEditor': 'none', 'window.restoreWindows': 'none',
      'workbench.editor.autoLockGroups': { 'default': false },
      'claudeCodeLauncher.manageEditorGroups': false,
      'claudeCodeLauncher.hookExecutionMode': 'disabled',
    }, null, 2));
    await seedWorkspace(workspace);
    let developmentPath = root;
    if (options.vsix) {
      const artifact = path.resolve(options.vsix);
      const verified = await verifyPackage(artifact);
      await fs.writeFile(path.join(temporary, 'package-verification.json'), JSON.stringify(verified, null, 2));
      env.LAUNCHER_HOST_ARTIFACT_SHA256 = verified.sha256;
      env.LAUNCHER_HOST_ARTIFACT_VERSION = verified.version;
      const hook = verified.entries.find(entry => entry.name === 'extension/hooks/record-change.js');
      if (!hook) throw new Error('VSIX verificado não contém o hook de captura.');
      env.LAUNCHER_HOST_HOOK_SHA256 = hook.sha256;
      // Invoke the editor's own CLI JS through Electron on all three OSes. This
      // avoids passing a Windows .cmd or any artifact/profile path to a shell.
      const cli = options.cli ? path.resolve(options.cli) : cliScript(executable);
      await fs.access(cli);
      const installation = await run(executable, [
        cli, '--user-data-dir', profile, '--extensions-dir', extensions,
        '--install-extension', artifact, '--force', '--do-not-sync',
      ], { ...env, ELECTRON_RUN_AS_NODE: '1' }, { cwd: root });
      await fs.writeFile(path.join(temporary, 'installation.log'), installation.output);
      if (installation.code !== 0 || installation.timedOut) throw new Error('Instalação isolada falhou: ' + installation.output.slice(-4000));
      developmentPath = path.join(temporary, 'test-driver');
      await fs.mkdir(developmentPath);
      await fs.writeFile(path.join(developmentPath, 'package.json'), JSON.stringify({
        name: 'launcher-test-driver', publisher: 'local', version: '1.0.0',
        engines: { vscode: '^1.94.0' }, main: './index.js', activationEvents: ['*'],
      }));
      await fs.writeFile(path.join(developmentPath, 'index.js'), 'exports.activate = () => {};\n');
    }
    // This is a trusted synthetic fixture, not a Restricted Mode validation.
    const execution = await run(executable, [
      ...fixtureArguments,
      '--new-window', '--disable-gpu', '--skip-welcome', '--skip-release-notes',
      '--disable-workspace-trust', '--disable-telemetry',
      '--user-data-dir=' + profile, '--extensions-dir=' + extensions,
      '--extensionDevelopmentPath=' + developmentPath,
      '--extensionTestsPath=' + path.join(root, 'test/host/suite.cjs'), workspace,
    ], env, { cwd: root });
    await fs.writeFile(path.join(temporary, 'host.log'), execution.output);
    let report;
    try { report = JSON.parse(await fs.readFile(reportPath, 'utf8')); } catch {}
    if (execution.code !== 0 || execution.timedOut || !report || report.status !== 'passed'
      || (options.vsix && (report.artifactSha256 !== env.LAUNCHER_HOST_ARTIFACT_SHA256
        || report.extensionVersion !== env.LAUNCHER_HOST_ARTIFACT_VERSION
        || report.captureIntegration?.stage !== 'rejected-and-persisted'))
      || (options['download-version'] && report.vscode !== options['download-version'])) {
      options.keep = true;
      throw new Error('Host não aprovado: ' + JSON.stringify({
        exitCode: execution.code, timedOut: execution.timedOut, report: report ?? null,
        logTail: execution.output.slice(-2500),
      }));
    }
    passed = true;
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    options.keep = true;
    await fs.writeFile(path.join(temporary, 'runner-failure.json'), JSON.stringify({
      status: 'failed', error: error.message, platform: process.platform, arch: process.arch,
      runnerNode: process.version, requestedEditorVersion: options['download-version'] ?? null,
      editorSandboxPolicy,
      artifactSha256: env?.LAUNCHER_HOST_ARTIFACT_SHA256 ?? null,
      source: 'synthetic fixtures; no Claude authentication, AI or paid service',
    }, null, 2));
    throw error;
  } finally {
    if (reportDirectory) {
      // Only synthetic evidence is exported. Never copy the profile or caller's environment.
      const summary = await exportEvidence(temporary, reportDirectory, {
        schemaVersion: 1, status: passed ? 'passed' : 'failed', runnerNode: process.version,
        platform: process.platform, arch: process.arch,
        editorSandboxPolicy,
        requestedEditorVersion: options['download-version'] ?? null,
        artifactSha256: env?.LAUNCHER_HOST_ARTIFACT_SHA256 ?? null,
      });
      console.log('Evidências desta execução: ' + JSON.stringify(summary));
    }
    if (options.keep) console.log('Evidências do perfil isolado: ' + temporary);
    else await fs.rm(temporary, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
