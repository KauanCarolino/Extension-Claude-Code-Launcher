'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

exports.verifyUnsupportedResources = async (workspace, checks) => {
  const uri = vscode.Uri.file(path.join(workspace, 'dirty.launcher-nb'));
  const before = JSON.stringify({ cell: 'before' }); const after = JSON.stringify({ cell: 'after' });
  await fs.writeFile(uri.fsPath, after);
  const serializer = vscode.workspace.registerNotebookSerializer('launcher-contract-notebook', {
    deserializeNotebook(bytes) { const data = JSON.parse(Buffer.from(bytes).toString('utf8')); return new vscode.NotebookData([new vscode.NotebookCellData(vscode.NotebookCellKind.Code, data.cell, 'plaintext')]); },
    serializeNotebook(data) { return Buffer.from(JSON.stringify({ cell: data.cells[0].value })); },
  });
  try {
    await fs.appendFile(path.join(workspace, '.claude/launcher-changes/log.jsonl'), JSON.stringify({
      id: 'host-dirty-notebook', time: new Date().toISOString(), file: uri.fsPath, tool: 'NotebookEdit', session: 'host-fixture', toolUseId: 'host-dirty-notebook', transcript: null, reason: null,
      before: { exists: true, text: before, large: false }, after: { exists: true, text: after, large: false },
    }) + '\n');
    await vscode.commands.executeCommand('claude-code-launcher.refreshChanges');
    const notebook = await vscode.workspace.openNotebookDocument(uri);
    await vscode.window.showNotebookDocument(notebook);
    const cell = notebook.cellAt(0).document;
    const edit = new vscode.WorkspaceEdit(); edit.replace(cell.uri, new vscode.Range(0, 0, cell.lineCount, 0), 'HUMAN_DIRTY_NOTEBOOK');
    assert(await vscode.workspace.applyEdit(edit)); assert(notebook.isDirty);
    await vscode.commands.executeCommand('claude-code-launcher.rejectAllChanges', uri.toString());
    assert.equal(cell.getText(), 'HUMAN_DIRTY_NOTEBOOK'); assert(notebook.isDirty);
    assert.equal(await fs.readFile(uri.fsPath, 'utf8'), after);
    const state = JSON.parse(await fs.readFile(path.join(workspace, '.claude/launcher-changes/review-state.v1.json'), 'utf8'));
    assert.equal(state.statuses['host-dirty-notebook'], undefined);
    assert(Object.values(state.reviews).flat().some(review => review.ids.includes('host-dirty-notebook')), 'A real captured review must exist; no-op without ingestion cannot pass.');
    assert(Object.values(state.operations).some(operation => operation.ids.includes('host-dirty-notebook') && operation.reason === 'unsupportedNotebook' && operation.stage !== 'complete'), 'The notebook guard must be reached; an unrelated no-op cannot pass.');
    checks.push('real dirty NotebookDocument refuses text reversal, preserves unsaved cell and disk, and never records a completed rejection');
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  } finally { serializer.dispose(); }

  const emitter = new vscode.EventEmitter(); let mutations = 0;
  const virtual = vscode.Uri.parse('launcher-contract-fs:/synthetic.txt');
  const data = Buffer.from('VIRTUAL_ORIGINAL');
  const mutation = () => { mutations++; throw vscode.FileSystemError.NoPermissions(); };
  const registration = vscode.workspace.registerFileSystemProvider('launcher-contract-fs', {
    onDidChangeFile: emitter.event, watch: () => new vscode.Disposable(() => {}),
    stat: () => ({ type: vscode.FileType.File, ctime: 0, mtime: 0, size: data.length }),
    readDirectory: () => [], readFile: () => data, createDirectory: mutation, writeFile: mutation, delete: mutation, rename: mutation,
  });
  try {
    const document = await vscode.workspace.openTextDocument(virtual); await vscode.window.showTextDocument(document);
    const edit = new vscode.WorkspaceEdit(); edit.replace(virtual, new vscode.Range(0, 0, 0, data.length), 'VIRTUAL_HUMAN');
    assert(await vscode.workspace.applyEdit(edit)); assert(document.isDirty);
    for (const command of ['claude-code-launcher.rejectAllChanges', 'claude-code-launcher.acceptAllChanges']) await vscode.commands.executeCommand(command, virtual.toString());
    assert.equal(document.getText(), 'VIRTUAL_HUMAN'); assert(document.isDirty); assert.equal(mutations, 0);
    const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', virtual);
    assert(!(lenses || []).some(lens => lens.command?.command?.startsWith('claude-code-launcher.')));
    checks.push('real virtual filesystem provider receives no mutation and retains its dirty buffer when public review commands are invoked');
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  } finally { registration.dispose(); emitter.dispose(); }
};
