/** Texto para o usuário a partir dos códigos internos. O código em si nunca é a mensagem. */
const SETTINGS = '.claude/settings.local.json';
const REASONS: Record<string, string> = {
	// Hooks e configuração
	execArgumentsNotConfirmed: 'a versão instalada do Claude Code não declarou suporte a hooks com executável e argumentos separados. Atualize a extensão oficial ou revise a opção "Hook Execution Mode"',
	ambiguousHookOwnership: `há em ${SETTINGS} um hook parecido com o do launcher que não foi criado por esta instalação. Revise ou remova esse hook`,
	invalidSettingsJson: `${SETTINGS} não é um JSON válido`,
	invalidSettingsShape: `a seção de hooks de ${SETTINGS} tem um formato inesperado`,
	invalidHookGroups: `a seção de hooks de ${SETTINGS} tem um formato inesperado`,
	settingsBudgetExceeded: `${SETTINGS} é grande demais para ser alterado com segurança`,
	settingsReadFailed: `não foi possível ler ${SETTINGS}`,
	settingsChanged: `${SETTINGS} mudou durante a operação. Tente novamente`,
	settingsVerificationFailed: `a gravação de ${SETTINGS} não pôde ser confirmada`,
	settingsWriteFailed: `não foi possível gravar ${SETTINGS}`,
	invalidHookPath: 'o caminho do script de captura não é válido nesta pasta',
	hookPlanBlocked: 'a configuração dos hooks não pôde ser preparada',
	invalidCapturePolicy: 'a política de captura gravada não é um JSON válido e foi preservada',
	unsupportedCapturePolicy: 'a política de captura gravada é de um formato desconhecido e foi preservada',
	// Propriedade da revisão
	readOnlyOwner: 'outra janela é a dona da revisão desta pasta',
	anotherWriter: 'outra janela é a dona da revisão desta pasta',
	ownerLost: 'esta janela perdeu a posse da revisão',
	releasedWriter: 'esta janela liberou a revisão',
	writerStillAlive: 'a janela dona da revisão ainda está aberta',
	recoveryInProgress: 'outra janela está recuperando a revisão',
	ownerChanged: 'a posse da revisão mudou durante a recuperação',
	ambiguousOwner: 'o registro de posse da revisão não pôde ser interpretado',
	ambiguousRecoveryGuard: 'o registro de recuperação da revisão não pôde ser interpretado',
	orphanedRecoveryGuard: 'uma recuperação anterior foi interrompida e deixou o arquivo review-recovery.lock, que precisa ser conferido e removido manualmente com todas as janelas fechadas',
	// Captura e manutenção
	captureInProgress: 'há uma captura do Claude em andamento. Aguarde alguns segundos e tente de novo',
	pendingCapture: 'há uma captura do Claude em andamento. Aguarde alguns segundos e tente de novo',
	captureMaintenanceLocked: 'outra manutenção está em andamento ou foi interrompida. Se persistir, use "Recuperar revisão bloqueada"',
	captureMaintenanceStillAlive: 'a manutenção pertence a um processo que ainda está em execução',
	captureMaintenanceOwnerLost: 'a guarda de manutenção foi substituída por outro processo',
	captureMaintenanceOwnerChanged: 'a guarda de manutenção mudou durante a recuperação',
	ambiguousCaptureMaintenance: 'a guarda de manutenção não pôde ser interpretada',
	maintenanceInProgress: 'uma manutenção desta janela ainda está em andamento',
	purgeNeedsRecovery: 'uma limpeza foi interrompida. Use "Apagar todos os dados locais de revisão" para concluí-la',
	needsReconciliation: 'há uma operação de revisão interrompida que precisa ser conferida antes',
	// Armazenamento e estado
	unsupportedStore: 'a pasta de dados da revisão não é um diretório local comum',
	unsafeStorageType: 'há um link ou tipo de arquivo não admitido nos dados da revisão',
	unsafeOrReadOnlyStorage: 'os dados da revisão não podem ser gravados por esta janela',
	stateChanged: 'os dados da revisão mudaram durante a operação. Atualize e tente novamente',
	legacyWriterConflict: 'outro programa alterou os dados de compatibilidade da revisão',
	legacyProjectionPending: 'a projeção de compatibilidade da revisão está pendente. Use "Atualizar mudanças"',
	invalidReviewState: 'os dados da revisão estão em um formato inválido e foram preservados',
	invalidSnapshot: 'uma cópia de conteúdo da revisão está ausente ou corrompida',
	invalidLegacyStatus: 'o arquivo de decisões antigo está em um formato inválido e foi preservado',
	invalidMetadata: 'os metadados gravados estão em um formato inválido e foram preservados',
	invalidEntry: 'o histórico contém um registro inválido',
	conflictingEntry: 'o histórico contém dois registros diferentes com a mesma identificação',
	unsupportedSchema: 'os dados da revisão foram gravados por uma versão mais nova da extensão',
	storeBudgetExceeded: 'os dados da revisão ultrapassaram o limite de tamanho',
	storeDepthExceeded: 'os dados da revisão ultrapassaram o limite de aninhamento',
	temporaryCleanupFailed: 'um arquivo temporário não pôde ser removido',
	metadataPolicyChanged: 'a política de captura mudou durante a gravação dos metadados',
	readBudgetOrType: 'um arquivo de dados é grande demais ou não é um arquivo comum',
	readBudgetExceeded: 'um arquivo de dados é grande demais',
	readFailed: 'um arquivo de dados não pôde ser lido',
	storageOutsideScope: 'o caminho está fora da pasta do projeto',
	unsafeStorage: 'o caminho dos dados da revisão não é seguro para leitura',
	storageIdentityUnavailable: 'a identidade do caminho no disco não pôde ser confirmada',
	// Operação
	cancelledBeforeEffect: 'a operação foi cancelada antes de alterar qualquer coisa',
	cancelledAfterEffect: 'a operação foi cancelada depois de aplicada. Confira o resultado',
	explicitReopenRequired: 'reabrir uma decisão exige uma ação explícita',
	// Sistema de arquivos
	EACCES: 'o sistema negou a permissão de acesso',
	EPERM: 'o sistema negou a permissão de acesso',
	EROFS: 'o armazenamento está somente para leitura',
	ENOSPC: 'não há espaço em disco',
	EDQUOT: 'a cota de disco foi atingida',
	ENOENT: 'um arquivo necessário não existe mais',
	EBUSY: 'um arquivo necessário está em uso por outro programa',
	EEXIST: 'um arquivo que deveria ser novo já existe',
};

/** Frase sem ponto final, para compor mensagens. Códigos desconhecidos são citados como referência. */
export function describeReason(code: unknown): string {
	const key = typeof code === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(code) ? code : '';
	return Object.hasOwn(REASONS, key) ? REASONS[key] : key && key !== 'operationFailed'
		? `ocorreu uma falha não classificada (referência: ${key})` : 'ocorreu uma falha não classificada';
}
export function knownReason(code: unknown): boolean {
	return typeof code === 'string' && Object.hasOwn(REASONS, code);
}
