// Regras puras, sem a API do editor: dá para testar com `node --test` (ver test/).
import { sameText } from './diff';

export interface Snapshot {
	exists: boolean;
	text: string | null;
	large: boolean;
	/** sha1 do texto, guardado em launcher-changes/blobs/<hash>.txt (log a partir da 0.7). */
	hash?: string | null;
}

export interface RawEntry {
	id: string;
	time: string;
	session?: string | null;
	tool?: string | null;
	file: string;
	before: Snapshot | null;
	after: Snapshot | null;
	reason?: string | null;
	transcript?: string | null;
	toolUseId?: string | null;
}

export type Status = 'accepted' | 'rejected';

export function normalizeEol(text: string): string {
	return text.replace(/\r\n/g, '\n');
}

/** Windows e macOS não diferenciam maiúsculas no caminho; Linux diferencia. */
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

/**
 * Chave estável de um arquivo: barras diferentes contam como o mesmo caminho e,
 * onde o sistema de arquivos não diferencia maiúsculas, letras também.
 */
export function fileKey(file: string, caseInsensitive = CASE_INSENSITIVE_FS): string {
	const slashes = file.replace(/\\/g, '/');
	return caseInsensitive ? slashes.toLowerCase() : slashes;
}

/** Agrupa as edições por arquivo, mantendo a ordem em que vieram. */
export function groupByFile<T extends { file: string }>(entries: readonly T[]): T[][] {
	const byFile = new Map<string, T[]>();
	for (const entry of entries) {
		const key = fileKey(entry.file);
		const list = byFile.get(key) ?? [];
		list.push(entry);
		byFile.set(key, list);
	}
	return [...byFile.values()];
}

/** Texto de um snapshot: '' se o arquivo não existia, undefined se o texto não foi guardado. */
export function textOf(snapshot: Snapshot | null): string | undefined {
	if (!snapshot || snapshot.large) {
		return undefined;
	}
	if (!snapshot.exists) {
		return '';
	}
	return snapshot.text ?? undefined;
}

export type RevertPlan =
	| { kind: 'write'; text: string }
	| { kind: 'delete' }
	| { kind: 'noop' }
	| { kind: 'skip'; reason: 'changed' | 'unknown' };

/**
 * O que fazer para desfazer as edições de `oldest` até `newest` (do mesmo
 * arquivo), sabendo o conteúdo atual (`undefined` = arquivo não existe).
 * Só mexe se o arquivo ainda está exatamente como o Claude deixou.
 */
export function planRevert(oldest: RawEntry, newest: RawEntry, current: string | undefined): RevertPlan {
	const before = oldest.before;
	const after = newest.after;
	if (!before || !after || before.large || after.large || (before.exists && before.text === null)) {
		return { kind: 'skip', reason: 'unknown' };
	}
	if (after.exists && after.text === null) {
		return { kind: 'skip', reason: 'unknown' };
	}
	const untouched = after.exists
		? current !== undefined && normalizeEol(current) === normalizeEol(after.text ?? '')
		: current === undefined;
	if (!untouched) {
		return { kind: 'skip', reason: 'changed' };
	}
	if (!before.exists) {
		return after.exists ? { kind: 'delete' } : { kind: 'noop' };
	}
	return { kind: 'write', text: before.text ?? '' };
}

/** Os dois snapshots descrevem com certeza o mesmo conteúdo (inclusive "arquivo não existe"). */
function sameSnapshot(a: Snapshot | null, b: Snapshot | null): boolean {
	if (!a || !b || a.large || b.large) {
		return false;
	}
	if (!a.exists || !b.exists) {
		return a.exists === b.exists;
	}
	return a.text !== null && b.text !== null && normalizeEol(a.text) === normalizeEol(b.text);
}

/**
 * As últimas edições de um arquivo que vieram em sequência sem nada no meio:
 * o "depois" de cada uma é exatamente o "antes" da seguinte. `entries` vai da
 * mais antiga para a mais recente. Se alguém mexeu no arquivo entre duas
 * edições (ou não dá para saber), a sequência começa depois desse ponto, para
 * que recusar não apague o que foi feito no meio.
 */
export function contiguousTail<T extends RawEntry>(entries: readonly T[]): T[] {
	let start = entries.length - 1;
	while (start > 0 && sameSnapshot(entries[start - 1].after, entries[start].before)) {
		start -= 1;
	}
	return entries.slice(Math.max(0, start));
}

export interface Chain {
	base: string;
	ids: string[];
	first: RawEntry;
	last: RawEntry;
}

