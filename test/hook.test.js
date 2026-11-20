// Testes do hook que o Claude Code chama antes e depois de cada edição.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const vm = require('node:vm');

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

function hookForPlatform(platform) {
	const module = { exports: {} };
	const source = fs.readFileSync(HOOK, 'utf8').replace(/^#![^\n]*/, '');
	const load = vm.runInThisContext('(function(require,module,exports,process){' + source + '\n})', { filename: HOOK });
	load(createRequire(HOOK), module, module.exports, { platform, pid: process.pid, cwd: () => process.cwd(), env: {} });
	return module.exports;
}

function changesDir(root) {
	return path.join(root, '.claude', 'launcher-changes');
}

function diagnosticEvents(root, bucket = 'observations') {
	const directory = path.join(changesDir(root), ...hook.CAPTURE_DIAGNOSTICS_DIR.split('/'), bucket);
	return fs.existsSync(directory) ? fs.readdirSync(directory).sort().map((name) => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'))) : [];
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
	assert.equal(JSON.stringify(diagnosticEvents(root)).includes('ordinary private fixture'), false);
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
	const root = path.resolve(path.sep, 'virtual');
	const linked = path.join(root, '.claude');
	const own = hook.storage(root, {
		realpathSync: (file) => file,
		lstatSync: (file) => ({ isSymbolicLink: () => posix(file) === posix(linked), isDirectory: () => true, isFile: () => false }),
		openSync: () => { opens += 1; },
	});
	assert.throws(() => own.read(path.join(linked, 'log.jsonl'), 100), /unsafeStorageType/);
	assert.equal(opens, 0);
});

test('snapshot timestamp refresh uses portable write access without destructive flags or content changes', () => {
	const root = project();
	const file = path.join(root, 'ordinary.txt');
	const content = 'ordinary content\r\n';
	fs.writeFileSync(file, content);
	const descriptors = new Map();
	const refreshed = [];
	const io = {
		...fs,
		openSync(file, flags, mode) {
			const fd = fs.openSync(file, flags, mode);
			descriptors.set(fd, { file, flags });
			return fd;
		},
		closeSync(fd) { descriptors.delete(fd); return fs.closeSync(fd); },
		futimesSync(fd, atime, mtime) {
			const opened = descriptors.get(fd);
			assert.ok(opened);
			assert.equal(path.dirname(opened.file), fs.realpathSync(path.join(changesDir(root), 'blobs')));
			// Model the Windows requirement: a read-only handle cannot update attributes.
			if ((opened.flags & fs.constants.O_RDWR) !== fs.constants.O_RDWR) {
				throw Object.assign(new Error('write access required for timestamp refresh'), { code: 'EPERM' });
			}
			assert.equal(opened.flags & (fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND), 0);
			if (fs.constants.O_NOFOLLOW) { assert.notEqual(opened.flags & fs.constants.O_NOFOLLOW, 0); }
			assert.equal(fs.readFileSync(opened.file, 'utf8'), content);
			refreshed.push(opened.file);
			return fs.futimesSync(fd, atime, mtime);
		},
	};
	const input = edit(root, file, 'portable-timestamps');
	const options = { fs: io, env: { CLAUDE_PROJECT_DIR: root } };
	assert.equal(hook.run('pre', input, options).state, 'prepared');
	assert.equal(hook.run('post', input, options).state, 'recorded');
	assert.equal(refreshed.length, 2, 'new and reused snapshots both refresh the existing blob');
	assert.equal(refreshed[0], refreshed[1]);
	const [entry] = readLog(root);
	assert.equal(blob(root, entry.before.hash), content);
	assert.equal(blob(root, entry.after.hash), content);
});

test('timestamp refresh errors keep capture blocked instead of recording an unrefreshed snapshot', () => {
	const root = project();
	const file = path.join(root, 'ordinary.txt');
	fs.writeFileSync(file, 'ordinary content');
	let refreshes = 0;
	const io = {
		...fs,
		futimesSync() { refreshes += 1; throw Object.assign(new Error('fixture access denied'), { code: 'EACCES' }); },
	};
	assert.deepEqual(hook.run('pre', edit(root, file, 'denied-timestamps'), { fs: io, env: { CLAUDE_PROJECT_DIR: root } }),
		{ state: 'blocked', code: 'storageUnavailable' });
	assert.equal(refreshes, 1);
	assert.equal(fs.existsSync(path.join(changesDir(root), 'log.jsonl')), false);
	assert.deepEqual(fs.readdirSync(path.join(changesDir(root), 'pending')), []);
	assert.deepEqual(fs.readdirSync(path.join(changesDir(root), 'active')), []);
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
	for (const name of ['blobs', 'pending', 'completed', 'log.jsonl', 'capture-status.json', 'capture-diagnostics', '.gitignore']) {
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

test('diagnostic producer keeps a lease and discards only its own event when maintenance begins', () => {
	const root = project();
	const file = path.join(root, 'ordinary.txt');
	fs.writeFileSync(file, 'ordinary content');
	installPolicy(root, { paused: true });
	const dir = changesDir(root);
	const guard = path.join(dir, hook.CAPTURE_MAINTENANCE_FILE);
	let observedActive = false;
	const io = { ...fs, openSync(name, flags, ...args) {
		if (String(name).includes(`${path.sep}observations${path.sep}`) && !fs.existsSync(guard)) {
			assert.equal(fs.readdirSync(path.join(dir, 'active')).length, 1);
			observedActive = true;
			fs.writeFileSync(guard, JSON.stringify({ token: 'maintenance-fixture', pid: process.pid }), { flag: 'wx' });
		}
		return fs.openSync(name, flags, ...args);
	} };
	hook.run('pre', edit(root, file, 'diagnostic-maintenance'), { env: { CLAUDE_PROJECT_DIR: root }, fs: io });
	assert.equal(observedActive, true);
	assert.equal(fs.existsSync(path.join(dir, 'capture-status.json')), false);
	assert.deepEqual(diagnosticEvents(root), []);
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

test('diagnostic pre is observation only, post proves append, and legacy status is preserved', () => {
	const root = project(), file = path.join(root, 'ordinary.txt');
	const privateText = 'ordinary-private-fixture';
	fs.writeFileSync(file, privateText);
	installPolicy(root);
	const legacy = path.join(changesDir(root), 'capture-status.json');
	const legacyText = JSON.stringify({ schemaVersion: 1, state: 'active', updatedAt: '2020-01-01T00:00:00.000Z' });
	fs.writeFileSync(legacy, legacyText);
	const input = { ...edit(root, file, 'diagnostic-commit'), transcript_path: path.join(root, 'private-transcript.jsonl') };
	assert.equal(capture(root, 'pre', input).state, 'prepared');
	assert.deepEqual(diagnosticEvents(root, 'completions'), []);
	assert.equal(diagnosticEvents(root)[0].code, 'capturePrepared');
	assert.equal(capture(root, 'post', input).state, 'recorded');
	const [completion] = diagnosticEvents(root, 'completions');
	assert.equal(completion.phase, 'post');
	assert.equal(completion.stage, 'append');
	assert.equal(completion.code, 'captureRecorded');
	assert.equal(completion.contentCoverage, 'complete');
	assert.equal(readLog(root).length, 1);
	assert.equal(capture(root, 'post', input).state, 'duplicate');
	assert.deepEqual(diagnosticEvents(root, 'completions'), [completion]);
	assert.equal(fs.readFileSync(legacy, 'utf8'), legacyText);
	const evidence = JSON.stringify([...diagnosticEvents(root), completion]);
	for (const marker of [privateText, root, file, 'private-transcript', 'diagnostic-commit']) { assert.equal(evidence.includes(marker), false); }
	assert.deepEqual(Object.keys(completion).sort(), ['code', 'contentCoverage', 'id', 'kind', 'observedAt', 'phase', 'schemaVersion', 'stage']);
});

test('later diagnostic failures preserve completion evidence and classify only enumerated IO categories', () => {
	for (const [errno, code] of [['EACCES', 'storagePermissionDenied'], ['EROFS', 'storageReadOnly'], ['ENOSPC', 'storageFull']]) {
		const root = project(), file = path.join(root, 'ordinary.txt');
		fs.writeFileSync(file, 'ordinary content');
		const input = edit(root, file, 'first');
		capture(root, 'pre', input); capture(root, 'post', input);
		const completions = diagnosticEvents(root, 'completions');
		const io = { ...fs, futimesSync() { throw Object.assign(new Error('ordinary-private-exception'), { code: errno }); } };
		assert.equal(hook.run('pre', edit(root, file, 'later'), { fs: io, env: { CLAUDE_PROJECT_DIR: root } }).state, 'blocked');
		assert.deepEqual(diagnosticEvents(root, 'completions'), completions);
		const observed = diagnosticEvents(root).find((event) => event.code === code);
		assert.ok(observed);
		assert.equal(observed.stage, 'snapshot');
		assert.equal(JSON.stringify(observed).includes('ordinary-private-exception'), false);
	}
});

test('failed append cannot produce completion evidence even after a prepared snapshot', () => {
	const root = project(), file = path.join(root, 'ordinary.txt');
	fs.writeFileSync(file, 'ordinary content');
	const input = edit(root, file, 'append-failure');
	assert.equal(capture(root, 'pre', input).state, 'prepared');
	const io = { ...fs, openSync(name, flags, ...args) {
		if (path.basename(String(name)) === 'log.jsonl') { throw Object.assign(new Error('ordinary fixture'), { code: 'ENOSPC' }); }
		return fs.openSync(name, flags, ...args);
	} };
	assert.equal(hook.run('post', input, { fs: io, env: { CLAUDE_PROJECT_DIR: root } }).state, 'blocked');
	assert.deepEqual(diagnosticEvents(root, 'completions'), []);
	assert.ok(diagnosticEvents(root).some((event) => event.code === 'storageFull' && event.stage === 'append'));
});

test('unconfirmed append flush cannot produce completion evidence', () => {
	const root = project(), file = path.join(root, 'ordinary.txt');
	fs.writeFileSync(file, 'ordinary content');
	const input = edit(root, file, 'append-flush');
	capture(root, 'pre', input);
	const descriptors = new Map();
	const io = { ...fs,
		openSync(name, flags, ...args) { const fd = fs.openSync(name, flags, ...args); descriptors.set(fd, String(name)); return fd; },
		closeSync(fd) { descriptors.delete(fd); return fs.closeSync(fd); },
		fsyncSync(fd) {
			if (path.basename(descriptors.get(fd) || '') === 'log.jsonl') { throw Object.assign(new Error('ordinary flush fixture'), { code: 'ENOSPC' }); }
			return fs.fsyncSync(fd);
		},
	};
	assert.equal(hook.run('post', input, { fs: io, env: { CLAUDE_PROJECT_DIR: root } }).state, 'blocked');
	assert.deepEqual(diagnosticEvents(root, 'completions'), []);
	assert.ok(diagnosticEvents(root).some((event) => event.code === 'storageFull' && event.stage === 'append'));
});

test('a completion-marker failure preserves confirmed append evidence and reports its separate stage', () => {
	const root = project(), file = path.join(root, 'ordinary.txt');
	fs.writeFileSync(file, 'ordinary content');
	const input = edit(root, file, 'marker-failure'); capture(root, 'pre', input);
	const io = { ...fs, openSync(name, flags, ...args) {
		if (path.basename(path.dirname(String(name))) === 'completed' && flags & fs.constants.O_CREAT) {
			throw Object.assign(new Error('ordinary marker fixture'), { code: 'ENOSPC' });
		}
		return fs.openSync(name, flags, ...args);
	} };
	assert.equal(hook.run('post', input, { fs: io, env: { CLAUDE_PROJECT_DIR: root } }).state, 'blocked');
	assert.equal(readLog(root).length, 1);
	assert.equal(diagnosticEvents(root, 'completions').length, 1);
	assert.ok(diagnosticEvents(root).some((event) => event.code === 'storageFull' && event.stage === 'completion'));
});

test('large and excluded captures do not claim complete content coverage', () => {
	const root = project(), file = path.join(root, 'ordinary.txt');
	fs.writeFileSync(file, 'x'.repeat(hook.MAX_FILE_BYTES + 1));
	const input = edit(root, file, 'large');
	capture(root, 'pre', input); capture(root, 'post', input);
	assert.equal(diagnosticEvents(root, 'completions')[0].contentCoverage, 'limited');
	installPolicy(root, { excludedPatterns: ['**/*.txt'] });
	assert.equal(capture(root, 'post', edit(root, file, 'excluded')).state, 'excluded');
	assert.ok(diagnosticEvents(root).some((event) => event.code === 'excludedByPolicy' && event.contentCoverage === 'none'));
	assert.equal(diagnosticEvents(root, 'completions').length, 1);
});

test('diagnostic retention bounds known events and preserves unsupported or corrupt evidence', () => {
	const root = project(), file = path.join(root, 'ordinary.txt');
	fs.writeFileSync(file, 'ordinary content');
	const directory = path.join(changesDir(root), ...hook.CAPTURE_DIAGNOSTICS_DIR.split('/'), 'observations');
	fs.mkdirSync(directory, { recursive: true });
	const unknown = path.join(directory, `20200101T000000000Z-${'a'.repeat(32)}.json`);
	const corrupt = path.join(directory, 'unknown.json');
	fs.writeFileSync(unknown, '{"schemaVersion":999}'); fs.writeFileSync(corrupt, 'unfinished fixture');
	const initial = Date.now() - 60000;
	for (let i = 0; i < 40; i += 1) {
		assert.equal(hook.run('pre', edit(root, file, 'retained-' + i), { env: { CLAUDE_PROJECT_DIR: root }, now: () => initial + i }).state, 'prepared');
	}
	assert.equal(fs.readdirSync(directory).length, 34);
	assert.equal(fs.readFileSync(unknown, 'utf8'), '{"schemaVersion":999}');
	assert.equal(fs.readFileSync(corrupt, 'utf8'), 'unfinished fixture');
	const known = fs.readdirSync(directory).filter((name) => ![path.basename(unknown), path.basename(corrupt)].includes(name))
		.map((name) => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')));
	assert.equal(known.map((event) => event.observedAt).sort().at(-1), new Date(initial + 39).toISOString());
});

test('maintenance arriving during diagnostic pruning preserves prior events and removes only the new own event', () => {
	const root = project(), file = path.join(root, 'ordinary.txt');
	fs.writeFileSync(file, 'ordinary content');
	const initial = Date.now() - 60000;
	for (let i = 0; i < 32; i += 1) { hook.run('pre', edit(root, file, 'previous-' + i), { env: { CLAUDE_PROJECT_DIR: root }, now: () => initial + i }); }
	const directory = path.join(changesDir(root), ...hook.CAPTURE_DIAGNOSTICS_DIR.split('/'), 'observations');
	const previous = fs.readdirSync(directory).sort();
	const guard = path.join(changesDir(root), hook.CAPTURE_MAINTENANCE_FILE);
	let interrupted = false;
	const io = { ...fs, openSync(name, flags, ...args) {
		if (!interrupted && String(name).includes(`${path.sep}observations${path.sep}`) && !(flags & fs.constants.O_CREAT)) {
			assert.equal(fs.readdirSync(path.join(changesDir(root), 'active')).length, 1);
			interrupted = true;
			fs.writeFileSync(guard, '{"token":"ordinary-maintenance-fixture"}', { flag: 'wx' });
		}
		return fs.openSync(name, flags, ...args);
	} };
	assert.equal(hook.run('pre', edit(root, file, 'new-event'), { fs: io, env: { CLAUDE_PROJECT_DIR: root } }).state, 'prepared');
	assert.equal(interrupted, true);
	assert.deepEqual(fs.readdirSync(directory).sort(), previous);
	assert.deepEqual(fs.readdirSync(path.join(changesDir(root), 'active')), []);
});

test('saturated unknown diagnostic inventory is bounded and does not block the Claude observation', () => {
	const root = project(), file = path.join(root, 'ordinary.txt');
	fs.writeFileSync(file, 'ordinary content');
	const directory = path.join(changesDir(root), ...hook.CAPTURE_DIAGNOSTICS_DIR.split('/'), 'observations');
	fs.mkdirSync(directory, { recursive: true });
	for (let i = 0; i < 150; i += 1) { fs.writeFileSync(path.join(directory, `unknown-${i}.json`), '{}'); }
	let reads = 0;
	const io = { ...fs, opendirSync(name, options) {
		const opened = fs.opendirSync(name, options);
		if (!String(name).endsWith(`${path.sep}observations`)) { return opened; }
		return { readSync() { reads += 1; return opened.readSync(); }, closeSync: () => opened.closeSync() };
	} };
	assert.equal(hook.run('pre', edit(root, file, 'saturated'), { fs: io, env: { CLAUDE_PROJECT_DIR: root } }).state, 'prepared');
	assert.equal(reads, 129);
	assert.equal(fs.readdirSync(directory).length, 150);
	assert.equal(fs.existsSync(path.join(changesDir(root), 'capture-status.json')), false);
});

test('one continuous producer lease spans append, diagnostic publication and pruning', () => {
	const root = project(), file = path.join(root, 'ordinary.txt');
	fs.writeFileSync(file, 'ordinary content');
	const releases = [];
	const io = { ...fs, unlinkSync(name) {
		if (String(name).includes(`${path.sep}active${path.sep}`)) {
			releases.push(diagnosticEvents(root, 'completions').length === 1 && diagnosticEvents(root).length === 1);
		}
		return fs.unlinkSync(name);
	} };
	assert.equal(hook.run('post', edit(root, file, 'continuous-lease'), { fs: io, env: { CLAUDE_PROJECT_DIR: root } }).state, 'recorded');
	assert.deepEqual(releases, [true], 'no lease is released in a gap before diagnostic evidence is published');
	assert.deepEqual(fs.readdirSync(path.join(changesDir(root), 'active')), []);
});
