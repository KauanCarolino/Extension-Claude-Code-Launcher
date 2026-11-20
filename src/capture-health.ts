/** Redacted presentation of capture evidence. Configuration is never proof of capture. */
import type { HookCapability } from './hooks';
import { CaptureDiagnosticCode, CaptureDiagnosticEvent, CaptureDiagnosticStage, CaptureDiagnostics, projectCaptureDiagnostics, validateCaptureDiagnostic } from './history';

export type CaptureConfiguration = 'configured' | 'disabled' | 'notConfigured' | 'unknown';
const stages: Record<CaptureDiagnosticStage, string> = {
	input: 'entrada', scope: 'escopo', policy: 'política', inventory: 'inventário', snapshot: 'snapshot',
	pending: 'preparação', append: 'registro', completion: 'conclusão', maintenance: 'manutenção',
};
const guidance: Record<CaptureDiagnosticCode, string> = {
	capturePrepared: 'Preparação registrada; aguardando o evento posterior da ferramenta.',
	captureRecorded: 'Evento registrado. A disponibilidade dos snapshots é informada separadamente.',
	capturePaused: 'A captura está pausada. Ative o registro quando quiser retomá-la.',
	captureMaintenance: 'Manutenção em andamento. Aguarde sua conclusão antes de tentar novamente.',
	captureGenerationChanged: 'A política mudou durante a ferramenta; confira a política e inicie uma nova captura.',
	quotaExceeded: 'Orçamento atingido. Revise a retenção ou limpe histórico elegível; pendências são preservadas.',
	invalidPolicy: 'Política incompatível preservada. Revise a configuração antes de ativar novas capturas.',
	excludedByPolicy: 'O recurso foi excluído da cópia pela política; isso não é uma captura integral.',
	resourceOutsideScope: 'Recurso fora do escopo admitido; mantenha a revisão dentro das pastas autorizadas.',
	inputBudgetExceeded: 'Evento acima do orçamento de entrada; esta captura não foi confirmada.',
	storagePermissionDenied: 'Confira as permissões dos dados locais de revisão; não remova locks de processos ativos.',
	storageReadOnly: 'O armazenamento está em leitura. Confira o volume e a propriedade da revisão.',
	storageFull: 'Sem espaço no armazenamento. Libere espaço antes de uma nova captura.',
	storageInventoryBudget: 'Inventário parcial pelo orçamento. Confira o armazenamento sem descartar dados desconhecidos.',
	unsafeStorageType: 'Um tipo de recurso não admitido impediu a captura. Não force leitura ou remoção desse recurso.',
	blobIntegrityFailed: 'Snapshot divergente preservado. Confira os dados locais antes de continuar.',
	pendingGenerationChanged: 'Preparação pertence a outra política. Confira a revisão antes de uma nova captura.',
	invalidPending: 'Preparação incompatível preservada. Confira os dados de recuperação.',
	storageUnavailable: 'Não foi possível acessar os dados locais nesta etapa. Confira permissões, espaço e manutenção.',
};
const content = {
	complete: 'Neste evento, a captura informou snapshots completos; disponibilidade atual e conflitos são verificados na revisão.',
	limited: 'Conteúdo parcial: este registro não comprova reversão integral.',
	none: 'Sem cópia de conteúdo; este evento não comprova reversão.',
	unknown: 'Disponibilidade de conteúdo desconhecida.',
};

/** Keep already observed evidence when an incomplete reload cannot reproduce it. Purge clears the owner cache. */
export function retainCaptureEvidence(previous: CaptureDiagnostics | undefined, next: CaptureDiagnostics): CaptureDiagnostics {
	const events = [previous?.latestObservation, previous?.lastCompletion, next.latestObservation, next.lastCompletion]
		.filter((event): event is CaptureDiagnosticEvent => Boolean(event));
	const issues = [...next.issues];
	if (next.kind === 'absent' && events.length) { issues.push('readUnavailable'); }
	return events.length ? projectCaptureDiagnostics(events, issues) : next;
}

export function captureEventView(event: CaptureDiagnosticEvent | null) {
	const known = validateCaptureDiagnostic(event);
	return known ? {
		at: known.observedAt, phase: known.phase, stage: known.stage, code: known.code,
		label: `${stages[known.stage]} · ${known.code}`,
		guidance: guidance[known.code], contentCoverage: known.contentCoverage, content: content[known.contentCoverage],
	} : null;
}

export function captureHealth(configuration: CaptureConfiguration, capability: HookCapability, diagnostics: CaptureDiagnostics) {
	const configurationLabel = {
		configured: 'Handlers próprios configurados', disabled: 'Registro desligado nas preferências',
		notConfigured: 'Handlers próprios não configurados', unknown: 'Configuração não pôde ser confirmada',
	}[configuration];
	let capabilityLabel = 'Capacidade de execução desconhecida; não há alternativa automática por shell.';
	if (capability.status === 'unsupported') { capabilityLabel = 'Execução de hooks desabilitada ou não admitida.'; }
	else if (capability.status === 'confirmed' && capability.harness === 'operator-selected-exec') {
		capabilityLabel = 'Exec selecionado pelo usuário; isso não comprova execução pelo Claude.';
	} else if (capability.status === 'confirmed' && capability.harness === 'anthropic.claude-code') {
		capabilityLabel = 'Schema instalado declara executável e argumentos separados; execução é uma evidência distinta.';
	}
	const version = typeof capability.version === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,64})?$/.test(capability.version) ? capability.version : null;
	return {
		configuration, configurationLabel, capability: capability.status, capabilityLabel, version,
		diagnosticKind: diagnostics.kind, partial: diagnostics.coverage !== 'complete',
		observation: captureEventView(diagnostics.latestObservation), completion: captureEventView(diagnostics.lastCompletion),
		evidenceLabel: diagnostics.kind === 'unknown' || diagnostics.coverage !== 'complete'
			? 'Diagnóstico desconhecido ou parcial; evidências anteriores são datadas e não comprovam atividade atual.'
			: diagnostics.kind === 'absent' ? 'Nenhum evento de captura observado neste diagnóstico.'
				: 'Evidência local datada; configurar o hook não comprova sua execução pelo Claude.',
		coverageLabel: 'Cobertura: Edit, Write, MultiEdit e NotebookEdit. Bash, PowerShell, MCP e alterações externas não são abrangidos. Notebook capturado não implica reversão admitida.',
	};
}
