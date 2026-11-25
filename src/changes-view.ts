/** Apresentação das mudanças: textos, rótulos e resumos. Sem dependência do editor em tempo de execução. */
import type * as vscode from 'vscode';
import { computeDiff, DiffResult, Hunk } from './diff';
import type { RawEntry } from './logic';
import { ReviewError, ReviewResolution } from './review';
import { operationView, projectReview } from './review-results';
import type { PurgeInventory, PurgeReason, PurgeReport } from './purge-plan';
import { describeReason } from './messages';
import { m, plural, t } from './i18n';

export interface ViewEntry extends Partial<ReturnType<typeof projectReview>> {
	id: string;
	time: string;
	/** Rótulo traduzido da ação ("Criou", "Editou"…). */
	action: string;
	/** Tipo estável da ação, para a página escolher cor e etiqueta sem depender do idioma. */
	actionKind: 'created' | 'rewrote' | 'edited' | 'command';
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

export interface SummaryItem {
	file: string;
	dir: string;
	action: string;
	added: number;
	removed: number;
	status: ReviewResolution | null;
	requestId: string | null;
	request: string | null;
	reason: string | null;
}

/** Uma linha, sem quebras e com limite, para caber num título ou numa citação. */
function oneLine(text: string, max: number): string {
	const line = text.replace(/\s+/g, ' ').trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * Resumo em markdown das mudanças, agrupado pelo pedido, para colar na descrição de um PR.
 * `items` vem em ordem cronológica; os arquivos repetidos num pedido aparecem uma vez, com os números somados.
 */
export function changesSummary(items: readonly SummaryItem[]): string {
	const groups = new Map<string, { request: string | null; files: Map<string, SummaryItem & { count: number }>; reasons: string[] }>();
	for (const item of items) {
		const key = item.requestId ?? '';
		const group = groups.get(key) ?? { request: item.request, files: new Map<string, SummaryItem & { count: number }>(), reasons: [] as string[] };
		groups.set(key, group);
		const path = (item.dir ? `${item.dir}/` : '') + item.file;
		const prior = group.files.get(path);
		group.files.set(path, prior
			? { ...prior, action: item.action, added: prior.added + item.added, removed: prior.removed + item.removed, status: item.status, count: prior.count + 1 }
			: { ...item, count: 1 });
		const reason = item.reason ? oneLine(item.reason.split(/\n\s*\n/)[0] ?? '', 280) : '';
		if (reason && !group.reasons.includes(reason)) { group.reasons.push(reason); }
	}
	const status = (value: ReviewResolution | null) => value === 'accepted' ? t('aceita') : value === 'rejected' ? t('recusada') : value === 'mixed' ? t('em partes') : t('pendente');
	const lines = [`## ${t('Mudanças do Claude')}`, ''];
	for (const group of groups.values()) {
		lines.push(`### ${group.request ? t('Pedido: {0}', oneLine(group.request, 160)) : t('Outras mudanças')}`, '');
		for (const [path, file] of group.files) {
			const counts = [file.added ? `+${file.added}` : '', file.removed ? `−${file.removed}` : ''].filter(Boolean).join(' ');
			lines.push(`- \`${path.replace(/`/g, "'")}\` — ${[file.count > 1 ? t('{0} ({1} edições)', file.action, file.count) : file.action, counts, status(file.status)].filter(Boolean).join(' · ')}`);
		}
		if (group.reasons.length) { lines.push(''); for (const reason of group.reasons.slice(0, 5)) { lines.push(`> ${reason}`); } }
		lines.push('');
	}
	return lines.join('\n').trimEnd() + '\n';
}
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
		actionKind: entry.tool === 'Command' ? 'command' as const : created ? 'created' as const : entry.tool === 'Write' ? 'rewrote' as const : 'edited' as const,
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
		return { ...base, summary: t('O arquivo não existe mais depois desta ação.') };
	}
	if (before?.large || after?.large) {
		return { ...base, summary: t('Arquivo grande demais (mais de 512 KB) para guardar o antes e o depois.') };
	}
	// Texto null num arquivo que existe: o blob dele sumiu (ou nunca foi guardado).
	if (before === null || after === null || after.text === null || (before.exists && before.text === null)) {
		return {
			...base,
			summary: t('Não foi possível capturar o conteúdo de antes desta edição.'),
			note: entry.tool === 'Command'
				? t('A captura do turno não guardou a cópia de antes: o projeto passou do limite de cópias, ou o arquivo não era texto.')
				: t('Isso acontece quando o registro foi ativado no meio de uma conversa.'),
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
			? t('Parte das linhas foi omitida aqui. Use "Lado a lado" para ver tudo.')
			: diff.approximate
				? t('Arquivo grande: as linhas foram comparadas em bloco. "Lado a lado" mostra o diff exato.')
				: null,
	};
}

