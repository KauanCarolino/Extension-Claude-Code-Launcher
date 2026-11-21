'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const vscode = require('vscode');
const launcherManifest = require('../../package.json');
const LAUNCHER_ID = launcherManifest.publisher + '.' + launcherManifest.name;

exports.run = async () => {
  const report = { scenario: 'official-extension-no-message', editor: vscode.env.appName, vscode: vscode.version,
    node: process.version, platform: process.platform, arch: process.arch,
    artifactSha256: process.env.LAUNCHER_HOST_ARTIFACT_SHA256, checks: [],
    limits: 'No prompt, model request, login mutation, account credentials or paid conversation. CLI auth state is separate from webview UI state; an open tab does not prove authentication.' };
  try {
    const launcher = vscode.extensions.getExtension(LAUNCHER_ID); assert(launcher);
    report.extensionVersion = launcher.packageJSON.version; assert.equal(report.extensionVersion, process.env.LAUNCHER_HOST_ARTIFACT_VERSION);
    const official = vscode.extensions.getExtension('anthropic.claude-code'); assert(official);
    report.officialVersion = official.packageJSON.version;
    await launcher.activate();
    await vscode.commands.executeCommand('claude-code-launcher.openTab');
    assert(official.isActive, 'Launcher must activate the real official extension.');
    const deadline = Date.now() + 15000;
    let tabs;
    while (Date.now() < deadline) {
      tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputWebview && /claude/i.test(tab.input.viewType));
      if (tabs.length) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert(tabs?.length, 'The real official webview tab must exist; command resolution alone is insufficient.');
    report.webviewTypes = tabs.map(tab => tab.input.viewType);
    report.checks.push('installed launcher activates real official extension and opens an observable official webview tab without sending a message');
    report.status = 'passed';
  } catch (error) { report.status = 'failed'; report.error = error.stack || String(error); throw error; }
  finally { await fs.writeFile(process.env.LAUNCHER_HOST_REPORT, JSON.stringify(report, null, 2)); }
};
