/** Texto para o usuário a partir dos códigos internos. O código em si nunca é a mensagem. */
import { m, t } from './i18n';

const SETTINGS = '.claude/settings.local.json';
const REASONS: Record<string, string> = {
	// Hooks e configuração
	execArgumentsNotConfirmed: m('a versão instalada do Claude Code não declarou suporte a hooks com executável e argumentos separados. Atualize a extensão oficial ou revise a opção "Hook Execution Mode"'),
	ambiguousHookOwnership: m('há em {0} um hook parecido com o do launcher que não foi criado por esta instalação. Revise ou remova esse hook'),
	invalidSettingsJson: m('{0} não é um JSON válido'),
	invalidSettingsShape: m('a seção de hooks de {0} tem um formato inesperado'),
	invalidHookGroups: m('a seção de hooks de {0} tem um formato inesperado'),
	settingsBudgetExceeded: m('{0} é grande demais para ser alterado com segurança'),
	settingsReadFailed: m('não foi possível ler {0}'),
	settingsChanged: m('{0} mudou durante a operação. Tente novamente'),
	settingsVerificationFailed: m('a gravação de {0} não pôde ser confirmada'),
	settingsWriteFailed: m('não foi possível gravar {0}'),
	invalidHookPath: m('o caminho do script de captura não é válido nesta pasta'),
	hookPlanBlocked: m('a configuração dos hooks não pôde ser preparada'),
	invalidCapturePolicy: m('a política de captura gravada não é um JSON válido e foi preservada'),
	unsupportedCapturePolicy: m('a política de captura gravada é de um formato desconhecido e foi preservada'),
	// Propriedade da revisão
	readOnlyOwner: m('outra janela é a dona da revisão desta pasta'),
	anotherWriter: m('outra janela é a dona da revisão desta pasta'),
	ownerLost: m('esta janela perdeu a posse da revisão'),
	releasedWriter: m('esta janela liberou a revisão'),
	writerStillAlive: m('a janela dona da revisão ainda está aberta'),
	recoveryInProgress: m('outra janela está recuperando a revisão'),
	ownerChanged: m('a posse da revisão mudou durante a recuperação'),
	ambiguousOwner: m('o registro de posse da revisão não pôde ser interpretado'),
	ambiguousRecoveryGuard: m('o registro de recuperação da revisão não pôde ser interpretado'),
	orphanedRecoveryGuard: m('uma recuperação anterior foi interrompida e deixou o arquivo review-recovery.lock, que precisa ser conferido e removido manualmente com todas as janelas fechadas'),
	// Captura e manutenção
	captureInProgress: m('há uma captura do Claude em andamento. Aguarde alguns segundos e tente de novo'),
	pendingCapture: m('há uma captura do Claude em andamento. Aguarde alguns segundos e tente de novo'),
	captureMaintenanceLocked: m('outra manutenção está em andamento ou foi interrompida. Se persistir, use "Recuperar revisão bloqueada"'),
	captureMaintenanceStillAlive: m('a manutenção pertence a um processo que ainda está em execução'),
	captureMaintenanceOwnerLost: m('a guarda de manutenção foi substituída por outro processo'),
	captureMaintenanceOwnerChanged: m('a guarda de manutenção mudou durante a recuperação'),
	ambiguousCaptureMaintenance: m('a guarda de manutenção não pôde ser interpretada'),
	maintenanceInProgress: m('uma manutenção desta janela ainda está em andamento'),
	purgeNeedsRecovery: m('uma limpeza foi interrompida. Use "Apagar todos os dados locais de revisão" para concluí-la'),
	needsReconciliation: m('há uma operação de revisão interrompida que precisa ser conferida antes'),
	// Armazenamento e estado
	unsupportedStore: m('a pasta de dados da revisão não é um diretório local comum'),
	unsafeStorageType: m('há um link ou tipo de arquivo não admitido nos dados da revisão'),
	unsafeOrReadOnlyStorage: m('os dados da revisão não podem ser gravados por esta janela'),
	stateChanged: m('os dados da revisão mudaram durante a operação. Atualize e tente novamente'),
	legacyWriterConflict: m('outro programa alterou os dados de compatibilidade da revisão'),
	legacyProjectionPending: m('a projeção de compatibilidade da revisão está pendente. Use "Atualizar mudanças"'),
	invalidReviewState: m('os dados da revisão estão em um formato inválido e foram preservados'),
	invalidSnapshot: m('uma cópia de conteúdo da revisão está ausente ou corrompida'),
	invalidLegacyStatus: m('o arquivo de decisões antigo está em um formato inválido e foi preservado'),
	invalidMetadata: m('os metadados gravados estão em um formato inválido e foram preservados'),
	invalidEntry: m('o histórico contém um registro inválido'),
	conflictingEntry: m('o histórico contém dois registros diferentes com a mesma identificação'),
	unsupportedSchema: m('os dados da revisão foram gravados por uma versão mais nova da extensão'),
	storeBudgetExceeded: m('os dados da revisão ultrapassaram o limite de tamanho'),
	storeDepthExceeded: m('os dados da revisão ultrapassaram o limite de aninhamento'),
	temporaryCleanupFailed: m('um arquivo temporário não pôde ser removido'),
	metadataPolicyChanged: m('a política de captura mudou durante a gravação dos metadados'),
	readBudgetOrType: m('um arquivo de dados é grande demais ou não é um arquivo comum'),
	readBudgetExceeded: m('um arquivo de dados é grande demais'),
	readFailed: m('um arquivo de dados não pôde ser lido'),
	storageOutsideScope: m('o caminho está fora da pasta do projeto'),
	unsafeStorage: m('o caminho dos dados da revisão não é seguro para leitura'),
	storageIdentityUnavailable: m('a identidade do caminho no disco não pôde ser confirmada'),
	// Operação
	cancelledBeforeEffect: m('a operação foi cancelada antes de alterar qualquer coisa'),
	cancelledAfterEffect: m('a operação foi cancelada depois de aplicada. Confira o resultado'),
	explicitReopenRequired: m('reabrir uma decisão exige uma ação explícita'),
	// Sistema de arquivos
	EACCES: m('o sistema negou a permissão de acesso'),
	EPERM: m('o sistema negou a permissão de acesso'),
	EROFS: m('o armazenamento está somente para leitura'),
	ENOSPC: m('não há espaço em disco'),
	EDQUOT: m('a cota de disco foi atingida'),
	ENOENT: m('um arquivo necessário não existe mais'),
	EBUSY: m('um arquivo necessário está em uso por outro programa'),
	EEXIST: m('um arquivo que deveria ser novo já existe'),
};

/** Frase sem ponto final, para compor mensagens. Códigos desconhecidos são citados como referência. */
export function describeReason(code: unknown): string {
	const key = typeof code === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(code) ? code : '';
	return Object.hasOwn(REASONS, key) ? t(REASONS[key], SETTINGS) : key && key !== 'operationFailed'
		? t('ocorreu uma falha não classificada (referência: {0})', key) : t('ocorreu uma falha não classificada');
}
export function knownReason(code: unknown): boolean {
	return typeof code === 'string' && Object.hasOwn(REASONS, code);
}
