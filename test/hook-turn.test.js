// Captura do turno: o que comandos e outras ferramentas mudaram entre o pedido e o fim da resposta.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'hooks', 'record-change.js');
const hook = require(HOOK);
const SESSION = '5d2c3a4e-0000-4000-8000-000000000001';

function project(t) {
	const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-turn-')));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	return root;
}
function write(root, relative, text, time) {
	const file = path.join(root, relative);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
	// Data explícita: o teste não depende da resolução do relógio do sistema de arquivos.
	if (time) { fs.utimesSync(file, time, time); }
	return file;
}
const dir = (root) => path.join(root, '.claude', 'launcher-changes');
const sha1 = (text) => crypto.createHash('sha1').update(text, 'utf8').digest('hex');
const later = (seconds) => new Date(Date.now() + seconds * 1000);
function turn(root, phase, extra = {}) {
	return hook.runTurn(phase, { session_id: SESSION, cwd: root, transcript_path: path.join(root, 't.jsonl'), ...extra }, { env: { CLAUDE_PROJECT_DIR: root } });
}
function log(root) {
	const file = path.join(dir(root), 'log.jsonl');
	return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
}
const blob = (root, hash) => fs.readFileSync(path.join(dir(root), 'blobs', hash + '.txt'), 'utf8');

test('o fim do turno registra o que um comando criou, mudou e apagou, com antes e depois revisáveis', (t) => {
	const root = project(t);
	write(root, 'src/a.txt', 'antes\n'); write(root, 'velho.txt', 'vai sumir\n');
	assert.equal(turn(root, 'turn-start').state, 'prepared');
	write(root, 'src/a.txt', 'depois do formatador\n', later(5));
	write(root, 'novo.txt', 'gerado\n');
	fs.rmSync(path.join(root, 'velho.txt'));
	const result = turn(root, 'turn-end');
	assert.equal(result.state, 'recorded'); assert.equal(result.changes, 3);
	const byFile = Object.fromEntries(log(root).map((entry) => [path.relative(root, entry.file), entry]));
	assert.deepEqual(Object.keys(byFile).sort(), ['novo.txt', path.join('src', 'a.txt'), 'velho.txt']);
	for (const entry of Object.values(byFile)) {
		assert.equal(entry.tool, 'Command'); assert.equal(entry.session, SESSION); assert.equal(entry.toolUseId, null);
		assert.equal(entry.transcript, path.join(root, 't.jsonl')); assert.match(entry.id, /^[a-f0-9]{32}$/);
	}
	const changed = byFile[path.join('src', 'a.txt')];
	assert.equal(blob(root, changed.before.hash), 'antes\n'); assert.equal(blob(root, changed.after.hash), 'depois do formatador\n');
	assert.deepEqual(byFile['novo.txt'].before, { exists: false, text: null, large: false });
	assert.equal(blob(root, byFile['novo.txt'].after.hash), 'gerado\n');
	assert.equal(blob(root, byFile['velho.txt'].before.hash), 'vai sumir\n');
	assert.deepEqual(byFile['velho.txt'].after, { exists: false, text: null, large: false });
	// Um segundo Stop no mesmo turno só registra o que mudou depois do primeiro.
	assert.equal(turn(root, 'turn-end').state, 'unchanged');
	write(root, 'novo.txt', 'gerado de novo\n', later(9));
	const again = turn(root, 'turn-end');
	assert.equal(again.changes, 1);
	const last = log(root).at(-1);
	assert.equal(blob(root, last.before.hash), 'gerado\n'); assert.equal(blob(root, last.after.hash), 'gerado de novo\n');
});

test('edições já capturadas pelo Edit/Write não se repetem; um comando depois delas parte do estado editado', (t) => {
	const root = project(t);
	write(root, 'b.txt', 'um\n'); write(root, 'c.txt', 'x\n');
	turn(root, 'turn-start');
	for (const [file, next] of [['b.txt', 'dois\n'], ['c.txt', 'y\n']]) {
		const input = { session_id: SESSION, cwd: root, tool_name: 'Write', tool_input: { file_path: path.join(root, file), content: next }, tool_use_id: 'toolu_' + file };
		hook.run('pre', input, { env: { CLAUDE_PROJECT_DIR: root } });
		write(root, file, next, later(3));
		hook.run('post', input, { env: { CLAUDE_PROJECT_DIR: root } });
	}
	// Um formatador mexe em c.txt depois da edição do Claude.
	write(root, 'c.txt', 'y formatado\n', later(6));
	assert.equal(turn(root, 'turn-end').changes, 1);
	const entries = log(root), command = entries.at(-1);
	assert.deepEqual(entries.map((entry) => entry.tool), ['Write', 'Write', 'Command']);
	assert.equal(path.basename(command.file), 'c.txt');
	assert.equal(blob(root, command.before.hash), 'y\n', 'o antes do comando é o depois da edição capturada');
	assert.equal(blob(root, command.after.hash), 'y formatado\n');
});

