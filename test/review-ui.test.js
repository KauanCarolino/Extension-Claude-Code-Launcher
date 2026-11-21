'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// DOM adapter exercises the shipped webview script; browser layout is a separate host gate.
function webview(saved = {}) {
	let document, listener;
	class Element {
		constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.events = {}; this.className = ''; this.value = ''; }
		get classList() { return { contains: name => this.className.split(' ').includes(name), add: name => { if (!this.classList.contains(name)) this.className += ' ' + name; }, toggle: (name, enabled) => { this.className = this.className.split(' ').filter(part => part !== name).concat(enabled ? [name] : []).join(' '); } }; }
		set textContent(value) { this.value = String(value); this.children = []; }
		get textContent() { return this.value + this.children.map(child => child.textContent).join(''); }
		set innerHTML(_) { throw new Error('webview must not interpret file data as HTML'); }
		append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
		replaceChildren(...children) { this.value = ''; this.children = []; this.append(...children); }
		setAttribute(key, value) { this.attributes[key] = value; }
		addEventListener(name, handler) { this.events[name] = handler; }
		focus() { document.activeElement = this; }
		querySelectorAll(selector) {
			const matches = selector === '[data-focus-key]' ? node => Boolean(node.dataset.focusKey) : selector === '[data-time]' ? node => Boolean(node.dataset.time) : node => node.classList.contains(selector.slice(1));
			return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
		}
	}
	const root = new Element('main'), body = new Element('body'), messages = [], states = [];
	document = { body, activeElement: null, getElementById: () => root, createElement: tag => new Element(tag) };
	const window = { scrollY: 17, scrollTo(x, y) { assert.equal(y, 17); }, addEventListener(name, handler) { if (name === 'message') listener = handler; } };
	vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../media/changes.js'), 'utf8'), {
		document, window, setInterval() {}, acquireVsCodeApi: () => ({ getState: () => saved, setState: state => states.push(state), postMessage: message => messages.push(message) })
	});
	return { root, body, document, messages, states, render: state => listener({ data: { type: 'state', hasFolder: true, enabled: true, entries: [], files: [], ...state } }),
		find: key => root.querySelectorAll('[data-focus-key]').find(node => node.dataset.focusKey === key),
		click(node) { assert(node); assert.notEqual(node.disabled, true); node.events.click({ preventDefault() {}, stopPropagation() {} }); } };
}
function fixture(overrides = {}) {
	const entry = { id: 'fixture', key: 'fixture-key', file: 'fixture.txt', dir: '', time: '2026-11-19T12:00:00Z', action: 'Editou',
		summary: 'Synthetic edit', canCompare: true, added: 1, removed: 1, hunks: [{ lines: [{ kind: 'add', text: '<script>SYNTHETIC</script>', newNo: 1 }] }],
		phase: 'blocked', revision: 4, blockedReason: 'O conteúdo mudou depois da captura.', acceptedParts: 1, rejectedParts: 1, pendingParts: 2,
		lastOperation: { outcome: 'partial', content: 'buffer', decision: 'failed', nextAction: 'retrySave', message: 'PRIVATE raw message', guidance: 'PRIVATE guidance' }, ...overrides };
	return { entries: [entry], files: [entry] };
}

test('compact and wide views show barriers, partial decisions and honest save results through text nodes', () => {
	for (const wide of [false, true]) {
		const ui = webview({ openCards: ['fixture'], layout: 'split', filesOpen: true, legendOpen: true }); ui.render({ ...fixture(), wide });
		assert.match(ui.root.textContent, /Revisão bloqueada.*conteúdo mudou/);
		assert.match(ui.root.textContent, /1 aceite · 1 recusa · 2 trechos pendentes/);
		assert.match(ui.root.textContent, /aplicado no editor; salvamento não confirmado/);
		assert.doesNotMatch(ui.root.textContent, /PRIVATE/);
		assert.equal(ui.find('accept:fixture-key').disabled, true); assert.equal(ui.find('reject:fixture-key').disabled, true);
		if (wide) { assert.equal(ui.body.classList.contains('split'), true); assert.match(ui.root.textContent, /<script>SYNTHETIC<\/script>/); }
	}
});

test('explicit accept-current capability preserves rejection barriers, revision and rerender focus/state', () => {
	const ui = webview({ openCards: ['fixture'], layout: 'split', filesOpen: false, legendOpen: true, openCaptureHealth: [1] });
	const state = { ...fixture({ canAcceptCurrent: true }), wide: true }; ui.render(state);
	const accept = ui.find('accept:fixture-key'); assert.notEqual(accept.disabled, true); assert.equal(ui.find('reject:fixture-key').disabled, true);
	accept.focus(); ui.render(state); assert.equal(ui.document.activeElement, ui.find('accept:fixture-key'));
	ui.click(ui.find('accept:fixture-key'));
	assert.deepEqual(JSON.parse(JSON.stringify(ui.messages.at(-1))), { command: 'acceptFile', key: 'fixture-key', revision: 4 });
	ui.click(ui.find('layout:unified')); const saved = ui.states.at(-1);
	assert.equal(saved.layout, 'unified'); assert.equal(saved.filesOpen, false); assert.equal(saved.legendOpen, true);
	assert.deepEqual([...saved.openCards], ['fixture']); assert.deepEqual([...saved.openCaptureHealth], [1]);
	ui.render({ ...state, readOnly: true }); assert.equal(ui.find('accept:fixture-key').disabled, true);
});

