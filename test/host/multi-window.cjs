'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const launcherManifest = require('../../package.json');
const LAUNCHER_ID = launcherManifest.publisher + '.' + launcherManifest.name;

async function until(fn, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timeout: ' + label);
}

exports.run = async () => {
  const workspace = process.env.LAUNCHER_HOST_WORKSPACE;
  const barrier = process.env.LAUNCHER_HOST_BARRIER;
  const role = process.env.LAUNCHER_HOST_ROLE;
  assert(workspace && barrier && ['writer', 'reader'].includes(role));
  const report = { scenario: 'two-real-windows', role, editor: vscode.env.appName, vscode: vscode.version,
    node: process.version, platform: process.platform, arch: process.arch,
    artifactSha256: process.env.LAUNCHER_HOST_ARTIFACT_SHA256, checks: [] };
  const signal = async name => {
    const file = path.join(barrier, name + '.json'); await fs.writeFile(file + '.tmp', JSON.stringify({ ready: true }), { flag: 'wx' }); await fs.rename(file + '.tmp', file);
  };
  const wait = name => until(async () => { try { return JSON.parse(await fs.readFile(path.join(barrier, name + '.json'), 'utf8')).ready; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }, name);
  const state = async () => JSON.parse(await fs.readFile(path.join(workspace, '.claude/launcher-changes/review-state.v1.json'), 'utf8'));
  const reviewOf = value => Object.values(value.reviews).flat().find(review => review.ids.includes('contract-partial'));
  try {
    const extension = vscode.extensions.getExtension(LAUNCHER_ID);
    assert(extension); await extension.activate();
    assert.equal(extension.packageJSON.version, process.env.LAUNCHER_HOST_ARTIFACT_VERSION);
    if (process.env.LAUNCHER_HOST_EXPECTED_VERSION) assert.equal(vscode.version, process.env.LAUNCHER_HOST_EXPECTED_VERSION);
    report.extensionVersion = extension.packageJSON.version;
    const uri = vscode.Uri.file(path.join(workspace, 'partial.txt'));
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
    const lenses = () => vscode.commands.executeCommand('vscode.executeCodeLensProvider', uri);
    if (role === 'writer') {
      const items = await until(async () => { const list = await lenses(); return list?.some(item => item.command?.command === 'claude-code-launcher.acceptChange') && list; }, 'writer lenses');
      const accept = items.find(item => item.command?.command === 'claude-code-launcher.acceptChange').command;
      await vscode.commands.executeCommand(accept.command, ...(accept.arguments || []));
      await until(async () => reviewOf(await state())?.accepted === 1, 'partial decision persisted');
      report.checks.push('first real window persists a partial acceptance');
      await signal('writer-ready');
      await wait('reader-observed');
      await vscode.commands.executeCommand('claude-code-launcher.releaseReviewWriter');
      await signal('writer-released');
      await wait('reader-finished');
      await vscode.commands.executeCommand('claude-code-launcher.refreshChanges');
      await until(() => document.getText() === 'ONE\ntwo\nthree\n', 'first window observes saved result');
      assert.equal((await state()).statuses['contract-partial'], 'mixed');
      report.checks.push('first real window observes transferred decision without losing its accepted hunk');
      await signal('writer-observed-result');
    } else {
      await wait('writer-ready');
      await vscode.commands.executeCommand('claude-code-launcher.refreshChanges');
      assert.equal(reviewOf(await state()).accepted, 1);
      const before = await fs.readFile(uri.fsPath);
      const items = await lenses();
      assert(!(items || []).some(item => ['claude-code-launcher.acceptChange', 'claude-code-launcher.rejectChange'].includes(item.command?.command)), 'A second real window must remain read-only while the first owns the store.');
      // Public command remains guarded even when invoked without a clickable lens.
      try { await vscode.commands.executeCommand('claude-code-launcher.rejectAllChanges', uri.toString()); } catch {}
      assert.deepEqual(await fs.readFile(uri.fsPath), before);
      assert.equal(reviewOf(await state()).accepted, 1);
      assert.equal((await state()).statuses['contract-partial'], undefined);
      let reloaded = false;
      try { await fs.access(path.join(barrier, 'reload-prepared.json')); reloaded = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!reloaded) {
        await signal('reload-prepared');
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
        // Reload terminates this Extension Host. The same test entrypoint resumes
        // in the new host and must re-observe the saved partial decision.
        await new Promise(() => {});
      }
      report.reloadedWindow = true;
      report.checks.push('fresh second host loads persisted partial review and refuses mutation under another owner');
      report.checks.push('actual reloadWindow preserves the partial decision and read-only ownership');
      await signal('reader-observed');
      await wait('writer-released');
      await vscode.commands.executeCommand('claude-code-launcher.recoverReviewWriter');
      await until(async () => (await lenses())?.some(item => item.command?.command === 'claude-code-launcher.rejectChange'), 'transferred writer lenses');
      await vscode.commands.executeCommand('claude-code-launcher.rejectAllChanges', uri.toString());
      await until(async () => (await fs.readFile(uri.fsPath, 'utf8')) === 'ONE\ntwo\nthree\n' && (await state()).statuses['contract-partial'] === 'mixed', 'transferred rejection');
      report.checks.push('ownership transfers explicitly and rejection preserves the previously accepted hunk');
      await signal('reader-finished');
      await wait('writer-observed-result');
      await vscode.commands.executeCommand('claude-code-launcher.releaseReviewWriter');
    }
    report.status = 'passed';
  } catch (error) { report.status = 'failed'; report.error = error.stack || String(error); throw error; }
  finally { await fs.writeFile(process.env.LAUNCHER_HOST_REPORT + '.tmp', JSON.stringify(report, null, 2)); await fs.rename(process.env.LAUNCHER_HOST_REPORT + '.tmp', process.env.LAUNCHER_HOST_REPORT); }
};
