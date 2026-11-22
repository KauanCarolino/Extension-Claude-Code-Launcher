// Testes da leitura dos transcripts do Claude Code: pedido e explicação de cada edição.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const OUT = process.env.LAUNCHER_TEST_OUT || path.resolve(__dirname, '../out');
const {
	findReasonInTranscript, findRequestsInTranscript, parseTranscriptMeta, readTranscriptMeta,
	clearTranscriptMetadataForRoots, transcriptMetadataCacheCount,
} = require(path.join(OUT, 'sessions.js'));

function transcript(lines) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-test-'));
	const file = path.join(dir, 'conversa.jsonl');
	fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
	return file;
}

const user = (uuid, content) => ({ type: 'user', uuid, message: { role: 'user', content } });
const assistant = (content) => ({ type: 'assistant', message: { role: 'assistant', content } });
const toolUse = (id) => ({ type: 'tool_use', id, name: 'Edit', input: {} });
const toolResult = (id) => user(`r-${id}`, [{ type: 'tool_result', tool_use_id: id, content: 'ok' }]);

test('cada edição aponta para a mensagem do usuário que a pediu', () => {
	const file = transcript([
		user('p1', 'adicione um botão'),
		assistant([{ type: 'text', text: 'Vou editar o arquivo.' }, toolUse('t1')]),
		toolResult('t1'),
		assistant([toolUse('t2')]),
		toolResult('t2'),
		user('p2', [{ type: 'text', text: 'agora mude a cor' }]),
		assistant([toolUse('t3')]),
	]);
	const requests = findRequestsInTranscript(file);
	assert.deepEqual(requests.get('t1'), { id: 'p1', text: 'adicione um botão' });
	assert.equal(requests.get('t2').id, 'p1', 'resposta de ferramenta não é pedido novo');
	assert.deepEqual(requests.get('t3'), { id: 'p2', text: 'agora mude a cor' });
});

test('mensagens internas não contam como pedido', () => {
	const file = transcript([
		user('p1', 'corrija o bug'),
		{ type: 'user', uuid: 'meta', isMeta: true, message: { role: 'user', content: 'lembrete do sistema' } },
		assistant([toolUse('t1')]),
	]);
	assert.equal(findRequestsInTranscript(file).get('t1').id, 'p1');
});

test('transcript inexistente não quebra', () => {
	assert.equal(findRequestsInTranscript(path.join(os.tmpdir(), 'nao-existe.jsonl')).size, 0);
	assert.equal(findReasonInTranscript(path.join(os.tmpdir(), 'nao-existe.jsonl'), 't1'), null);
});

test('a explicação é o texto logo antes da edição', () => {
	const file = transcript([
		user('p1', 'faça X'),
		assistant([{ type: 'text', text: 'Primeiro, ajusto o tipo.' }, toolUse('t1')]),
		toolResult('t1'),
		assistant([{ type: 'text', text: 'Agora o teste.' }, toolUse('t2')]),
	]);
	assert.equal(findReasonInTranscript(file, 't1'), 'Primeiro, ajusto o tipo.');
	assert.equal(findReasonInTranscript(file, 't2'), 'Agora o teste.');
});

test('parseTranscriptMeta acha explicação e pedido de todas as edições numa passada', () => {
	const lines = [
		user('p1', 'faça X'),
		assistant([{ type: 'text', text: 'Ajusto o tipo.' }, toolUse('t1'), toolUse('t2')]),
		toolResult('t1'),
		assistant([{ type: 'thinking', thinking: 'Agora o teste.' }, toolUse('t3')]),
	].map((line) => JSON.stringify(line)).join('\n');
	const meta = parseTranscriptMeta(lines, 'x.jsonl');
	assert.equal(meta.reasons.get('t1'), 'Ajusto o tipo.');
	assert.equal(meta.reasons.get('t2'), 'Ajusto o tipo.', 'chamadas em paralelo dividem a explicação');
	assert.equal(meta.reasons.get('t3'), 'Agora o teste.', 'sem texto, vale o thinking');
	assert.equal(meta.requests.get('t3').id, 'p1');
});

test('readTranscriptMeta lê de forma assíncrona e relê só quando o arquivo muda', async () => {
	const file = transcript([user('p1', 'faça X'), assistant([toolUse('t1')])]);
	const first = await readTranscriptMeta(file);
	assert.equal(first.requests.get('t1').id, 'p1');
	assert.equal(await readTranscriptMeta(file), first, 'sem mudança, usa o cache');
	fs.appendFileSync(file, `${JSON.stringify(assistant([toolUse('t2')]))}\n`);
	const second = await readTranscriptMeta(file);
	assert.equal(second.requests.get('t2').id, 'p1');
	assert.equal((await readTranscriptMeta(path.join(os.tmpdir(), 'nao-existe.jsonl'))).reasons.size, 0);
});

function syntheticReader(records, overrides = {}) {
	const calls = { stat: 0, open: 0 };
	const fileSystem = { ...fs, promises: { ...fs.promises,
		async stat(file) { calls.stat++; const text = records.get(file); if (text === undefined) throw new Error('ordinary fixture absent'); return { size: Buffer.byteLength(text), mtimeMs: 1 }; },
		async open(file) {
			calls.open++; return { async read(buffer, offset, length, start) {
				const value = Buffer.from(records.get(file)); const bytesRead = value.copy(buffer, offset, start, start + length); return { bytesRead };
			}, async close() {} };
		}, ...overrides,
	} };
	const filename = path.join(OUT, 'sessions.js'), module = { exports: {} };
	vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, Buffer, process: { env: {} },
		require: name => name === 'fs' ? fileSystem : name.startsWith('./') ? require(path.join(OUT, name)) : require(name) }, { filename });
	return { api: module.exports, calls };
}
function transcriptText(lines) { return lines.map(line => JSON.stringify(line)).join('\n') + '\n'; }

