// Testes do diff usado pelo painel e pelas marcas no editor.
// Rodar com `npm test` (compila e chama `node --test`).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeDiff, diffLines, groupsOf, joinText, sameText, splitText } = require('../out/diff.js');

test('textos iguais não têm diferença', () => {
	const diff = computeDiff('a\nb\nc\n', 'a\nb\nc\n');
	assert.equal(diff.added, 0);
	assert.equal(diff.removed, 0);
	assert.equal(diff.modified, 0);
	assert.equal(diff.hunks.length, 0);
});

test('conta linhas novas e removidas', () => {
	const diff = computeDiff('a\nb\nc\n', 'a\nc\nd\ne\n');
	assert.equal(diff.removed, 1);
	assert.equal(diff.added, 2);
	assert.equal(diff.modified, 0);
});

test('linha parecida conta como modificada, com as palavras que mudaram', () => {
	const { lines } = diffLines('const total = soma(a, b);\n', 'const total = soma(a, b, c);\n');
	const after = lines.find((line) => line.pair === 'depois');
	assert.ok(after, 'a linha nova deveria estar pareada com a antiga');
	const changed = after.segments.filter((segment) => segment.changed).map((segment) => segment.text).join('');
	assert.match(changed, /c/);
	assert.equal(computeDiff('const total = soma(a, b);\n', 'const total = soma(a, b, c);\n').modified, 1);
});

test('ignora diferença de \\r\\n', () => {
	const diff = computeDiff('a\r\nb\r\n', 'a\nb\n');
	assert.equal(diff.hunks.length, 0);
	assert.ok(sameText('a\r\nb\r\n', 'a\nb'));
});

test('arquivo novo: tudo é linha nova', () => {
	const diff = computeDiff('', 'um\ndois\n');
	assert.equal(diff.added, 2);
	assert.equal(diff.removed, 0);
});

test('grupos apontam as posições certas nos dois textos', () => {
	const groups = groupsOf(diffLines('a\nb\nc\nd\n', 'a\nB\nc\nd\ne\n').lines);
	assert.equal(groups.length, 2);
	assert.deepEqual(
		{ oldStart: groups[0].oldStart, newStart: groups[0].newStart, oldLines: groups[0].oldLines, newLines: groups[0].newLines },
		{ oldStart: 1, newStart: 1, oldLines: ['b'], newLines: ['B'] },
	);
	assert.deepEqual(groups[1].newLines, ['e']);
	assert.equal(groups[1].newStart, 4);
});

test('recusar um grupo reconstrói o texto de antes', () => {
	const before = 'a\nb\nc\n';
	const after = 'a\nX\nc\nY\n';
	let current = splitText(after);
	// Recusa de baixo para cima para as posições continuarem válidas.
	for (const group of groupsOf(diffLines(before, after).lines).reverse()) {
		current.lines.splice(group.newStart, group.newLines.length, ...group.oldLines);
	}
	assert.equal(joinText(current), before);
});

test('splitText e joinText preservam a quebra de linha final', () => {
	assert.equal(joinText(splitText('a\nb\n')), 'a\nb\n');
	assert.equal(joinText(splitText('a\nb')), 'a\nb');
	assert.deepEqual(splitText('').lines, []);
});
