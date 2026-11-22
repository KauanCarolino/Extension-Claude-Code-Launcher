import { diffLines, groupsOf } from './diff';
import { ReviewContent, ReviewOperation, SharedReview, sameContent } from './review';
import { m, t } from './i18n';

export const REVIEW_REASONS = ['completed', 'previousOperationRecovered', 'saveReturnedFalse', 'applyFailed',
	'verificationFailed', 'stateWriteFailed', 'operationFailed', 'externalChange', 'staleRevision', 'unknownSnapshot',
	'needsReconciliation', 'readOnlyOwner', 'anotherWriter', 'ownerLost', 'releasedWriter', 'ambiguousContext',
	'legacyWriterConflict', 'legacyProjectionPending', 'stateChanged', 'unsupportedResource', 'unsupportedEncoding',
	'unsupportedNotebook', 'unsupportedStore', 'unsupportedSchema', 'invalidSnapshot', 'invalidReviewState',
	'resourceOutsideScope', 'resourceIdentityUnavailable', 'dirtyDocument', 'undoCapacity', 'storeBudgetExceeded',
	'storeDepthExceeded', 'missingReview', 'missingUndo', 'reviewUnavailable', 'maintenanceInProgress',
	'cancelledBeforeEffect', 'cancelledAfterEffect', 'permissionDenied', 'storageFull', 'purgeNeedsRecovery'] as const;
export type ReviewResultReason = typeof REVIEW_REASONS[number];
export type ReviewAction = 'accept' | 'reject' | 'undo';
export interface ReviewItemResult {
	file: string;
	ids: string[];
	operationId: string | null;
	action: ReviewAction;
	requestedAction?: ReviewAction;
	lastKnownStage?: ReviewOperation['stage'];
	outcome: 'complete' | 'partial' | 'blocked' | 'failed' | 'recovered';
	content: 'unchanged' | 'buffer' | 'persisted' | 'unknown';
	decision: 'persisted' | 'notPersisted' | 'failed';
	conflict: boolean;
	cancellation: 'none' | 'beforeEffect' | 'afterEffect';
	reason: ReviewResultReason;
	nextAction: 'none' | 'retrySave' | 'reconcile' | 'compare' | 'retry' | 'recoverWriter' | 'reviewAgain';
}

/** Only enumerated categories cross into presentation or durable diagnostics. */
export function reviewResultReason(error: unknown): ReviewResultReason {
	if (typeof error === 'string' && REVIEW_REASONS.includes(error as ReviewResultReason)) { return error as ReviewResultReason; }
	const value = error && typeof error === 'object' ? error as { code?: unknown; message?: unknown } : {};
	if (typeof value.code === 'string' && REVIEW_REASONS.includes(value.code as ReviewResultReason)) { return value.code as ReviewResultReason; }
	if (value.code === 'EACCES' || value.code === 'EPERM' || value.code === 'EROFS') { return 'permissionDenied'; }
	if (value.code === 'ENOSPC' || value.code === 'EDQUOT') { return 'storageFull'; }
	return typeof value.message === 'string' && REVIEW_REASONS.includes(value.message as ReviewResultReason) ? value.message as ReviewResultReason : 'operationFailed';
}
const conflictReasons = new Set<ReviewResultReason>(['externalChange', 'staleRevision', 'dirtyDocument', 'ambiguousContext', 'legacyWriterConflict', 'stateChanged']);
const ownerReasons = new Set<ReviewResultReason>(['readOnlyOwner', 'anotherWriter', 'ownerLost', 'releasedWriter', 'maintenanceInProgress']);

export function blockedReviewResult(file: string, ids: readonly string[], action: ReviewAction, error: unknown): ReviewItemResult {
	const reason = reviewResultReason(error);
	return { file, ids: [...ids], operationId: null, action, outcome: 'blocked', content: 'unchanged', decision: 'notPersisted',
		conflict: conflictReasons.has(reason), cancellation: reason === 'cancelledBeforeEffect' ? 'beforeEffect' : 'none', reason,
		nextAction: reason === 'purgeNeedsRecovery' ? 'reconcile' : ownerReasons.has(reason) ? 'recoverWriter' : ['unknownSnapshot', 'externalChange', 'staleRevision', 'dirtyDocument', 'ambiguousContext',
			'unsupportedNotebook', 'unsupportedResource', 'unsupportedEncoding', 'resourceOutsideScope'].includes(reason) ? 'compare' : 'retry' };
}

