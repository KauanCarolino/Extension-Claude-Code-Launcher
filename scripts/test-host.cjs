'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { verifyPackage } = require('./verify-package.cjs');

const root = path.resolve(__dirname, '..');

function parseArguments(args) {
  const result = { editor: 'code', keep: false };
  while (args.length) {
    const name = args.shift();
    if (name === '--keep') result.keep = true;
    else if (['--editor', '--executable', '--cli', '--vsix'].includes(name) && args.length) {
      result[name.slice(2)] = args.shift();
    } else throw new Error('Argumento inválido: ' + name);
  }
  if (!['code', 'cursor'].includes(result.editor)) throw new Error('Editor deve ser code ou cursor.');
  return result;
}

function run(executable, args, env, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let timedOut = false;
    const append = data => { output = (output + data.toString()).slice(-128000); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, timeout);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut, output });
    });
  });
}

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
  const application = options.editor === 'cursor' ? 'Cursor' : 'Visual Studio Code';
  const app = '/Applications/' + application + '.app/Contents';
  const executable = options.executable || (process.platform === 'darwin'
    ? path.join(app, 'MacOS', options.editor === 'cursor' ? 'Cursor' : 'Code') : undefined);
  if (!executable) throw new Error('Informe --executable com o executável do editor instalado.');
  await fs.access(executable);
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-host-')));
  const workspace = path.join(temporary, 'workspace');
  const profile = path.join(temporary, 'profile');
  const extensions = path.join(temporary, 'extensions');
  const reportPath = path.join(temporary, 'result.json');
  const env = { ...process.env,
    CLAUDE_CONFIG_DIR: path.join(temporary, 'claude'),
    LAUNCHER_HOST_REPORT: reportPath,
    LAUNCHER_HOST_WORKSPACE: workspace,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  delete env.VSCODE_IPC_HOOK_CLI;
  try {
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
      env.LAUNCHER_HOST_ARTIFACT_SHA256 = verified.sha256;
      const cli = options.cli || (process.platform === 'darwin' ? path.join(app, 'Resources/app/out/cli.js') : undefined);
      if (!cli) throw new Error('Modo --vsix exige --cli com o cli.js deste editor.');
      const installation = await run(executable, [
        cli, '--user-data-dir', profile, '--extensions-dir', extensions,
        '--install-extension', artifact, '--force', '--do-not-sync',
      ], { ...env, ELECTRON_RUN_AS_NODE: '1' });
      if (installation.code !== 0) throw new Error('Instalação isolada falhou: ' + installation.output.slice(-4000));
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
      '--new-window', '--disable-gpu', '--skip-welcome', '--skip-release-notes',
      '--disable-workspace-trust', '--disable-telemetry',
      '--user-data-dir=' + profile, '--extensions-dir=' + extensions,
      '--extensionDevelopmentPath=' + developmentPath,
      '--extensionTestsPath=' + path.join(root, 'test/host/suite.cjs'), workspace,
    ], env);
    await fs.writeFile(path.join(temporary, 'host.log'), execution.output);
    let report;
    try { report = JSON.parse(await fs.readFile(reportPath, 'utf8')); } catch {}
    if (execution.code !== 0 || execution.timedOut || !report || report.status !== 'passed') {
      options.keep = true;
      throw new Error('Host não aprovado: ' + JSON.stringify({
        exitCode: execution.code, timedOut: execution.timedOut, report: report ?? null,
        logTail: execution.output.slice(-2500),
      }));
    }
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (options.keep) console.log('Evidências do perfil isolado: ' + temporary);
    else await fs.rm(temporary, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
