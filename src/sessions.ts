// Lê as conversas que o Claude Code guarda em ~/.claude/projects/<pasta>/<id>.jsonl.
// Só lê o começo e o fim de cada arquivo: transcripts com imagens chegam a vários MB.

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const require: (id: string) => any;
declare const process: { env: Record<string, string | undefined> };

const fs = require('fs');
const path = require('path');
const os = require('os');

const TAIL_BYTES = 256 * 1024;
const HEAD_BYTES = 512 * 1024;
const MAX_TITLE = 80;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SessionInfo {
	id: string;
	title: string;
	updated: number;
}

const titleCache = new Map<string, { mtime: number; title: string | null }>();

export function sessionsDir(workspaceFolder: string): string {
	const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
	return path.join(base, 'projects', workspaceFolder.replace(/[^a-zA-Z0-9]/g, '-'));
}

export function listSessions(workspaceFolder: string, limit: number): SessionInfo[] {
	const dir = sessionsDir(workspaceFolder);
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return [];
	}

	const files: Array<{ id: string; file: string; mtime: number; size: number }> = [];
	for (const name of names) {
		const id = name.endsWith('.jsonl') ? name.slice(0, -'.jsonl'.length) : '';
		if (!SESSION_ID.test(id)) {
			continue;
		}
		try {
			const file = path.join(dir, name);
			const stat = fs.statSync(file);
			files.push({ id, file, mtime: stat.mtimeMs, size: stat.size });
		} catch {
			// Arquivo sumiu entre o readdir e o stat.
		}
	}
	files.sort((a, b) => b.mtime - a.mtime);

	const sessions: SessionInfo[] = [];
	for (const item of files) {
		if (sessions.length >= limit) {
			break;
		}
		const cached = titleCache.get(item.id);
		const title = cached && cached.mtime === item.mtime ? cached.title : readTitle(item.file, item.size);
		titleCache.set(item.id, { mtime: item.mtime, title });
		if (title) {
			sessions.push({ id: item.id, title, updated: item.mtime });
		}
	}
	return sessions;
}

// Título escolhido pelo usuário > título gerado pelo Claude Code > primeira mensagem.
// Sem nenhuma mensagem do usuário, a conversa está vazia e não entra na lista.
function readTitle(file: string, size: number): string | null {
	const tail = readRange(file, Math.max(0, size - TAIL_BYTES), size);
	let custom: string | null = null;
	let generated: string | null = null;
	for (const entry of parseLines(tail)) {
		if (entry.type === 'custom-title' && typeof entry.customTitle === 'string') {
			custom = entry.customTitle;
		} else if (entry.type === 'ai-title' && typeof entry.aiTitle === 'string') {
			generated = entry.aiTitle;
		} else if (entry.type === 'summary' && typeof entry.summary === 'string') {
			generated = generated ?? entry.summary;
		}
	}

	const head = size <= TAIL_BYTES ? tail : readRange(file, 0, Math.min(size, HEAD_BYTES));
	const firstPrompt = firstUserText(head);
	if (!firstPrompt && !custom && !generated) {
		return null;
	}
	return clip(custom || generated || firstPrompt || 'Conversa sem título');
}

function firstUserText(text: string): string | null {
	for (const entry of parseLines(text)) {
		if (entry.type !== 'user' || entry.isMeta || !entry.message) {
			continue;
		}
		const content = entry.message.content;
		const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
		for (const block of blocks) {
			if (block && block.type === 'text' && typeof block.text === 'string') {
				const clean = block.text.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '').trim();
				if (clean) {
					return clean;
				}
			}
		}
	}
	return null;
}

function* parseLines(text: string): Generator<any> {
	for (const line of text.split('\n')) {
		if (!line.startsWith('{')) {
			continue;
		}
		try {
			yield JSON.parse(line);
		} catch {
			// Linha cortada na borda do trecho lido.
		}
	}
}

