'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

async function until(fn, description, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timeout: ' + description);
}

exports.run = async () => {
  const workspace = process.env.LAUNCHER_HOST_WORKSPACE;
  assert(workspace && process.env.LAUNCHER_HOST_REPORT, 'Use o runner de perfil isolado.');
  const checks = [];
  const report = {
    editor: vscode.env.appName, vscode: vscode.version, node: process.version,
    platform: process.platform, arch: process.arch,
    artifactSha256: process.env.LAUNCHER_HOST_ARTIFACT_SHA256 ?? null,
    trustScenario: 'trusted synthetic workspace; Restricted Mode not tested',
    checks,
  };
  try {
    const lockBefore = vscode.workspace.getConfiguration('workbench.editor').get('autoLockGroups');
    const extension = vscode.extensions.getExtension('kauan.claude-code-launcher');
    assert(extension, 'Extensão não encontrada no perfil de teste.');
    await extension.activate();
    assert(extension.isActive);
    const commands = new Set(await vscode.commands.getCommands(true));
    for (const command of extension.packageJSON.contributes.commands) {
      assert(commands.has(command.command), 'Comando não registrado: ' + command.command);
    }
    assert.deepEqual(vscode.workspace.getConfiguration('workbench.editor').get('autoLockGroups'), lockBefore);
    checks.push('activation, declared commands and unmanaged preferences');

    const assertResolution = async (id, resolution) => {
      await until(async () => {
        const state = JSON.parse(await fs.readFile(path.join(workspace, '.claude/launcher-changes/review-state.v1.json'), 'utf8'));
        return state.statuses[id] === resolution;
      }, 'decisão persistida para ' + id);
    };

    const openReview = async name => {
      const uri = vscode.Uri.file(path.join(workspace, name));
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, { preview: false });
      const lenses = await until(async () => {
        const items = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', uri);
        return items?.some(x => x.command?.command === 'claude-code-launcher.rejectChange') && items;
      }, 'lentes de revisão em ' + name);
      return { uri, document, lenses };
    };

    let review = await openReview('crlf.txt');
    await vscode.commands.executeCommand('claude-code-launcher.rejectAllChanges', review.uri.toString());
    await until(async () => (await fs.readFile(review.uri.fsPath, 'utf8')) === 'before\r\nline\r\n', 'restauração CRLF');
    assert.equal(review.document.getText(), 'before\r\nline\r\n');
    await assertResolution('host-crlf.txt', 'rejected');
    checks.push('CRLF restored in real TextDocument and on disk');

    review = await openReview('created.txt');
    await vscode.commands.executeCommand('claude-code-launcher.rejectAllChanges', review.uri.toString());
    await until(async () => {
      try { await fs.access(review.uri.fsPath); return false; }
      catch (error) { if (error.code === 'ENOENT') return true; throw error; }
    }, 'recusa de criação');
    await assertResolution('host-created.txt', 'rejected');
    checks.push('rejecting a creation restores absence');

    await vscode.commands.executeCommand('claude-code-launcher.undoReject');
    await until(async () => (await fs.readFile(review.uri.fsPath, 'utf8')) === 'created\n', 'desfazer recusa de criação');
    checks.push('undoing a rejected creation restores its contents');

    review = await openReview('partial.txt');
    const accept = review.lenses.find(x => x.command?.command === 'claude-code-launcher.acceptChange').command;
    await vscode.commands.executeCommand(accept.command, ...(accept.arguments ?? []));
    await vscode.commands.executeCommand('claude-code-launcher.rejectAllChanges', review.uri.toString());
    await until(async () => (await fs.readFile(review.uri.fsPath, 'utf8')) === 'ONE\ntwo\nthree\n', 'aceite parcial preservado');
    await assertResolution('host-partial.txt', 'mixed');
    checks.push('accepted hunk survives rejection of remaining changes');

    await vscode.commands.executeCommand('claude-code-launcher.undoReject');
    await until(async () => (await fs.readFile(review.uri.fsPath, 'utf8')) === 'ONE\ntwo\nTHREE\n', 'desfazer recusa parcial');
    checks.push('undoing a rejection preserves the accepted hunk');

    review = await openReview('manual.txt');
    const manual = 'claude\nstable\nMANUAL\n';
    let edit = new vscode.WorkspaceEdit();
    edit.replace(review.uri, new vscode.Range(0, 0, review.document.lineCount, 0), manual);
    assert(await vscode.workspace.applyEdit(edit));
    assert(await review.document.save());
    const latest = 'claude2\nstable\nMANUAL\n';
    edit = new vscode.WorkspaceEdit();
    edit.replace(review.uri, new vscode.Range(0, 0, review.document.lineCount, 0), latest);
    assert(await vscode.workspace.applyEdit(edit));
    assert(await review.document.save());
    await fs.appendFile(path.join(workspace, '.claude/launcher-changes/log.jsonl'), JSON.stringify({
      id: 'host-manual-second', time: '2026-11-19T12:00:01.000Z',
      file: review.uri.fsPath, tool: 'Edit', session: 'host-fixture', toolUseId: 'host-manual-second',
      transcript: null, reason: null,
      before: { exists: true, text: manual, large: false },
      after: { exists: true, text: latest, large: false },
    }) + '\n');
    // Calling a public action while refresh is pending must also preserve human input.
    await vscode.commands.executeCommand('claude-code-launcher.rejectAllChanges', review.uri.toString());
    assert((await fs.readFile(review.uri.fsPath, 'utf8')).includes('MANUAL\n'));
    checks.push('manual content survives rejection during a new capture');
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = error.stack || String(error);
    throw error;
  } finally {
    await fs.writeFile(process.env.LAUNCHER_HOST_REPORT, JSON.stringify(report, null, 2));
  }
};
