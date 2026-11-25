'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, writeLog, OUT } = require('./helpers/changes-fixture.cjs');
const sessions = require(path.join(OUT, 'sessions.js'));

const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e';
const at = (seconds) => new Date(Date.UTC(2026, 10, 22, 12, 0, seconds)).toISOString();
function transcript(file, lines) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
}
const prompt = (text, seconds) => ({ type: 'user', timestamp: at(seconds), message: { content: text } });
const assistant = (seconds, ...content) => ({ type: 'assistant', timestamp: at(seconds), message: { content } });

test('o turno é representado pela última chamada de terminal depois do pedido que o abriu', async (t) => {
	const file = path.join(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'launcher-turn-meta-')), 's.jsonl');
	t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
	transcript(file, [
		prompt('Pedido antigo', 0), assistant(1, { type: 'tool_use', id: 'toolu_old', name: 'Bash', input: {} }),
		prompt('Formate o projeto', 10),
		assistant(11, { type: 'text', text: 'Vou ler.' }, { type: 'tool_use', id: 'toolu_read', name: 'Read', input: {} }),
		{ type: 'user', timestamp: at(12), message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_read', content: 'ok' }] } },
		assistant(13, { type: 'tool_use', id: 'toolu_fmt', name: 'Bash', input: { command: 'npm run format' } }),
		assistant(14, { type: 'tool_use', id: 'toolu_after', name: 'Read', input: {} }),
		prompt('Pedido seguinte', 30), assistant(31, { type: 'tool_use', id: 'toolu_next', name: 'Bash', input: {} }),
	]);
	assert.equal(await sessions.findTurnToolUse(file, at(20)), 'toolu_fmt', 'terminal vence outras ferramentas do mesmo turno');
	assert.equal(await sessions.findTurnToolUse(file, at(11)), 'toolu_read', 'sem terminal, vale a última chamada');
	assert.equal(await sessions.findTurnToolUse(file, at(10)), undefined, 'o pedido ainda não tem chamada');
	assert.equal(await sessions.findTurnToolUse(file, at(40)), 'toolu_next');
	assert.equal(await sessions.findTurnToolUse(file, 'não é data'), undefined);
	assert.equal(await sessions.findTurnToolUse(path.join(path.dirname(file), 'ausente.jsonl'), at(20)), undefined);
});

test('mudanças por comando aparecem como tal, com pedido e explicação do turno, e dispensam o aviso de terminal', async (t) => {
	const f = fixture(t); f.configuredHooks({ turnCapture: true }); f.policy(); await f.store();
	const file = path.join(f.root, 'sessions', SESSION + '.jsonl');
	transcript(file, [
		prompt('Formate o projeto', 10),
		assistant(13, { type: 'text', text: 'Vou rodar o formatador.' }, { type: 'tool_use', id: 'toolu_fmt', name: 'Bash', input: { command: 'npm run format' } }),
	]);
	fs.writeFileSync(path.join(f.root, 'a.txt'), 'b');
	writeLog(f, [{ id: 'command-1', time: at(20), session: SESSION, tool: 'Command', file: path.join(f.root, 'a.txt'),
		before: { exists: true, text: 'a', large: false }, after: { exists: true, text: 'b', large: false }, reason: null, transcript: file, toolUseId: null }]);
	f.controller.entries = await f.controller.loadEntries();
	await f.controller.meta.fill(); await f.controller.writeChain;
	const states = []; const view = { postMessage: async (state) => { states.push(state); } };
	f.controller.post(view, false);
	const [shown] = states.at(-1).entries;
	assert.deepEqual([shown.action, shown.actionKind, shown.request, shown.reason], ['Mudou por comando', 'command', 'Formate o projeto', 'Vou rodar o formatador.']);
	// A captura do turno está configurada: o aviso de comandos de terminal não aparece mesmo com um comando que escreve.
	await f.controller.loadCaptureHealth(f.folder);
	f.controller.setActiveChat({ sessions: [SESSION], title: 'Conversa', elsewhere: [] });
	clearTimeout(f.controller.shellTimer);
	await f.controller.updateShellActivity();
	f.controller.post(view, false);
	assert.equal(states.at(-1).shell, null);
	assert.match(states.at(-1).captureHealth[0].coverageLabel, /captura do turno/);
});
