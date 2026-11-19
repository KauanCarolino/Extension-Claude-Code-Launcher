'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const vscode = require('vscode');
const { assertHookNode, run, validDiagnosticEvent } = require('../../scripts/host-tooling.cjs');
const { collectReviewFailureDiagnostics } = require('../../scripts/host-state-diagnostics.cjs');

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

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
    if (process.env.LAUNCHER_HOST_EXPECTED_VERSION) {
      assert.equal(vscode.version, process.env.LAUNCHER_HOST_EXPECTED_VERSION, 'O editor executado deve corresponder ao pin.');
    }
    const lockBefore = vscode.workspace.getConfiguration('workbench.editor').get('autoLockGroups');
    const extension = vscode.extensions.getExtension('kauan.claude-code-launcher');
    assert(extension, 'Extensão não encontrada no perfil de teste.');
    report.extensionVersion = extension.packageJSON.version;
    if (report.artifactSha256) assert.equal(report.extensionVersion, process.env.LAUNCHER_HOST_ARTIFACT_VERSION);
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
      let lastItems = [];
      let lenses;
      try {
        lenses = await until(async () => {
          const items = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', uri);
          lastItems = Array.isArray(items) ? items : [];
          return items?.some(x => x.command?.command === 'claude-code-launcher.rejectChange') && items;
        }, 'lentes de revisão em ' + name);
      } catch (error) {
        try {
          report.reviewFailureDiagnostics = await collectReviewFailureDiagnostics({
            workspace, fixture: name,
            workspaceSyncRealpath: require('node:fs').realpathSync(workspace),
            documentFsPath: document.uri.fsPath,
            inlineEnabled: vscode.workspace.getConfiguration('claudeCodeLauncher').get('inlineChanges', true),
            trusted: vscode.workspace.isTrusted, documentText: document.getText(),
            document: { scheme: document.uri.scheme, eol: document.eol, dirty: document.isDirty, closed: document.isClosed,
              lineCount: document.lineCount, uriEqualsRequested: document.uri.toString() === uri.toString(),
              editorVisible: vscode.window.visibleTextEditors.some(editor => editor.document === document) },
            lensCount: lastItems.length, lensCommands: lastItems.map(item => item.command?.command),
          });
        } catch { report.reviewFailureDiagnostics = { stage: 'codelens-timeout', collection: 'unavailable' }; }
        throw error;
      }
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

    if (report.artifactSha256) {
      const hookPath = path.join(extension.extensionPath, 'hooks/record-change.js');
      const installedHookSha256 = sha256(await fs.readFile(hookPath));
      assert.equal(installedHookSha256, process.env.LAUNCHER_HOST_HOOK_SHA256,
        'O hook executado deve ser idêntico à entrada do VSIX verificado.');
      const hookNode = process.env.LAUNCHER_HOST_HOOK_NODE;
      assert(hookNode && path.isAbsolute(hookNode), 'O runner deve fornecer Node externo com caminho absoluto.');
      const hookEnv = { ...process.env, CLAUDE_PROJECT_DIR: workspace };
      delete hookEnv.ELECTRON_RUN_AS_NODE;
      delete hookEnv.NODE_OPTIONS;
      const version = await run(hookNode, ['--version'], hookEnv, { cwd: workspace, timeout: 10000 });
      assert.equal(version.code, 0, version.output);
      assert.equal(version.timedOut, false);
      const hookVersion = version.output.trim();
      assertHookNode(hookVersion);
      assert.equal(hookVersion, process.env.LAUNCHER_HOST_HOOK_NODE_VERSION);

      const name = 'capture-integration.txt';
      const file = path.join(workspace, name);
      const before = Buffer.from('capture before\r\nlinha maçã\r\n', 'utf8');
      const after = Buffer.from('capture after\r\nlinha maçã\r\n', 'utf8');
      const toolUseId = 'host-packaged-hook-synthetic';
      const input = { cwd: workspace, session_id: 'host-packaged-hook-synthetic',
        tool_name: 'Edit', tool_use_id: toolUseId,
        tool_input: { file_path: file, old_string: 'capture before', new_string: 'capture after' } };
      report.captureIntegration = {
        source: 'synthetic Edit event; no Claude authentication, AI, prompt or paid service',
        hookSource: 'installed VSIX extension/hooks/record-change.js',
        hookSha256: installedHookSha256, hookNode: hookVersion, hostNode: process.version,
        beforeSha256: sha256(before), afterSha256: sha256(after), stage: 'prepared',
      };
      const diagnosticFiles = async kind => {
        const directory = path.join(workspace, '.claude/launcher-changes/capture-diagnostics/v2', kind);
        try { return await fs.readdir(directory); }
        catch (error) { if (error.code === 'ENOENT') return []; throw error; }
      };
      const priorDiagnostics = {
        observations: new Set(await diagnosticFiles('observations')),
        completions: new Set(await diagnosticFiles('completions')),
      };
      // This scenario starts with an ordinary file. Only the installed hook may
      // create its capture entries; never seed or inject its log/canonical state.
      await fs.writeFile(file, before);
      const capturedUri = vscode.Uri.file(file);
      const capturedDocument = await vscode.workspace.openTextDocument(capturedUri);
      await vscode.window.showTextDocument(capturedDocument, { preview: false });
      assert.equal(capturedDocument.getText(), before.toString('utf8'));
      const invokeHook = async phase => {
        const execution = await run(hookNode, [hookPath, phase], hookEnv, {
          cwd: workspace, timeout: 15000, input: JSON.stringify(input),
        });
        assert.equal(execution.timedOut, false, 'Timeout no hook ' + phase);
        assert.equal(execution.code, 0, 'Falha no hook ' + phase + ': ' + execution.output);
      };
      await invokeHook('pre');
      report.captureIntegration.stage = 'pre-returned';
      await fs.writeFile(file, after);
      await until(() => capturedDocument.getText() === after.toString('utf8'), 'TextDocument atualizado antes do post');
      await invokeHook('post');
      report.captureIntegration.stage = 'post-returned';
      const diagnostics = {};
      report.captureIntegration.diagnostics = diagnostics;
      for (const [bucket, kind] of [['observations', 'observation'], ['completions', 'completion']]) {
        diagnostics[bucket] = [];
        for (const name of (await diagnosticFiles(bucket)).filter(name => !priorDiagnostics[bucket].has(name))) {
          assert.match(name, /^\d{8}T\d{9}Z-[a-f0-9]{32}\.json$/, 'Nome de diagnóstico v2 inválido.');
          const record = JSON.parse(await fs.readFile(path.join(
            workspace, '.claude/launcher-changes/capture-diagnostics/v2', bucket, name), 'utf8'));
          assert(validDiagnosticEvent(record, kind, name), 'Diagnóstico v2 deve cumprir schema/allowlist/identidade antes da exportação.');
          // Export only the documented redacted fields, never paths or payloads.
          diagnostics[bucket].push(Object.fromEntries([
            'schemaVersion', 'id', 'kind', 'phase', 'stage', 'code', 'observedAt', 'contentCoverage',
          ].map(key => [key, record[key]])));
        }
      }
      assert(diagnostics.observations.some(record => record.phase === 'pre'), 'O pre deve produzir observação v2.');
      assert(diagnostics.observations.some(record => record.phase === 'post'), 'O post deve produzir observação v2.');
      assert.equal(diagnostics.completions.length, 1, 'Uma execução post deve produzir uma conclusão durável.');
      const completion = diagnostics.completions[0];
      assert.equal(completion.phase, 'post');
      assert.equal(completion.stage, 'append');
      assert.equal(completion.code, 'captureRecorded');
      assert.equal(completion.contentCoverage, 'complete');
      report.captureIntegration.contentCoverage = completion.contentCoverage;
      const entries = (await fs.readFile(path.join(workspace, '.claude/launcher-changes/log.jsonl'), 'utf8'))
        .split('\n').filter(Boolean).map(line => JSON.parse(line));
      const captured = entries.filter(entry => entry.toolUseId === toolUseId);
      assert.equal(captured.length, 1, 'O post do hook deve registrar exatamente uma captura sintética.');
      assert.equal(captured[0].file, file);
      assert.equal(captured[0].before.exists, true);
      assert.equal(captured[0].after.exists, true);
      assert.equal(typeof captured[0].before.hash, 'string');
      assert.equal(typeof captured[0].after.hash, 'string');
      report.captureIntegration.entryId = captured[0].id;
      const capturedLenses = await until(async () => {
        const items = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', capturedUri);
        return items?.some(item => item.command?.command === 'claude-code-launcher.rejectChange') && items;
      }, 'watcher de captura atualizou lentes do arquivo já aberto');
      review = { uri: capturedUri, document: capturedDocument, lenses: capturedLenses };
      report.captureIntegration.stage = 'watcher-ingested-with-codelens';
      await vscode.commands.executeCommand('claude-code-launcher.rejectAllChanges', review.uri.toString());
      await until(async () => (await fs.readFile(file)).equals(before), 'bytes da captura real restaurados');
      assert.equal(review.document.getText(), before.toString('utf8'));
      await until(async () => {
        const statuses = JSON.parse(await fs.readFile(path.join(workspace, '.claude/launcher-changes/status.json'), 'utf8'));
        return statuses[captured[0].id] === 'rejected';
      }, 'projeção pública da recusa da captura real');
      report.captureIntegration.stage = 'rejected-and-persisted';
      report.captureIntegration.restoredSha256 = sha256(await fs.readFile(file));
      report.captureIntegration.resolution = 'rejected';
      checks.push('installed VSIX hook → external Node pre/post → watcher CodeLens → public reject → exact bytes and status');
    } else {
      report.captureIntegration = { status: 'not-run', reason: 'requires --vsix; development host evidence only' };
    }
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = error.stack || String(error);
    throw error;
  } finally {
    await fs.writeFile(process.env.LAUNCHER_HOST_REPORT, JSON.stringify(report, null, 2));
  }
};
