/** Apresentação das mudanças: textos, rótulos e resumos. Sem dependência do editor em tempo de execução. */
import type * as vscode from 'vscode';
import { computeDiff, DiffResult, Hunk } from './diff';
import type { RawEntry } from './logic';
import { ReviewError, ReviewResolution } from './review';
import { operationView, projectReview } from './review-results';
import type { PurgeInventory, PurgeReason, PurgeReport } from './purge-plan';
import { describeReason } from './messages';

export interface ViewEntry extends Partial<ReturnType<typeof projectReview>> {
	id: string;
	time: string;
	action: string;
	file: string;
	dir: string;
	summary: string;
	reason: string | null;
	added: number;
	removed: number;
	modified: number;
	hunks: Hunk[];
	note: string | null;
	canCompare: boolean;
	status: ReviewResolution | null;
	requestId: string | null;
	request: string | null;
	lastOperation?: ReturnType<typeof operationView>;
}

export interface FileSummary extends Partial<ReturnType<typeof projectReview>> {
	/** Edição mais recente do arquivo: "Ver no código" parte dela. */
	id: string;
	/** Identifica o arquivo nas ações aceitar/recusar. */
	key: string;
	file: string;
	dir: string;
	added: number;
	removed: number;
	created: boolean;
	deleted: boolean;
	lastOperation?: ReturnType<typeof operationView>;
}

export type BaseView = Omit<ViewEntry, 'status' | 'requestId' | 'request'>;
/** `relativePath` é o caminho como o editor o mostra; este módulo não depende do editor. */
export function toViewEntry(entry: RawEntry, relativePath: string): BaseView {
	const relative = relativePath.replace(/\\/g, '/');
	const slash = relative.lastIndexOf('/');
	const before = entry.before;
	const after = entry.after;
	const created = before !== null && !before.exists && after?.exists === true;
	const deleted = after !== null && !after.exists;

	const base = {
		id: entry.id,
		time: entry.time,
		action: actionLabel(entry.tool, created),
		file: slash >= 0 ? relative.slice(slash + 1) : relative,
		dir: slash >= 0 ? relative.slice(0, slash) : '',
		summary: '',
		reason: entry.reason?.trim() || null,
		added: 0,
		removed: 0,
		modified: 0,
		hunks: [] as Hunk[],
		note: null as string | null,
		canCompare: false,
	};

	if (deleted) {
		return { ...base, summary: 'O arquivo não existe mais depois desta ação.' };
	}
	if (before?.large || after?.large) {
		return { ...base, summary: 'Arquivo grande demais (mais de 512 KB) para guardar o antes e o depois.' };
	}
	// Texto null num arquivo que existe: o blob dele sumiu (ou nunca foi guardado).
	if (before === null || after === null || after.text === null || (before.exists && before.text === null)) {
		return {
			...base,
			summary: 'Não foi possível capturar o conteúdo de antes desta edição.',
			note: 'Isso acontece quando o registro foi ativado no meio de uma conversa.',
		};
	}

	const diff: DiffResult = computeDiff(before.text ?? '', after.text);
	return {
		...base,
		summary: summarize(diff, created),
		added: diff.added,
		removed: diff.removed,
		modified: diff.modified,
		hunks: diff.hunks,
		canCompare: true,
		note: diff.clipped
			? 'Parte das linhas foi omitida aqui. Use "Lado a lado" para ver tudo.'
			: diff.approximate
				? 'Arquivo grande: as linhas foram comparadas em bloco. "Lado a lado" mostra o diff exato.'
				: null,
	};
}

export function actionLabel(tool: string | null | undefined, created: boolean): string {
	if (created) {
		return 'Criou';
	}
	switch (tool) {
		case 'Write':
			return 'Reescreveu';
		case 'MultiEdit':
			return 'Editou em várias partes';
		case 'NotebookEdit':
			return 'Editou notebook';
		default:
			return 'Editou';
	}
}

