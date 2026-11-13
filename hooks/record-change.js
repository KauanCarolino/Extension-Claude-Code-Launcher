#!/usr/bin/env node
// Hook do Claude Code instalado pelo Claude Code Launcher.
// PreToolUse ("pre"): guarda o conteúdo do arquivo antes da edição.
// PostToolUse ("post"): lê o conteúdo depois da edição e grava uma entrada em
// <projeto>/.claude/launcher-changes/log.jsonl, com a explicação que o Claude deu.
// Qualquer erro é engolido: o hook nunca bloqueia nem altera o que o Claude faz.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_FILE_BYTES = 512 * 1024;
const MAX_TRANSCRIPT_TAIL = 2 * 1024 * 1024;
const MAX_REASON_CHARS = 4000;

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
		fs.writeFileSync(pendingFile, JSON.stringify({ before: snapshot(absolute) }));
		return;
	}
	if (phase !== 'post') {
		return;
	}

	const after = snapshot(absolute);
	let before = null;
	try {
		before = JSON.parse(fs.readFileSync(pendingFile, 'utf8')).before;
		fs.unlinkSync(pendingFile);
	} catch {
		before = rebuildBefore(input.tool_name, toolInput, after);
	}

	const entry = {
		id: `${key}-${Date.now().toString(36)}`,
		time: new Date().toISOString(),
		session: input.session_id || null,
		tool: input.tool_name || null,
		file: absolute,
		before,
		after,
		reason: findReason(input.transcript_path, input.tool_use_id),
		// O Claude Code grava o transcript em lotes: quando este hook roda, o texto
		// da edição pode ainda não estar no arquivo. A extensão completa depois.
		transcript: input.transcript_path || null,
		toolUseId: input.tool_use_id || null,
	};
	fs.mkdirSync(dir, { recursive: true });
	ensureIgnored(dir);
	fs.appendFileSync(path.join(dir, 'log.jsonl'), `${JSON.stringify(entry)}\n`);
}

function snapshot(file) {
	try {
		const stat = fs.statSync(file);
		if (stat.size > MAX_FILE_BYTES) {
			return { exists: true, text: null, large: true };
		}
		return { exists: true, text: fs.readFileSync(file, 'utf8'), large: false };
	} catch {
		return { exists: false, text: null, large: false };
	}
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
	return { exists: true, text, large: false };
}

// Procura no transcript o texto que o Claude escreveu logo antes desta chamada de ferramenta.
function findReason(transcriptPath, toolUseId) {
	if (!transcriptPath) {
		return null;
	}
	let text;
	try {
		const fd = fs.openSync(transcriptPath, 'r');
		const size = fs.fstatSync(fd).size;
		const length = Math.min(size, MAX_TRANSCRIPT_TAIL);
		const buffer = Buffer.alloc(length);
		fs.readSync(fd, buffer, 0, length, size - length);
		fs.closeSync(fd);
		text = buffer.toString('utf8');
	} catch {
		return null;
	}

	// O texto que o Claude escreve entre ferramentas pode vir como bloco "text" ou,
	// em modelos mais novos, como bloco "thinking" com a atualização de progresso.
	// Blocos "text" têm prioridade; sem eles, vale o último "thinking" não vazio.
	let texts = [];
	let progress = '';
	let found = null;
	const current = () => (texts.length > 0 ? texts.join('\n\n') : progress);
	for (const line of text.split('\n')) {
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.type === 'user') {
			texts = [];
			progress = '';
			continue;
		}
		if (entry.type !== 'assistant' || !entry.message) {
			continue;
		}
		const content = typeof entry.message.content === 'string'
			? [{ type: 'text', text: entry.message.content }]
			: Array.isArray(entry.message.content) ? entry.message.content : [];
		for (const block of content) {
			if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
				texts.push(block.text.trim());
			} else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
				progress = block.thinking.trim();
			} else if (block.type === 'tool_use' && toolUseId && block.id === toolUseId) {
				found = current();
			}
		}
	}
	// Se a chamada ainda não foi gravada no transcript, o texto mais recente é o dela.
	const reason = found !== null ? found : current();
	if (!reason) {
		return null;
	}
	return reason.length > MAX_REASON_CHARS ? `${reason.slice(0, MAX_REASON_CHARS)}…` : reason;
}

function ensureIgnored(dir) {
	const ignore = path.join(dir, '.gitignore');
	if (!fs.existsSync(ignore)) {
		fs.writeFileSync(ignore, '*\n');
	}
}