function readRange(file: string, start: number, end: number): string {
	let fd: number | undefined;
	try {
		fd = fs.openSync(file, 'r');
		const buffer = Buffer.alloc(end - start);
		fs.readSync(fd, buffer, 0, end - start, start);
		return buffer.toString('utf8');
	} catch {
		return '';
	} finally {
		if (fd !== undefined) {
			fs.closeSync(fd);
		}
	}
}

declare const Buffer: { alloc(size: number): { toString(encoding: string): string } };

const REASON_TAIL_BYTES = 4 * 1024 * 1024;
const MAX_REASON_CHARS = 4000;

/**
 * Texto que o Claude escreveu logo antes da chamada `toolUseId`. Blocos "text"
 * têm prioridade; sem eles vale o último "thinking" não vazio, que é onde
 * modelos mais novos guardam a mensagem entre ferramentas. Devolve null se a
 * chamada ainda não está no transcript.
 */
export function findReasonInTranscript(transcriptPath: string, toolUseId: string): string | null {
	let size: number;
	try {
		size = fs.statSync(transcriptPath).size;
	} catch {
		return null;
	}
	const text = readRange(transcriptPath, Math.max(0, size - REASON_TAIL_BYTES), size);
	let texts: string[] = [];
	let progress = '';
	for (const entry of parseLines(text)) {
		if (entry.type === 'user') {
			texts = [];
			progress = '';
			continue;
		}
		if (entry.type !== 'assistant' || !entry.message) {
			continue;
		}
		const content = entry.message.content;
		const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
		for (const block of blocks) {
			if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
				texts.push(block.text.trim());
			} else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
				progress = block.thinking.trim();
			} else if (block.type === 'tool_use' && block.id === toolUseId) {
				const reason = texts.length > 0 ? texts.join('\n\n') : progress;
				return reason.length > MAX_REASON_CHARS ? `${reason.slice(0, MAX_REASON_CHARS)}…` : reason;
			}
		}
	}
	return null;
}

export interface RequestInfo {
	/** Identifica a mensagem do usuário dentro da conversa. */
	id: string;
	text: string;
}

/**
 * Para cada chamada de ferramenta no fim do transcript, a mensagem do usuário
 * que a originou (o "pedido"). Respostas de ferramentas e mensagens internas
 * não contam como pedido.
 */
export function findRequestsInTranscript(transcriptPath: string): Map<string, RequestInfo> {
	const result = new Map<string, RequestInfo>();
	let size: number;
	try {
		size = fs.statSync(transcriptPath).size;
	} catch {
		return result;
	}
	const text = readRange(transcriptPath, Math.max(0, size - REASON_TAIL_BYTES), size);
	let current: RequestInfo | null = null;
	for (const entry of parseLines(text)) {
		if (entry.type === 'user' && !entry.isMeta && entry.message) {
			const prompt = promptText(entry.message.content);
			if (prompt) {
				current = { id: String(entry.uuid ?? `${transcriptPath}:${prompt}`), text: clip(prompt, MAX_REQUEST) };
			}
			continue;
		}
		if (entry.type !== 'assistant' || !entry.message || !current) {
			continue;
		}
		const content = entry.message.content;
		for (const block of Array.isArray(content) ? content : []) {
			if (block && block.type === 'tool_use' && typeof block.id === 'string') {
				result.set(block.id, current);
			}
		}
	}
	return result;
}

const MAX_REQUEST = 160;

function promptText(content: unknown): string | null {
	const blocks: any[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
	if (blocks.some((block) => block && block.type === 'tool_result')) {
		return null;
	}
	const parts: string[] = [];
	for (const block of blocks) {
		if (block && block.type === 'text' && typeof block.text === 'string') {
			const clean = block.text.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '').trim();
			if (clean) {
				parts.push(clean);
			}
		}
	}
	return parts.length > 0 ? parts.join(' ') : null;
}

function clip(text: string, max = MAX_TITLE): string {
	const oneLine = text.replace(/\s+/g, ' ').trim();
	return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
