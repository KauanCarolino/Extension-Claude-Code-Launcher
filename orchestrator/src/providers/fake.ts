// Provedor falso: aplica um patch conhecido e, quando o teste pede, devolve o texto de cota gravado.
// Fica nos testes para sempre. Ele imita o `id` de um provedor real para o roteador tratar igual.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Provider, ProviderId, RunResult, WorkPacket } from '../types';
import { matchesQuotaFixtures, quotaFixture } from './quota';

export interface FakeAction {
	/** Conteúdo novo por caminho relativo; `null` apaga. Também é aplicado antes de uma cota, para simular edição pela metade. */
	files?: Record<string, string | null | undefined>;
	output?: string;
	exitCode?: number;
	/** Responde com o texto de cota gravado em `fixtures/quota/<quotaFixtureName>`. */
	quota?: boolean;
	/** Desobedece a instrução e commita sozinho. */
	commit?: boolean;
	stderr?: string;
}

export type FakeScript = (packet: WorkPacket, call: number) => FakeAction;

export interface FakeOptions {
	id: ProviderId;
	script: FakeScript;
	unavailable?: string;
	quotaFixtureName?: string;
}

export class FakeProvider implements Provider {
	readonly id: ProviderId;
	readonly calls: WorkPacket[] = [];
	unavailable: string | undefined;
	private readonly script: FakeScript;
	private readonly quotaText: string;

	constructor(opts: FakeOptions) {
		this.id = opts.id;
		this.script = opts.script;
		this.unavailable = opts.unavailable;
		this.quotaText = quotaFixture(opts.quotaFixtureName ?? 'fake.txt');
	}

	async available(): Promise<{ ok: boolean; reason?: string }> {
		return this.unavailable ? { ok: false, reason: this.unavailable } : { ok: true };
	}

	async run(packet: WorkPacket): Promise<RunResult> {
		this.calls.push(packet);
		const action = this.script(packet, this.calls.length);
		const started = Date.now();
		if (!packet.readOnly) {
			for (const [rel, content] of Object.entries(action.files ?? {})) {
				const file = path.join(packet.cwd, rel);
				if (content === undefined) continue;
				if (content === null) {
					fs.rmSync(file, { force: true });
				} else {
					fs.mkdirSync(path.dirname(file), { recursive: true });
					fs.writeFileSync(file, content);
				}
			}
			if (action.commit) {
				execFileSync('git', ['add', '-A'], { cwd: packet.cwd });
				execFileSync('git', ['commit', '--quiet', '-m', 'worker commit'], { cwd: packet.cwd });
			}
		}
		if (action.quota) {
			return { exitCode: 1, output: '', stderr: this.quotaText, durationMs: Date.now() - started };
		}
		return {
			exitCode: action.exitCode ?? 0,
			output: action.output ?? 'done',
			stderr: action.stderr ?? '',
			durationMs: Date.now() - started,
		};
	}

	isQuotaError(result: RunResult): boolean {
		return matchesQuotaFixtures(`${result.output}\n${result.stderr}`, [this.quotaText]);
	}
}
