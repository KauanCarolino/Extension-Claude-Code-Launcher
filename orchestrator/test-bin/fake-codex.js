#!/usr/bin/env node
// Binário falso do `codex` para os testes do adapter: imita versão, `login status`, o parser do clap e o JSONL do `exec --json`.
// Comportamento por variável: FAKE_CODEX_LOGIN (chatgpt|apikey|none), FAKE_CODEX_REJECT, FAKE_CODEX_MODE, FAKE_CODEX_LOG.
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const env = process.env;

if (args[0] === '--version') {
	process.stdout.write('codex-cli 0.98.0\n');
	process.exit(0);
}

if (args[0] === 'login' && args[1] === 'status') {
	const login = env.FAKE_CODEX_LOGIN || 'chatgpt';
	if (login === 'none') {
		process.stderr.write('Not logged in\n');
		process.exit(1);
	}
	process.stderr.write(login === 'apikey' ? 'Logged in using an API key - sk-proj-***\n' : 'Logged in using ChatGPT\n');
	process.exit(0);
}

if (args[0] !== 'exec') {
	process.stderr.write(`error: unrecognized subcommand '${args[0]}'\n`);
	process.exit(2);
}

const WITH_VALUE = new Set(['--color', '--sandbox', '-c']);
const BOOL = new Set(['--json', '--ephemeral']);
const opts = {};
let prompt;
for (let i = 1; i < args.length; i++) {
	const a = args[i];
	if (a === '-') {
		prompt = '-';
		continue;
	}
	if (a === env.FAKE_CODEX_REJECT || (!WITH_VALUE.has(a) && !BOOL.has(a))) {
		process.stderr.write(`error: unexpected argument '${a}' found\n\nUsage: codex exec [OPTIONS] [PROMPT]\n`);
		process.exit(2);
	}
	if (WITH_VALUE.has(a)) opts[a] = args[++i];
	else opts[a] = true;
}

const input = prompt === '-' ? fs.readFileSync(0, 'utf8') : '';
if (env.FAKE_CODEX_LOG) {
	fs.appendFileSync(
		env.FAKE_CODEX_LOG,
		`${JSON.stringify({ args, prompt: input, cwd: process.cwd(), apiKey: Boolean(env.OPENAI_API_KEY || env.CODEX_API_KEY) })}\n`,
	);
}

const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
emit({ type: 'thread.started', thread_id: '0199a213-81c0-7800-8aa1-bbab2a035a53' });
emit({ type: 'turn.started' });

function finish(text) {
	emit({ type: 'item.completed', item: { id: 'item_9', type: 'agent_message', text } });
	emit({ type: 'turn.completed', usage: { input_tokens: 200, cached_input_tokens: 150, output_tokens: 30, reasoning_output_tokens: 10 } });
	process.exit(0);
}

function fail(message) {
	emit({ type: 'error', message });
	emit({ type: 'turn.failed', error: { message } });
	process.exit(1);
}

const mode = env.FAKE_CODEX_MODE || 'fix';
if (mode === 'quota') {
	// Texto do `UsageLimitReachedError` do Codex para o plano Plus, com o apóstrofo curvo.
	fail('You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 3:05 PM.');
}
if (mode === 'error') fail('unexpected status 500 Internal Server Error (usage-ish words: limit 429)');
if (mode === 'garbage') {
	process.stdout.write('not json\n');
	process.exit(0);
}

if (opts['--sandbox'] === 'read-only') {
	const plan = {
		goal: 'add() returns the sum',
		steps: [{ id: '1', title: 'Fix add in math.js', files: ['math.js'], doneWhen: 'node --test passes', confidence: 0.9, risk: 'low' }],
	};
	finish(JSON.stringify(plan));
}

emit({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'bash -lc cat math.js', status: 'in_progress' } });
const file = path.join(process.cwd(), 'math.js');
fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('a - b', 'a + b'));
finish('Fixed add in math.js.');
