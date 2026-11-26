// Lugar dos adapters reais enquanto eles não chegam: Claude na fase 1, Codex na fase 3.
// Responde indisponível, então o roteador nunca entrega um passo a ele.
import type { Provider, ProviderId, RunResult, WorkPacket } from '../types';

export class PendingProvider implements Provider {
	constructor(
		readonly id: ProviderId,
		private readonly phase: number,
	) {}

	async available(): Promise<{ ok: boolean; reason?: string }> {
		return { ok: false, reason: `the ${this.id} adapter arrives in phase ${this.phase}` };
	}

	async run(_packet: WorkPacket): Promise<RunResult> {
		throw new Error(`the ${this.id} adapter is not implemented yet`);
	}

	isQuotaError(_result: RunResult): boolean {
		return false;
	}
}