/**
 * Junta a última edição de um arquivo com as anteriores que vieram em
 * sequência (o "depois" de uma é o "antes" da seguinte) e ainda não foram
 * revisadas. `entries` vai da mais antiga para a mais recente.
 */
export function collectChain(entries: readonly RawEntry[], isReviewed: (id: string) => boolean): Chain | undefined {
	const last = entries[entries.length - 1];
	if (!last) {
		return undefined;
	}
	let before = textOf(last.before);
	if (before === undefined) {
		return undefined;
	}
	const ids = [last.id];
	let first = last;
	for (let index = entries.length - 2; index >= 0; index -= 1) {
		const previous = entries[index];
		const previousAfter = textOf(previous.after);
		const previousBefore = textOf(previous.before);
		if (
			isReviewed(previous.id)
			|| previousAfter === undefined
			|| previousBefore === undefined
			|| !sameText(previousAfter, before)
		) {
			break;
		}
		before = previousBefore;
		first = previous;
		ids.unshift(previous.id);
	}
	return { base: before, ids, first, last };
}

/**
 * Escolhe as linhas do log que ficam quando ele passa de `max` edições: todas
 * as pendentes e as revisadas mais recentes, até `max`. Linhas que não são
 * JSON válido ficam (o hook pode estar escrevendo uma).
 */
export function trimLog(lines: readonly string[], max: number, isReviewed: (id: string) => boolean): string[] | undefined {
	const parsed = lines
		.filter((line) => line.trim())
		.map((line) => {
			try {
				const entry = JSON.parse(line) as RawEntry;
				return { line, id: typeof entry.id === 'string' ? entry.id : null, time: String(entry.time ?? '') };
			} catch {
				return { line, id: null, time: '' };
			}
		});
	if (parsed.length <= max) {
		return undefined;
	}
	const reviewed = parsed
		.filter((item) => item.id !== null && isReviewed(item.id))
		.sort((a, b) => b.time.localeCompare(a.time));
	const pending = parsed.length - reviewed.length;
	const dropped = new Set(reviewed.slice(Math.max(0, max - pending)).map((item) => item.line));
	if (dropped.size === 0) {
		return undefined;
	}
	return parsed.filter((item) => !dropped.has(item.line)).map((item) => item.line);
}

const BLOB_HASH = /^[0-9a-f]{40}$/;

/** Hash de blob válido (evita montar caminhos com texto qualquer vindo do log). */
export function isBlobHash(hash: unknown): hash is string {
	return typeof hash === 'string' && BLOB_HASH.test(hash);
}

/**
 * Snapshot com o texto preenchido a partir do blob, quando o log guarda só o
 * hash. Sem o blob, o texto fica null e o snapshot conta como desconhecido.
 */
export function resolveSnapshot(snapshot: Snapshot | null, getBlob: (hash: string) => string | undefined): Snapshot | null {
	if (!snapshot || snapshot.text !== null || !snapshot.exists || snapshot.large || !isBlobHash(snapshot.hash)) {
		return snapshot;
	}
	return { ...snapshot, text: getBlob(snapshot.hash) ?? null };
}

/** Hashes de blob citados nas linhas do log (ou de qualquer JSON com snapshots `before`/`after`). */
export function referencedBlobs(lines: readonly string[]): Set<string> {
	const hashes = new Set<string>();
	for (const line of lines) {
		if (!line.trim()) {
			continue;
		}
		try {
			const entry = JSON.parse(line) as Partial<RawEntry>;
			for (const snapshot of [entry.before, entry.after]) {
				if (snapshot && isBlobHash(snapshot.hash)) {
					hashes.add(snapshot.hash);
				}
			}
		} catch {
			// Linha incompleta: o hook pode estar escrevendo.
		}
	}
	return hashes;
}

export interface ActiveChat {
	/** Conversas cujo título coincide com o da aba. Mais de uma quando há títulos repetidos. */
	sessions: string[];
	title: string;
}

/**
 * Associa a aba do chat às conversas gravadas pelo título, único dado que a aba expõe.
 * Títulos repetidos não são desempatados: todas as conversas com aquele título entram,
 * para o painel não esconder mudanças de uma delas. Sem correspondência, devolve null (mostra tudo).
 */
export function matchChatSessions(label: string, sessions: readonly { id: string; title: string; updated: number }[]): ActiveChat | null {
	const title = label.trim();
	if (!title) { return null; }
	const matches = sessions.filter((session) => session.title.trim() === title).sort((a, b) => b.updated - a.updated);
	return matches.length ? { sessions: [...new Set(matches.map((session) => session.id))], title } : null;
}
