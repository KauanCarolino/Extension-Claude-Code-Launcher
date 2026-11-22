'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const OUT = process.env.LAUNCHER_TEST_OUT || path.resolve(__dirname, '../out');
const ROOT = path.resolve(__dirname, '..');
const { check, placeholders } = require('../scripts/l10n-check.cjs');

test('toda frase marcada no código tem inglês, sem sobras e com os mesmos marcadores {n}', () => {
	const { keys, missing, unused, mismatched } = check();
	assert.ok(keys.size > 400, 'o verificador encontrou as frases do código');
	assert.deepEqual(missing, [], 'frases sem tradução em l10n/en.json');
	assert.deepEqual(unused, [], 'frases em l10n/en.json que o código não usa mais');
	assert.deepEqual(mismatched, [], 'traduções com marcadores diferentes da frase original');
	assert.equal(placeholders('a {1} b {0} {0}'), '{0},{1}');
});

test('o manifesto usa só chaves que existem nas duas traduções, e o guia tem as páginas dos dois idiomas', () => {
	const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
	const english = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.nls.json'), 'utf8'));
	const portuguese = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.nls.pt-br.json'), 'utf8'));
	const used = new Set();
	JSON.stringify(manifest, (key, value) => { const match = typeof value === 'string' && /^%(.+)%$/.exec(value); if (match) { used.add(match[1]); } return value; });
	assert.deepEqual([...used].sort(), Object.keys(english).sort());
	assert.deepEqual(Object.keys(portuguese).sort(), Object.keys(english).sort());
	for (const command of manifest.contributes.commands) { assert.match(command.title, /^%command\./, command.command); }
	for (const table of [english, portuguese]) {
		for (const [key, value] of Object.entries(table)) {
			assert.equal(typeof value, 'string', key);
			if (key.endsWith('.media')) { assert.ok(fs.existsSync(path.join(ROOT, value)), value); }
		}
	}
	assert.equal(portuguese['command.showChanges'], 'Mostrar mudanças do Claude');
});

test('a interface fica em português por padrão e passa a inglês com o dicionário', () => {
	const i18n = require(path.join(OUT, 'i18n.js'));
	assert.equal(i18n.resolveLanguage('pt-br', 'auto'), 'pt-br');
	assert.equal(i18n.resolveLanguage('pt', undefined), 'pt-br');
	assert.equal(i18n.resolveLanguage('en', 'auto'), 'en');
	assert.equal(i18n.resolveLanguage('es', 'auto'), 'en', 'outros idiomas usam inglês');
	assert.equal(i18n.resolveLanguage('es', 'pt-br'), 'pt-br', 'a preferência explícita vence');
	assert.equal(i18n.resolveLanguage(undefined, 'auto'), 'pt-br', 'sem idioma do editor, fica o português');

	assert.equal(i18n.t('Desfazer pedido'), 'Desfazer pedido');
	assert.equal(i18n.plural(2, '{0} arquivo', '{0} arquivos'), '2 arquivos');
	assert.equal(i18n.htmlLanguage(), 'pt-BR');
	assert.equal(i18n.webviewDictionaryScript(), '<script type="application/json" id="launcher-l10n">{}</script>');

	i18n.configureLanguage('en', ROOT);
	try {
		assert.equal(i18n.currentLanguage(), 'en');
		assert.equal(i18n.htmlLanguage(), 'en');
		assert.equal(i18n.t('Desfazer pedido'), 'Undo request');
		assert.equal(i18n.t('Desfazer o pedido "{0}"?', 'x'), 'Undo the request "x"?');
		assert.equal(i18n.plural(1, '{0} arquivo', '{0} arquivos'), '1 file');
		assert.equal(i18n.t('frase sem tradução'), 'frase sem tradução', 'sem tradução, mostra o original');
		const changesView = require(path.join(OUT, 'changes-view.js'));
		assert.equal(changesView.joinList(['1 new line', '2 removed lines', '3 modified lines']), '1 new line, 2 removed lines and 3 modified lines');
		const messages = require(path.join(OUT, 'messages.js'));
		assert.equal(messages.describeReason('invalidSettingsJson'), '.claude/settings.local.json is not valid JSON');
		const script = i18n.webviewDictionaryScript();
		assert.equal(script.includes('</script>', 10), true);
		assert.equal(/<(?!\/?script)/.test(script.slice(script.indexOf('>') + 1, script.lastIndexOf('</script>'))), false, 'o JSON não abre nem fecha tags');
	} finally {
		i18n.configureLanguage('pt-br', ROOT);
	}
	// Um dicionário ilegível não quebra a interface: ela fica em português.
	i18n.configureLanguage('en', path.join(ROOT, 'pasta-inexistente'));
	assert.equal(i18n.currentLanguage(), 'pt-br');
	assert.equal(i18n.requestedLanguage(), 'en');
	i18n.configureLanguage('pt-br', ROOT);
});