test('saved-but-unregistered, unknown and recovered results remain distinct and ignore arbitrary host copy', () => {
	const ui = webview();
	for (const [operation, expected] of [
		[{ outcome: 'partial', content: 'persisted', decision: 'failed', nextAction: 'reconcile' }, /Conteúdo salvo; registro da decisão pendente/],
		[{ outcome: 'failed', content: 'unknown', decision: 'notPersisted', nextAction: 'compare' }, /Efeito no conteúdo desconhecido/],
		[{ outcome: 'recovered', content: 'persisted', decision: 'persisted', nextAction: 'reviewAgain' }, /nova ação não foi executada/],
		[{ outcome: 'partial', content: 'unknown', decision: 'notPersisted', lastKnownStage: 'prepared', nextAction: 'reconcile' }, /operação interrompida.*conteúdo atual precisa ser conferido/],
		[{ outcome: 'complete', content: 'persisted', decision: 'persisted', reason: 'legacyProjectionPending', nextAction: 'reconcile' }, /Atualizar mudanças.*decisão canônica já foi concluída/],
		[{ outcome: 'partial', content: 'buffer', decision: 'failed', cancellation: 'afterEffect' }, /cancelada após a aplicação.*salvamento não confirmado/],
		[{ outcome: 'partial', content: 'persisted', decision: 'persisted', reason: 'legacyWriterConflict', nextAction: 'compare' }, /Conteúdo salvo e decisão canônica registrada; há um impedimento adicional/],
	]) {
		ui.render(fixture({ lastOperation: { ...operation, message: 'PRIVATE', guidance: 'PRIVATE' } }));
		assert.match(ui.root.textContent, expected); assert.doesNotMatch(ui.root.textContent, /PRIVATE/);
	}
	ui.render(fixture({ pendingParts: -1, lastOperation: { outcome: 'PRIVATE', content: 'unknown', decision: 'failed', message: 'PRIVATE' } }));
	assert.match(ui.root.textContent, /Quantidade de trechos pendentes indisponível/); assert.doesNotMatch(ui.root.textContent, /PRIVATE/);
	ui.render(fixture({ lastOperation: { outcome: 'blocked', content: 'unchanged', decision: 'notPersisted', reason: 'purgeNeedsRecovery', nextAction: 'reconcile' } }));
	assert.match(ui.root.textContent, /Apagar todos os dados locais de revisão/); assert.match(ui.root.textContent, /não remova o marcador manualmente/);
	assert.doesNotMatch(ui.root.textContent, /repita a ação/);
});

test('interrupted purge exposes only the specific confirmed cleanup recovery while all review mutations stay disabled', () => {
	const ui = webview();
	ui.render({ ...fixture(), wide: true, readOnly: true, readOnlyReason: 'Uma limpeza interrompida precisa de recuperação.', readOnlyAction: 'clearAllReviewData' });
	const recovery = ui.find('recover-purge'); assert(recovery); assert.match(recovery.textContent, /Concluir limpeza/); assert.notEqual(recovery.disabled, true);
	assert.equal(ui.find('accept:fixture-key').disabled, true); assert.equal(ui.find('reject:fixture-key').disabled, true);
	assert.equal(ui.find('acceptAll').disabled, true); assert.equal(ui.find('rejectAll').disabled, true); assert.equal(ui.find('purge').disabled, true);
	ui.click(recovery); assert.deepEqual(JSON.parse(JSON.stringify(ui.messages.at(-1))), { command: 'clearAllReviewData' });
	ui.render({ ...fixture(), wide: true, readOnly: true, readOnlyReason: 'Somente leitura', readOnlyAction: 'acceptAll' });
	assert.equal(ui.find('recover-purge'), undefined); assert.equal(ui.find('acceptAll').disabled, true);
});

test('chat scope banner names the conversation, warns about repeated titles and toggles the filter', () => {
	const ui = webview({});
	ui.render({ ...fixture(), chat: { title: 'Corrigir login', scoped: true, matches: 1, others: 2 } });
	assert.match(ui.root.textContent, /Conversa: Corrigir login/);
	assert.doesNotMatch(ui.root.textContent, /conversas com este título/);
	assert.match(ui.root.textContent, /Ver todas \(2 de outras\)/);
	ui.render({ ...fixture(), chat: { title: 'Corrigir login', scoped: true, matches: 3, others: 0 } });
	assert.match(ui.root.textContent, /Conversa: Corrigir login \(3 conversas com este título\)/);
	assert.equal(ui.find('chat-scope'), undefined, 'sem mudanças de outras conversas não há alternância');
	ui.render({ ...fixture(), chat: { title: 'Corrigir login', scoped: false, matches: 3, others: 4 } });
	assert.match(ui.root.textContent, /Todas as conversas/);
	ui.click(ui.find('chat-scope'));
	assert.equal(ui.messages.at(-1).command, 'toggleChatFilter');
});
