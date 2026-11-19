// Testes do hook que o Claude Code chama antes e depois de cada edição.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'hooks', 'record-change.js');
const hook = require(HOOK);
const fixtures = [];
test.after(() => { fixtures.forEach((root) => fs.rmSync(root, { recursive: true, force: true })); });

function runHook(phase, input) {
	const result = spawnSync(process.execPath, [HOOK, phase], {
		input: JSON.stringify(input),
		encoding: 'utf8',
		env: { ...process.env, CLAUDE_PROJECT_DIR: input.cwd },
	});
	assert.equal(result.status, 0, result.stderr);
}

function project() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-hook-'));
	fixtures.push(root);
	return root;
}

/** Caminho com "/" em qualquer sistema, para comparar com os caminhos simulados. */
function posix(file) {
	return String(file).replace(/\\/g, '/');
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

function installPolicy(root, fields = {}) {
	const dir = changesDir(root);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'capture-policy.json'), JSON.stringify({ ...hook.DEFAULT_POLICY, generation: 'fixture-generation', ...fields }));
}
function capture(root, phase, input) {
	return hook.run(phase, input, { env: { CLAUDE_PROJECT_DIR: root } });
}

test('paused policy and exclusions prevent new snapshots without exposing fixture text', () => {
	const root = project();
	const file = path.join(root, 'ordinary.txt');
	fs.writeFileSync(file, 'ordinary private fixture');
	installPolicy(root, { paused: true });
	assert.equal(capture(root, 'pre', edit(root, file, 'paused')).state, 'paused');
	assert.equal(fs.existsSync(path.join(changesDir(root), 'blobs')), false);
	assert.equal(fs.readFileSync(path.join(changesDir(root), 'capture-status.json'), 'utf8').includes('ordinary private fixture'), false);
	installPolicy(root, { excludedPatterns: ['**/*.txt'] });
	assert.equal(capture(root, 'pre', edit(root, file, 'excluded')).state, 'excluded');
	assert.equal(fs.existsSync(path.join(changesDir(root), 'log.jsonl')), false);
});

test('unknown policy version blocks capture, and quota never prunes pending data', () => {
	const root = project();
	const file = path.join(root, 'ordinary.txt');
	fs.writeFileSync(file, 'ordinary text');
	installPolicy(root, { schemaVersion: 2 });
	assert.equal(capture(root, 'pre', edit(root, file, 'invalid-policy')).code, 'invalidPolicy');
	installPolicy(root, { maxStorageBytes: 1024 * 1024 });
	const pending = path.join(changesDir(root), 'pending');
	fs.mkdirSync(pending);
	fs.writeFileSync(path.join(pending, 'retained.json'), '{"before":null}');
	assert.equal(capture(root, 'pre', edit(root, file, 'quota')).code, 'quotaExceeded');
	assert.equal(fs.readFileSync(path.join(pending, 'retained.json'), 'utf8'), '{"before":null}');
	assert.equal(fs.existsSync(path.join(changesDir(root), 'log.jsonl')), false);
});

test('pre/post retries retain the first snapshot and produce only one committed record', () => {
	const root = project();
	const file = path.join(root, 'ordinary.txt');
	const input = edit(root, file, 'repeated-operation');
	fs.writeFileSync(file, 'first\n');
	assert.equal(capture(root, 'pre', input).state, 'prepared');
	fs.writeFileSync(file, 'second\n');
	assert.equal(capture(root, 'pre', input).state, 'duplicate');
	assert.equal(capture(root, 'post', input).state, 'recorded');
	assert.equal(capture(root, 'post', input).state, 'duplicate');
	const log = readLog(root);
	assert.equal(log.length, 1);
	assert.equal(blob(root, log[0].before.hash), 'first\n');
	assert.deepEqual(fs.readdirSync(path.join(changesDir(root), 'active')), []);
	if (process.platform !== 'win32') {
		assert.equal(fs.statSync(path.join(changesDir(root), 'log.jsonl')).mode & 0o777, 0o600);
		assert.equal(fs.statSync(path.join(changesDir(root), 'blobs')).mode & 0o777, 0o700);
	}
});

