import { execFile, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_PROJECT } from '../src/project';
import type { Context } from '../src/runner';
import type { PlanStep, ProjectConfig, Provider } from '../src/types';

/** Verificador do repositório de teste: cada argumento é `arquivo=conteúdo esperado`. */
const VERIFY_JS = `
const fs = require('fs');
let ok = true;
for (const arg of process.argv.slice(2)) {
  const [file, want] = arg.split('=');
  const got = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (got !== want) { console.log('FAIL ' + file + ': expected ' + JSON.stringify(want) + ', got ' + JSON.stringify(got)); ok = false; }
}
console.log(ok ? 'all good' : 'tests failed');
process.exit(ok ? 0 : 1);
`;

export function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

export function makeRepo(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orquestra-test-'));
	git(dir, 'init', '--quiet', '-b', 'main');
	git(dir, 'config', 'user.name', 'Test');
	git(dir, 'config', 'user.email', 'test@example.invalid');
	git(dir, 'config', 'commit.gpgsign', 'false');
	git(dir, 'config', 'core.autocrlf', 'false');
	fs.writeFileSync(path.join(dir, 'README.md'), 'test repo\n');
	fs.writeFileSync(path.join(dir, 'verify.js'), VERIFY_JS);
	git(dir, 'add', '-A');
	git(dir, 'commit', '--quiet', '-m', 'init');
	return dir;
}

export function project(expect: string[], overrides: Partial<ProjectConfig> = {}): ProjectConfig {
	return { ...DEFAULT_PROJECT, deny: [...DEFAULT_PROJECT.deny], allowBash: [], test: ['node', 'verify.js', ...expect], testTimeoutSec: 60, ...overrides };
}

export interface Clock {
	now: () => Date;
	advance(ms: number): void;
}

export function clock(start = Date.parse('2026-11-26T12:00:00Z')): Clock {
	let t = start;
	return {
		now: () => new Date(t),
		advance(ms: number) {
			t += ms;
		},
	};
}

export function context(cwd: string, providers: Provider[], proj: ProjectConfig, extra: Partial<Context> = {}): Context {
	return {
		cwd,
		providers,
		project: proj,
		calibrationPath: path.join(cwd, '..', `${path.basename(cwd)}-calibration.json`),
		confirmPlan: async () => true,
		...extra,
	};
}

export function step(id: string, files: string[], extra: Partial<PlanStep> = {}): PlanStep {
	return { id, title: `Step ${id}`, files, doneWhen: `${files.join(', ')} written`, confidence: 0.9, risk: 'low', ...extra };
}

export function planJson(steps: PlanStep[], goal = 'make the test pass'): string {
	return JSON.stringify({ goal, steps });
}

export function read(cwd: string, file: string): string | null {
	const p = path.join(cwd, file);
	return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

const ROOT = path.resolve(__dirname, '..', '..');
export const CLI = path.join(ROOT, 'out', 'src', 'cli.js');

/** Um executável de verdade a partir de `test-bin/fake-<name>.js`: `.cmd` no Windows (passa pelo cmd.exe), script `sh` no resto. */
export function fakeBin(name: 'claude' | 'codex' | 'gh' = 'claude'): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `orquestra-bin-${name}-`));
	const script = `fake-${name}.js`;
	// O script vai ao lado do shim: o cmd.exe lê o .cmd na página de código OEM, e o caminho do repositório tem "ã".
	fs.copyFileSync(path.join(ROOT, 'test-bin', script), path.join(dir, script));
	if (process.platform === 'win32') {
		const shim = path.join(dir, `${name}.cmd`);
		fs.writeFileSync(shim, `@"${process.execPath}" "%~dp0${script}" %*\r\n`);
		return shim;
	}
	const shim = path.join(dir, name);
	fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/${script}" "$@"\n`, { mode: 0o755 });
	return shim;
}

let shared: { codex: string; gh: string } | undefined;

/**
 * Ambiente dos testes. Codex e gh sempre apontam para os falsos, para que um `codex` ou `gh` de verdade
 * instalado na máquina nunca seja chamado.
 */
export function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
	shared ??= { codex: fakeBin('codex'), gh: fakeBin('gh') };
	const env: NodeJS.ProcessEnv = { ...process.env, ORQUESTRA_CODEX_BIN: shared.codex, ORQUESTRA_GH_BIN: shared.gh, ...extra };
	// Sem isso, o `node --test` do repositório de teste se reportaria a este runner.
	delete env.NODE_TEST_CONTEXT;
	for (const k of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN']) if (!(k in extra)) delete env[k];
	return env;
}

export function runCli(cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		execFile(process.execPath, [CLI, ...args], { cwd, env }, (err, stdout, stderr) => {
			resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) });
		});
	});
}

/** Repositório com um bug e um teste que falha por causa dele. */
export function bugRepo(testCmd: string, projectExtra: Record<string, unknown> = {}): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'orquestra-e2e-'));
	git(cwd, 'init', '--quiet', '-b', 'main');
	git(cwd, 'config', 'user.name', 'Test');
	git(cwd, 'config', 'user.email', 'test@example.invalid');
	git(cwd, 'config', 'commit.gpgsign', 'false');
	fs.writeFileSync(path.join(cwd, 'math.js'), 'exports.add = (a, b) => a - b;\n');
	fs.writeFileSync(
		path.join(cwd, 'math.test.js'),
		"const test = require('node:test');\nconst assert = require('node:assert');\nconst { add } = require('./math');\ntest('add', () => assert.equal(add(2, 3), 5));\n",
	);
	fs.mkdirSync(path.join(cwd, '.orquestra'));
	fs.writeFileSync(path.join(cwd, '.orquestra', 'project.json'), JSON.stringify({ test: testCmd, baseBranch: 'main', ...projectExtra }));
	git(cwd, 'add', '-A');
	git(cwd, 'commit', '--quiet', '-m', 'init with a bug');
	return cwd;
}

/** Remoto `origin` local (repositório bare numa pasta temporária): o push dos testes nunca sai da máquina. */
export function addBareRemote(cwd: string): string {
	const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'orquestra-remote-'));
	git(bare, 'init', '--quiet', '--bare');
	git(cwd, 'remote', 'add', 'origin', bare);
	git(cwd, 'push', '--quiet', 'origin', 'main');
	return bare;
}

export function logLines<T>(file: string): T[] {
	return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as T) : [];
}
