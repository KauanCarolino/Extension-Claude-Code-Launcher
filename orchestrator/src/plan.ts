// Validação do JSON do planner. JSON inválido ganha uma nova tentativa; a segunda falha para a tarefa.
import { isDenied } from './project';
import type { Plan, PlanStep, Risk } from './types';

const RISKS: readonly Risk[] = ['low', 'medium', 'high'];

/** Tira cercas de markdown e texto em volta: o modelo às vezes embrulha o JSON. */
function extractJson(text: string): string {
	const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
	const body = fenced ? fenced[1] : text;
	const start = body.indexOf('{');
	const end = body.lastIndexOf('}');
	if (start < 0 || end <= start) throw new Error('no JSON object in the answer');
	return body.slice(start, end + 1);
}

export function parsePlan(text: string, deny: readonly string[]): Plan {
	let raw: unknown;
	try {
		raw = JSON.parse(extractJson(text));
	} catch (err) {
		throw new Error(`invalid JSON: ${(err as Error).message}`);
	}
	if (!raw || typeof raw !== 'object') throw new Error('the plan must be an object');
	const r = raw as Record<string, unknown>;
	if (typeof r.goal !== 'string' || !r.goal.trim()) throw new Error('goal must be a non-empty string');
	if (!Array.isArray(r.steps) || r.steps.length === 0) throw new Error('steps must be a non-empty list');
	const ids = new Set<string>();
	const steps: PlanStep[] = r.steps.map((s: unknown, i: number) => {
		const where = `steps[${i}]`;
		if (!s || typeof s !== 'object') throw new Error(`${where} must be an object`);
		const step = s as Record<string, unknown>;
		const id = typeof step.id === 'number' ? String(step.id) : step.id;
		if (typeof id !== 'string' || !/^[A-Za-z0-9_.-]{1,32}$/.test(id)) throw new Error(`${where}.id must be a short identifier`);
		if (id.startsWith('repair-')) throw new Error(`${where}.id must not start with "repair-"`);
		if (ids.has(id)) throw new Error(`${where}.id "${id}" is repeated`);
		ids.add(id);
		if (typeof step.title !== 'string' || !step.title.trim()) throw new Error(`${where}.title must be a non-empty string`);
		if (!Array.isArray(step.files) || !step.files.every((f) => typeof f === 'string' && f.trim())) {
			throw new Error(`${where}.files must be a list of paths`);
		}
		const files = (step.files as string[]).map((f) => f.trim().replace(/\\/g, '/').replace(/^\.\//, ''));
		for (const f of files) {
			if (f.startsWith('/') || /^[A-Za-z]:/.test(f) || f.split('/').includes('..')) throw new Error(`${where}.files has a path outside the repository: ${f}`);
			if (isDenied(f, deny)) throw new Error(`${where}.files includes a denied file: ${f}`);
		}
		if (typeof step.doneWhen !== 'string') throw new Error(`${where}.doneWhen must be a string`);
		if (typeof step.confidence !== 'number' || !Number.isFinite(step.confidence) || step.confidence < 0 || step.confidence > 1) {
			throw new Error(`${where}.confidence must be a number from 0 to 1`);
		}
		if (!RISKS.includes(step.risk as Risk)) throw new Error(`${where}.risk must be one of ${RISKS.join(', ')}`);
		return {
			id,
			title: step.title.trim().split(/\r?\n/)[0].slice(0, 200),
			files,
			doneWhen: step.doneWhen,
			confidence: step.confidence,
			risk: step.risk as Risk,
		};
	});
	return { goal: r.goal.trim(), steps };
}
