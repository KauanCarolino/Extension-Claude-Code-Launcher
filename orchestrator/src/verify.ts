// Verifier: roda o comando de teste do projeto. A palavra do modelo sobre o teste é ignorada.
import { tailLines } from './budget';
import { runProjectCommand } from './proc';
import { commandLabel } from './project';
import type { TestRecord } from './types';

export interface CommandResult {
	exitCode: number | null;
	timedOut: boolean;
	output: string;
	durationMs: number;
}

export async function runCommand(cmd: string | string[], cwd: string, timeoutMs: number): Promise<CommandResult> {
	const r = await runProjectCommand(cmd, { cwd, timeoutMs });
	const output = r.stdout + (r.stderr ? `\n${r.stderr}` : '') + (r.spawnError ? `\n[orquestra] could not start: ${r.spawnError}\n` : '');
	return { exitCode: r.exitCode, timedOut: r.timedOut, output, durationMs: r.durationMs };
}

export async function verify(cmd: string | string[], cwd: string, timeoutSec: number, now: () => Date): Promise<TestRecord> {
	const r = await runCommand(cmd, cwd, timeoutSec * 1000);
	return {
		command: commandLabel(cmd),
		exitCode: r.exitCode,
		timedOut: r.timedOut,
		passed: r.exitCode === 0 && !r.timedOut,
		durationMs: r.durationMs,
		at: now().toISOString(),
		tail: tailLines(r.output) + (r.timedOut ? `\n[orquestra] test timed out after ${timeoutSec}s` : ''),
	};
}