test('shared-transcript selection returns only permitted tool IDs and does not retain excluded metadata', async () => {
	const file = '/fixture/A/shared.jsonl';
	const text = transcriptText([user('p1', 'ordinary request'), assistant([{ type: 'text', text: 'ordinary reason' }, toolUse('excluded'), toolUse('permitted')])]);
	const f = syntheticReader(new Map([[file, text]]));
	const meta = await f.api.readTranscriptMeta(file, { toolUseIds: ['permitted'], cache: false });
	assert.deepEqual([...meta.reasons.keys()], ['permitted']); assert.deepEqual([...meta.requests.keys()], ['permitted']);
	assert.equal(meta.requests.get('permitted').id, 'p1'); assert.equal(f.api.transcriptMetadataCacheCount(['/fixture/A']), 0);
	const parsed = parseTranscriptMeta(text, file, { toolUseIds: ['permitted'] });
	assert.deepEqual([...parsed.reasons.keys()], ['permitted']); assert.equal(parsed.requests.has('excluded'), false);
});

test('cache:false and selective reads bypass a prior full cache and do not retain new content', async () => {
	const file = '/fixture/A/cache.jsonl', make = reason => transcriptText([user('p1', 'ordinary request'), assistant([{ type: 'text', text: reason }, toolUse('t1')])]);
	const records = new Map([[file, make('reason A')]]), f = syntheticReader(records);
	const cached = await f.api.readTranscriptMeta(file);
	assert.equal(f.api.transcriptMetadataCacheCount(['/fixture/A']), 1);
	records.set(file, make('reason B')); // Same byte length and synthetic mtime, so legacy cache remains reusable.
	const fresh = await f.api.readTranscriptMeta(file, { cache: false });
	assert.equal(fresh.reasons.get('t1'), 'reason B'); assert.notEqual(fresh, cached);
	assert.equal(await f.api.readTranscriptMeta(file), cached); assert.equal(cached.reasons.get('t1'), 'reason A');
	assert.equal((await f.api.readTranscriptMeta(file, { toolUseIds: ['t1'] })).reasons.get('t1'), 'reason B');
	assert.equal(f.api.clearTranscriptMetadataForRoots(['/fixture/A']), 1);
	await f.api.readTranscriptMeta(file, { cache: false }); assert.equal(f.api.transcriptMetadataCacheCount(['/fixture/A']), 0);
});

test('cache invalidation is memory-only and respects project boundaries and Windows directory case', async () => {
	const a = String.raw`D:\Fixture\A\chat.jsonl`, b = String.raw`D:\Fixture\B\chat.jsonl`, upper = String.raw`D:\Fixture\Case\chat.jsonl`;
	const text = transcriptText([user('p1', 'ordinary request'), assistant([toolUse('t1')])]);
	const f = syntheticReader(new Map([[a, text], [b, text], [upper, text]]));
	for (const file of [a, b, upper]) await f.api.readTranscriptMeta(file);
	const before = { ...f.calls };
	assert.equal(f.api.transcriptMetadataCacheCount([String.raw`d:\Fixture\A`]), 1);
	assert.equal(f.api.transcriptMetadataCacheCount([String.raw`D:\Fixture\case`]), 0);
	assert.equal(f.api.clearTranscriptMetadataForRoots([String.raw`d:\Fixture\A`]), 1);
	assert.equal(f.api.transcriptMetadataCacheCount([String.raw`D:\Fixture\B`]), 1);
	assert.equal(f.api.transcriptMetadataCacheCount([String.raw`D:\Fixture\Case`]), 1);
	assert.equal(f.api.clearTranscriptMetadataForRoots([String.raw`D:\Fixture\case`]), 0);
	assert.equal(f.api.clearTranscriptMetadataForRoots(['relative-root']), 0); assert.deepEqual(f.calls, before);
});

test('malformed or over-budget metadata selections return before any filesystem IO', async () => {
	const f = syntheticReader(new Map());
	for (const options of [null, [], { cache: 'yes' }, { unknown: true }, { toolUseIds: [] }, { toolUseIds: 't1' },
		{ toolUseIds: [''] }, { toolUseIds: ['bad\n'] }, { toolUseIds: ['a'.repeat(257)] }, { toolUseIds: Array(257).fill('t1') }, { toolUseIds: Array(1) }]) {
		const meta = await f.api.readTranscriptMeta('/fixture/A/absent.jsonl', options); assert.equal(meta.reasons.size, 0); assert.equal(meta.requests.size, 0);
	}
	await f.api.readTranscriptMeta('/fixture/invalid\n.jsonl');
	assert.deepEqual(f.calls, { stat: 0, open: 0 });
});

test('a read started before cache invalidation cannot repopulate the cleared scope afterwards', async () => {
	const file = '/fixture/A/inflight.jsonl', text = transcriptText([user('p1', 'ordinary request'), assistant([toolUse('t1')])]);
	let release, signal;
	const waiting = new Promise(resolve => { release = resolve; }), opened = new Promise(resolve => { signal = resolve; });
	const f = syntheticReader(new Map([[file, text]]), { async open() {
		signal(); await waiting;
		return { async read(buffer, offset, length, start) { return { bytesRead: Buffer.from(text).copy(buffer, offset, start, start + length) }; }, async close() {} };
	} });
	const read = f.api.readTranscriptMeta(file); await opened;
	assert.equal(f.api.clearTranscriptMetadataForRoots(['/fixture/A']), 0); release();
	assert.equal((await read).requests.has('t1'), true); assert.equal(f.api.transcriptMetadataCacheCount(['/fixture/A']), 0);
});
