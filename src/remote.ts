/**
 * Janelas remotas (WSL, SSH, contêineres, Codespaces). O launcher roda onde o workspace está, como
 * a extensão oficial: o hook usa o `node` dessa máquina e as conversas ficam no `~/.claude` dela.
 * Duas ações do editor, porém, dependem da máquina local: revelar no gerenciador de arquivos e,
 * em alguns ambientes, a lixeira.
 */
import * as vscode from 'vscode';
import { t } from './i18n';

/** `wsl`, `ssh-remote`, `dev-container`, `codespaces`… ou `undefined` numa janela local. */
export function remoteName(): string | undefined {
	return vscode.env?.remoteName || undefined;
}

/**
 * "Mostrar no sistema" abre o gerenciador de arquivos da máquina local. Numa janela remota o arquivo
 * está na outra máquina: revela no Explorer quando é do workspace, senão copia o caminho.
 */
export async function revealPath(file: string): Promise<void> {
	const uri = vscode.Uri.file(file);
	const remote = remoteName();
	if (!remote) { await vscode.commands.executeCommand('revealFileInOS', uri); return; }
	if (vscode.workspace.getWorkspaceFolder(uri)) { await vscode.commands.executeCommand('revealInExplorer', uri); return; }
	await vscode.env.clipboard.writeText(file);
	void vscode.window.showInformationMessage(t('Numa janela remota ({0}), o arquivo fica na outra máquina. O caminho foi copiado: {1}', remote, file));
}

/** Erro do editor quando o sistema de arquivos não tem lixeira (contêineres e alguns hosts remotos). */
export function isTrashUnavailable(error: unknown): boolean {
	// Um erro do sistema (EACCES, ENOSPC…) é outra falha, mesmo que a mensagem cite a lixeira.
	const code = (error as { code?: unknown } | null)?.code;
	if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) { return false; }
	const message = error instanceof Error ? error.message : String(error);
	return /trash|recycle/i.test(message) && /support|unable|unavailable|not available/i.test(message);
}

/** Exclusão sempre pela lixeira; sem lixeira, nada é apagado e o erro explica o motivo. */
export async function deleteToTrash(uri: vscode.Uri, recursive = false): Promise<void> {
	try { await vscode.workspace.fs.delete(uri, recursive ? { recursive: true, useTrash: true } : { useTrash: true }); }
	catch (error) {
		if (isTrashUnavailable(error)) { throw new Error(t('A lixeira não está disponível neste ambiente (comum em contêineres e janelas remotas). Nada foi apagado; apague à mão se quiser.')); }
		throw error;
	}
}
