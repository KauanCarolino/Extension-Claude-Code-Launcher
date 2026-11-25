// Aviso do resultado de uma decisão em lote: resumo, "Desfazer" quando tudo foi recusado e o detalhe por arquivo.

import * as vscode from 'vscode';
import { formatReviewItemResult, ReviewItemResult, summarizeReviewResults } from './review-results';
import { basename } from './changes-view';
import { t } from './i18n';

export interface ReviewReportActions {
	isDisposed(): boolean;
	undo(): Promise<void>;
}

export function showReviewReport(results: readonly ReviewItemResult[], actions: ReviewReportActions): void {
	if (actions.isDisposed() || !results.length) { return; }
	const summary = summarizeReviewResults(results);
	const details = () => {
		if (actions.isDisposed()) { return; }
		return vscode.window.showQuickPick(results.map((result) => ({ label: basename(result.file), description: result.reason,
			detail: formatReviewItemResult(result) })), { title: t('Resultado da revisão por arquivo'), placeHolder: t('Confira o conteúdo, o registro e a próxima ação de cada item.') });
	};
	const complete = results.every((result) => result.outcome === 'complete');
	const undoLabel = t('Desfazer'), detailsLabel = t('Detalhes');
	if (complete) {
		const undo = results.every((result) => result.action === 'reject');
		void vscode.window.showInformationMessage(summary.message, ...(undo ? [undoLabel, detailsLabel] : [detailsLabel])).then((choice) => {
			if (actions.isDisposed()) { return; }
			if (choice === undoLabel) { void actions.undo(); } else if (choice === detailsLabel) { void details(); }
		});
	} else { void vscode.window.showWarningMessage(summary.message, detailsLabel).then((choice) => { if (!actions.isDisposed() && choice === detailsLabel) { void details(); } }); }
}