export const REVIEW_NEXT_ACTIONS: Record<ReviewItemResult['nextAction'], string> = {
	none: '', retrySave: m('Salve o arquivo ou repita a ação no painel. A intenção existente será conferida antes de outra alteração.'),
	reconcile: m('Atualize o painel para conferir o registro pendente e repita a ação se a revisão continuar disponível.'),
	compare: m('Confira o arquivo e use a comparação no painel antes de decidir novamente.'),
	retry: m('Confira a condição informada e tente novamente pelo painel.'),
	recoverWriter: m('Aguarde a operação ativa ou use Liberar revisão e Recuperar revisão bloqueada nas janelas envolvidas.'),
	reviewAgain: m('Confira o resultado recuperado antes de repetir a nova ação.'),
};
const reasonText: Partial<Record<ReviewResultReason, string>> = {
	externalChange: m('O conteúdo mudou depois da captura.'), staleRevision: m('A revisão mudou; use as ações atualizadas.'),
	dirtyDocument: m('Há alterações não salvas que precisam ser preservadas.'), ambiguousContext: m('Mais de um contexto reivindica este recurso.'),
	unknownSnapshot: m('O conteúdo necessário à restauração não está disponível.'), unsupportedNotebook: m('A reversão de notebook não está habilitada.'),
	unsupportedResource: m('Este recurso não possui um adaptador de reversão validado.'), unsupportedEncoding: m('A codificação ou as quebras de linha não admitem esta reversão.'),
	resourceOutsideScope: m('O recurso está fora do escopo autorizado.'), permissionDenied: m('O armazenamento não permite esta operação.'),
	storageFull: m('Não há espaço disponível para concluir a operação.'), undoCapacity: m('Não há capacidade para preservar a recuperação necessária.'),
	legacyWriterConflict: m('Outro escritor alterou os dados de compatibilidade.'), legacyProjectionPending: m('A decisão canônica foi registrada; a projeção de compatibilidade continua pendente.'),
	purgeNeedsRecovery: m('Uma limpeza interrompida precisa de recuperação antes de continuar a revisão.'),
};
function guidance(result: ReviewItemResult): string {
	if (result.reason === 'purgeNeedsRecovery') { return t('Use Apagar todos os dados locais de revisão para concluir a limpeza; não remova o marcador manualmente.'); }
	return result.reason === 'legacyProjectionPending' && result.decision === 'persisted'
		? t('Use Atualizar mudanças para recuperar a projeção de compatibilidade; a decisão canônica já foi concluída.')
		: t(REVIEW_NEXT_ACTIONS[result.nextAction]);
}
export function formatReviewItemResult(result: ReviewItemResult): string {
	let message: string;
	if (result.outcome === 'recovered') { message = t('Uma operação anterior foi recuperada. A nova ação solicitada não foi executada.'); }
	else if (result.outcome === 'complete' && result.decision === 'persisted') {
		message = result.action === 'undo' ? t('Recusa desfeita e registrada.') : result.action === 'accept' ? t('Decisão de aceite registrada.') : t('Recusa concluída e registrada.');
	} else if (result.decision === 'persisted') {
		message = result.content === 'persisted' ? t('O conteúdo foi salvo e a decisão canônica foi registrada, mas há um impedimento adicional.')
			: t('A decisão canônica foi registrada; o efeito atual no conteúdo precisa ser conferido.');
	} else if (result.content === 'buffer') { message = t('O conteúdo foi aplicado no editor, mas o salvamento não foi confirmado. A decisão continua pendente.'); }
	else if (result.content === 'persisted') { message = t('O conteúdo foi salvo; o registro da decisão continua pendente de recuperação.'); }
	else if (result.content === 'unknown') { message = t('Não foi possível confirmar o efeito no conteúdo. Nenhuma conclusão foi anunciada.'); }
	else { message = result.cancellation === 'beforeEffect' ? t('A operação foi cancelada antes de alterar o conteúdo.') : t('A operação não foi concluída; o conteúdo permaneceu inalterado.'); }
	if (result.cancellation === 'afterEffect') { message = t('A operação foi cancelada após a aplicação. {0}', message); }
	const detail = reasonText[result.reason] && t(reasonText[result.reason] as string);
	return [message, detail, guidance(result)].filter(Boolean).join(' ');
}
export class ReviewResultError extends Error {
	readonly code: ReviewResultReason;
	declare readonly cause: unknown;
	constructor(public readonly result: ReviewItemResult, cause?: unknown) {
		super(`${formatReviewItemResult(result)} (${result.reason})`);
		this.name = 'ReviewResultError'; this.code = result.reason;
		Object.defineProperty(this, 'cause', { value: cause, enumerable: false });
	}
}
export function operationView(result: ReviewItemResult) {
	return { action: result.action, outcome: result.outcome, content: result.content, decision: result.decision,
		conflict: result.conflict, cancellation: result.cancellation, reason: result.reason, nextAction: result.nextAction,
		lastKnownStage: result.lastKnownStage,
		message: formatReviewItemResult(result), guidance: guidance(result) };
}
/** Reload has only durable historical stages, never a fresh observation of a buffer. */
export function pendingOperationView(operation: ReviewOperation) {
	if (operation.stage === 'complete') { return undefined; }
	const request = operation.request as { action?: unknown } | undefined;
	const action = operation.kind === 'undo' ? 'undo' : request?.action === 'accept' ? 'accept' : 'reject';
	const result = blockedReviewResult(operation.file, operation.ids, action, operation.reason || 'needsReconciliation');
	result.operationId = operation.id; result.outcome = 'partial'; result.content = 'unknown';
	result.nextAction = 'reconcile'; result.lastKnownStage = operation.stage;
	const stages: Record<ReviewOperation['stage'], string> = { prepared: m('intenção preparada'), bufferApplied: m('alteração aplicada no editor'),
		contentVerified: m('conteúdo verificado'), complete: m('concluída'), blocked: m('operação bloqueada'), needsReconciliation: m('reconciliação necessária') };
	return { ...operationView(result), message: t('Há uma operação interrompida. Último estágio registrado: {0}. O conteúdo atual precisa ser conferido antes da conclusão.', t(stages[operation.stage] || m('desconhecido'))) };
}
export function summarizeReviewResults(results: readonly ReviewItemResult[]) {
	const count = <K extends keyof ReviewItemResult>(key: K, value: ReviewItemResult[K]) => results.filter(result => result[key] === value).length;
	return { total: results.length, complete: count('outcome', 'complete'), recovered: count('outcome', 'recovered'),
		partial: count('outcome', 'partial'), blocked: count('outcome', 'blocked'), failed: count('outcome', 'failed'),
		buffer: count('content', 'buffer'), persisted: count('content', 'persisted'), unknownContent: count('content', 'unknown'),
		decisionPersisted: count('decision', 'persisted'), decisionFailed: count('decision', 'failed'),
		message: t('{0} concluídos; {1} recuperados; {2} parciais; {3} bloqueados; {4} falharam.', count('outcome', 'complete'), count('outcome', 'recovered'), count('outcome', 'partial'), count('outcome', 'blocked'), count('outcome', 'failed')),
		items: results.map(result => ({ file: result.file, ids: [...result.ids], ...operationView(result) })) };
}
export interface ReviewProjection {
	revision?: number;
	phase: 'pending' | 'blocked' | 'complete' | 'unavailable';
	blockedReason: string | null;
	acceptedParts: number;
	rejectedParts: number;
	pendingParts: number | null;
	canAcceptCurrent: boolean;
}
export function projectReview(review: SharedReview | undefined, observed?: ReviewContent): ReviewProjection {
	if (!review) { return { phase: 'unavailable' as const, revision: undefined, blockedReason: null, acceptedParts: 0, rejectedParts: 0, pendingParts: null, canAcceptCurrent: false }; }
	const external = observed && review.phase === 'pending' && !sameContent(review.expected, observed);
	const reason = external ? 'externalChange' : review.blockReason;
	const phase = external ? 'blocked' as const : review.phase;
	let pendingParts: number | null = null;
	if (review.base.kind !== 'unavailable' && review.expected.kind !== 'unavailable') {
		pendingParts = phase === 'complete' ? 0 : groupsOf(diffLines(review.base.kind === 'text' ? review.base.text : '', review.expected.kind === 'text' ? review.expected.text : '').lines).length;
		// Existence is a pending structural decision even when both textual projections are empty.
		if (phase !== 'complete' && review.base.kind !== review.expected.kind && pendingParts === 0) { pendingParts = 1; }
	}
	return { revision: review.revision, phase, blockedReason: phase === 'blocked' ? t(reasonText[reviewResultReason({ code: reason })] || m('A revisão está bloqueada; confira o contexto e os dados de recuperação.')) : null,
		acceptedParts: review.accepted, rejectedParts: review.rejected, pendingParts,
		canAcceptCurrent: phase === 'blocked' && reason === 'externalChange' && review.base.kind !== 'unavailable' && review.expected.kind !== 'unavailable' && observed?.kind !== 'unavailable' };
}
