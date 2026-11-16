// Testes do hook que o Claude Code chama antes e depois de cada edição.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'hooks', 'record-change.js');

function runHook(phase, input) {
	const result = spawnSync(process.execPath, [HOOK, phase], {
		input: JSON.stringify(input),
		encoding: 'utf8',
		env: { ...process.env, CLAUDE_PROJECT_DIR: input.cwd },
	});
	assert.equal(result.status, 0, result.stderr);
}

function project() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-hook-'));
}

function changesDir(root) {
	return path.join(root, '.claude', 'launcher-changes');
}

function readLog(root) {
	return fs.readFileSync(path.join(changesDir(root), 'log.jsonl'), 'utf8')
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

function blob(root, hash) {
	return fs.readFileSync(path.join(changesDir(root), 'blobs', `${hash}.txt`), 'utf8');
}

function edit(root, file, id, tool = 'Edit', extra = {}) {
	return { cwd: root, session_id: 's', tool_use_id: id, tool_name: tool, tool_input: { file_path: file, ...extra } };
}

test('o hook guarda antes e depois como blobs e o log só com o hash', () => {
	const root = project();
	const file = path.join(root, 'a.txt');
	fs.writeFileSync(file, 'v1\n');
	runHook('pre', edit(root, file, 't1'));
	fs.writeFileSync(file, 'v2\n');
	runHook('post', edit(root, file, 't1'));

	const [entry] = readLog(root);
	assert.equal(entry.before.text, null);
	assert.equal(blob(root, entry.before.hash), 'v1\n');
	assert.equal(blob(root, entry.after.hash), 'v2\n');
	assert.equal(entry.reason, null, 'a explicação fica para a extensão');
	assert.equal(entry.toolUseId, 't1');
	assert.equal(fs.readFileSync(path.join(changesDir(root), '.gitignore'), 'utf8'), '*\n');
	assert.deepEqual(fs.readdirSync(path.join(changesDir(root), 'pending')), [], 'o "pre" é apagado no "post"');
});

test('edições seguidas reaproveitam o mesmo blob', () => {
	const root = project();
	const file = path.join(root, 'a.txt');
	fs.writeFileSync(file, 'v1\n');
	for (const [id, next] of [['t1', 'v2\n'], ['t2', 'v3\n']]) {
		runHook('pre', edit(root, file, id));
		fs.writeFileSync(file, next);
		runHook('post', edit(root, file, id));
	}
	const [first, second] = readLog(root);
	assert.equal(first.after.hash, second.before.hash);
	assert.equal(fs.readdirSync(path.join(changesDir(root), 'blobs')).length, 3);
});

test('arquivo criado: o antes não existe', () => {
	const root = project();
	const file = path.join(root, 'novo.txt');
	runHook('pre', edit(root, file, 't1', 'Write'));
	fs.writeFileSync(file, 'oi');
	runHook('post', edit(root, file, 't1', 'Write'));
	const [entry] = readLog(root);
	assert.deepEqual(entry.before, { exists: false, text: null, large: false });
	assert.equal(blob(root, entry.after.hash), 'oi');
});

test('sem o "pre", um Edit simples ainda recupera o antes', () => {
	const root = project();
	const file = path.join(root, 'a.txt');
	fs.writeFileSync(file, 'olá mundo\n');
	runHook('post', edit(root, file, 't1', 'Edit', { old_string: 'oi', new_string: 'olá' }));
	const [entry] = readLog(root);
	assert.equal(blob(root, entry.before.hash), 'oi mundo\n');
});

test('entrada inválida não quebra o hook', () => {
	const result = spawnSync(process.execPath, [HOOK, 'post'], { input: 'isto nao e json', encoding: 'utf8' });
	assert.equal(result.status, 0);
});
