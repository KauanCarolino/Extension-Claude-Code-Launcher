/**
 * Limpeza dos dados de captura: retenção do log revisado, marcadores velhos do hook e cópias sem uso.
 * Só a janela dona da revisão (store gravável) chega aqui; nenhuma função toca o que ainda pode ser
 * necessário para revisar ou desfazer.
 */
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { assessStoragePath, retentionCandidates, safeReadText, validateRawEntry, validateSavedMeta } from './history';
import { referencedBlobs } from './logic';
import { writeOwnedFile } from './owned-file';
import { ReviewError } from './review';
import type { ReviewStore } from './review-store';

/** Blobs sem referência só saem depois disso: o hook pode estar no meio de uma edição. */
export const BLOB_GRACE_MS = 10 * 60 * 1000;
/**
 * "pre" sem "post" (ferramenta negada ou que falhou) e marcadores de edição já gravada saem
 * depois disso: nenhuma chamada de ferramenta fica aberta por tanto tempo.
 */
export const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Manifestos da captura do turno sem uso há tanto tempo saem; o índice (index.json) fica. */
export const TURN_MANIFEST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Acima disso, o log perde as edições revisadas mais antigas. */
export const MAX_LOG_ENTRIES = 400;

type Cancelled = () => boolean;

/**
 * Tira do log as edições já revisadas que a retenção (ou `clear`) permite apagar, preservando
 * o que um desfazer ou uma operação em andamento ainda cita. Devolve se o log foi reescrito.
 * `onRewritten` roda logo depois da troca do log, antes da coleta de cópias.
 */
export async function pruneReviewedLog(store: ReviewStore, options: { clear: boolean; retentionDays: number; cancelled: Cancelled; onRewritten?: () => void }): Promise<boolean> {
	const { cancelled } = options;
	if (cancelled()) { throw new ReviewError('cancelledBeforeEffect'); }
	const file = nodePath.join(store.directory, 'log.jsonl');
	const read = await safeReadText(file, store.root, 128 * 1024 * 1024);
	if (read.kind === 'absent') { return false; } if (read.kind === 'error') { throw new ReviewError(read.code); }
	const rows = read.text.split('\n').map((line) => { try { const parsed = validateRawEntry(JSON.parse(line)); return { line, entry: parsed.ok ? parsed.entry : undefined }; } catch { return { line, entry: undefined }; } });
	const state = store.get(); const protectedIds = new Set(state.undo.filter((item) => item.phase !== 'consumed').flatMap((item) => item.ids));
	for (const operation of Object.values(state.operations)) { if (operation.stage !== 'complete') { operation.ids.forEach((id) => protectedIds.add(id)); } }
	const candidates = rows.flatMap((row) => row.entry ? [row.entry] : []);
	const isEligible = (id: string) => Object.hasOwn(state.statuses, id) && !protectedIds.has(id);
	const remove = new Set(options.clear ? candidates.filter((entry) => isEligible(entry.id)).map((entry) => entry.id) : retentionCandidates(candidates, options.retentionDays, Date.now(), isEligible));
	let remaining = candidates.filter((entry) => !remove.has(entry.id)).length;
	for (const entry of [...candidates].sort((a, b) => a.time.localeCompare(b.time))) { if (remaining <= MAX_LOG_ENTRIES) { break; } if (isEligible(entry.id) && !remove.has(entry.id)) { remove.add(entry.id); remaining -= 1; } }
	if (!remove.size) { return false; }
	const kept = rows.filter((row) => !row.entry || !remove.has(row.entry.id)).map((row) => row.line).filter((line) => line.trim());
	await writeOwnedFile(store, file, kept.length ? kept.join('\n') + '\n' : '', read.text, { cancelled });
	await store.update((draft) => {
		for (const [resource, list] of Object.entries(draft.reviews)) { draft.reviews[resource] = list.filter((review) => review.phase !== 'complete' || !review.ids.every((id) => remove.has(id))); if (!draft.reviews[resource].length) { delete draft.reviews[resource]; } }
		for (const id of remove) { delete draft.statuses[id]; }
		for (const [id, op] of Object.entries(draft.operations)) { if (op.stage === 'complete' && op.kind !== 'migration' && op.ids.every((entryId) => remove.has(entryId)) && !draft.undo.some((item) => item.phase !== 'consumed' && item.operationId === id)) { delete draft.operations[id]; } }
		draft.undo = draft.undo.filter((item) => item.phase !== 'consumed' || !item.ids.every((id) => remove.has(id)));
	});
	const metaFile = nodePath.join(store.directory, 'meta.json'), meta = await safeReadText(metaFile, store.root, 8 * 1024 * 1024);
	if (meta.kind === 'content') { const parsed = validateSavedMeta(JSON.parse(meta.text)); for (const id of remove) { delete parsed[id]; } await writeOwnedFile(store, metaFile, JSON.stringify(parsed) + '\n', meta.text, { cancelled }); }
	options.onRewritten?.(); await collectBlobs(store, kept, cancelled); return true;
}

