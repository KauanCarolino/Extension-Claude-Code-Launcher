import { execFileSync } from 'node:child_process';
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
