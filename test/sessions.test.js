// Testes da leitura dos transcripts do Claude Code: pedido e explicação de cada edição.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
	findReasonInTranscript, findRequestsInTranscript, parseTranscriptMeta, readTranscriptMeta,
} = require('../out/sessions.js');

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
