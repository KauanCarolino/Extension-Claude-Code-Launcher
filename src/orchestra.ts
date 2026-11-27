/**
 * Aba do orquestrador: a parte sem VS Code. Acha a CLI `orquestra`, monta os argumentos de cada ação
 * e lê os jobs de `.orquestra/jobs/`. Quem planeja, edita, commita, testa e abre o PR é sempre a CLI,
 * num processo separado: a extensão só envia o pedido e mostra o estado.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const PROVIDERS = ['claude', 'codex'] as const;
export type OrchestraProvider = typeof PROVIDERS[number];

/** Teto do pedido digitado na aba. O planner recebe isso quase literalmente. */
export const MAX_REQUEST = 8000;

export interface CliCommand {
	/** Executável: o node, ou o próprio `orquestra` quando ele não é um script. */
	file: string;
	/** Argumentos antes dos da ação (o caminho do `cli.js`, quando roda pelo node). */
	prefix: string[];
	/** De onde veio, para a mensagem de ajuda. */
	source: 'setting' | 'workspace' | 'path';
	/** Rodar o Electron do editor como node (só quando não há `node` no PATH). */
	electronAsNode?: boolean;
}

export interface CliLookup {
	setting: string | undefined;
	/** Pasta da extensão: em desenvolvimento, o orquestrador compilado fica em `orchestrator/out`. */
	extensionPath: string;
	/** `orquestra` no PATH, já resolvido. */
	onPath: string | undefined;
	/** `node` no PATH; sem ele, `fallbackNode` roda como node. */
	node: string | undefined;
	fallbackNode: string;
	platform: string;
	exists?: (file: string) => boolean;
	realpath?: (file: string) => string;
}

const isScript = (file: string) => /\.(?:c|m)?js$/i.test(file);

/** Caminho do `cli.js` atrás do `orquestra.cmd` que o `npm link` cria no Windows. */
function windowsShimTarget(shim: string, exists: (file: string) => boolean): string | undefined {
	const candidate = path.win32.join(path.win32.dirname(shim), 'node_modules', 'orquestra', 'out', 'src', 'cli.js');
	return exists(candidate) ? candidate : undefined;
}

/**
 * A CLI que a aba usa, na ordem: a opção `claudeCodeLauncher.orchestrator.cliPath` (só da máquina), o
 * orquestrador compilado ao lado da extensão (desenvolvimento) e o `orquestra` do PATH. Nunca passa por shell.
 */
export function resolveCli(lookup: CliLookup): CliCommand | undefined {
	const exists = lookup.exists ?? ((file: string) => fs.existsSync(file));
	const realpath = lookup.realpath ?? ((file: string) => fs.realpathSync(file));
	const viaNode = (script: string, source: CliCommand['source']): CliCommand => lookup.node
		? { file: lookup.node, prefix: [script], source }
		: { file: lookup.fallbackNode, prefix: [script], source, electronAsNode: true };
	const setting = lookup.setting?.trim();
	if (setting) {
		if (!path.isAbsolute(setting) || !exists(setting)) { return undefined; }
		return isScript(setting) ? viaNode(setting, 'setting') : { file: setting, prefix: [], source: 'setting' };
	}
	const bundled = path.join(lookup.extensionPath, 'orchestrator', 'out', 'src', 'cli.js');
	if (exists(bundled)) { return viaNode(bundled, 'workspace'); }
	if (!lookup.onPath) { return undefined; }
	let target = lookup.onPath;
	try { target = realpath(lookup.onPath); } catch { /* fica o caminho do PATH */ }
	if (isScript(target)) { return viaNode(target, 'path'); }
	if (lookup.platform === 'win32' && /\.(?:cmd|bat)$/i.test(target)) {
		// Um .cmd só roda pelo cmd.exe; o script atrás dele roda direto pelo node.
		const script = windowsShimTarget(target, exists);
		return script ? viaNode(script, 'path') : undefined;
	}
	return { file: target, prefix: [], source: 'path' };
}

/** Id de job como a CLI cria (`20261126-a1b2c3`): nada que vire opção ou caminho. */
export function validJobId(id: unknown): id is string {
	return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id) && !id.startsWith('-');
}

