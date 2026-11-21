import * as vscode from 'vscode';
import { Status } from './logic';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import * as crypto from 'node:crypto';

// Constantes, tipos e utilitários independentes do ChangesController.

export const STATUS_KEY = 'claudeCodeLauncher.entryStatus';
export const LEGACY_REVIEWED_KEY = 'claudeCodeLauncher.reviewedEntries';
export const UNDO_KEY = 'claudeCodeLauncher.undoStack';
// Limite de entradas de "desfazer" mantidas.
export const MAX_UNDO = 5;

export interface UndoItem {
	file: string;
	/** Conteúdo antes de recusar (undefined = o arquivo não existia). */
	previous: string | undefined;
	/** Conteúdo que a recusa deixou (undefined = a recusa apagou o arquivo). */
	restored: string | undefined;
}

export interface Undo {
	items: UndoItem[];
	ids: string[];
}

export function loadStatus(memento: vscode.Memento): Map<string, Status> {
	const saved = memento.get<Record<string, Status>>(STATUS_KEY);
	if (saved && typeof saved === 'object') {
		return new Map(Object.entries(saved).filter(([, value]) => value === 'accepted' || value === 'rejected'));
	}
	// Versões anteriores guardavam só a lista de edições revisadas.
	const legacy = memento.get<string[]>(LEGACY_REVIEWED_KEY, []);
	return new Map(legacy.map((id) => [id, 'accepted']));
}

export async function confirm(message: string, detail: string, action: string): Promise<boolean> {
	const answer = await vscode.window.showWarningMessage(message, { modal: true, detail }, action);
	return answer === action;
}

export function loadUndo(memento: vscode.Memento): Undo[] {
	const saved = memento.get<Undo[]>(UNDO_KEY, []);
	if (!Array.isArray(saved)) {
		return [];
	}
	return saved.filter((undo) => undo && Array.isArray(undo.items) && Array.isArray(undo.ids)).slice(-MAX_UNDO);
}

export function createNonce(): string {
	return crypto.randomBytes(24).toString('hex');
}

export async function existsLocal(file: string): Promise<boolean> { try { await nodeFs.promises.lstat(file); return true; } catch (error) { if ((error as { code?: string }).code === 'ENOENT') { return false; } throw error; } }

export async function canonicalResource(file: string, root: string): Promise<string | undefined> {
	if (!nodePath.isAbsolute(file) || !nodePath.isAbsolute(root)) { return undefined; }
	try {
		const canonicalRoot = await nodeFs.promises.realpath(root); let current = nodePath.resolve(file); const missing: string[] = [];
		while (true) {
			try { current = await nodeFs.promises.realpath(current); break; }
			catch (error) { if ((error as { code?: string }).code !== 'ENOENT' || current === nodePath.dirname(current)) { return undefined; } missing.unshift(nodePath.basename(current)); current = nodePath.dirname(current); }
		}
		const canonical = nodePath.join(current, ...missing), relative = nodePath.relative(canonicalRoot, canonical);
		return relative !== '..' && !relative.startsWith('..' + nodePath.sep) && !nodePath.isAbsolute(relative) ? canonical : undefined;
	} catch { return undefined; }
}
