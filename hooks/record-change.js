#!/usr/bin/env node
// Hook do Claude Code instalado pelo Claude Code Launcher.
// PreToolUse ("pre"): guarda o conteúdo do arquivo antes da edição.
// PostToolUse ("post"): lê o conteúdo depois da edição e grava uma entrada em
// <projeto>/.claude/launcher-changes/log.jsonl.
// O texto de cada versão vai para blobs/<sha1>.txt e o log guarda só o hash:
// edições seguidas do mesmo arquivo reaproveitam o mesmo blob.
// A explicação e o pedido saem do transcript, lidos depois pela extensão: o
// hook fica rápido e o Claude não espera por ele.
// Qualquer erro é engolido: o hook nunca bloqueia nem altera o que o Claude faz.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_FILE_BYTES = 512 * 1024;

const phase = process.argv[2];
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
	raw += chunk;
});
process.stdin.on('end', () => {
	try {
		run(JSON.parse(raw));
	} catch {
		// Ignorado de propósito.
	}
	process.exit(0);
});

function run(input) {
	const toolInput = input.tool_input || {};
	const file = toolInput.file_path || toolInput.notebook_path;
	if (!file) {
		return;
	}

	const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
	const dir = path.join(root, '.claude', 'launcher-changes');
	const pendingDir = path.join(dir, 'pending');
	const blobDir = path.join(dir, 'blobs');
	const absolute = path.isAbsolute(file) ? file : path.resolve(input.cwd || root, file);
	const key = crypto
		.createHash('sha1')
		.update(String(input.tool_use_id || `${input.session_id}|${absolute}`))
		.digest('hex')
		.slice(0, 16);
	const pendingFile = path.join(pendingDir, `${key}.json`);

	if (phase === 'pre') {
		fs.mkdirSync(pendingDir, { recursive: true });
		ensureIgnored(dir);
		fs.writeFileSync(pendingFile, JSON.stringify({ before: snapshot(absolute, blobDir) }));
		return;
	}
	if (phase !== 'post') {
		return;
	}

	const afterText = readSmall(absolute);
	const after = store(afterText, blobDir);
	let before = null;
	try {
		before = JSON.parse(fs.readFileSync(pendingFile, 'utf8')).before;
		fs.unlinkSync(pendingFile);
	} catch {
		before = store(rebuildBefore(input.tool_name, toolInput, afterText), blobDir);
	}

	const entry = {
		id: `${key}-${Date.now().toString(36)}`,
		time: new Date().toISOString(),
		session: input.session_id || null,
		tool: input.tool_name || null,
		file: absolute,
		before,
		after,
		reason: null,
		// A extensão lê a explicação e o pedido no transcript depois: o Claude
		// Code grava o transcript em lotes e o texto ainda pode não estar lá.
		transcript: input.transcript_path || null,
		toolUseId: input.tool_use_id || null,
	};
	fs.mkdirSync(dir, { recursive: true });
	ensureIgnored(dir);
	fs.appendFileSync(path.join(dir, 'log.jsonl'), `${JSON.stringify(entry)}\n`);
}

/** { exists, large, text } do arquivo; text é undefined se ele for grande demais. */
function readSmall(file) {
	try {
		const stat = fs.statSync(file);
		if (stat.size > MAX_FILE_BYTES) {
			return { exists: true, large: true, text: undefined };
		}
		return { exists: true, large: false, text: fs.readFileSync(file, 'utf8') };
	} catch {
		return { exists: false, large: false, text: undefined };
	}
}

function snapshot(file, blobDir) {
	return store(readSmall(file), blobDir);
}

/** Grava o texto num blob e devolve o snapshot com o hash (null quando não se sabe o conteúdo). */
function store(read, blobDir) {
	if (!read) {
		return null;
	}
	if (!read.exists || read.large || typeof read.text !== 'string') {
		return { exists: read.exists, text: null, large: read.large };
	}
	const hash = crypto.createHash('sha1').update(read.text, 'utf8').digest('hex');
	const blob = path.join(blobDir, `${hash}.txt`);
	try {
		// Blob já existe: só renova a data, para a limpeza da extensão não levá-lo.
		const now = new Date();
		fs.utimesSync(blob, now, now);
	} catch {
		fs.mkdirSync(blobDir, { recursive: true });
		const temp = `${blob}.${process.pid}.tmp`;
		fs.writeFileSync(temp, read.text, 'utf8');
		fs.renameSync(temp, blob);
	}
	return { exists: true, text: null, large: false, hash };
}

// Sem o "pre" (hook adicionado no meio da sessão, por exemplo), um Edit simples
// ainda pode ser desfeito no texto para recuperar o "antes".
function rebuildBefore(tool, toolInput, after) {
	if (tool !== 'Edit' || !after || typeof after.text !== 'string') {
		return null;
	}
	const { old_string: oldString, new_string: newString, replace_all: replaceAll } = toolInput;
	if (typeof oldString !== 'string' || typeof newString !== 'string' || !after.text.includes(newString)) {
		return null;
	}
	const text = replaceAll
		? after.text.split(newString).join(oldString)
		: after.text.replace(newString, () => oldString);
	return { exists: true, large: false, text };
}

function ensureIgnored(dir) {
	const ignore = path.join(dir, '.gitignore');
	if (!fs.existsSync(ignore)) {
		fs.writeFileSync(ignore, '*\n');
	}
}