/** Pedido digitado: texto com quebras de linha e tabs, sem outros caracteres de controle. */
export function validRequest(text: unknown): text is string {
	return typeof text === 'string' && text.trim().length > 0 && text.length <= MAX_REQUEST
		&& !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text);
}

export type OrchestraAction =
	| { kind: 'plan'; provider?: OrchestraProvider }
	| { kind: 'confirm'; id: string; pr: boolean }
	| { kind: 'resume'; id: string; discard: boolean }
	| { kind: 'pr'; id: string }
	| { kind: 'drop'; id: string }
	| { kind: 'status'; id: string }
	| { kind: 'providers' };

/** Argumentos da CLI para cada ação. O pedido vai pelo stdin (`--stdin`), nunca na linha de comando. */
export function actionArgs(action: OrchestraAction): string[] {
	switch (action.kind) {
		case 'plan': return ['plan', '--stdin', ...(action.provider ? ['--provider', action.provider] : [])];
		case 'confirm': return ['resume', action.id, '--yes', ...(action.pr ? ['--pr'] : [])];
		case 'resume': return ['resume', action.id, '--yes', ...(action.discard ? ['--discard'] : [])];
		case 'pr': return ['resume', action.id, '--yes', '--pr'];
		case 'drop': return ['drop', action.id];
		case 'status': return ['status', action.id];
		case 'providers': return ['providers', '--json'];
	}
}

// ---------------------------------------------------------------- jobs

export interface JobStepView {
	id: string; title: string; files: string[]; status: string; provider?: string; commit?: string; confidence: number; risk: string;
}

/** O que a página recebe de cada job: só os campos que ela mostra, com tipos conferidos. */
export interface JobView {
	id: string; state: string; reason?: string; request: string; branch: string; createdAt: string; updatedAt: string;
	goal?: string; planConfirmed: boolean; steps: JobStepView[]; repairCycles: number;
	lastTest?: { passed: boolean; command: string; exitCode: number | null; timedOut: boolean; durationMs: number };
	wantPr: boolean; prUrl?: string; prError?: string;
	timing: { modelMs: Record<string, number>; testMs: number; quotaWaitMs: number; quotaSince?: string; endedAt?: string };
	providers: string[];
}

const str = (v: unknown, max = 4000): string | undefined => typeof v === 'string' ? v.slice(0, max) : undefined;
const num = (v: unknown): number => typeof v === 'number' && Number.isFinite(v) ? v : 0;
const obj = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};

/** Só links https de PR seguem para "abrir no navegador". */
export function safePrUrl(url: unknown): string | undefined {
	if (typeof url !== 'string' || url.length > 2048) { return undefined; }
	try { return new URL(url).protocol === 'https:' ? url : undefined; } catch { return undefined; }
}

/** Converte o JSON gravado pela CLI. Um arquivo de outra versão, ou ilegível, vira `undefined`. */
export function jobView(raw: unknown): JobView | undefined {
	const j = obj(raw);
	if (j.version !== 1 || !validJobId(j.id) || typeof j.state !== 'string') { return undefined; }
	const plan = obj(j.plan);
	const steps = Array.isArray(j.steps) ? j.steps.slice(0, 100).map((value): JobStepView => {
		const s = obj(value);
		return {
			id: str(s.id, 32) ?? '', title: str(s.title, 300) ?? '', files: Array.isArray(s.files) ? s.files.filter((f): f is string => typeof f === 'string').slice(0, 50) : [],
			status: str(s.status, 16) ?? 'pending', provider: str(s.provider, 16), commit: str(s.commit, 64)?.slice(0, 8), confidence: num(s.confidence), risk: str(s.risk, 16) ?? '',
		};
	}) : [];
	const test = obj(j.lastTest);
	const timing = obj(j.timing);
	const modelMs = Object.fromEntries(Object.entries(obj(timing.modelMs)).map(([k, v]) => [k, num(v)]));
	const pr = obj(j.pr);
	return {
		id: j.id, state: j.state, reason: str(j.reason, 1000), request: str(j.request, 8000) ?? '', branch: str(j.branch, 300) ?? '',
		createdAt: str(j.createdAt, 64) ?? '', updatedAt: str(j.updatedAt, 64) ?? '',
		goal: str(plan.goal, 1000), planConfirmed: j.planConfirmed === true, steps, repairCycles: num(j.repairCycles),
		lastTest: j.lastTest ? { passed: test.passed === true, command: str(test.command, 300) ?? '', exitCode: typeof test.exitCode === 'number' ? test.exitCode : null,
			timedOut: test.timedOut === true, durationMs: num(test.durationMs) } : undefined,
		wantPr: j.wantPr === true, prUrl: safePrUrl(pr.url), prError: str(j.prError, 1000),
		timing: { modelMs, testMs: num(timing.testMs), quotaWaitMs: num(timing.quotaWaitMs), quotaSince: str(timing.quotaSince, 64), endedAt: str(timing.endedAt, 64) },
		providers: [...new Set(steps.map((s) => s.provider).filter((p): p is string => !!p))],
	};
}

