// Regras puras, sem a API do editor: dá para testar com `node --test` (ver test/).
import { sameText } from './diff';

export interface Snapshot {
	exists: boolean;
	text: string | null;
	large: boolean;
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

/** Chave estável de um arquivo: mesma pasta escrita com barras ou letras diferentes conta como um só. */
export function fileKey(file: string): string {
	return file.replace(/\\/g, '/').toLowerCase();
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
