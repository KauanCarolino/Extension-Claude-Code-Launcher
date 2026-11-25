'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const vscode = require('vscode');
const launcherManifest = require('../../package.json');
const LAUNCHER_ID = launcherManifest.publisher + '.' + launcherManifest.name;
const { observeRuntime } = require('./observe-runtime.cjs');

async function until(work, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await work()) return; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw new Error('Timeout: ' + label);
}

async function measure(work, observer) {
  const before = { ...observer?.io }; const memory = process.memoryUsage(); const start = performance.now();
  const probe = new Promise(resolve => setTimeout(() => resolve(performance.now() - start), 0));
  await work(); const elapsedMs = performance.now() - start;
  return { elapsedMs, timerProbeMs: await probe, heapDeltaBytes: process.memoryUsage().heapUsed - memory.heapUsed,
    ioCalls: observer ? Object.fromEntries(Object.entries(observer.io).map(([key, value]) => [key, value - (before[key] || 0)])) : null };
}

exports.run = async () => {
  const report = { scenario: 'owned-component-lifecycle', editor: vscode.env.appName, vscode: vscode.version,
    node: process.version, platform: process.platform, arch: process.arch,
    artifactSha256: process.env.LAUNCHER_HOST_ARTIFACT_SHA256, checks: [], cycles: [], homeCycles: [],
    method: 'Verified installed component source, observational CommonJS loader, real ExtensionContext and forwarded real editor/fs APIs. The private controller and home classes are exposed from the installed bundle by appended test-only exports in the VM; production bytes are unchanged. Counts cover these component instances, not all editor handles. Heap deltas are noisy process observations, not GC-retained size or proof of leak.' };
  try {
    const extension = vscode.extensions.getExtension(LAUNCHER_ID); assert(extension);
    report.extensionVersion = extension.packageJSON.version;
    assert.equal(report.extensionVersion, process.env.LAUNCHER_HOST_ARTIFACT_VERSION);
    report.activeBeforeActivationMeasurement = extension.isActive;
    report.activation = await measure(() => extension.activate());
    report.activationInterpretation = report.activeBeforeActivationMeasurement ? 'already active; activation await only, not startup duration' : 'explicit installed extension activation, includes public API initialization';
    const driver = vscode.extensions.getExtension('local.launcher-contract-driver'); assert(driver);
    const { context } = await driver.activate(); assert(context);
    // Use the installed extension URI for actual packaged webview assets, while
    // the test driver supplies genuine isolated Mementos and ExtensionContext.
    const componentContext = new Proxy(context, { get(target, key) {
      if (key === 'extensionUri') return extension.extensionUri;
      const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    await vscode.commands.executeCommand('claude-code-launcher.releaseReviewWriter');
    const extra = path.join(path.dirname(process.env.LAUNCHER_HOST_WORKSPACE), 'second-root');
    await fs.mkdir(extra, { recursive: true });
    for (let index = 0; index < 5; index++) {
      // The package ships one bundle (dist/extension.js); the controller class is exposed from it.
      const observer = observeRuntime(vscode, path.join(extension.extensionPath, 'dist'));
      const { __testChangesController: ChangesController } = observer.load(path.join(extension.extensionPath, 'dist/extension.js'), { __testChangesController: 'ChangesController' });
      const beforeHeap = process.memoryUsage().heapUsed;
      let controller;
      const initialization = await measure(async () => { controller = new ChangesController(componentContext); await controller.refresh(); }, observer);
      const baseline = observer.snapshot();
      const samples = [];
      for (let repeat = 0; repeat < 3; repeat++) {
        controller.openPanel();
        samples.push(await measure(() => controller.refresh(), observer));
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      }
      const folderEvent = new Promise(resolve => { const listener = vscode.workspace.onDidChangeWorkspaceFolders(() => { listener.dispose(); resolve(); }); });
      assert(vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders.length, 0, { uri: vscode.Uri.file(extra) }));
      await folderEvent; await controller.refresh();
      const removed = new Promise(resolve => { const listener = vscode.workspace.onDidChangeWorkspaceFolders(() => { listener.dispose(); resolve(); }); });
      assert(vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders.length - 1, 1));
      await removed; await controller.refresh();
      controller.openPanel();
      const pending = controller.refresh();
      observer.markDisposed(); controller.dispose(); await Promise.all([pending, controller.whenDisposed()]);
      // Drain scheduled work past debounce without sleeping over a pending test.
      await new Promise(resolve => setTimeout(resolve, 450));
      const after = observer.snapshot();
      report.cycles.push({ index, initialization, refresh: samples, baseline, after,
        postCount: observer.posts.length, heapAfterDrainDeltaBytes: process.memoryUsage().heapUsed - beforeHeap });
      assert.equal(after.total, 0, 'Owned resources must return to zero after component disposal: ' + JSON.stringify(after));
      assert.equal(after.latePosts, 0, 'No late publication after disposal');
      assert.equal(controller.activeOperations.size, 0); assert.equal(controller.backgroundTasks.size, 0);
    }
    report.checks.push('five actual component activations/disposals, fifteen panels opened/closed, five folder add/remove cycles, disposal with in-flight refresh and open panel');
    const sessionDirectory = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.env.LAUNCHER_HOST_WORKSPACE.replace(/[^a-zA-Z0-9]/g, '-'));
    await fs.mkdir(sessionDirectory, { recursive: true });
    for (let index = 0; index < 1000; index++) {
      const id = '00000000-0000-4000-8000-' + String(index).padStart(12, '0');
      await fs.writeFile(path.join(sessionDirectory, id + '.jsonl'), JSON.stringify({ type: 'user', message: { content: 'Synthetic lifecycle conversation ' + index } }) + '\n');
    }
    for (let index = 0; index < 5; index++) {
      const observer = observeRuntime(vscode, path.join(extension.extensionPath, 'dist'));
      const { __testHomeProvider: Home } = observer.load(path.join(extension.extensionPath, 'dist/extension.js'), { __testHomeProvider: 'LauncherViewProvider' });
      const provider = new Home(componentContext); let wrapped;
      const viewId = 'launcher-contract-driver.home' + index;
      const registration = vscode.window.registerWebviewViewProvider(viewId, { resolveWebviewView(view) {
        wrapped = observer.wrapView(view); provider.resolveWebviewView(wrapped.view);
      } });
      try {
        await vscode.commands.executeCommand(viewId + '.focus');
        await until(() => observer.posts.length, 'real home view initial result');
        const baseline = observer.snapshot(); const refresh = [];
        for (let repeat = 0; repeat < 3; repeat++) {
          refresh.push(await measure(() => provider.postState(), observer));
          await vscode.commands.executeCommand('workbench.action.closeSidebar');
          await vscode.commands.executeCommand(viewId + '.focus');
          await until(() => provider.view?.visible, 'home view visible again');
        }
        const readsBefore = observer.io['fs.promises.readdir'] || 0;
        const pending = provider.postState();
        assert.equal(observer.io['fs.promises.readdir'], readsBefore + 1, 'Disposal must interrupt actual session IO, not an invisible-view no-op');
        provider.refresh(30);
        observer.markDisposed(); provider.dispose(); await pending;
        registration.dispose(); wrapped?.disposeObservation();
        await new Promise(resolve => setTimeout(resolve, 450));
        const after = observer.snapshot(); report.homeCycles.push({ index, syntheticSessions: 1000, baseline, refresh, after });
        assert.equal(after.total, 0, 'Home-owned listeners/timers must drain: ' + JSON.stringify(after));
        assert.equal(after.latePosts, 0, 'Home must discard pending results after disposal');
      } finally { provider.dispose(); registration.dispose(); wrapped?.disposeObservation(); }
    }
    report.checks.push('five real home view lifecycles with 1000 synthetic sessions, hide/show, queued refresh and in-flight IO discarded on disposal');
    report.status = 'passed';
  } catch (error) { report.status = 'failed'; report.error = error.stack || String(error); throw error; }
  finally { await fs.writeFile(process.env.LAUNCHER_HOST_REPORT, JSON.stringify(report, null, 2)); }
};
