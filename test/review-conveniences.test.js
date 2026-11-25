'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, entry, writeLog, OUT } = require('./helpers/changes-fixture.cjs');
const { changesSummary } = require(path.join(OUT, 'changes-view.js'));

test('o resumo agrupa por pedido, soma edições do mesmo arquivo e cita a explicação do Claude', () => {
	const item = (file, fields = {}) => ({ file, dir: 'src', action: 'Editou', added: 1, removed: 0, status: null, requestId: 'r1', request: 'Corrija o login', reason: null, ...fields });
	const text = changesSummary([
		item('a.ts', { reason: 'Vou validar o token.\n\nDetalhes que não entram.' }),
		item('a.ts', { added: 2, removed: 3, status: 'accepted', reason: 'Vou validar o token.' }),
		item('b`x.ts', { action: 'Mudou por comando', status: 'rejected' }),
		item('c.ts', { requestId: null, request: null, dir: '' }),
	]);
	assert.equal(text, [
		'## Mudanças do Claude', '',
		'### Pedido: Corrija o login', '',
		'- `src/a.ts` — Editou (2 edições) · +3 −3 · aceita',
		"- `src/b'x.ts` — Mudou por comando · +1 · recusada", '',
		'> Vou validar o token.', '',
		'### Outras mudanças', '',
		'- `c.ts` — Editou · +1 · pendente', '',
	].join('\n'));
});

test('aceitar um pedido mantém só os arquivos cujas mudanças vieram todas dele, e o resumo vai para a área de transferência', async (t) => {
	const f = fixture(t);
	const items = [entry(f.root, 'one'), entry(f.root, 'two'), entry(f.root, 'mixed-old', 'mixed.txt', '2026-11-19T11:00:00.000Z'), entry(f.root, 'mixed-new', 'mixed.txt')];
	items[3].before = { exists: true, text: 'after', large: false };
	for (const item of items) { fs.writeFileSync(item.file, 'after'); }
	writeLog(f, items); await f.store(); f.controller.entries = await f.controller.loadEntries();
	for (const id of ['one', 'two', 'mixed-new']) { f.controller.requestCache.set(id, { id: 'r1', text: 'Pedido um' }); }
	f.controller.requestCache.set('mixed-old', { id: 'r0', text: 'Pedido antigo' });
	await f.controller.handleMessage({ command: 'acceptRequest', request: 'r1' }, { postMessage: async () => undefined }, false);
	assert.equal(f.controller.status.get('one'), 'accepted'); assert.equal(f.controller.status.get('two'), 'accepted');
	assert.equal(f.controller.status.has('mixed-new'), false, 'mixed.txt tem mudança de outro pedido e fica pendente');
	assert.equal(fs.readFileSync(path.join(f.root, 'one.txt'), 'utf8'), 'after');
	let copied;
	f.vscode.env = { clipboard: { writeText: async (text) => { copied = text; } } };
	await f.controller.handleMessage({ command: 'copySummary' }, { postMessage: async () => undefined }, false);
	assert.match(copied, /^## Mudanças do Claude\n/);
	assert.match(copied, /### Pedido: Pedido um[\s\S]*`one\.txt`[\s\S]*aceita/);
	assert.match(f.messages.at(-1), /Resumo de 3 arquivos copiado/);
});
