'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');

const DIAGNOSTIC_KEYS = ['schemaVersion', 'id', 'kind', 'phase', 'stage', 'code', 'observedAt', 'contentCoverage'];
const DIAGNOSTIC_STAGES = ['input', 'scope', 'policy', 'inventory', 'snapshot', 'pending', 'append', 'completion', 'maintenance'];
const DIAGNOSTIC_CODES = [
  'capturePrepared', 'captureRecorded', 'capturePaused', 'captureMaintenance', 'captureGenerationChanged',
  'quotaExceeded', 'invalidPolicy', 'excludedByPolicy', 'resourceOutsideScope', 'inputBudgetExceeded',
  'storagePermissionDenied', 'storageReadOnly', 'storageFull', 'storageInventoryBudget', 'unsafeStorageType',
  'blobIntegrityFailed', 'pendingGenerationChanged', 'invalidPending', 'storageUnavailable',
];

function validDiagnosticEvent(value, kind, filename, now = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== DIAGNOSTIC_KEYS.length
    || Object.keys(value).some(key => !DIAGNOSTIC_KEYS.includes(key))) return false;
  const date = typeof value.observedAt === 'string' ? Date.parse(value.observedAt) : NaN;
  return value.schemaVersion === 2 && value.kind === kind && ['observation', 'completion'].includes(kind)
    && typeof value.id === 'string' && /^[a-f0-9]{32}$/.test(value.id) && ['pre', 'post'].includes(value.phase)
    && DIAGNOSTIC_STAGES.includes(value.stage) && DIAGNOSTIC_CODES.includes(value.code)
    && ['complete', 'limited', 'none', 'unknown'].includes(value.contentCoverage)
    && Number.isFinite(date) && date >= 0 && date <= now + 5 * 60 * 1000 && new Date(date).toISOString() === value.observedAt
    && filename === value.observedAt.replace(/[-:.]/g, '') + '-' + value.id + '.json'
    && (kind !== 'completion' || value.phase === 'post' && value.stage === 'append' && value.code === 'captureRecorded')
    && (value.code !== 'captureRecorded' || value.phase === 'post' && value.stage === 'append')
    && (value.code !== 'capturePrepared' || value.phase === 'pre' && value.stage === 'pending');
}

async function createEvidenceDirectory(base) {
  const directory = path.resolve(base);
  await fs.mkdir(directory, { recursive: true });
  return fs.mkdtemp(path.join(directory, 'run-'));
}

async function exportEvidence(temporary, destination, summary) {
  const copied = [];
  for (const name of ['result.json', 'host.log', 'installation.log', 'package-verification.json', 'runner-failure.json']) {
    try { await fs.copyFile(path.join(temporary, name), path.join(destination, name)); copied.push(name); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const result = { ...summary, evidenceDirectory: destination, runId: path.basename(destination),
    resultFile: copied.includes('result.json') ? 'result.json' : null, files: copied };
  await fs.writeFile(path.join(destination, 'runner.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  return result;
}

function parseArguments(args) {
  const result = { editor: 'code', keep: false };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (seen.has(name)) throw new Error('Argumento repetido: ' + name);
    seen.add(name);
    if (name === '--keep') result.keep = true;
    else if (['--editor', '--executable', '--cli', '--vsix', '--download-version', '--report-dir'].includes(name)
      && args[index + 1] && !args[index + 1].startsWith('--')) result[name.slice(2)] = args[++index];
    else throw new Error('Argumento inválido: ' + name);
  }
  if (!['code', 'cursor'].includes(result.editor)) throw new Error('Editor deve ser code ou cursor.');
  if (result['download-version'] && (!/^\d+\.\d+\.\d+$/.test(result['download-version'])
    || result.editor !== 'code' || result.executable || result.cli)) {
    throw new Error('--download-version exige versão exata de VS Code e não aceita --executable/--cli.');
  }
  return result;
}

function assertHookNode(version) {
  if (!/^v?\d+\.\d+\.\d+(?:[-+].*)?$/.test(version) || Number(version.replace(/^v/, '').split('.')[0]) < 22) {
    throw new Error('O Node externo do hook deve ser >=22; recebido: ' + version);
  }
}

function hostEnvironment(temporary, workspace, reportPath, base = process.env, hookNode = process.execPath, hookVersion = process.version) {
  assertHookNode(hookVersion);
  if (!path.isAbsolute(hookNode)) throw new Error('O executável Node externo deve ter caminho absoluto.');
  const env = { ...base,
    CLAUDE_CONFIG_DIR: path.join(temporary, 'claude'),
    LAUNCHER_HOST_REPORT: reportPath,
    LAUNCHER_HOST_WORKSPACE: workspace,
    LAUNCHER_HOST_HOOK_NODE: hookNode,
    LAUNCHER_HOST_HOOK_NODE_VERSION: hookVersion,
  };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'VSCODE_IPC_HOOK_CLI',
    'LAUNCHER_HOST_ARTIFACT_SHA256', 'LAUNCHER_HOST_HOOK_SHA256', 'LAUNCHER_HOST_ARTIFACT_VERSION',
    'LAUNCHER_HOST_EXPECTED_VERSION']) delete env[key];
  return env;
}

async function provisionEditor(options, temporary, download) {
  if (options['download-version']) {
    const provision = download || require('@vscode/test-electron').downloadAndUnzipVSCode;
    // An exact pin prevents an offline/"stable" fallback from silently changing the target.
    return provision({ version: options['download-version'], cachePath: path.join(temporary, 'editor'), timeout: 30000 });
  }
  if (options.executable) return path.resolve(options.executable);
  if (process.platform !== 'darwin') throw new Error('Informe --executable ou --download-version.');
  const application = options.editor === 'cursor' ? 'Cursor' : 'Visual Studio Code';
  return path.join('/Applications', application + '.app', 'Contents/MacOS', options.editor === 'cursor' ? 'Cursor' : 'Code');
}

function cliScript(executable, platform = process.platform) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  return platform === 'darwin'
    ? paths.resolve(paths.dirname(executable), '../Resources/app/out/cli.js')
    : paths.resolve(paths.dirname(executable), 'resources/app/out/cli.js');
}

function run(executable, args, env, { timeout = 120000, cwd, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let output = '';
    let timedOut = false;
    let forceTimer;
    const append = data => { output = (output + data.toString()).slice(-128000); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
      forceTimer.unref();
    }, timeout);
    const clear = () => { clearTimeout(timer); clearTimeout(forceTimer); };
    child.once('error', error => { clear(); reject(error); });
    child.once('close', (code, signal) => { clear(); resolve({ code, signal, timedOut, output }); });
    if (input !== undefined) {
      child.stdin.on('error', error => { if (error.code !== 'EPIPE') { clear(); child.kill(); reject(error); } });
      child.stdin.end(input);
    }
  });
}

module.exports = { parseArguments, assertHookNode, hostEnvironment, provisionEditor, cliScript, run,
  validDiagnosticEvent, createEvidenceDirectory, exportEvidence };
