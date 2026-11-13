// Testes das regras de revisão: juntar edições, recusar e limpar o log.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { collectChain, fileKey, groupByFile, planRevert, textOf, trimLog } = require('../out/logic.js');

function snap(text) {
	return text === undefined ? { exists: false, text: null, large: false } : { exists: true, text, large: false };
}

function entry(id, before, after, extra) {
	return Object.assign(
		{ id, time: `2026-01-01T00:00:0${id.length}Z`, file: 'C:\\proj\\a.ts', before: snap(before), after: snap(after) },
		extra || {},
	);
}

const never = () => false;

test('fileKey ignora barras e maiúsculas', () => {
	assert.equal(fileKey('C:\\Proj\\A.ts'), fileKey('c:/proj/a.ts'));
});

test('groupByFile agrupa mantendo a ordem', () => {
	const groups = groupByFile([
		{ id: '1', file: 'C:\\p\\a.ts' },
		{ id: '2', file: 'C:\\p\\b.ts' },
		{ id: '3', file: 'c:/p/a.ts' },
	]);
	assert.deepEqual(groups.map((list) => list.map((item) => item.id)), [['1', '3'], ['2']]);
});

test('textOf: arquivo inexistente vira texto vazio, grande vira undefined', () => {
	assert.equal(textOf(snap(undefined)), '');
	assert.equal(textOf({ exists: true, text: null, large: true }), undefined);
	assert.equal(textOf(null), undefined);
	assert.equal(textOf(snap('x')), 'x');
});

test('collectChain junta edições seguidas do mesmo arquivo', () => {
	const chain = collectChain([entry('a', '1', '2'), entry('bb', '2', '3'), entry('ccc', '3', '4')], never);
	assert.deepEqual(chain.ids, ['a', 'bb', 'ccc']);
	assert.equal(chain.base, '1');
	assert.equal(chain.first.id, 'a');
	assert.equal(chain.last.id, 'ccc');
});

test('collectChain para numa edição já revisada', () => {
	const chain = collectChain([entry('a', '1', '2'), entry('bb', '2', '3')], (id) => id === 'a');
	assert.deepEqual(chain.ids, ['bb']);
	assert.equal(chain.base, '2');
});

test('collectChain para quando o arquivo mudou entre duas edições', () => {
	const chain = collectChain([entry('a', '1', '2'), entry('bb', '2-editado', '3')], never);
	assert.deepEqual(chain.ids, ['bb']);
});

test('collectChain sem o "antes" não abre revisão', () => {
	const last = entry('a', '1', '2');
	last.before = null;
	assert.equal(collectChain([last], never), undefined);
});

test('planRevert restaura o texto de antes', () => {
	assert.deepEqual(planRevert(entry('a', 'v1', 'v2'), entry('bb', 'v2', 'v3'), 'v3'), { kind: 'write', text: 'v1' });
});

test('planRevert aceita \\r\\n diferente no arquivo atual', () => {
	assert.equal(planRevert(entry('a', 'x\n', 'y\n'), entry('a', 'x\n', 'y\n'), 'y\r\n').kind, 'write');
});

test('planRevert não mexe em arquivo editado depois do Claude', () => {
	assert.deepEqual(planRevert(entry('a', 'v1', 'v2'), entry('a', 'v1', 'v2'), 'v2 + mudança minha'), {
		kind: 'skip',
		reason: 'changed',
	});
});

test('planRevert apaga arquivo criado pelo Claude', () => {
	assert.deepEqual(planRevert(entry('a', undefined, 'novo'), entry('a', undefined, 'novo'), 'novo'), { kind: 'delete' });
});

test('planRevert recria arquivo apagado pelo Claude', () => {
	assert.deepEqual(planRevert(entry('a', 'velho', undefined), entry('a', 'velho', undefined), undefined), {
		kind: 'write',
		text: 'velho',
	});
});

test('planRevert não recria se alguém já recriou o arquivo', () => {
	assert.equal(planRevert(entry('a', 'velho', undefined), entry('a', 'velho', undefined), 'outro').kind, 'skip');
});

test('planRevert: criado e apagado pelo Claude não deixa nada a fazer', () => {
	assert.deepEqual(planRevert(entry('a', undefined, 'x'), entry('bb', 'x', undefined), undefined), { kind: 'noop' });
});

test('planRevert sem cópia do conteúdo anterior pula o arquivo', () => {
	const big = entry('a', 'x', 'y');
	big.before = { exists: true, text: null, large: true };
	assert.deepEqual(planRevert(big, big, 'y'), { kind: 'skip', reason: 'unknown' });
});

test('trimLog não mexe enquanto o log está abaixo do limite', () => {
	assert.equal(trimLog(['{"id":"a"}', '{"id":"b"}'], 5, () => true), undefined);
});

test('trimLog tira as revisadas mais antigas e mantém as pendentes', () => {
	const lines = [
		'{"id":"old","time":"2026-01-01"}',
		'{"id":"pending","time":"2026-01-02"}',
		'{"id":"mid","time":"2026-01-03"}',
		'{"id":"new","time":"2026-01-04"}',
		'',
	];
	const kept = trimLog(lines, 3, (id) => id !== 'pending');
	assert.deepEqual(kept.map((line) => JSON.parse(line).id), ['pending', 'mid', 'new']);
});

test('trimLog mantém linha que não é JSON (o hook pode estar escrevendo)', () => {
	const kept = trimLog(['{"id":"a","time":"1"}', '{"id":"b","time":"2"}', '{"id":"c'], 2, () => true);
	assert.ok(kept.includes('{"id":"c'));
	assert.ok(!kept.includes('{"id":"a","time":"1"}'));
});