test('controle de versão, dependências, .gitignore da raiz, exclusões de privacidade e binários ficam de fora', (t) => {
	const root = project(t);
	write(root, '.gitignore', '# saída\ndist/\n*.log\n/raiz-apenas.txt\n!importante.log\n');
	for (const relative of ['.git/HEAD', 'node_modules/pkg/index.js', 'dist/app.js', 'logs/run.log', 'raiz-apenas.txt', '.env', 'keep.txt']) { write(root, relative, 'v1\n'); }
	write(root, 'imagem.bin', Buffer.from([0xff, 0xfe, 0x00, 0x81]));
	turn(root, 'turn-start');
	const time = later(5);
	for (const relative of ['.git/HEAD', 'node_modules/pkg/index.js', 'dist/app.js', 'logs/run.log', 'raiz-apenas.txt', '.env', 'keep.txt']) { write(root, relative, 'v2\n', time); }
	write(root, 'imagem.bin', Buffer.from([0xff, 0xfe, 0x00, 0x82, 0x90]), time);
	write(root, 'sub/raiz-apenas.txt', 'fora da raiz conta\n', time);
	turn(root, 'turn-end');
	assert.deepEqual(log(root).map((entry) => path.relative(root, entry.file)).sort(), ['keep.txt', path.join('sub', 'raiz-apenas.txt')]);
	assert.equal(JSON.stringify(log(root)).includes('.env'), false);
});

test('captura pausada, manutenção, sessão sem início e manifesto adulterado não gravam nada', (t) => {
	const root = project(t);
	write(root, 'a.txt', '1\n');
	assert.equal(turn(root, 'turn-end').state, 'ignored', 'sem turn-start não há com o que comparar');
	fs.mkdirSync(dir(root), { recursive: true });
	const policy = { schemaVersion: 1, generation: 'g1', paused: true, excludedPatterns: [], maxStorageBytes: 64 * 1024 * 1024, retentionDays: 30 };
	fs.writeFileSync(path.join(dir(root), 'capture-policy.json'), JSON.stringify(policy));
	assert.equal(turn(root, 'turn-start').code, 'capturePaused');
	assert.equal(fs.existsSync(path.join(dir(root), 'turns')), false);
	fs.writeFileSync(path.join(dir(root), 'capture-policy.json'), JSON.stringify({ ...policy, paused: false }));
	fs.writeFileSync(path.join(dir(root), hook.CAPTURE_MAINTENANCE_FILE), '{}');
	assert.equal(turn(root, 'turn-start').code, 'captureMaintenance');
	fs.rmSync(path.join(dir(root), hook.CAPTURE_MAINTENANCE_FILE));
	assert.equal(turn(root, 'turn-start').state, 'prepared');
	const manifest = fs.readdirSync(path.join(dir(root), 'turns')).find((name) => name !== 'index.json');
	const file = path.join(dir(root), 'turns', manifest);
	const value = JSON.parse(fs.readFileSync(file, 'utf8'));
	value.files['../fora.txt'] = { size: 1, mtimeMs: 1, hash: null, mirrored: false };
	fs.writeFileSync(file, JSON.stringify(value));
	write(root, 'a.txt', '2\n', later(5));
	assert.deepEqual(turn(root, 'turn-end'), { state: 'blocked', code: 'invalidPending' });
	assert.deepEqual(log(root), []);
	assert.deepEqual(fs.readdirSync(path.join(dir(root), 'active')), [], 'a lease sai mesmo quando o turno é recusado');
	assert.equal(hook.runTurn('turn-start', { cwd: root }).state, 'ignored', 'sem session_id não há turno');
	assert.equal(hook.runTurn('pre', { session_id: SESSION, cwd: root }).state, 'ignored');
});

