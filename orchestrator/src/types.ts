// Contrato do orquestrador: esquema da tarefa, do projeto e a interface única dos modelos.
// A memória da tarefa é o arquivo do job mais o branch; a conversa do modelo não entra aqui.

export type ProviderId = 'claude' | 'codex';

export const PROVIDER_IDS: readonly ProviderId[] = ['claude', 'codex'];

export type JobState =
	| 'planning'
	| 'running'
	| 'blocked_quota'
	| 'blocked_test'
	| 'needs_human'
	// Teste verde sem `--pr`: a tarefa terminou, mas nenhum PR foi aberto.
	| 'passed'
	| 'pr_open';

export type StepStatus = 'pending' | 'running' | 'done';

export type Risk = 'low' | 'medium' | 'high';

export interface PlanStep {
	id: string;
	title: string;
	files: string[];
	doneWhen: string;
	confidence: number;
	risk: Risk;
}

export interface Plan {
	goal: string;
	steps: PlanStep[];
}

export interface Step extends PlanStep {
	status: StepStatus;
	/** Modelo que tentou o passo por último; falha de tarefa fica nele. */
	provider?: ProviderId;
	/** Commit do orquestrador que fechou o passo. */
	commit?: string;
	/** Falhas de tarefa (não de cota) desde a última retomada. */
	attempts: number;
}

export interface QuotaBlock {
	at: string;
	reason: string;
}

export interface TestRecord {
	command: string;
	exitCode: number | null;
	timedOut: boolean;
	passed: boolean;
	durationMs: number;
	at: string;
	/** Últimas linhas da saída, que vão para o pacote de reparo. */
	tail: string;
}

export interface JobEvent {
	at: string;
	state: JobState;
	note?: string;
}

export interface Job {
	version: 1;
	id: string;
	slug: string;
	request: string;
	createdAt: string;
	updatedAt: string;
	state: JobState;
	/** Motivo do estado atual quando ele para a tarefa. */
	reason?: string;
	branch: string;
	baseBranch: string;
	baseCommit: string;
	preferredProvider: ProviderId;
	plan?: Plan;
	planConfirmed: boolean;
	planAttempts: number;
	steps: Step[];
	repairCycles: number;
	/** Modelos que encheram a cota nesta execução; `resume` limpa e tenta de novo. */
	quota: Partial<Record<ProviderId, QuotaBlock>>;
	timing: {
		modelMs: Partial<Record<ProviderId, number>>;
		/** Verifier e `gh`. */
		testMs: number;
		/** Tempo parado em `blocked_quota`, fora do tempo de modelo. */
		quotaWaitMs: number;
		quotaSince?: string;
		endedAt?: string;
	};
	budget: {
		/** Estimativa local de tokens de entrada; não é a fatura da assinatura. */
		inputTokensEstimate: number;
		calls: number;
		/** O que o CLI disse ter usado, incluindo cache. Também não é a fatura. */
		reportedInputTokens?: number;
		reportedOutputTokens?: number;
	};
	lastTest?: TestRecord;
	/** A calibração só conta a primeira rodada de teste de cada tarefa. */
	calibrationRecorded: boolean;
	pr?: { url: string };
	events: JobEvent[];
}

export type PacketKind = 'plan' | 'step' | 'repair';

export type RoutePath = 'cheap' | 'full' | 'repair' | 'plan';

/** O que atravessa para o modelo. O repositório inteiro e a sessão do outro modelo ficam de fora. */
export interface WorkPacket {
	jobId: string;
	kind: PacketKind;
	cwd: string;
	path: RoutePath;
	maxTurns: number;
	/** Só leitura: o planner não edita nada. */
	readOnly: boolean;
	goal: string;
	step?: PlanStep;
	doneTitles: string[];
	allowedFiles: string[];
	deny: string[];
	diff?: string;
	testTail?: string;
	/** Texto final enviado ao modelo, já cortado para o teto do caminho. */
	prompt: string;
	estimatedTokens: number;
}

export interface RunResult {
	exitCode: number | null;
	/** Saída padrão do modelo; no planner, é onde vem o JSON. */
	output: string;
	stderr: string;
	durationMs: number;
	/** Falha ao iniciar o processo, timeout etc. */
	error?: string;
	/** Saída bruta do CLI, para reconhecer cota e para capturar fixture nova. */
	raw?: string;
	/** Tokens que o próprio CLI relatou, quando relata. */
	usage?: { inputTokens: number; outputTokens: number };
	turns?: number;
}

export interface Provider {
	id: ProviderId;
	available(): Promise<{ ok: boolean; reason?: string }>;
	run(packet: WorkPacket): Promise<RunResult>;
	/** Só reconhece mensagens guardadas como fixture. Erro desconhecido não é cota. */
	isQuotaError(result: RunResult): boolean;
}

export interface ProjectConfig {
	/** String roda pelo shell do sistema; lista roda direto, sem reinterpretar aspas. */
	test: string | string[];
	/** Checagem curta opcional antes de cada commit de passo. */
	check?: string | string[];
	baseBranch: string;
	maxRepairCycles: number;
	testTimeoutSec: number;
	/** Teto de cada chamada de modelo. */
	modelTimeoutSec: number;
	defaultProvider: ProviderId;
	deny: string[];
	/** Comandos que o worker pode rodar para ver um erro pontual, como `npm test -- *`. Vazio: sem shell. */
	allowBash: string[];
}