export const MAX_JOBS = 20;

/** Jobs da pasta, do mais novo para o mais antigo. Não chama a CLI: só lê os arquivos que ela grava. */
export async function readJobs(root: string, limit = MAX_JOBS): Promise<JobView[]> {
	const dir = path.join(root, '.orquestra', 'jobs');
	let names: string[];
	try { names = await fs.promises.readdir(dir); } catch { return []; }
	const jobs = await Promise.all(names.filter((n) => /^[A-Za-z0-9_-]+\.json$/.test(n)).map(async (name) => {
		try {
			const file = path.join(dir, name);
			// Um job tem poucos KB; um arquivo enorme ali não é do orquestrador.
			if ((await fs.promises.stat(file)).size > 2 * 1024 * 1024) { return undefined; }
			return jobView(JSON.parse(await fs.promises.readFile(file, 'utf8')));
		} catch { return undefined; }
	}));
	return jobs.filter((j): j is JobView => !!j).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}

/** Ações que fazem sentido para o job, na ordem dos botões. */
export function jobActions(job: JobView): Array<'confirm' | 'drop' | 'resume' | 'discard' | 'pr' | 'openPr'> {
	if (job.state === 'pr_open') { return job.prUrl ? ['openPr'] : []; }
	if (job.state === 'passed') { return job.wantPr && !job.prUrl ? ['pr'] : job.prUrl ? ['openPr'] : ['pr']; }
	if (!job.planConfirmed) {
		// Plano pronto e esperando: confirmar ou descartar. Sem plano (o planner falhou): tentar de novo ou descartar.
		return job.goal !== undefined ? ['confirm', 'drop'] : ['resume', 'drop'];
	}
	return ['resume', 'discard'];
}

export interface ProvidersView {
	providers: Array<{ id: string; ok: boolean; reason?: string }>;
	gh: { ok: boolean; reason?: string };
	defaultProvider?: string;
}

/** Lê a saída de `orquestra providers --json`. */
export function parseProviders(stdout: string): ProvidersView | undefined {
	try {
		const raw = obj(JSON.parse(stdout.trim().split(/\r?\n/).pop() ?? ''));
		if (!Array.isArray(raw.providers)) { return undefined; }
		const status = (v: unknown) => { const s = obj(v); return { ok: s.ok === true, reason: str(s.reason, 500) }; };
		return {
			providers: raw.providers.slice(0, 8).map((p) => ({ id: str(obj(p).id, 32) ?? '?', ...status(p) })),
			gh: status(raw.gh),
			defaultProvider: str(raw.defaultProvider, 32),
		};
	} catch { return undefined; }
}

/** Última linha de erro da CLI (`orquestra: ...`), para a notificação. */
export function cliError(stderr: string): string | undefined {
	const line = stderr.split(/\r?\n/).reverse().find((l) => l.startsWith('orquestra: '));
	return line ? line.slice('orquestra: '.length).slice(0, 500) : undefined;
}

/** Modelo inicial do `.orquestra/project.json`, com o teste adivinhado pelo `package.json`. */
export function projectTemplate(packageJson: string | undefined): string {
	let test = 'npm test';
	try {
		const scripts = obj(obj(JSON.parse(packageJson ?? '')).scripts);
		if (typeof scripts.test !== 'string') { test = 'echo "set the test command in .orquestra/project.json" && exit 1'; }
	} catch { /* sem package.json: fica npm test, para a pessoa trocar */ }
	return `${JSON.stringify({ test, baseBranch: 'main', maxRepairCycles: 2, defaultProvider: 'claude', allowBash: [], remote: 'origin', prDraft: false }, null, 2)}\n`;
}
