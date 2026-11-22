'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const OUT = process.env.LAUNCHER_TEST_OUT || path.resolve(__dirname, '../out');
const shell = require(path.join(OUT, 'shell-activity.js'));
const { fixture } = require('./helpers/changes-fixture.cjs');

const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e';
const toolUse = (name, command, id = 'toolu_' + Math.random().toString(16).slice(2)) =>
	JSON.stringify({ type: 'assistant', timestamp: '2026-11-22T10:00:00.000Z', message: { content: [{ type: 'tool_use', id, name, input: { command } }] } });

test('leitura conhecida não conta como possível escrita; redirecionamento, encadeamento e programas desconhecidos contam', () => {
	for (const command of ['ls -la', 'git status --short', 'git diff HEAD -- src', 'cat a.txt | grep -E "x|y" | wc -l', 'cd src && rg foo',
		'rg x 2>&1 >/dev/null; pwd', 'sed -n 1,20p file', 'find . -name "*.ts"', 'echo "a > b"', 'FOO=1 head -n 3 x', 'Get-ChildItem | Select-Object Name',
		'git log --oneline 2>&1 | head']) {
		assert.equal(shell.mayWriteFiles(command), false, command);
	}
	for (const command of ['npm install', 'echo x > out.txt', 'cat a >> b', 'sed -i s/a/b/ f', 'git checkout -- .', 'ls && rm -rf build',
		'find . -name "*.tmp" -delete', 'python3 script.py', 'echo $(touch x)', 'grep x f | tee copy', 'sort -o f f', 'git -C other status',
		'ls &> listing.txt']) {
		assert.equal(shell.mayWriteFiles(command), true, command);
	}
	assert.equal(shell.writingProgram('ls && /usr/bin/npm.exe run build'), 'npm');
	assert.equal(shell.mayWriteFiles(''), false);
});

test('a contagem vem só das chamadas de terminal do assistente, sem guardar o texto dos comandos', () => {
	const activity = shell.emptyShellActivity();
	shell.addShellActivity(activity, [
		toolUse('Bash', 'git status'),
		toolUse('Bash', 'npm test -- --token=SECRET'),
		toolUse('PowerShell', 'Remove-Item build -Recurse'),
		toolUse('Edit', 'not a shell'),
		JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: '"tool_use" "Bash"' }] } }),
		'{"type":"assistant", cortado',
	]);
	assert.deepEqual(activity, { commands: 3, mayWrite: 2, programs: ['remove-item', 'npm'], partial: false });
	assert.equal(JSON.stringify(activity).includes('SECRET'), false);
});

test('o transcript é lido por acréscimo, inclusive com a última linha ainda incompleta', async (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-shell-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const file = path.join(dir, SESSION + '.jsonl');
	assert.equal(await shell.readShellActivity(file), undefined);
	const first = toolUse('Bash', 'npm run build');
	fs.writeFileSync(file, toolUse('Bash', 'ls') + '\n' + first.slice(0, 20));
	assert.deepEqual(await shell.readShellActivity(file), { commands: 1, mayWrite: 0, programs: [], partial: false });
	fs.appendFileSync(file, first.slice(20) + '\n');
	assert.deepEqual(await shell.readShellActivity(file), { commands: 2, mayWrite: 1, programs: ['npm'], partial: false });
	fs.appendFileSync(file, toolUse('Bash', 'rm x') + '\n');
	assert.deepEqual(await shell.readShellActivity(file), { commands: 3, mayWrite: 2, programs: ['rm', 'npm'], partial: false });
	// Um transcript reescrito menor recomeça a contagem.
	fs.writeFileSync(file, toolUse('Bash', 'cat a') + '\n');
	assert.deepEqual(await shell.readShellActivity(file), { commands: 1, mayWrite: 0, programs: [], partial: false });
});

test('o painel avisa sobre comandos que podem ter alterado arquivos na conversa em foco', async (t) => {
	const f = fixture(t);
	fs.mkdirSync(path.join(f.root, 'sessions'), { recursive: true });
	fs.writeFileSync(path.join(f.root, 'sessions', SESSION + '.jsonl'), [toolUse('Bash', 'git status'), toolUse('Bash', 'npm install')].join('\n') + '\n');
	const states = [];
	const view = { postMessage: async (state) => { states.push(state); } };
	f.controller.setActiveChat({ sessions: [SESSION], title: 'Conversa', elsewhere: [] });
	// A troca de conversa agenda uma releitura; aqui ela é feita na hora.
	clearTimeout(f.controller.shellTimer);
	await f.controller.updateShellActivity();
	f.controller.post(view, false);
	assert.deepEqual(states.at(-1).shell, { commands: 2, mayWrite: 1, programs: ['npm'], partial: false, scope: 'chat' });
	// Só leitura não gera aviso.
	fs.writeFileSync(path.join(f.root, 'sessions', SESSION + '.jsonl'), toolUse('Bash', 'ls') + '\n');
	await f.controller.updateShellActivity();
	f.controller.post(view, false);
	assert.equal(states.at(-1).shell, null);
	assert.equal(f.controller.handleMessage({ command: 'openScm' }, view, false) instanceof Promise, true);
	await f.controller.handleMessage({ command: 'openScm' }, view, false);
	assert.deepEqual(f.executedCommands.at(-1), ['workbench.view.scm']);
});