test('generation changes keep the previous pending record rather than fabricating a before', () => {
	const root = project();
	const file = path.join(root, 'ordinary.txt');
	const input = edit(root, file, 'generation');
	fs.writeFileSync(file, 'before\n');
	installPolicy(root);
	assert.equal(capture(root, 'pre', input).state, 'prepared');
	fs.writeFileSync(file, 'after\n');
	installPolicy(root, { generation: 'next-generation' });
	assert.equal(capture(root, 'post', input).state, 'blocked');
	assert.equal(fs.existsSync(path.join(changesDir(root), 'log.jsonl')), false);
	assert.equal(fs.readdirSync(path.join(changesDir(root), 'pending')).filter((name) => name.endsWith('.json')).length, 1);
});

test('permission errors are unknown, confirmed absence is separate, and special-file IO is never read', () => {
	assert.equal(hook.readSmall('/virtual/file.txt', { openSync: () => { throw { code: 'EACCES' }; } }), null);
	assert.deepEqual(hook.readSmall('/virtual/file.txt', { openSync: () => { throw { code: 'ENOENT' }; } }),
		{ exists: false, large: false, text: undefined });
	let reads = 0;
	assert.equal(hook.readSmall('/virtual/file.txt', {
		openSync: () => 1, fstatSync: () => ({ isFile: () => false }), closeSync: () => {}, readSync: () => { reads += 1; },
	}), null);
	assert.equal(reads, 0);
});

test('simulated storage-link metadata is rejected before any file open or write', () => {
	let opens = 0;
	const own = hook.storage('/virtual', {
		realpathSync: (file) => file,
		lstatSync: (file) => ({ isSymbolicLink: () => posix(file) === '/virtual/.claude', isDirectory: () => true, isFile: () => false }),
		openSync: () => { opens += 1; },
	});
	assert.throws(() => own.read('/virtual/.claude/log.jsonl', 100), /unsafeStorageType/);
	assert.equal(opens, 0);
});

test('fallback does not invent a before for an ambiguous or empty replacement', () => {
	assert.equal(hook.rebuildBefore('Edit', { old_string: 'before', new_string: '' }, { text: 'ordinary text' }), null);
	assert.equal(hook.rebuildBefore('Edit', { old_string: 'before', new_string: 'after' }, { text: 'after after' }), null);
	assert.equal(hook.rebuildBefore('Edit', { old_string: 'old', new_string: 'new', replace_all: true }, { text: 'new new' }), null);
});

test('post without pre leaves replace_all before unknown when original matching text is ambiguous', () => {
	const root = project();
	const file = path.join(root, 'ordinary.txt');
	fs.writeFileSync(file, 'new new');
	const input = edit(root, file, 'replace-all', 'Edit', { old_string: 'old', new_string: 'new', replace_all: true });
	assert.equal(capture(root, 'post', input).state, 'recorded');
	const [record] = readLog(root);
	assert.equal(record.before, null);
	assert.equal(blob(root, record.after.hash), 'new new');
});

test('snapshots preserve BOM and line endings in ordinary source text', () => {
	const root = project();
	const file = path.join(root, 'ordinary.txt');
	const input = edit(root, file, 'bom');
	fs.writeFileSync(file, '\uFEFFbefore\r\n');
	assert.equal(capture(root, 'pre', input).state, 'prepared');
	fs.writeFileSync(file, '\uFEFFafter\r\n');
	assert.equal(capture(root, 'post', input).state, 'recorded');
	const [record] = readLog(root);
	assert.equal(blob(root, record.before.hash), '\uFEFFbefore\r\n');
	assert.equal(blob(root, record.after.hash), '\uFEFFafter\r\n');
});

test('stdin budget admits ordinary escaped Edit fields up to the supported file snapshot size', () => {
	const text = '\u0001'.repeat(hook.MAX_FILE_BYTES - 4) + 'á';
	const input = { tool_input: { old_string: text, new_string: text } };
	const bytes = Buffer.byteLength(JSON.stringify(input));
	assert.ok(bytes > 1024 * 1024);
	assert.ok(bytes < hook.MAX_INPUT_BYTES);
});

test('maintenance guard blocks new producers before data directories and never recreates diagnostic data', () => {
	const root = project();
	const file = path.join(root, 'ordinary.txt');
	fs.writeFileSync(file, 'ordinary content');
	installPolicy(root);
	const dir = changesDir(root);
	const guard = path.join(dir, hook.CAPTURE_MAINTENANCE_FILE);
	const token = JSON.stringify({ token: 'maintenance-fixture', pid: process.pid });
	fs.writeFileSync(guard, token, { flag: 'wx' });
	const result = capture(root, 'pre', edit(root, file, 'maintenance'));
	assert.equal(result.code, 'captureMaintenance');
	for (const name of ['blobs', 'pending', 'completed', 'log.jsonl', 'capture-status.json', '.gitignore']) {
		assert.equal(fs.existsSync(path.join(dir, name)), false, name);
	}
	assert.deepEqual(fs.readdirSync(path.join(dir, 'active')), []);
	assert.equal(fs.readFileSync(guard, 'utf8'), token);
});

