'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const OUT = process.env.LAUNCHER_TEST_OUT || path.resolve(__dirname, '../out');
const { fixture, entry, writeLog } = require('./helpers/changes-fixture.cjs');

function remoteModule(remoteName) {
	const executed = [], copied = [], messages = [];
	const vscode = {
		env: { remoteName, clipboard: { writeText: async (text) => { copied.push(text); } } },
		Uri: { file: (fsPath) => ({ fsPath, scheme: 'file' }) },
		workspace: { getWorkspaceFolder: (uri) => uri.fsPath.startsWith('/projeto/') ? { uri: { fsPath: '/projeto' } } : undefined,
			fs: { delete: async () => { throw new Error("Unable to delete file '/projeto/a' via trash because provider does not support it."); } } },
		commands: { executeCommand: async (...args) => { executed.push(args); } },
		window: { showInformationMessage: async (message) => { messages.push(message); } },
	};
	const file = path.join(OUT, 'remote.js'), module = { exports: {} };
	vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, exports: module.exports, require: (id) => id === 'vscode' ? vscode : id.startsWith('.') ? require(path.join(OUT, id)) : require(id) }, { filename: file });
	return { api: module.exports, executed, copied, messages, vscode };
}

test('revelar usa o gerenciador local, o Explorer na janela remota, ou copia o caminho de fora do workspace', async () => {
	const local = remoteModule(undefined);
	await local.api.revealPath('/home/eu/.claude/skills/x');
	assert.deepEqual(local.executed.map((call) => [call[0], call[1].fsPath]), [['revealFileInOS', '/home/eu/.claude/skills/x']]);
	const remote = remoteModule('wsl');
	await remote.api.revealPath('/projeto/.claude/rules/a.md');
	await remote.api.revealPath('/home/eu/.claude/settings.json');
	assert.deepEqual(remote.executed.map((call) => [call[0], call[1].fsPath]), [['revealInExplorer', '/projeto/.claude/rules/a.md']]);
	assert.deepEqual(remote.copied, ['/home/eu/.claude/settings.json']);
	assert.match(remote.messages[0], /janela remota \(wsl\)/);
});

test('sem lixeira, a exclusão não acontece e a mensagem explica; erro de permissão continua sendo outra coisa', async () => {
	const { api } = remoteModule('dev-container');
	await assert.rejects(api.deleteToTrash({ fsPath: '/projeto/a' }), /lixeira não está disponível/);
	assert.equal(api.isTrashUnavailable(Object.assign(new Error('trash failed: unsupported'), { code: 'EACCES' })), false);
	assert.equal(api.isTrashUnavailable(new Error('ordinary failure')), false);
});

test('recusar a criação de um arquivo sem lixeira fica bloqueado com o motivo, sem apagar em definitivo', async (t) => {
	const f = fixture(t);
	const created = { ...entry(f.root, 'created', 'novo.txt'), before: { exists: false, text: null, large: false }, after: { exists: true, text: 'after', large: false } };
	fs.writeFileSync(created.file, 'after'); writeLog(f, [created]); await f.store(); f.controller.entries = await f.controller.loadEntries();
	f.editor.deleteError = new Error("Unable to delete file via trash because provider does not support it.");
	await assert.rejects(f.controller.executeReviewDecision(created.file, { action: 'reject' }), (error) => error.result.reason === 'trashUnavailable' && error.result.content === 'unchanged');
	assert.equal(fs.readFileSync(created.file, 'utf8'), 'after');
});
