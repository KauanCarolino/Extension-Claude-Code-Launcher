'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

exports.verifyEncoding = async (workspace, checks) => {
  const history = path.join(workspace, '.claude/launcher-changes');
  const state = async () => JSON.parse(await fs.readFile(path.join(history, 'review-state.v1.json'), 'utf8'));
  const seed = async (name, before, bytes) => {
    const uri = vscode.Uri.file(path.join(workspace, name)); const id = 'encoding-' + name;
    await fs.writeFile(uri.fsPath, bytes);
    await fs.appendFile(path.join(history, 'log.jsonl'), JSON.stringify({ id, file: uri.fsPath, time: new Date().toISOString(), tool: 'Edit', session: 'synthetic-encoding', toolUseId: id, transcript: null, reason: null,
      before: { exists: true, text: before, large: false }, after: { exists: true, text: bytes.toString('utf8'), large: false } }) + '\n');
    await vscode.commands.executeCommand('claude-code-launcher.refreshChanges');
    assert(Object.values((await state()).reviews).flat().some(review => review.ids.includes(id)), 'Encoding fixture must be ingested before invoking the public command');
    const document = await vscode.workspace.openTextDocument(uri); await vscode.window.showTextDocument(document);
    return { uri, id, document };
  };

  const before = '\uFEFFmaçã antes\r\nfim\r\n'; const after = Buffer.from('\uFEFFmaçã depois\r\nfim\r\n');
  const bom = await seed('bom.txt', before, after);
  const deadline = Date.now() + 15000; let reject;
  while (Date.now() < deadline && !reject) {
    const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', bom.uri);
    reject = (lenses || []).find(lens => lens.command?.command === 'claude-code-launcher.rejectChange')?.command;
    if (!reject) await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert(reject, 'An unchanged BOM file must expose real review lenses instead of a false external-change barrier');
  // Execute the actual lens arguments, including its canonical hunk signature.
  await vscode.commands.executeCommand(reject.command, ...(reject.arguments || []));
  assert.deepEqual(await fs.readFile(bom.uri.fsPath), Buffer.from(before), 'Restore the exact UTF-8 BOM, CRLF and final newline bytes');
  assert.equal(bom.document.getText(), before.slice(1)); assert.equal(bom.document.isDirty, false);
  assert.equal((await state()).statuses[bom.id], 'rejected');
  await vscode.commands.executeCommand('claude-code-launcher.undoReject');
  assert.deepEqual(await fs.readFile(bom.uri.fsPath), after, 'Undo must not strip or duplicate the BOM');
  assert.equal(bom.document.getText(), after.toString('utf8').slice(1));
  checks.push('real CodeLens hunk rejection and undo preserve one UTF-8 BOM, CRLF, Unicode and final newline');

  for (const [name, original, bytes] of [
    ['bom-change.txt', 'before\n', Buffer.from('\uFEFFafter\n')],
    ['mixed-eol.txt', 'before\r\nsecond\n', Buffer.from('after\r\nsecond\n')],
    ['invalid-utf8.txt', 'before\n', Buffer.from([0x61, 0xc3, 0x28, 0x0a])],
  ]) {
    const fixture = await seed(name, original, bytes); const buffer = fixture.document.getText(); const version = fixture.document.version;
    await vscode.commands.executeCommand('claude-code-launcher.rejectAllChanges', fixture.uri.toString());
    assert.deepEqual(await fs.readFile(fixture.uri.fsPath), bytes, name + ' must not be silently normalized');
    assert.equal(fixture.document.getText(), buffer); assert.equal(fixture.document.version, version); assert.equal(fixture.document.isDirty, false);
    assert.equal((await state()).statuses[fixture.id], undefined);
    checks.push('real editor blocks unsupported ' + name + ' without buffer mutation, byte normalization or completed decision');
  }
};
