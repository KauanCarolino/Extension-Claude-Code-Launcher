// Lê as conversas que o Claude Code guarda em ~/.claude/projects/<pasta>/<id>.jsonl.
// Só lê o começo e o fim de cada arquivo: transcripts com imagens chegam a vários MB.

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const require: (id: string) => any;

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

export interface RequestInfo {
	/** Identifica a mensagem do usuário dentro da conversa. */
	id: string;
	text: string;
}

export interface TranscriptMeta {
	/**
	 * Para cada chamada de ferramenta, o texto que o Claude escreveu logo antes
	 * dela. Blocos "text" têm prioridade; sem eles vale o último "thinking" não
	 * vazio, que é onde modelos mais novos guardam a mensagem entre ferramentas.
	 */
	reasons: Map<string, string>;
	/** Para cada chamada de ferramenta, a mensagem do usuário que a originou (o "pedido"). */
	requests: Map<string, RequestInfo>;
}

/** Explicação e pedido de cada chamada de ferramenta, numa só passada pelo texto do transcript. */
export function parseTranscriptMeta(text: string, transcriptPath: string): TranscriptMeta {
	const reasons = new Map<string, string>();
	const requests = new Map<string, RequestInfo>();
	let texts: string[] = [];
	let progress = '';
	let current: RequestInfo | null = null;
	for (const entry of parseLines(text)) {
		if (entry.type === 'user') {
			texts = [];
			progress = '';
			// Respostas de ferramentas e mensagens internas não contam como pedido.
			if (!entry.isMeta && entry.message) {
				const prompt = promptText(entry.message.content);
				if (prompt) {
					current = { id: String(entry.uuid ?? `${transcriptPath}:${prompt}`), text: clip(prompt, MAX_REQUEST) };
				}
			}
			continue;
		}
		if (entry.type !== 'assistant' || !entry.message) {
			continue;
		}
		const content = entry.message.content;
		const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
		for (const block of blocks) {
			if (!block) {
				continue;
			}
			if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
				texts.push(block.text.trim());
			} else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
				progress = block.thinking.trim();
			} else if (block.type === 'tool_use' && typeof block.id === 'string') {
				const reason = texts.length > 0 ? texts.join('\n\n') : progress;
				reasons.set(block.id, reason.length > MAX_REASON_CHARS ? `${reason.slice(0, MAX_REASON_CHARS)}…` : reason);
				if (current) {
					requests.set(block.id, current);
				}
			}
		}
	}
	return { reasons, requests };
}

const metaCache = new Map<string, { size: number; mtime: number; meta: TranscriptMeta }>();
const MAX_META_CACHE = 20;

/**
 * Lê o fim do transcript sem travar o editor. Guarda o resultado e só relê
 * quando o arquivo muda. Transcript inexistente devolve mapas vazios.
 */
export async function readTranscriptMeta(transcriptPath: string): Promise<TranscriptMeta> {
	let stat: { size: number; mtimeMs: number };
	try {
		stat = await fs.promises.stat(transcriptPath);
	} catch {
		return { reasons: new Map(), requests: new Map() };
	}
	const cached = metaCache.get(transcriptPath);
	if (cached && cached.size === stat.size && cached.mtime === stat.mtimeMs) {
		return cached.meta;
	}
	let text = '';
	let handle: any;
	try {
		handle = await fs.promises.open(transcriptPath, 'r');
		const start = Math.max(0, stat.size - REASON_TAIL_BYTES);
		const buffer = Buffer.alloc(stat.size - start);
		await handle.read(buffer, 0, stat.size - start, start);
		text = buffer.toString('utf8');
	} catch {
		return { reasons: new Map(), requests: new Map() };
	} finally {
		await handle?.close().catch(() => undefined);
	}
	const meta = parseTranscriptMeta(text, transcriptPath);
	metaCache.delete(transcriptPath);
	metaCache.set(transcriptPath, { size: stat.size, mtime: stat.mtimeMs, meta });
	while (metaCache.size > MAX_META_CACHE) {
		metaCache.delete(metaCache.keys().next().value as string);
	}
	return meta;
}

function readTranscriptTailSync(transcriptPath: string): string | undefined {
	try {
		const size = fs.statSync(transcriptPath).size;
		return readRange(transcriptPath, Math.max(0, size - REASON_TAIL_BYTES), size);
	} catch {
		return undefined;
	}
}

/** Texto que o Claude escreveu logo antes da chamada `toolUseId`; null se ela ainda não está no transcript. */
export function findReasonInTranscript(transcriptPath: string, toolUseId: string): string | null {
	const text = readTranscriptTailSync(transcriptPath);
	return text === undefined ? null : parseTranscriptMeta(text, transcriptPath).reasons.get(toolUseId) ?? null;
}

/** Para cada chamada de ferramenta no fim do transcript, o pedido do usuário que a originou. */
export function findRequestsInTranscript(transcriptPath: string): Map<string, RequestInfo> {
	const text = readTranscriptTailSync(transcriptPath);
	return text === undefined ? new Map() : parseTranscriptMeta(text, transcriptPath).requests;
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