export function summarize(diff: DiffResult, created: boolean): string {
	if (created) {
		return `Arquivo novo, com ${plural(diff.added, 'linha', 'linhas')}.`;
	}
	if (diff.hunks.length === 0) {
		return 'O conteúdo ficou igual: nenhuma linha mudou.';
	}
	const parts: string[] = [];
	if (diff.modified > 0) {
		parts.push(`${plural(diff.modified, 'linha modificada', 'linhas modificadas')}`);
	}
	if (diff.added > 0) {
		parts.push(`${plural(diff.added, 'linha nova', 'linhas novas')}`);
	}
	if (diff.removed > 0) {
		parts.push(`${plural(diff.removed, 'linha removida', 'linhas removidas')}`);
	}
	const where = diff.hunks.length === 1 ? 'em 1 trecho' : `em ${diff.hunks.length} trechos`;
	return `${joinPt(parts)}, ${where} do arquivo.`;
}

export function countFiles(count: number): string {
	return plural(count, 'arquivo', 'arquivos');
}

export function plural(count: number, one: string, many: string): string {
	return `${count} ${count === 1 ? one : many}`;
}

export function joinPt(parts: string[]): string {
	if (parts.length <= 1) {
		return capitalize(parts[0] ?? '');
	}
	return capitalize(`${parts.slice(0, -1).join(', ')} e ${parts[parts.length - 1]}`);
}

export function capitalize(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

export function basename(file: string): string {
	const parts = file.split(/[\\/]/);
	return parts[parts.length - 1] || file;
}

export function errorCode(error: unknown): string { return error instanceof ReviewError ? error.code : (error as { code?: string })?.code || 'operationFailed'; }

/**
 * As exclusões protegem segredos de serem copiados para o histórico. O settings.json de um projeto
 * pode acrescentar padrões, mas não retirar os do usuário (ou os padrões de fábrica que ele manteve):
 * basta abrir e confiar num repositório para as configurações dele valerem.
 */
export function excludedPatterns(config: vscode.WorkspaceConfiguration): string[] | undefined {
	const inspected = config.inspect?.<unknown>('historyExcludedPatterns');
	if (!inspected) { return config.get<string[]>('historyExcludedPatterns'); }
	const list = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
	const base = Array.isArray(inspected.globalValue) ? list(inspected.globalValue) : list(inspected.defaultValue);
	return [...new Set([...base, ...list(inspected.workspaceValue), ...list(inspected.workspaceFolderValue)])];
}

/** Explicação para o usuário; o código interno só aparece quando não há texto para ele. */
export function explain(error: unknown): string { return describeReason(errorCode(error)); }
export const NODE_MISSING = 'O hook de captura é executado com o comando "node", que não foi encontrado no PATH desta janela. Instale o Node.js e reinicie o editor; sem ele nenhuma mudança do Claude é registrada.';
export const HOOK_SCRIPT_DIFFERS = 'O script de captura em .claude/launcher-changes está ausente ou diferente do distribuído pela extensão e não pôde ser restaurado nesta janela. A captura pode não ser confiável.';
export const HOOK_SCRIPT_RESTORED = 'O script de captura em .claude/launcher-changes estava diferente do distribuído pela extensão e foi restaurado. Se você não o alterou, confira o que mais mudou na pasta .claude.';

export function purgeInventoryText(inventory: PurgeInventory): string {
	return ['history', 'capture', 'blobs', 'canonical', 'metadata', 'projection', 'backups'].map((category) => `${category}=${inventory.items.filter((item) => item.category === category).length}`).join(', ')
		+ `; memória da janela: undo=${inventory.memory.undoCount ?? '?'}, cache=${inventory.memory.cacheCount ?? '?'}; desconhecidos preservados=${inventory.unknown.length}${inventory.coverage === 'partial' ? '; inventário parcial' : ''}`;
}
export function purgeReportText(report: PurgeReport): string {
	return report.categories.filter((category) => category.beforeCount || category.remainingCount || category.reasons.length).map((category) => `${category.category}: ${category.outcome}, restantes=${category.remainingCount ?? '?'}${category.reasons.length ? ` (${category.reasons.join(', ')})` : ''}`).join('; ') || 'sem dados próprios restantes';
}
export function purgeFailureReason(error: unknown): PurgeReason {
	const reason = errorCode(error);
	return ['readOnlyOwner', 'anotherWriter', 'ownerLost'].includes(reason) ? 'ownershipRequired' : ['captureInProgress', 'pendingCapture', 'needsReconciliation'].includes(reason) ? 'captureInProgress'
		: reason.startsWith('cancelled') ? 'cancelled' : ['unsafeStorageType', 'unsupportedStore'].includes(reason) ? 'unsafeType' : reason === 'stateChanged' ? 'changedSincePlan' : 'operationFailed';
}
