// Processos externos: argumentos em lista, texto longo pelo stdin, timeout que mata a árvore inteira.
import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ProcResult {
	exitCode: number | null;
	timedOut: boolean;
	stdout: string;
	stderr: string;
	durationMs: number;
	/** Não conseguiu iniciar (binário ausente, permissão). */
	spawnError?: string;
}

export interface ProcOptions {
	cwd: string;
	timeoutMs: number;
	input?: string;
	env?: NodeJS.ProcessEnv;
}

const MAX_CAPTURE = 4 * 1024 * 1024;

export function killTree(pid: number | undefined): void {
	if (!pid) return;
	if (process.platform === 'win32') {
		execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
		return;
	}
	try {
		process.kill(-pid, 'SIGKILL');
	} catch {
		try {
			process.kill(pid, 'SIGKILL');
		} catch {}
	}
}

/** Aspas para uma linha do cmd.exe. Só usada com `.cmd`/`.bat`, que o Windows não executa direto. */
export function quoteForCmd(arg: string): string {
	if (arg === '') return '""';
	if (!/[\s"&|<>^(),;=!%]/.test(arg)) return arg;
	return `"${arg.replace(/"/g, '""')}"`;
}

function collector() {
	const chunks: string[] = [];
	let size = 0;
	return {
		push(b: Buffer) {
			chunks.push(b.toString('utf8'));
			size += b.length;
			// Guarda só o fim de saídas enormes.
			while (size > MAX_CAPTURE && chunks.length > 1) size -= Buffer.byteLength(chunks.shift() as string);
		},
		text: () => chunks.join(''),
	};
}

function run(command: string, args: string[], opts: ProcOptions, extra: { shell?: boolean; verbatim?: boolean }): Promise<ProcResult> {
	const started = Date.now();
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			cwd: opts.cwd,
			env: opts.env ?? process.env,
			windowsHide: true,
			shell: extra.shell,
			windowsVerbatimArguments: extra.verbatim,
			detached: process.platform !== 'win32',
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		const out = collector();
		const err = collector();
		child.stdout?.on('data', out.push);
		child.stderr?.on('data', err.push);
		child.stdin?.on('error', () => {});
		child.stdin?.end(opts.input ?? '');
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			killTree(child.pid);
		}, opts.timeoutMs);
		let settled = false;
		const finish = (exitCode: number | null, spawnError?: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ exitCode: timedOut ? null : exitCode, timedOut, stdout: out.text(), stderr: err.text(), durationMs: Date.now() - started, spawnError });
		};
		child.on('error', (e) => finish(null, e.message));
		child.on('close', (code) => finish(code));
	});
}

/** Executa um binário com argumentos em lista. `.cmd`/`.bat` passam pelo cmd.exe com aspas controladas. */
export function runFile(file: string, args: string[], opts: ProcOptions): Promise<ProcResult> {
	if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
		const line = [file, ...args].map(quoteForCmd).join(' ');
		return run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], opts, { verbatim: true });
	}
	return run(file, args, opts, {});
}

/** Comando do projeto: string vai pelo shell do sistema (como `npm test` precisa), lista roda direto. */
export function runProjectCommand(cmd: string | string[], opts: ProcOptions): Promise<ProcResult> {
	if (Array.isArray(cmd)) {
		const [file, ...args] = cmd;
		return runFile(resolveOnPath(file) ?? file, args, opts);
	}
	return run(cmd, [], opts, { shell: true });
}

/** Procura no PATH respeitando o PATHEXT do Windows. Caminho com barra é usado como veio. */
export function resolveOnPath(name: string, envPath = process.env.PATH ?? ''): string | undefined {
	if (name.includes('/') || name.includes('\\')) return fs.existsSync(name) ? name : undefined;
	// Só o que o spawn sabe executar: um `.js` ou `.ps1` no PATHEXT abriria outro interpretador.
	const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', '.com'] : [''];
	for (const dir of envPath.split(path.delimiter).filter(Boolean)) {
		for (const ext of process.platform === 'win32' && path.extname(name) ? [''] : exts) {
			const candidate = path.join(dir, name + ext.toLowerCase());
			try {
				if (fs.statSync(candidate).isFile()) return candidate;
			} catch {}
		}
	}
	return undefined;
}
