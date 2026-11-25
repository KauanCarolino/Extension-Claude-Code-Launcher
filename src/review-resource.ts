// Leitura e escrita dos arquivos do projeto durante uma decisão de revisão (aceitar, recusar, desfazer).
// Cada efeito confere antes que o arquivo ainda é o esperado, e para quando a janela está fechando.

import * as vscode from 'vscode';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { TextDecoder as Utf8Decoder } from 'node:util';
import { ReviewContent, ReviewError, sameContent } from './review';
import { ResourceAdapter } from './reversal';
import { LOG_DIR } from './capture-setup';
import { assessResourceScope, safeReadText } from './history';
import { isTrashUnavailable } from './remote';

/** Marca de uma limpeza completa interrompida: enquanto existir, nada é escrito no projeto. */
export const PURGE_STATE_FILE = 'purge-state.v1.json';

/** Adaptador do executor de decisões para os arquivos de uma pasta do workspace. */
export function resourceAdapter(root: string, isDisposed: () => boolean): ResourceAdapter {
	return {
		read: (file) => observeResource(file, root, true),
		readPersisted: (file) => observeResource(file, root, false),
		write: (file, target, expected) => writeResource(file, root, target, expected, isDisposed),
	};
}

/** Conteúdo atual: o do editor quando o arquivo está aberto (`buffer`), senão o do disco. */
export async function observeResource(file: string, root: string, buffer: boolean): Promise<ReviewContent> {
	const scope = await assessResourceScope(file, root); if (!scope.allowed) { throw new ReviewError(scope.code || 'resourceOutsideScope'); }
	const uri = vscode.Uri.file(file);
	let disk: ReviewContent;
	try {
		const stat = await nodeFs.promises.lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) { throw new ReviewError('unsupportedResource'); }
		const bytes = await nodeFs.promises.readFile(file);
		disk = { kind: 'text', text: new Utf8Decoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) };
	} catch (error) { if ((error as { code?: string }).code === 'ENOENT') { disk = { kind: 'absent' }; } else { throw error; } }
	if (buffer) {
		const open = vscode.workspace.textDocuments.find((doc) => !doc.isClosed && doc.uri.toString() === uri.toString());
		if (open && !(disk.kind === 'absent' && !open.isDirty)) { const text = open.getText(); return { kind: 'text', text: disk.kind === 'text' && disk.text.startsWith('﻿') && !text.startsWith('﻿') ? '﻿' + text : text }; }
	}
	return disk;
}

/** Leva o arquivo de `expected` para `target`: cria, manda para a lixeira ou reescreve pelo editor e salva. */
export async function writeResource(file: string, root: string, target: ReviewContent, expected: ReviewContent, isDisposed: () => boolean): Promise<void> {
	if (isDisposed()) { throw new ReviewError('cancelledBeforeEffect'); }
	const purge = await safeReadText(nodePath.join(root, ...LOG_DIR, PURGE_STATE_FILE), root, 4096);
	if (purge.kind !== 'absent') { throw new ReviewError('purgeNeedsRecovery'); }
	if (!sameContent(await observeResource(file, root, true), expected)) { throw new ReviewError('externalChange'); }
	const uri = vscode.Uri.file(file);
	if (file.toLowerCase().endsWith('.ipynb') || vscode.workspace.notebookDocuments.some((doc) => doc.uri.toString() === uri.toString())) { throw new ReviewError('unsupportedNotebook'); }
	if (target.kind === 'unavailable') { throw new ReviewError('unknownSnapshot'); }
	if (target.kind === 'absent') {
		const open = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === uri.toString());
		if (open?.isDirty) { throw new ReviewError('dirtyDocument'); }
		if (expected.kind === 'absent') { return; }
		if (isDisposed()) { throw new ReviewError('cancelledBeforeEffect'); }
		try { await vscode.workspace.fs.delete(uri, { useTrash: true }); } catch (error) { if (isTrashUnavailable(error)) { throw new ReviewError('trashUnavailable'); } throw error; }
		if (isDisposed()) { throw new ReviewError('cancelledAfterEffect'); } return;
	}
	if (expected.kind === 'absent') {
		await nodeFs.promises.mkdir(nodePath.dirname(file), { recursive: true });
		const scope = await assessResourceScope(file, root); if (!scope.allowed) { throw new ReviewError('resourceOutsideScope'); }
		if (isDisposed()) { throw new ReviewError('cancelledBeforeEffect'); }
		// Arquivo do projeto, não dado privado da revisão: nasce com a permissão padrão do sistema (umask).
		await nodeFs.promises.writeFile(file, target.text, { flag: 'wx' }); if (isDisposed()) { throw new ReviewError('cancelledAfterEffect'); } return;
	}
	const document = await vscode.workspace.openTextDocument(uri);
	if (isDisposed()) { throw new ReviewError('cancelledBeforeEffect'); }
	const current = await observeResource(file, root, true);
	if (!sameContent(current, expected)) { throw new ReviewError('externalChange'); }
	const disk = await observeResource(file, root, false);
	if (disk.kind !== 'text' || disk.text.startsWith('﻿') !== target.text.startsWith('﻿')) { throw new ReviewError('unsupportedEncoding'); }
	const text = target.text.replace(/^﻿/, '');
	if (document.getText() !== text) {
		const version = document.version;
		const edit = new vscode.WorkspaceEdit();
		const clean = text.replace(/\r\n/g, '\n');
		const eol = text.includes('\r\n') ? vscode.EndOfLine.CRLF : vscode.EndOfLine.LF;
		edit.set(uri, [vscode.TextEdit.replace(document.validateRange(new vscode.Range(0, 0, document.lineCount, 0)), clean), vscode.TextEdit.setEndOfLine(eol)]);
		if (isDisposed()) { throw new ReviewError('cancelledBeforeEffect'); }
		if (document.version !== version) { throw new ReviewError('externalChange'); }
		if (!(await vscode.workspace.applyEdit(edit))) { throw new ReviewError('applyFailed'); }
	}
	if (isDisposed()) { throw new ReviewError('cancelledAfterEffect'); }
	// A human edit may arrive while applyEdit is in flight. Keep that buffer
	// dirty instead of implicitly saving text that was not part of this plan.
	if (document.getText() !== text) { throw new ReviewError('externalChange'); }
	const saved = await document.save();
	if (isDisposed()) { throw new ReviewError('cancelledAfterEffect'); }
	if (!saved) { throw new ReviewError('saveReturnedFalse'); }
}
