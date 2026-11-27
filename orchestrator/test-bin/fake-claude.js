#!/usr/bin/env node
// Binário falso do `claude` para os testes do adapter: imita versão, parser de flags e a saída JSON do `-p`.
// Comportamento por variável: FAKE_CLAUDE_VERSION, FAKE_CLAUDE_REJECT, FAKE_CLAUDE_MODE, FAKE_CLAUDE_LOG.
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const env = process.env;

if (args.includes('--version')) {
	process.stdout.write(`${env.FAKE_CLAUDE_VERSION || '2.1.332 (Claude Code)'}\n`);
	process.exit(0);
}

const WITH_VALUE = new Set(['--output-format', '--max-turns', '--permission-prompts', '--permission-mode', '--tools', '--allowedTools', '--disallowedTools']);
const BOOL = new Set(['-p', '--no-session-persistence']);
const opts = {};
for (let i = 0; i < args.length; i++) {
	const a = args[i];
	if (a === env.FAKE_CLAUDE_REJECT || (!WITH_VALUE.has(a) && !BOOL.has(a))) {
		process.stderr.write(`error: unknown option '${a}'\n`);
		process.exit(1);
	}
	if (WITH_VALUE.has(a)) opts[a] = args[++i];
	else opts[a] = true;
}

const prompt = fs.readFileSync(0, 'utf8');
if (env.FAKE_CLAUDE_LOG) {
	fs.appendFileSync(
		env.FAKE_CLAUDE_LOG,
		`${JSON.stringify({ args, prompt, cwd: process.cwd(), apiKey: Boolean(env.ANTHROPIC_API_KEY), nested: Boolean(env.CLAUDECODE) })}\n`,
	);
}

function reply(obj, code = 0) {
	process.stdout.write(`${JSON.stringify({ type: 'result', num_turns: 2, usage: { input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 20 }, ...obj })}\n`);
	process.exit(code);
}

const mode = env.FAKE_CLAUDE_MODE || 'fix';
if (mode === 'hang') {
	// Fica rodando até alguém matar: o teste do "Parar" confere que a CLI leva o modelo junto.
	if (env.FAKE_CLAUDE_PIDFILE) fs.writeFileSync(env.FAKE_CLAUDE_PIDFILE, String(process.pid));
	setInterval(() => {}, 1000);
	return;
}
if (mode === 'garbage') {
	process.stdout.write('not json at all\n');
	process.exit(0);
}
if (mode === 'error') {
	reply({ subtype: 'success', is_error: true, result: 'Something unexpected went wrong (usage-ish words: limit 429)' }, 1);
}

const readOnly = opts['--tools'] === 'Read,Glob,Grep';
// Linha que o Claude Code 2.x monta quando a janela de 5 horas acaba.
const QUOTA = "You've hit your 5-hour limit · resets 3pm (America/Sao_Paulo)";
if (mode === 'quota' || (mode === 'quota-worker' && !readOnly)) {
	reply({ subtype: 'success', is_error: true, result: QUOTA }, 1);
}
if (readOnly) {
	const plan = {
		goal: 'add() returns the sum',
		steps: [{ id: '1', title: 'Fix add in math.js', files: ['math.js'], doneWhen: 'node --test passes', confidence: 0.9, risk: 'low' }],
	};
	reply({ subtype: 'success', is_error: false, result: `Here is the plan:\n${JSON.stringify(plan)}` });
}

const file = path.join(process.cwd(), 'math.js');
fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('a - b', 'a + b'));
reply({ subtype: 'success', is_error: false, result: 'Fixed add in math.js.' });
