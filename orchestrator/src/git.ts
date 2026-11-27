// Git pelo `execFile`, com argumentos em lista: o PowerShell não reinterpreta aspas no caminho.
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const JOB_TRAILER = 'Orquestra-Job';
export const STEP_TRAILER = 'Orquestra-Step';

export interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

export function git(cwd: string, args: string[], allowFail = false): Promise<GitResult> {
	return new Promise((resolve, reject) => {
		execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
			const e = err as (Error & { code?: number | string }) | null;
			if (e?.code === 'ENOENT') {
				reject(new Error('git was not found on PATH'));
				return;
			}
			const code = !e ? 0 : typeof e.code === 'number' ? e.code : 1;
			const result = { code, stdout: String(stdout), stderr: String(stderr) };
			if (code !== 0 && !allowFail) {
				reject(new Error(`git ${args.join(' ')} failed (${code}): ${result.stderr.trim() || result.stdout.trim()}`));
				return;
			}
			resolve(result);
		});
	});
}

export async function repoRoot(cwd: string): Promise<string> {
	const r = await git(cwd, ['rev-parse', '--show-toplevel'], true);
	if (r.code !== 0) throw new Error('This folder is not inside a git repository');
	return path.resolve(r.stdout.trim());
}

export async function head(cwd: string): Promise<string> {
	return (await git(cwd, ['rev-parse', 'HEAD'])).stdout.trim();
}

export async function currentBranch(cwd: string): Promise<string> {
	return (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
}

export async function branchExists(cwd: string, branch: string): Promise<boolean> {
	const r = await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], true);
	return r.code === 0;
}

/** Arquivos que o próprio orquestrador escreve e que nunca contam como sujeira. */
export function isOrquestraLocal(file: string): boolean {
	const f = file.replace(/\\/g, '/');
	return f.startsWith('.orquestra/jobs/') || f === '.orquestra/jobs';
}

/** Arquivos alterados, novos ou apagados na árvore, relativos à raiz. */
export async function changedFiles(cwd: string): Promise<string[]> {
	const r = await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
	const parts = r.stdout.split('\0');
	const files: string[] = [];
	for (let i = 0; i < parts.length; i++) {
		const entry = parts[i];
		if (entry.length < 4) continue;
		const x = entry[0];
		files.push(entry.slice(3));
		// Em renomeação e cópia, o caminho de origem vem no campo seguinte.
		if (x === 'R' || x === 'C') {
			files.push(parts[i + 1]);
			i++;
		}
	}
	return [...new Set(files)].filter((f) => !isOrquestraLocal(f));
}

export async function isClean(cwd: string): Promise<boolean> {
	return (await changedFiles(cwd)).length === 0;
}

/** Garante que os jobs locais nunca sujem a árvore, sem tocar no .gitignore da pessoa. */
export async function excludeJobsDir(cwd: string): Promise<void> {
	const r = await git(cwd, ['rev-parse', '--git-path', 'info/exclude']);
	const file = path.resolve(cwd, r.stdout.trim());
	const line = '/.orquestra/jobs/';
	const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
	if (current.split(/\r?\n/).includes(line)) return;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.appendFileSync(file, `${current && !current.endsWith('\n') ? '\n' : ''}${line}\n`);
}

export async function switchToBranch(cwd: string, branch: string, startPoint: string): Promise<void> {
	if (await branchExists(cwd, branch)) {
		if ((await currentBranch(cwd)) !== branch) await git(cwd, ['switch', branch]);
		return;
	}
	await git(cwd, ['switch', '-c', branch, startPoint]);
}

/** Devolve a árvore ao último commit. Só é chamada quando a árvore estava limpa antes do worker. */
export async function discardChanges(cwd: string): Promise<void> {
	await git(cwd, ['reset', '--hard', '--quiet', 'HEAD']);
	// Sem `-x`: arquivos ignorados, inclusive `.orquestra/jobs/`, ficam onde estão.
	await git(cwd, ['clean', '-fd', '--quiet']);
}

export async function commitFiles(cwd: string, files: string[], title: string, jobId: string, stepId: string): Promise<string> {
	await git(cwd, ['add', '-A', '--', ...files]);
	const message = `${title}\n\n${JOB_TRAILER}: ${jobId}\n${STEP_TRAILER}: ${stepId}\n`;
	await git(cwd, ['commit', '--quiet', '--no-verify', '-m', message]);
	return head(cwd);
}

export interface StepCommit {
	sha: string;
	stepId: string;
	subject: string;
}

/** Commits do orquestrador para esta tarefa no branch: a fonte de verdade de "passo feito". */
export async function stepCommits(cwd: string, branch: string, baseCommit: string, jobId: string): Promise<StepCommit[]> {
	if (!(await branchExists(cwd, branch))) return [];
	const sep = '\x1f';
	const r = await git(cwd, [
		'log',
		'--reverse',
		`--format=%H${sep}%s${sep}%(trailers:key=${JOB_TRAILER},valueonly,separator=%x2C)${sep}%(trailers:key=${STEP_TRAILER},valueonly,separator=%x2C)%x1e`,
		`${baseCommit}..refs/heads/${branch}`,
	]);
	const out: StepCommit[] = [];
	for (const record of r.stdout.split('\x1e')) {
		const [sha, subject, job, step] = record.trim().split(sep);
		if (!sha || job?.trim() !== jobId || !step?.trim()) continue;
		out.push({ sha, subject, stepId: step.trim() });
	}
	return out;
}

export async function remoteExists(cwd: string, remote: string): Promise<boolean> {
	return (await git(cwd, ['remote', 'get-url', remote], true)).code === 0;
}

/** Envia só o branch da tarefa, sem forçar. Os hooks de pre-push da pessoa continuam valendo. */
export async function pushBranch(cwd: string, remote: string, branch: string): Promise<void> {
	await git(cwd, ['push', '--quiet', '--set-upstream', remote, `refs/heads/${branch}:refs/heads/${branch}`]);
}

export async function diffSince(cwd: string, baseCommit: string): Promise<string> {
	return (await git(cwd, ['diff', '--no-color', `${baseCommit}..HEAD`])).stdout;
}
