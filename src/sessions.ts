// Lê as conversas que o Claude Code guarda em ~/.claude/projects/<pasta>/<id>.jsonl.
// Só lê o começo e o fim de cada arquivo: transcripts com imagens chegam a vários MB.

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const require: (id: string) => any;

const fs = require('fs');
const path = require('path');
const os = require('os');
const ByteBuffer = require('buffer').Buffer;
const crypto = require('node:crypto');

const TAIL_BYTES = 256 * 1024;
const HEAD_BYTES = 512 * 1024;
const MAX_TITLE = 80;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SessionInfo {
	id: string;
	title: string;
	updated: number;
}

const titleCache = new Map<string, { mtime: number; size: number; title: string | null }>();
const MAX_TITLE_CACHE = 1000;
const MAX_SESSION_FILES = 10000;
const MAX_TITLE_CANDIDATES = 256;

function cacheTitle(file: string, mtime: number, size: number, title: string | null): void {
	titleCache.delete(file);
	titleCache.set(file, { mtime, size, title });
	while (titleCache.size > MAX_TITLE_CACHE) { titleCache.delete(titleCache.keys().next().value as string); }
}

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
			const stat = fs.lstatSync(file);
			if (!stat.isFile() || stat.isSymbolicLink()) { continue; }
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
		const cached = titleCache.get(item.file);
		const title = cached && cached.mtime === item.mtime && cached.size === item.size ? cached.title : readTitle(item.file, item.size);
		cacheTitle(item.file, item.mtime, item.size, title);
		if (title) {
			sessions.push({ id: item.id, title, updated: item.mtime });
		}
	}
	return sessions;
}


export interface SessionListing {
	sessions: SessionInfo[];
	partial: boolean;
	scanned: number;
	total: number;
}

/** IO assíncrono com concorrência limitada e orçamento explícito de candidatos. */
export async function listSessionsAsync(workspaceFolder: string, limit: number, cancelled: () => boolean = () => false): Promise<SessionListing> {
	const result: SessionListing = { sessions: [], partial: false, scanned: 0, total: 0 };
	let names: string[];
	const dir = sessionsDir(workspaceFolder);
	try { names = await fs.promises.readdir(dir); }
	catch (error) {
		result.partial = (error as { code?: string }).code !== 'ENOENT';
		return result;
	}
	if (cancelled()) { return result; }
	const candidates = names.filter((name) => name.endsWith('.jsonl') && SESSION_ID.test(name.slice(0, -6)));
	result.total = candidates.length;
	result.partial = candidates.length > MAX_SESSION_FILES;
	const selected = candidates.slice(0, MAX_SESSION_FILES);
	const files: Array<{ id: string; file: string; mtime: number; size: number }> = [];
	for (let offset = 0; offset < selected.length && !cancelled(); offset += 8) {
		const batch = await Promise.all(selected.slice(offset, offset + 8).map(async (name) => {
			const file = path.join(dir, name);
			try {
				const stat = await fs.promises.lstat(file);
				return stat.isFile() && !stat.isSymbolicLink() ? { id: name.slice(0, -6), file, mtime: stat.mtimeMs, size: stat.size } : undefined;
			} catch (error) {
				if ((error as { code?: string }).code !== 'ENOENT') { result.partial = true; }
				return undefined;
			}
		}));
		files.push(...batch.filter((file): file is NonNullable<typeof file> => file !== undefined));
	}
	files.sort((a, b) => b.mtime - a.mtime || a.id.localeCompare(b.id));
	for (const item of files) {
		if (cancelled() || result.sessions.length >= Math.max(0, limit)) { break; }
		if (result.scanned >= MAX_TITLE_CANDIDATES) { result.partial = true; break; }
		result.scanned += 1;
		const cached = titleCache.get(item.file);
		let title: string | null;
		if (cached && cached.mtime === item.mtime && cached.size === item.size) { title = cached.title; }
		else {
			const tail = await readRangeAsync(item.file, Math.max(0, item.size - TAIL_BYTES), item.size);
			if (cancelled()) { break; }
			if (tail === null) { result.partial = true; continue; }
			const head = item.size <= TAIL_BYTES ? tail : await readRangeAsync(item.file, 0, Math.min(item.size, HEAD_BYTES));
			if (cancelled()) { break; }
			if (head === null) { result.partial = true; continue; }
			title = titleFromRanges(tail, head);
			cacheTitle(item.file, item.mtime, item.size, title);
		}
		if (title) { result.sessions.push({ id: item.id, title, updated: item.mtime }); }
	}
	return result;
}

