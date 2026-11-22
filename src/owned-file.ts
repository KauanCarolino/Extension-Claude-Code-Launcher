/** Escrita dos arquivos próprios da revisão: só substitui o conteúdo que foi lido antes, por troca atômica. */
import * as nodeFs from 'node:fs';
import * as crypto from 'node:crypto';
import { assessStoragePath, safeReadText } from './history';
import { ReviewError } from './review';
import type { ReviewStore } from './review-store';

export interface OwnedWriteOptions {
	/** A janela foi fechada ou a posse se perdeu: nenhum efeito novo deve começar. */
	cancelled(): boolean;
	/** Conferência extra (por exemplo, a política de metadados) antes de gravar e antes de trocar. */
	assertPermits?: () => Promise<void>;
}

/**
 * Grava `text` em `file` se o arquivo ainda tiver `expected` (ou estiver ausente, com `undefined`).
 * Escreve num temporário privado ao lado, confere de novo e troca por rename: quem lê nunca vê
 * meio arquivo, e uma mudança concorrente faz a gravação falhar em vez de ser sobrescrita.
 */
export async function writeOwnedFile(store: ReviewStore, file: string, text: string, expected: string | undefined, options: OwnedWriteOptions): Promise<void> {
	const { cancelled, assertPermits } = options;
	if (cancelled() || !store.writable || !(await assessStoragePath(file, store.root)).allowed) { throw new ReviewError('unsafeOrReadOnlyStorage'); }
	const read = await safeReadText(file, store.root, 128 * 1024 * 1024);
	if (read.kind === 'error' || (read.kind === 'content' ? read.text : undefined) !== expected) { throw new ReviewError('stateChanged'); }
	const temp = `${file}.${crypto.randomUUID()}.tmp`;
	await assertPermits?.();
	let handle: nodeFs.promises.FileHandle | undefined; let created = false;
	try {
		handle = await nodeFs.promises.open(temp, 'wx', 0o600); created = true;
		await handle.writeFile(text, 'utf8'); await handle.sync(); await handle.close(); handle = undefined;
		const again = await safeReadText(file, store.root, 128 * 1024 * 1024);
		if (again.kind === 'error' || (again.kind === 'content' ? again.text : undefined) !== expected) { throw new ReviewError('stateChanged'); }
		if (cancelled() || !store.writable) { throw new ReviewError('cancelledBeforeEffect'); }
		await assertPermits?.();
		if (cancelled() || !store.writable) { throw new ReviewError('cancelledBeforeEffect'); }
		await nodeFs.promises.rename(temp, file); created = false;
	} finally {
		let failed = false;
		if (handle) { try { await handle.close(); } catch { failed = true; } }
		if (created) { try { await nodeFs.promises.unlink(temp); } catch (error) { if ((error as { code?: string }).code !== 'ENOENT') { failed = true; } } }
		// Deliberado: um temporário que não pôde ser removido não pode terminar como sucesso.
		// eslint-disable-next-line no-unsafe-finally
		if (failed) { throw new ReviewError('temporaryCleanupFailed'); }
	}
}
