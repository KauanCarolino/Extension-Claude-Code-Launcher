// Roteador: escolhe o modelo e o caminho de cada passo por confiança, risco, cota e histórico local.
import { isConfident, type Calibration } from './calibrate';
import type { Job, PlanStep, Provider, ProviderId, RoutePath } from './types';

export const CHEAP_MAX_FILES = 3;

export function choosePath(step: PlanStep, cal: Calibration, threshold?: number): RoutePath {
	const confident = isConfident(cal, step.confidence, threshold);
	const small = step.files.length > 0 && step.files.length <= CHEAP_MAX_FILES;
	return confident && step.risk === 'low' && small ? 'cheap' : 'full';
}

export interface PickOptions {
	/** Falha de tarefa fica no mesmo modelo: ele vem primeiro se ainda tiver cota. */
	sticky?: ProviderId;
	/** Segundo reparo: o outro modelo, se estiver disponível. */
	prefer?: ProviderId;
}

export type Pick = { provider: Provider } | { provider: null; reasons: string[] };

export async function pickProvider(job: Job, providers: readonly Provider[], opts: PickOptions = {}): Promise<Pick> {
	const order: ProviderId[] = [];
	for (const id of [opts.prefer, opts.sticky, job.preferredProvider, ...providers.map((p) => p.id)]) {
		if (id && !order.includes(id)) order.push(id);
	}
	const reasons: string[] = [];
	for (const id of order) {
		const provider = providers.find((p) => p.id === id);
		if (!provider) continue;
		const block = job.quota[id];
		if (block) {
			// Nenhum turno novo no modelo que encheu a cota.
			reasons.push(`${id}: quota (${block.reason})`);
			continue;
		}
		const status = await provider.available();
		if (!status.ok) {
			reasons.push(`${id}: ${status.reason ?? 'unavailable'}`);
			continue;
		}
		return { provider };
	}
	return { provider: null, reasons };
}

export function otherProvider(id: ProviderId | undefined, providers: readonly Provider[]): ProviderId | undefined {
	return providers.find((p) => p.id !== id)?.id;
}
