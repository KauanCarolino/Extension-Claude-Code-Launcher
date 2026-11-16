// Testes das regras de revisão: juntar edições, recusar e limpar o log.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
	collectChain, contiguousTail, fileKey, groupByFile, planRevert, referencedBlobs, resolveSnapshot, textOf, trimLog,
} = require('../out/logic.js');

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

test('fileKey ignora barras e, onde o disco não diferencia, maiúsculas', () => {
	assert.equal(fileKey('C:\\Proj\\A.ts', true), fileKey('c:/proj/a.ts', true));
});

test('fileKey diferencia maiúsculas em disco que diferencia (Linux)', () => {
	assert.notEqual(fileKey('/proj/A.ts', false), fileKey('/proj/a.ts', false));
	assert.equal(fileKey('/proj\\a.ts', false), fileKey('/proj/a.ts', false));
});

test('groupByFile agrupa mantendo a ordem', () => {
	const groups = groupByFile([
		{ id: '1', file: 'C:\\p\\a.ts' },
		{ id: '2', file: 'C:\\p\\b.ts' },
		{ id: '3', file: 'C:/p/a.ts' },
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

test('contiguousTail pega todas as edições quando não há nada no meio', () => {
	const tail = contiguousTail([entry('a', 'v1', 'v2\n'), entry('bb', 'v2\r\n', 'v3'), entry('ccc', 'v3', 'v4')]);
	assert.deepEqual(tail.map((item) => item.id), ['a', 'bb', 'ccc']);
});

test('contiguousTail para onde o arquivo foi mudado entre duas edições', () => {
	// Claude: v1→v2; usuário: v2→v2+minha; Claude: v2+minha→v3.
	const tail = contiguousTail([entry('a', 'v1', 'v2'), entry('bb', 'v2 + minha', 'v3')]);
	assert.deepEqual(tail.map((item) => item.id), ['bb']);
	// Recusar volta para o estado com a mudança do usuário, não para v1.
	assert.deepEqual(planRevert(tail[0], tail[tail.length - 1], 'v3'), { kind: 'write', text: 'v2 + minha' });
});

test('contiguousTail não confia em snapshot grande no meio', () => {
	const middle = entry('bb', 'v2', 'v3');
	middle.before = { exists: true, text: null, large: true };
	const tail = contiguousTail([entry('a', 'v1', 'v2'), middle]);
	assert.deepEqual(tail.map((item) => item.id), ['bb']);
	assert.equal(planRevert(tail[0], tail[0], 'v3').kind, 'skip');
});

test('contiguousTail distingue arquivo apagado de arquivo vazio', () => {
	const tail = contiguousTail([entry('a', 'x', undefined), entry('bb', '', 'y')]);
	assert.deepEqual(tail.map((item) => item.id), ['bb']);
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

const HASH = 'a'.repeat(40);

test('resolveSnapshot preenche o texto a partir do blob', () => {
	const blobs = new Map([[HASH, 'conteúdo']]);
	const get = (hash) => blobs.get(hash);
	assert.deepEqual(resolveSnapshot({ exists: true, text: null, large: false, hash: HASH }, get), {
		exists: true, text: 'conteúdo', large: false, hash: HASH,
	});
	// Log antigo, com o texto dentro da linha: fica como está.
	assert.equal(resolveSnapshot(snap('inline'), get).text, 'inline');
	assert.equal(resolveSnapshot(null, get), null);
});

test('resolveSnapshot sem o blob deixa o snapshot desconhecido (recusar pula o arquivo)', () => {
	const before = resolveSnapshot({ exists: true, text: null, large: false, hash: HASH }, () => undefined);
	assert.equal(before.text, null);
	const missing = entry('a', 'x', 'y');
	missing.before = before;
	assert.deepEqual(planRevert(missing, missing, 'y'), { kind: 'skip', reason: 'unknown' });
	assert.equal(textOf(before), undefined);
});

test('resolveSnapshot ignora hash que não é sha1 (não monta caminho com texto do log)', () => {
	let asked = false;
	resolveSnapshot({ exists: true, text: null, large: false, hash: '../../segredo' }, () => {
		asked = true;
		return 'x';
	});
	assert.equal(asked, false);
});

test('referencedBlobs junta os hashes citados no log', () => {
	const other = 'b'.repeat(40);
	const lines = [
		JSON.stringify({ id: '1', before: { exists: true, text: null, large: false, hash: HASH }, after: null }),
		JSON.stringify({ id: '2', before: { exists: false, text: null, large: false }, after: { exists: true, hash: other } }),
		'{"id":"3","before":{"hash":"incomple',
		'',
	];
	assert.deepEqual([...referencedBlobs(lines)].sort(), [HASH, other]);
});