/**
 * O hook deixa um marcador em completed/ a cada edição gravada e um "pre" em pending/ quando a
 * ferramenta não chega ao "post"; o estado canônico acumula cópias em review-blobs/. A retenção
 * do log não alcança nenhum deles, e o hook para de capturar quando a pasta passa do seu
 * orçamento de inventário. Não precisa da guarda de manutenção: só toca marcadores mais velhos
 * que qualquer chamada de ferramenta e cópias que nenhum estado desta janela (a única escritora) referencia.
 */
export async function housekeep(store: ReviewStore, cancelled: Cancelled): Promise<void> {
	await removeAged(store, 'completed', PENDING_MAX_AGE_MS, cancelled);
	await removeAged(store, 'pending', PENDING_MAX_AGE_MS, cancelled);
	// Manifesto de uma conversa que nunca chegou ao Stop (janela fechada, Claude interrompido).
	await removeAged(store, 'turns', TURN_MANIFEST_MAX_AGE_MS, cancelled);
	if (cancelled() || !store.writable) { return; }
	await store.collectUnreferencedBlobs(BLOB_GRACE_MS);
}

export async function removeAged(store: ReviewStore, name: 'completed' | 'pending' | 'turns', maxAgeMs: number, cancelled: Cancelled): Promise<number> {
	const directory = nodePath.join(store.directory, name);
	if (!(await assessStoragePath(directory, store.root)).allowed) { throw new ReviewError('unsafeStorageType'); }
	let names: string[];
	try { names = await nodeFs.promises.readdir(directory); }
	catch (error) { if ((error as { code?: string }).code === 'ENOENT') { return 0; } throw error; }
	const now = Date.now(); let removed = 0;
	for (const item of names) {
		// Só os nomes que o próprio hook cria; "<chave>.post" é de uma captura em andamento.
		if (!/^[a-f0-9]{32}\.json$/.test(item)) { continue; }
		if (cancelled() || !store.writable) { break; }
		const file = nodePath.join(directory, item);
		try {
			const stat = await nodeFs.promises.lstat(file);
			if (!stat.isFile() || stat.isSymbolicLink() || now - stat.mtimeMs <= maxAgeMs) { continue; }
			await nodeFs.promises.unlink(file); removed += 1;
		} catch (error) { if ((error as { code?: string }).code !== 'ENOENT') { throw error; } }
	}
	return removed;
}

/** Recolhe as cópias do hook que o log atual não cita. Chamar sob a guarda de manutenção. */
export async function collectLogBlobs(store: ReviewStore, cancelled: Cancelled): Promise<void> {
	const read = await safeReadText(nodePath.join(store.directory, 'log.jsonl'), store.root, 128 * 1024 * 1024);
	if (read.kind === 'error') { throw new ReviewError(read.code); }
	await collectBlobs(store, read.kind === 'content' ? read.text.split('\n') : [], cancelled);
}

/**
 * Apaga os blobs que nenhuma linha do log nem nenhum "pre" em andamento
 * cita. Blobs recentes ficam: o hook pode tê-los gravado agora há pouco.
 */
export async function collectBlobs(store: ReviewStore, logLines: readonly string[], cancelled: Cancelled): Promise<void> {
	if (!store.writable) { return; }
	const keep = referencedBlobs(logLines), pending = nodePath.join(store.directory, 'pending'), directory = nodePath.join(store.directory, 'blobs');
	if (!(await assessStoragePath(pending, store.root)).allowed || !(await assessStoragePath(directory, store.root)).allowed) { throw new ReviewError('unsafeStorageType'); }
	try {
		for (const name of await nodeFs.promises.readdir(pending)) {
			if (!/^[a-f0-9]{32}\.json$/.test(name)) { continue; }
			const read = await safeReadText(nodePath.join(pending, name), store.root, 64 * 1024);
			if (read.kind === 'error') { throw new ReviewError(read.code); }
			if (read.kind === 'content') { referencedBlobs([read.text]).forEach((hash) => keep.add(hash)); }
		}
	} catch (error) { if ((error as { code?: string }).code !== 'ENOENT') { throw error; } }
	try {
		for (const name of await nodeFs.promises.readdir(directory)) {
			if (!/^[a-f0-9]{40}\.txt$/.test(name) || keep.has(name.slice(0, 40))) { continue; }
			const file = nodePath.join(directory, name); if (!(await assessStoragePath(file, store.root)).allowed) { throw new ReviewError('unsafeStorageType'); }
			const stat = await nodeFs.promises.lstat(file); if (stat.isFile() && !stat.isSymbolicLink() && Date.now() - stat.mtimeMs > BLOB_GRACE_MS) { if (cancelled()) { throw new ReviewError('cancelledBeforeEffect'); } await nodeFs.promises.unlink(file); }
		}
	} catch (error) { if ((error as { code?: string }).code !== 'ENOENT') { throw error; } }
}
