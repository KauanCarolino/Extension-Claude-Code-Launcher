'use strict';

// Only synthetic workspaces and isolated profiles are created by this runner.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { parseArguments, hostEnvironment, provisionEditor, cliScript, editorFixtureArguments, run, runUntilReport, validateContractReport,
  createEvidenceDirectory, exportEvidence, removeTemporary } = require('./host-tooling.cjs');
const { verifyPackage } = require('./verify-package.cjs');
const root = path.resolve(__dirname, '..');

async function waitFor(file, failureFile, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { await fs.access(file); return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { const result = JSON.parse(await fs.readFile(failureFile, 'utf8')); if (result.status === 'failed') throw new Error(result.error); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Host did not reach its coordination checkpoint.');
}

async function main() {
  const [scenario, ...argv] = process.argv.slice(2);
  if (!['multi-window', 'lifecycle', 'official'].includes(scenario)) throw new Error('Scenario must be multi-window, lifecycle or official.');
  let officialSource;
  const officialArgument = argv.indexOf('--official-extension');
  if (officialArgument !== -1) {
    if (scenario !== 'official' || !argv[officialArgument + 1] || argv[officialArgument + 1].startsWith('--')) throw new Error('--official-extension requires the official scenario and an installed extension program directory.');
    officialSource = path.resolve(argv[officialArgument + 1]); argv.splice(officialArgument, 2);
  }
  if (scenario === 'official' && !officialSource) throw new Error('Official scenario requires --official-extension.');
  const options = parseArguments(argv);
  const sourceRoot = options['source-root'] ? path.resolve(options['source-root']) : root;
  if (!options.vsix) throw new Error('Contract hosts require a verified --vsix.');
  // macOS AF_UNIX sockets include this path and must remain below 104 bytes.
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lc-')));
  const workspace = path.join(temporary, 'workspace');
  const extensions = path.join(temporary, 'extensions');
  const barrier = path.join(temporary, 'coordination');
  const evidence = options['report-dir'] && await createEvidenceDirectory(options['report-dir']);
  let passed = false;
  let verification;
  let officialEvidence;
  const running = [];
  const cancellation = new AbortController();
  try {
    for (const directory of [workspace, extensions, barrier]) await fs.mkdir(directory, { recursive: true });
    const launchTarget = scenario === 'lifecycle' ? path.join(temporary, 'fixture.code-workspace') : workspace;
    if (scenario === 'lifecycle') await fs.writeFile(launchTarget, JSON.stringify({ folders: [{ path: workspace }], settings: {} }));
    await fs.writeFile(path.join(workspace, 'partial.txt'), 'ONE\ntwo\nTHREE\n');
    const history = path.join(workspace, '.claude/launcher-changes'); await fs.mkdir(history, { recursive: true });
    await fs.writeFile(path.join(history, 'log.jsonl'), JSON.stringify({ id: 'contract-partial', time: new Date().toISOString(),
      file: path.join(workspace, 'partial.txt'), tool: 'Edit', session: 'synthetic-contract', toolUseId: 'contract-partial', transcript: null, reason: null,
      before: { exists: true, text: 'one\ntwo\nthree\n', large: false }, after: { exists: true, text: 'ONE\ntwo\nTHREE\n', large: false } }) + '\n');
    const executable = await provisionEditor(options, temporary);
    const artifact = path.resolve(options.vsix); verification = await verifyPackage(artifact, sourceRoot);
    await fs.writeFile(path.join(temporary, 'package-verification.json'), JSON.stringify(verification, null, 2));
    const driver = path.join(temporary, 'driver'); await fs.mkdir(driver);
    await fs.writeFile(path.join(driver, 'package.json'), JSON.stringify({ name: 'launcher-contract-driver', publisher: 'local', version: '1.0.0', engines: { vscode: '^1.94.0' }, main: './index.js', activationEvents: ['*'],
      contributes: scenario === 'lifecycle' ? { views: { explorer: Array.from({ length: 5 }, (_, index) => ({ id: 'launcher-contract-driver.home' + index, name: 'Synthetic lifecycle ' + index, type: 'webview' })) } } : undefined }));
    const multiWindowDriver = 'exports.activate = context => { setImmediate(() => Promise.resolve(require('
      + JSON.stringify(path.join(root, 'test/host/multi-window.cjs')) + ').run()).finally(() => require("vscode").commands.executeCommand("workbench.action.quit")).catch(() => {})); return { context }; };\n';
    // Normal development windows survive reloadWindow. --extensionTestsPath
    // intentionally terminates the editor when its test host restarts.
    await fs.writeFile(path.join(driver, 'index.js'), scenario === 'multi-window' ? multiWindowDriver : 'exports.activate = context => ({ context });\n');
    const prepare = async role => {
      const profile = path.join(temporary, role[0]); await fs.mkdir(path.join(profile, 'User'), { recursive: true });
      await fs.writeFile(path.join(profile, 'User/settings.json'), JSON.stringify({ 'telemetry.telemetryLevel': 'off', 'update.mode': 'none',
        'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false, 'workbench.startupEditor': 'none',
        'window.restoreWindows': 'none', 'claudeCodeLauncher.manageEditorGroups': false, 'claudeCodeLauncher.hookExecutionMode': 'disabled' }));
      const env = hostEnvironment(temporary, workspace, path.join(temporary, role + '.json'));
      await fs.mkdir(env.CLAUDE_CONFIG_DIR, { recursive: true });
      Object.assign(env, { LAUNCHER_HOST_ROLE: role, LAUNCHER_HOST_BARRIER: barrier,
        LAUNCHER_HOST_ARTIFACT_SHA256: verification.sha256, LAUNCHER_HOST_ARTIFACT_VERSION: verification.version });
      if (options['download-version']) env.LAUNCHER_HOST_EXPECTED_VERSION = options['download-version'];
      if (scenario === 'official') {
        for (const name of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_OAUTH|CLAUDE_CODE_API_KEY|AWS_|AZURE_|GOOGLE_|VERTEX_)/.test(name)) delete env[name];
        env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'; env.DISABLE_TELEMETRY = '1';
      }
      return { profile, env };
    };
    const writer = await prepare('writer'); const reader = await prepare('reader');
    if (officialSource) {
      const manifest = JSON.parse(await fs.readFile(path.join(officialSource, 'package.json'), 'utf8'));
      if ((manifest.publisher + '.' + manifest.name).toLowerCase() !== 'anthropic.claude-code') throw new Error('Expected the already installed official Claude Code extension.');
      const copied = path.join(extensions, 'anthropic.claude-code-' + manifest.version);
      await fs.cp(officialSource, copied, { recursive: true, errorOnExist: true, force: false, dereference: false });
      const entry = await fs.readFile(path.join(copied, 'extension.js'));
      const binary = path.join(copied, 'resources/native-binary', process.platform === 'win32' ? 'claude.exe' : 'claude');
      const binaryVersion = await run(binary, ['--version'], writer.env, { cwd: workspace, timeout: 20000 });
      const versionMatch = /^(\d+\.\d+\.\d+)(?:\s|$)/.exec(binaryVersion.output.trim());
      if (binaryVersion.code !== 0 || binaryVersion.timedOut || !versionMatch) throw new Error('Official CLI version could not be identified.');
      const status = await run(binary, ['auth', 'status'], writer.env, { cwd: workspace, timeout: 20000 });
      if (status.timedOut || ![0, 1].includes(status.code)) throw new Error('Official CLI auth status unavailable.');
      let auth; try { auth = JSON.parse(status.output); } catch { throw new Error('Official CLI auth status was not JSON; raw output not retained.'); }
      if (!auth || typeof auth.loggedIn !== 'boolean' || auth.loggedIn !== (status.code === 0)) throw new Error('Official CLI auth status schema or exit code was inconsistent; raw output not retained.');
      if (typeof auth.configDirectory === 'string' && path.resolve(auth.configDirectory) !== path.resolve(writer.env.CLAUDE_CONFIG_DIR)) throw new Error('Official CLI reported a different config directory.');
      officialEvidence = { version: manifest.version, entrySha256: crypto.createHash('sha256').update(entry).digest('hex'),
        cliVersion: versionMatch[1],
        auth: { exitCode: status.code, loggedIn: auth.loggedIn, isolatedConfigReported: typeof auth.configDirectory === 'string', authMethod: ['none', 'claude.ai', 'oauth_token', 'api_key', 'api_key_helper', 'third_party'].includes(auth.authMethod) ? auth.authMethod : 'unknown' },
        scope: 'Program files copied from installed official extension; isolated config; auth status and synthetic Setup initialization; no login/logout or model message' };
      if (officialEvidence.auth.loggedIn) throw new Error('No-auth smoke requires an unauthenticated isolated CLI; no login or logout was attempted.');
      officialEvidence.hookProbe = await require('./official-hook-probe.cjs').probeOfficialHooks({ binary, env: writer.env, workspace, temporary, hooksModulePath: path.join(sourceRoot, 'out/hooks.js') });
    }
    const installation = await run(executable, [options.cli ? path.resolve(options.cli) : cliScript(executable), '--user-data-dir', writer.profile,
      '--extensions-dir', extensions, '--install-extension', artifact, '--force', '--do-not-sync'], { ...writer.env, ELECTRON_RUN_AS_NODE: '1' }, { cwd: root });
    await fs.writeFile(path.join(temporary, 'installation.log'), installation.output);
    if (installation.code !== 0 || installation.timedOut) throw new Error('Isolated installation failed.');
    const launch = async ({ profile, env }, role) => {
      const validateReport = report => validateContractReport(report, { scenario, role, sha256: verification.sha256,
        version: verification.version, vscodeVersion: options['download-version'] });
      const runner = scenario === 'multi-window' ? runUntilReport : run;
      const result = await runner(executable, [...editorFixtureArguments(process.platform, Boolean(options['download-version'])),
        '--new-window', '--disable-gpu', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--disable-telemetry',
        '--user-data-dir=' + profile, '--extensions-dir=' + extensions, '--extensionDevelopmentPath=' + driver,
        ...(scenario === 'multi-window' ? [] : ['--extensionTestsPath=' + path.join(root, 'test/host/' + scenario + '.cjs')]), launchTarget], env,
        { cwd: root, signal: cancellation.signal, reportFile: path.join(temporary, role + '.json'), validateReport });
      await fs.writeFile(path.join(temporary, role + '.log'), result.output);
      const report = result.report || JSON.parse(await fs.readFile(path.join(temporary, role + '.json'), 'utf8'));
      validateReport(report);
      if (scenario !== 'multi-window' && (result.code !== 0 || result.timedOut || result.cancelled)) throw new Error('Contract host failed: ' + role + ': ' + JSON.stringify({ status: report.status, error: report.error, editor: report.editor, vscode: report.vscode, exitCode: result.code, timedOut: result.timedOut, cancelled: result.cancelled }));
      return { ...report, processCompletion: { shutdown: result.shutdown || 'normal-exit', exitCode: result.code,
        signal: result.signal, timedOut: result.timedOut, cancelled: result.cancelled } };
    };
    const first = launch(writer, 'writer'); running.push(first); first.catch(() => undefined);
    if (scenario === 'multi-window') {
      await waitFor(path.join(barrier, 'writer-ready.json'), path.join(temporary, 'writer.json'));
      const second = launch(reader, 'reader'); running.push(second); second.catch(() => undefined);
    }
    const reports = await Promise.all(running);
    await fs.writeFile(path.join(temporary, 'result.json'), JSON.stringify({ status: 'passed', scenario, artifactSha256: verification.sha256, extensionVersion: verification.version, sourceVerification: sourceRoot === root ? 'current-workspace' : 'explicit-source-snapshot', official: officialEvidence, hosts: reports }, null, 2));
    passed = true;
  } catch (error) {
    cancellation.abort();
    options.keep = true;
    await fs.writeFile(path.join(temporary, 'runner-failure.json'), JSON.stringify({ status: 'failed', scenario, error: error.message }, null, 2));
    throw error;
  } finally {
    await Promise.allSettled(running);
    if (!passed) {
      const hosts = [];
      for (const role of ['writer', 'reader']) { try { hosts.push(JSON.parse(await fs.readFile(path.join(temporary, role + '.json'), 'utf8'))); } catch {} }
      if (hosts.length) await fs.writeFile(path.join(temporary, 'result.json'), JSON.stringify({ status: 'failed', scenario, artifactSha256: verification?.sha256, hosts }, null, 2));
    }
    const logs = [];
    for (const role of ['writer', 'reader']) { try { logs.push(role + '\n' + await fs.readFile(path.join(temporary, role + '.log'), 'utf8')); } catch {} }
    await fs.writeFile(path.join(temporary, 'host.log'), logs.join('\n'));
    if (evidence) console.log(JSON.stringify(await exportEvidence(temporary, evidence, { status: passed ? 'passed' : 'failed', scenario,
      artifactSha256: verification?.sha256 ?? null, platform: process.platform, arch: process.arch, runnerNode: process.version })));
    if (options.keep) console.log('Isolated evidence: ' + temporary);
    else await removeTemporary(temporary);
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