export function actionLabel(tool: string | null | undefined, created: boolean): string {
	if (tool === 'Command') {
		return created ? t('Criou por comando') : t('Mudou por comando');
	}
	if (created) {
		return t('Criou');
	}
	switch (tool) {
		case 'Write':
			return t('Reescreveu');
		case 'MultiEdit':
			return t('Editou em várias partes');
		case 'NotebookEdit':
			return t('Editou notebook');
		default:
			return t('Editou');
	}
}

export function summarize(diff: DiffResult, created: boolean): string {
	if (created) {
		return t('Arquivo novo, com {0}.', plural(diff.added, '{0} linha', '{0} linhas'));
	}
	if (diff.hunks.length === 0) {
		return t('O conteúdo ficou igual: nenhuma linha mudou.');
	}
	const parts: string[] = [];
	if (diff.modified > 0) {
		parts.push(plural(diff.modified, '{0} linha modificada', '{0} linhas modificadas'));
	}
	if (diff.added > 0) {
		parts.push(plural(diff.added, '{0} linha nova', '{0} linhas novas'));
	}
	if (diff.removed > 0) {
		parts.push(plural(diff.removed, '{0} linha removida', '{0} linhas removidas'));
	}
	const where = plural(diff.hunks.length, 'em {0} trecho', 'em {0} trechos');
	return t('{0}, {1} do arquivo.', joinList(parts), where);
}

export function countFiles(count: number): string {
	return plural(count, '{0} arquivo', '{0} arquivos');
}

/** "a", "a e b", "a, b e c" (no idioma da interface), com a primeira letra maiúscula. */
export function joinList(parts: string[]): string {
	if (parts.length <= 1) {
		return capitalize(parts[0] ?? '');
	}
	return capitalize(t('{0} e {1}', parts.slice(0, -1).join(', '), parts[parts.length - 1]));
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
export const NODE_MISSING = m('O hook de captura é executado com o comando "node", que não foi encontrado no PATH desta janela. Instale o Node.js e reinicie o editor; sem ele nenhuma mudança do Claude é registrada.');
export const HOOK_SCRIPT_DIFFERS = m('O script de captura em .claude/launcher-changes está ausente ou diferente do distribuído pela extensão e não pôde ser restaurado nesta janela. A captura pode não ser confiável.');
export const HOOK_SCRIPT_RESTORED = m('O script de captura em .claude/launcher-changes estava diferente do distribuído pela extensão e foi restaurado. Se você não o alterou, confira o que mais mudou na pasta .claude.');

export function purgeInventoryText(inventory: PurgeInventory): string {
	return ['history', 'capture', 'blobs', 'canonical', 'metadata', 'projection', 'backups'].map((category) => `${category}=${inventory.items.filter((item) => item.category === category).length}`).join(', ')
		+ t('; memória da janela: undo={0}, cache={1}; desconhecidos preservados={2}', inventory.memory.undoCount ?? '?', inventory.memory.cacheCount ?? '?', inventory.unknown.length)
		+ (inventory.coverage === 'partial' ? t('; inventário parcial') : '');
}
export function purgeReportText(report: PurgeReport): string {
	return report.categories.filter((category) => category.beforeCount || category.remainingCount || category.reasons.length).map((category) => t('{0}: {1}, restantes={2}', category.category, category.outcome, category.remainingCount ?? '?')
		+ (category.reasons.length ? ` (${category.reasons.join(', ')})` : '')).join('; ') || t('sem dados próprios restantes');
}
export function purgeFailureReason(error: unknown): PurgeReason {
	const reason = errorCode(error);
	return ['readOnlyOwner', 'anotherWriter', 'ownerLost'].includes(reason) ? 'ownershipRequired' : ['captureInProgress', 'pendingCapture', 'needsReconciliation'].includes(reason) ? 'captureInProgress'
		: reason.startsWith('cancelled') ? 'cancelled' : ['unsafeStorageType', 'unsupportedStore'].includes(reason) ? 'unsafeType' : reason === 'stateChanged' ? 'changedSincePlan' : 'operationFailed';
}