async function readRangeAsync(file: string, start: number, end: number): Promise<string | null> {
	let handle: any;
	try {
		handle = await fs.promises.open(file, 'r');
		const buffer = ByteBuffer.alloc(Math.max(0, end - start));
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
		return buffer.toString('utf8', 0, bytesRead);
	} catch { return null; }
	finally { await handle?.close().catch(() => undefined); }
}

// Título escolhido pelo usuário > título gerado pelo Claude Code > primeira mensagem.
// Sem nenhuma mensagem do usuário, a conversa está vazia e não entra na lista.
function readTitle(file: string, size: number): string | null {
	const tail = readRange(file, Math.max(0, size - TAIL_BYTES), size);
	const head = size <= TAIL_BYTES ? tail : readRange(file, 0, Math.min(size, HEAD_BYTES));
	return titleFromRanges(tail, head);
}

function titleFromRanges(tail: string, head: string): string | null {
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

export interface TranscriptMetaOptions {
	toolUseIds?: readonly string[];
	cache?: boolean;
}
export const MAX_TRANSCRIPT_META_TOOL_IDS = 256;
function metaSelection(options: TranscriptMetaOptions | undefined): { ids?: Set<string>; cache: boolean } | undefined {
	if (options === undefined) { return { cache: true }; }
	if (options === null || typeof options !== 'object' || Array.isArray(options)
		|| Object.keys(options).some(key => key !== 'toolUseIds' && key !== 'cache')
		|| options.cache !== undefined && typeof options.cache !== 'boolean') { return undefined; }
	if (options.toolUseIds === undefined) { return { cache: options.cache !== false }; }
	if (!Array.isArray(options.toolUseIds) || options.toolUseIds.length > MAX_TRANSCRIPT_META_TOOL_IDS
		|| Array.from(options.toolUseIds).some(id => typeof id !== 'string' || !/^[^\u0000-\u001f\u007f]{1,256}$/.test(id))) { return undefined; }
	// Selected metadata is intentionally ephemeral, even when the legacy full-transcript cache is populated.
	return { ids: new Set(options.toolUseIds), cache: false };
}
function emptyTranscriptMeta(): TranscriptMeta { return { reasons: new Map(), requests: new Map() }; }

/** Explicação e pedido de cada chamada de ferramenta, numa só passada pelo texto do transcript. */
export function parseTranscriptMeta(text: string, transcriptPath: string, options?: TranscriptMetaOptions): TranscriptMeta {
	const selection = metaSelection(options);
	return selection ? parseSelectedTranscriptMeta(text, transcriptPath, selection.ids) : emptyTranscriptMeta();
}
function parseSelectedTranscriptMeta(text: string, transcriptPath: string, ids?: ReadonlySet<string>): TranscriptMeta {
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
					current = { id: typeof entry.uuid === 'string' && /^[^\u0000-\u001f\u007f]{1,256}$/.test(entry.uuid) ? entry.uuid : 'request-' + crypto.createHash('sha256').update(`${transcriptPath}\0${prompt}`).digest('hex'), text: clip(prompt, MAX_REQUEST) };
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
			} else if (block.type === 'tool_use' && typeof block.id === 'string' && (!ids || ids.has(block.id))) {
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
let metaCacheEpoch = 0;

function metadataRoots(roots: readonly string[]): string[] {
	if (!Array.isArray(roots) || roots.length > 128 || roots.some(root => typeof root !== 'string' || root.length < 1 || root.length > 8192 || /[\u0000-\u001f\u007f]/.test(root))) { return []; }
	return roots.filter(root => (/^(?:[A-Za-z]:[\\/]|\\\\)/.test(root) ? path.win32 : path.posix).isAbsolute(root));
}
function metadataUnderRoot(file: string, root: string): boolean {
	const paths = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(root) ? path.win32 : path.posix;
	if (!paths.isAbsolute(file)) { return false; }
	const normalizedRoot = paths.normalize(root), normalizedFile = paths.normalize(file), relative = paths.relative(normalizedRoot, normalizedFile);
	if (!relative || relative === '..' || relative.startsWith('..' + paths.sep) || paths.isAbsolute(relative)) { return false; }
	// Win32.relative folds case; verify the reconstructed path without folding directory/file names.
	const identity = (value: string) => value.replace(/^[A-Z]:/, drive => drive.toLowerCase());
	return identity(paths.join(normalizedRoot, relative)) === identity(normalizedFile);
}
/** Counts transcript cache entries, not prompts/reasons. Performs no filesystem IO. */
export function transcriptMetadataCacheCount(roots: readonly string[]): number {
	const allowed = metadataRoots(roots);
	return [...metaCache.keys()].filter(file => allowed.some(root => metadataUnderRoot(file, root))).length;
}
/** Explicit purge/disposal only. Existing saved metadata and other project caches stay untouched. */
export function clearTranscriptMetadataForRoots(roots: readonly string[]): number {
	const allowed = metadataRoots(roots); if (!allowed.length) { return 0; }
	metaCacheEpoch += 1; // A read started before invalidation must not repopulate the global cache afterwards.
	let removed = 0;
	for (const file of metaCache.keys()) { if (allowed.some(root => metadataUnderRoot(file, root))) { metaCache.delete(file); removed += 1; } }
	return removed;
}

/**
 * Lê o fim do transcript sem travar o editor. Guarda o resultado e só relê
 * quando o arquivo muda. Transcript inexistente devolve mapas vazios.
 */
export async function readTranscriptMeta(transcriptPath: string, options?: TranscriptMetaOptions): Promise<TranscriptMeta> {
	const selection = metaSelection(options), epoch = metaCacheEpoch;
	if (!selection || selection.ids?.size === 0 || typeof transcriptPath !== 'string' || transcriptPath.length < 1 || transcriptPath.length > 8192 || /[\u0000-\u001f\u007f]/.test(transcriptPath)) { return emptyTranscriptMeta(); }
	let stat: { size: number; mtimeMs: number };
	try {
		stat = await fs.promises.stat(transcriptPath);
	} catch {
		return emptyTranscriptMeta();
	}
	if (!Number.isSafeInteger(stat.size) || stat.size < 0 || !Number.isFinite(stat.mtimeMs)) { return emptyTranscriptMeta(); }
	const cached = selection.cache ? metaCache.get(transcriptPath) : undefined;
	if (cached && cached.size === stat.size && cached.mtime === stat.mtimeMs) {
		return cached.meta;
	}
	let text = '';
	let handle: any;
	try {
		handle = await fs.promises.open(transcriptPath, 'r');
		const start = Math.max(0, stat.size - REASON_TAIL_BYTES);
		const buffer = ByteBuffer.alloc(stat.size - start);
		const { bytesRead } = await handle.read(buffer, 0, stat.size - start, start);
		text = buffer.toString('utf8', 0, bytesRead);
	} catch {
		return emptyTranscriptMeta();
	} finally {
		await handle?.close().catch(() => undefined);
	}
	const meta = parseSelectedTranscriptMeta(text, transcriptPath, selection.ids);
	if (selection.cache && epoch === metaCacheEpoch) {
		metaCache.delete(transcriptPath);
		metaCache.set(transcriptPath, { size: stat.size, mtime: stat.mtimeMs, meta });
		while (metaCache.size > MAX_META_CACHE) { metaCache.delete(metaCache.keys().next().value as string); }
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