test('producer is visible before a normal blob write and observes a later maintenance guard before append', () => {
	const root = project();
	const file = path.join(root, 'ordinary.txt');
	fs.writeFileSync(file, 'ordinary content');
	installPolicy(root);
	const dir = changesDir(root);
	const guard = path.join(dir, hook.CAPTURE_MAINTENANCE_FILE);
	let observedActive = false;
	const io = { ...fs, openSync(name, flags, ...args) {
		if (String(name).includes(`${path.sep}blobs${path.sep}`) && !fs.existsSync(guard)) {
			assert.equal(fs.readdirSync(path.join(dir, 'active')).length, 1);
			observedActive = true;
			fs.writeFileSync(guard, JSON.stringify({ token: 'maintenance-fixture', pid: process.pid }), { flag: 'wx' });
		}
		return fs.openSync(name, flags, ...args);
	} };
	const result = hook.run('post', edit(root, file, 'in-flight-maintenance'), { env: { CLAUDE_PROJECT_DIR: root }, fs: io });
	assert.equal(observedActive, true);
	assert.equal(result.code, 'captureMaintenance');
	assert.equal(fs.existsSync(path.join(dir, 'log.jsonl')), false);
	assert.equal(fs.existsSync(path.join(dir, 'capture-status.json')), false);
	assert.deepEqual(fs.readdirSync(path.join(dir, 'active')), []);
	assert.deepEqual(fs.readdirSync(path.join(dir, 'pending')), []);
});

test('diagnostic producer keeps a lease and discards its own temporary status when maintenance begins', () => {
	const root = project();
	const file = path.join(root, 'ordinary.txt');
	fs.writeFileSync(file, 'ordinary content');
	installPolicy(root, { paused: true });
	const dir = changesDir(root);
	const guard = path.join(dir, hook.CAPTURE_MAINTENANCE_FILE);
	let observedActive = false;
	const io = { ...fs, openSync(name, flags, ...args) {
		if (path.basename(String(name)).startsWith('.capture-status-') && !fs.existsSync(guard)) {
			assert.equal(fs.readdirSync(path.join(dir, 'active')).length, 1);
			observedActive = true;
			fs.writeFileSync(guard, JSON.stringify({ token: 'maintenance-fixture', pid: process.pid }), { flag: 'wx' });
		}
		return fs.openSync(name, flags, ...args);
	} };
	hook.run('pre', edit(root, file, 'diagnostic-maintenance'), { env: { CLAUDE_PROJECT_DIR: root }, fs: io });
	assert.equal(observedActive, true);
	assert.equal(fs.existsSync(path.join(dir, 'capture-status.json')), false);
	assert.equal(fs.readdirSync(dir).some((name) => name.startsWith('.capture-status-')), false);
	assert.deepEqual(fs.readdirSync(path.join(dir, 'active')), []);
});

test('failed exclusive lease creation never removes the path that belongs to another producer', () => {
	const root = project();
	const file = path.join(root, 'ordinary.txt');
	fs.writeFileSync(file, 'ordinary content');
	installPolicy(root);
	const collisions = new Set();
	let foreignDeletes = 0;
	const io = { ...fs,
		openSync(name, flags, ...args) {
			if (String(name).includes(`${path.sep}active${path.sep}`) && (flags & fs.constants.O_EXCL)) {
				collisions.add(String(name));
				throw { code: 'EEXIST' };
			}
			return fs.openSync(name, flags, ...args);
		},
		unlinkSync(name) {
			if (collisions.has(String(name))) { foreignDeletes += 1; return; }
			return fs.unlinkSync(name);
		},
	};
	const result = hook.run('pre', edit(root, file, 'lease-collision'), { env: { CLAUDE_PROJECT_DIR: root }, fs: io });
	assert.equal(result.state, 'blocked');
	assert.ok(collisions.size >= 1);
	assert.equal(foreignDeletes, 0);
});