test('as cópias do início do turno respeitam o orçamento e as antigas sem referência são recolhidas', (t) => {
	const root = project(t);
	write(root, 'a.txt', 'atual\n');
	fs.mkdirSync(path.join(dir(root), 'turn-blobs'), { recursive: true });
	const stale = path.join(dir(root), 'turn-blobs', sha1('sem uso\n') + '.txt');
	const recent = path.join(dir(root), 'turn-blobs', sha1('recente\n') + '.txt');
	fs.writeFileSync(stale, 'sem uso\n'); fs.utimesSync(stale, new Date(1000), new Date(1000));
	fs.writeFileSync(recent, 'recente\n');
	turn(root, 'turn-start');
	assert.equal(fs.existsSync(stale), false); assert.equal(fs.existsSync(recent), true, 'cópia recente fica: outro turno pode estar gravando');
	assert.equal(fs.readFileSync(path.join(dir(root), 'turn-blobs', sha1('atual\n') + '.txt'), 'utf8'), 'atual\n');
	// Orçamento de 2 MiB: metade fica para as cópias do turno; o terceiro arquivo já não cabe nela.
	const small = project(t);
	for (const name of ['a.txt', 'b.txt', 'c.txt']) { write(small, name, name[0].repeat(400 * 1024)); }
	fs.mkdirSync(dir(small), { recursive: true });
	fs.writeFileSync(path.join(dir(small), 'capture-policy.json'), JSON.stringify({ schemaVersion: 1, generation: 'g', paused: false, excludedPatterns: [], maxStorageBytes: 2 * 1024 * 1024, retentionDays: 30 }));
	assert.equal(turn(small, 'turn-start').limited, true);
	write(small, 'c.txt', 'mudou\n', later(5));
	assert.equal(turn(small, 'turn-end').changes, 1);
	assert.deepEqual(log(small)[0].before, { exists: true, text: null, large: false }, 'sem cópia, o antes fica desconhecido em vez de inventado');
});

test('como processo, o hook do turno não escreve nada na saída (o UserPromptSubmit a mandaria ao Claude)', (t) => {
	const root = project(t);
	write(root, 'a.txt', '1\n');
	for (const phase of hook.TURN_PHASES) {
		const result = spawnSync(process.execPath, [HOOK, phase], { input: JSON.stringify({ session_id: SESSION, cwd: root, prompt: 'faça algo' }),
			encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
		assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
	}
	assert.equal(fs.readdirSync(path.join(dir(root), 'turns')).length, 2, 'manifesto da conversa e índice');
});

test('as regras do .gitignore seguem o git: âncoras, só pastas, negação, classes, ** e escapes', () => {
	const rules = hook.gitignoreRules('dist/\n/build\na/b\n*.log\n!x.log\n[ab].txt\nfoo[!0-9]\ndocs/**/*.tmp\n\\#literal\n\\!bang\ntrail \\ \n# c\n../fora\n\n');
	const layers = [{ base: '', rules }];
	const ignored = (relative, isDirectory = false) => hook.gitignored(relative, isDirectory, layers);
	assert.equal(rules.length, 11, 'comentário, linha vazia e ../ ficam de fora');
	assert.equal(ignored('dist', true), true); assert.equal(ignored('dist'), false, 'dist/ vale só para pastas');
	assert.equal(ignored('sub/dist', true), true, 'sem barra no meio, vale em qualquer nível');
	assert.equal(ignored('build'), true); assert.equal(ignored('sub/build'), false, '/build só na pasta do .gitignore');
	assert.equal(ignored('a/b'), true); assert.equal(ignored('x/a/b'), false, 'barra no meio prende à pasta');
	assert.equal(ignored('logs/run.log'), true); assert.equal(ignored('x.log'), false, 'a negação depois reinclui');
	assert.equal(ignored('a.txt'), true); assert.equal(ignored('c.txt'), false);
	assert.equal(ignored('foox'), true); assert.equal(ignored('foo1'), false);
	assert.equal(ignored('docs/a.tmp'), true); assert.equal(ignored('docs/x/y/a.tmp'), true); assert.equal(ignored('a.tmp'), false);
	assert.equal(ignored('#literal'), true); assert.equal(ignored('!bang'), true); assert.equal(ignored('trail  '), true);
	assert.deepEqual(hook.gitignoreRules('[sem-fim\n'), hook.gitignoreRules('\\[sem-fim\n'), 'colchete sem fim é literal');
});

test('cada pasta usa o próprio .gitignore, e o mais fundo decide (inclusive reincluindo)', (t) => {
	const root = project(t);
	write(root, '.gitignore', '*.gen.ts\ncache/\n');
	write(root, 'packages/web/.gitignore', '.next/\n!keep.gen.ts\n/local.txt\n');
	const paths = ['a.gen.ts', 'packages/web/.next/out.js', 'packages/web/keep.gen.ts', 'packages/web/other.gen.ts',
		'packages/web/local.txt', 'packages/web/src/local.txt', 'packages/api/.next/out.js', 'packages/api/cache/x.txt', 'keep.txt'];
	for (const relative of paths) { write(root, relative, 'v1\n'); }
	turn(root, 'turn-start');
	const time = later(5);
	for (const relative of paths) { write(root, relative, 'v2\n', time); }
	turn(root, 'turn-end');
	assert.deepEqual(log(root).map((entry) => path.relative(root, entry.file).split(path.sep).join('/')).sort(),
		['keep.txt', 'packages/api/.next/out.js', 'packages/web/keep.gen.ts', 'packages/web/src/local.txt']);
});
