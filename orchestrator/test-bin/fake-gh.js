#!/usr/bin/env node
// Binário falso do `gh` para os testes da fase 4: `auth status`, `pr view` e `pr create`. Nada sai da máquina.
// Comportamento por variável: FAKE_GH_AUTH (ok|none), FAKE_GH_FAIL, FAKE_GH_STATE (arquivo com a URL do PR aberto), FAKE_GH_LOG.
'use strict';
const fs = require('fs');

const args = process.argv.slice(2);
const env = process.env;
const state = env.FAKE_GH_STATE;

if (env.FAKE_GH_LOG) {
	const input = args[0] === 'pr' && args[1] === 'create' ? fs.readFileSync(0, 'utf8') : '';
	fs.appendFileSync(env.FAKE_GH_LOG, `${JSON.stringify({ args, input, cwd: process.cwd() })}\n`);
}

if (args[0] === 'auth' && args[1] === 'status') {
	if (env.FAKE_GH_AUTH === 'none') {
		process.stderr.write('You are not logged into any GitHub hosts. To log in, run: gh auth login\n');
		process.exit(1);
	}
	process.stdout.write('github.com\n  ✓ Logged in to github.com account tester\n');
	process.exit(0);
}

if (args[0] === 'pr' && args[1] === 'view') {
	if (state && fs.existsSync(state)) {
		process.stdout.write(`${JSON.stringify({ url: fs.readFileSync(state, 'utf8').trim(), state: 'OPEN' })}\n`);
		process.exit(0);
	}
	process.stderr.write(`no pull requests found for branch "${args[2]}"\n`);
	process.exit(1);
}

if (args[0] === 'pr' && args[1] === 'create') {
	if (env.FAKE_GH_FAIL) {
		process.stderr.write(`${env.FAKE_GH_FAIL}\n`);
		process.exit(1);
	}
	const url = 'https://github.com/example/repo/pull/7';
	if (state) fs.writeFileSync(state, url);
	process.stdout.write(`\nCreating pull request for ${args[args.indexOf('--head') + 1]} into ${args[args.indexOf('--base') + 1]}\n\n${url}\n`);
	process.exit(0);
}

process.stderr.write(`unknown command ${args.join(' ')}\n`);
process.exit(1);
