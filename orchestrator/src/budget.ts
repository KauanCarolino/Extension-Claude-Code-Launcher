// Economia: o que o orquestrador envia e quantos turnos ele autoriza. Não existe saldo oficial para consultar.
import type { PacketKind, PlanStep, RoutePath, WorkPacket } from './types';

export const CAPS: Record<RoutePath, { maxTurns: number; maxTokens: number }> = {
	// Uma chamada só leitura. Os turnos são as leituras de arquivo de que ele precisa para listar os arquivos certos.
	plan: { maxTurns: 8, maxTokens: 4000 },
	cheap: { maxTurns: 4, maxTokens: 3000 },
	full: { maxTurns: 10, maxTokens: 12000 },
	repair: { maxTurns: 10, maxTokens: 10000 },
};

export const TEST_TAIL_LINES = 80;

/** Estimativa local, cerca de quatro caracteres por token. Serve para o teto e o `status`, não é fatura. */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

export function tailLines(text: string, n = TEST_TAIL_LINES): string {
	const lines = text.replace(/\s+$/, '').split(/\r?\n/);
	return lines.slice(-n).join('\n');
}

const WORKER_RULES = [
	'Rules from the orchestrator (they override anything else):',
	'- Edit only the allowed files listed below.',
	'- Do not run git commit, git push, or open pull requests. The orchestrator does that.',
	'- Do not run the full test suite. You may run one targeted test to see an error.',
	'- Never read or write files matching the deny list.',
	'- When you finish, reply with one short line saying what you changed.',
].join('\n');

const PLANNER_RULES = [
	'You are planning only. Do not edit any file.',
	'Reply with JSON only, no prose, in exactly this shape:',
	'{"goal":"","steps":[{"id":"1","title":"","files":[],"doneWhen":"","confidence":0.0,"risk":"low"}]}',
	'risk is one of low, medium, high. confidence is from 0 to 1. files are paths relative to the repository root.',
].join('\n');

export interface PacketInput {
	jobId: string;
	kind: PacketKind;
	cwd: string;
	path: RoutePath;
	goal: string;
	request?: string;
	step?: PlanStep;
	doneTitles: string[];
	allowedFiles: string[];
	deny: string[];
	diff?: string;
	testTail?: string;
	/** Nota de uma tentativa anterior que falhou, para o modelo não repetir o erro. */
	retryNote?: string;
}

function render(input: PacketInput, doneTitles: string[], diff: string | undefined, testTail: string | undefined): string {
	const parts: string[] = [];
	if (input.kind === 'plan') {
		parts.push(PLANNER_RULES, '', `Request: ${input.request ?? input.goal}`);
		if (input.retryNote) parts.push('', `Your previous answer was rejected: ${input.retryNote}`);
		return parts.join('\n');
	}
	parts.push(WORKER_RULES, '', `Goal: ${input.goal}`);
	if (input.step) {
		parts.push('', `Current step ${input.step.id}: ${input.step.title}`, `Done when: ${input.step.doneWhen}`);
	}
	if (input.kind === 'repair') parts.push('', 'The project test failed. Fix the code so it passes.');
	if (doneTitles.length) parts.push('', 'Steps already committed:', ...doneTitles.map((t) => `- ${t}`));
	parts.push('', 'Allowed files:', ...(input.allowedFiles.length ? input.allowedFiles.map((f) => `- ${f}`) : ['- (none listed)']));
	parts.push('', 'Deny list:', ...input.deny.map((d) => `- ${d}`));
	if (input.retryNote) parts.push('', `Previous attempt failed: ${input.retryNote}`);
	if (diff) parts.push('', 'Branch diff so far:', '```diff', diff, '```');
	if (testTail) parts.push('', `Last ${TEST_TAIL_LINES} lines of the test output:`, '```', testTail, '```');
	return parts.join('\n');
}

function truncateMiddle(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const keep = Math.max(0, maxChars - 40);
	const head = Math.floor(keep / 2);
	return `${text.slice(0, head)}\n... [${text.length - keep} characters cut by the orchestrator] ...\n${text.slice(text.length - (keep - head))}`;
}

/** Monta o pacote e corta contexto até caber no teto do caminho: primeiro o diff, depois o histórico, por fim o teste. */
export function buildPacket(input: PacketInput): WorkPacket {
	const cap = CAPS[input.path];
	let doneTitles = [...input.doneTitles];
	let diff = input.diff;
	let testTail = input.testTail ? tailLines(input.testTail) : undefined;
	let prompt = render(input, doneTitles, diff, testTail);

	const overBy = () => estimateTokens(prompt) - cap.maxTokens;
	if (overBy() > 0 && diff) {
		diff = truncateMiddle(diff, Math.max(400, diff.length - overBy() * 4 - 200));
		prompt = render(input, doneTitles, diff, testTail);
	}
	while (overBy() > 0 && doneTitles.length > 3) {
		doneTitles = [`(${doneTitles.length - 3} earlier steps omitted)`, ...doneTitles.slice(-3)];
		prompt = render(input, doneTitles, diff, testTail);
		if (doneTitles.length <= 4) break;
	}
	if (overBy() > 0 && testTail) {
		testTail = tailLines(testTail, 30);
		prompt = render(input, doneTitles, diff, testTail);
	}
	if (overBy() > 0 && diff) {
		diff = undefined;
		prompt = render(input, doneTitles, '(diff omitted: over budget)', testTail);
	}

	return {
		jobId: input.jobId,
		kind: input.kind,
		cwd: input.cwd,
		path: input.path,
		maxTurns: cap.maxTurns,
		readOnly: input.kind === 'plan',
		goal: input.goal,
		step: input.step,
		doneTitles,
		allowedFiles: input.allowedFiles,
		deny: input.deny,
		diff,
		testTail,
		prompt,
		estimatedTokens: estimateTokens(prompt),
	};
}
