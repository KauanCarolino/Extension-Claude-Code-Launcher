/**
 * Comandos de terminal (Bash e PowerShell) que o Claude pediu numa conversa, lidos do transcript.
 * A captura só observa Edit, Write, MultiEdit e NotebookEdit: o que um comando grava fica fora da
 * revisão. Isto não captura nada; só permite avisar que pode haver mudanças que o painel não mostra.
 * O texto dos comandos nunca sai deste módulo: só a contagem e o nome dos programas.
 */
import * as fs from 'node:fs';
import { Buffer as Bytes } from 'node:buffer';

export const SHELL_TOOLS: readonly string[] = ['Bash', 'PowerShell'];

export interface ShellActivity {
	/** Chamadas de terminal encontradas. */
	commands: number;
	/** Delas, as que podem ter alterado arquivos: tudo o que não é leitura reconhecida. */
	mayWrite: number;
	/** Programas das chamadas mais recentes que podem ter alterado arquivos, sem argumentos. */
	programs: string[];
	/** Parte do transcript não foi lida (arquivo grande ou linha gigante): pode haver mais. */
	partial: boolean;
}

/** Programas que só leem. Na dúvida, um programa fica fora: o aviso a mais é o erro seguro. */
const READ_ONLY_PROGRAMS = new Set([
	'ls', 'll', 'dir', 'cat', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'wc', 'pwd', 'echo', 'printf',
	'which', 'where', 'whereis', 'type', 'file', 'stat', 'du', 'df', 'tree', 'date', 'env', 'printenv', 'whoami', 'id', 'uname',
	'hostname', 'true', 'false', 'test', '[', 'diff', 'cmp', 'uniq', 'cut', 'tr', 'column', 'jq', 'basename', 'dirname', 'realpath',
	'readlink', 'nl', 'od', 'hexdump', 'xxd', 'md5sum', 'sha1sum', 'sha256sum', 'shasum', 'ps', 'uptime', 'free', 'cd', 'sleep',
	// PowerShell
	'get-childitem', 'gci', 'get-content', 'gc', 'select-string', 'sls', 'get-location', 'gl', 'get-item', 'gi', 'test-path',
	'resolve-path', 'measure-object', 'get-process', 'write-output', 'write-host', 'get-command', 'get-date', 'set-location',
	'select-object', 'where-object', 'sort-object', 'format-table', 'format-list', 'out-string', 'out-null',
]);
/** Subcomandos do git que não tocam nos arquivos do projeto. */
const READ_ONLY_GIT = new Set(['status', 'log', 'diff', 'show', 'branch', 'rev-parse', 'ls-files', 'remote', 'describe', 'blame', 'shortlog', 'grep', 'reflog']);

/** Divide a linha de comando nos programas encadeados, respeitando aspas, e aponta redirecionamentos para arquivo. */
function scan(command: string): { segments: string[]; redirect: boolean; substitution: boolean } {
	const segments: string[] = [];
	let current = '', quote: '"' | "'" | undefined, redirect = false, substitution = false;
	const push = () => { if (current.trim()) { segments.push(current.trim()); } current = ''; };
	for (let i = 0; i < command.length; i += 1) {
		const ch = command[i], next = command[i + 1];
		if (quote) {
			if (ch === quote) { quote = undefined; }
			else if (quote === '"' && (ch === '`' || ch === '$' && next === '(')) { substitution = true; }
			current += ch; continue;
		}
		if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
		if (ch === '`' || ch === '$' && next === '(') { substitution = true; }
		if (ch === '>' || ch === '&' && next === '>') {
			const rest = command.slice(ch === '&' ? i + 2 : i + 1);
			// `2>&1` e afins só duplicam a saída; `> /dev/null` descarta. Nenhum grava arquivo.
			const duplicate = ch === '>' && /^>?\s*&(\d|-)/.exec(rest);
			if (duplicate) { i += duplicate[0].length; continue; }
			if (!/^>?\s*(\/dev\/null|\$null|nul)(?![\w./\\-])/i.test(rest)) { redirect = true; }
			current += ch; continue;
		}
		if (ch === ';' || ch === '\n' || ch === '|' || ch === '&') { push(); continue; }
		current += ch;
	}
	push();
	return { segments, redirect, substitution };
}

/** Nome do programa de um trecho, sem caminho, extensão nem variáveis de ambiente na frente. */
function programOf(segment: string): { program: string; words: string[] } {
	const words = segment.split(/\s+/).filter(Boolean);
	while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) { words.shift(); }
	const program = (words[0] ?? '').replace(/^["']|["']$/g, '').replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase();
	return { program, words };
}

function readOnlySegment(segment: string): boolean {
	const { program, words } = programOf(segment);
	if (!program) { return true; }
	if (program === 'git') {
		const sub = words.slice(1).find((word) => !word.startsWith('-'));
		return sub !== undefined && READ_ONLY_GIT.has(sub);
	}
	if (program === 'sed') { return !words.some((word) => /^-[a-zA-Z]*i/.test(word) || word.startsWith('--in-place')); }
	if (program === 'find') { return !words.some((word) => ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprintf', '-fls'].includes(word)); }
	if (program === 'sort') { return !words.some((word) => word === '-o' || word.startsWith('--output')); }
	return READ_ONLY_PROGRAMS.has(program);
}

/**
 * Se o comando pode ter alterado arquivos. Conservador: redirecionamento, substituição de comando
 * e qualquer programa fora da lista de leitura contam como possível escrita.
 */
export function mayWriteFiles(command: string): boolean {
	if (typeof command !== 'string' || !command.trim()) { return false; }
	const { segments, redirect, substitution } = scan(command);
	return redirect || substitution || segments.some((segment) => !readOnlySegment(segment));
}

/** Primeiro programa do comando que não é só leitura, para citar no aviso. */
export function writingProgram(command: string): string {
	const { segments } = scan(command);
	const segment = segments.find((item) => !readOnlySegment(item)) ?? segments[0] ?? '';
	return programOf(segment).program.slice(0, 40);
}

export function emptyShellActivity(): ShellActivity { return { commands: 0, mayWrite: 0, programs: [], partial: false }; }

/** Soma as chamadas de terminal das linhas JSONL de um transcript em `activity`. */
export function addShellActivity(activity: ShellActivity, lines: Iterable<string>): void {
	for (const line of lines) {
		// Filtro barato antes do JSON.parse: a maioria das linhas não tem comando de terminal.
		if (!line.startsWith('{') || !line.includes('"tool_use"') || !SHELL_TOOLS.some((name) => line.includes(`"${name}"`))) { continue; }
		let entry: any;
		try { entry = JSON.parse(line); } catch { continue; }
		const content = entry?.type === 'assistant' ? entry.message?.content : undefined;
		if (!Array.isArray(content)) { continue; }
		for (const block of content) {
			if (!block || block.type !== 'tool_use' || !SHELL_TOOLS.includes(block.name)) { continue; }
			const command = typeof block.input?.command === 'string' ? block.input.command : '';
			activity.commands += 1;
			if (!mayWriteFiles(command)) { continue; }
			activity.mayWrite += 1;
			const program = writingProgram(command);
			if (program) { activity.programs = [program, ...activity.programs.filter((item) => item !== program)].slice(0, 3); }
		}
	}
}

/** O fim do transcript que é lido na primeira vez; o resto entra por acréscimo. */
const SCAN_BYTES = 8 * 1024 * 1024;
/** Uma linha maior que isso (imagem embutida, saída enorme) é descartada. */
const MAX_LINE_BYTES = 16 * 1024 * 1024;
const MAX_CACHE = 50;
const cache = new Map<string, { size: number; mtime: number; offset: number; remainder: Bytes; activity: ShellActivity }>();

/**
 * Atividade de terminal do transcript `file`. O transcript só cresce, então cada leitura continua
 * de onde a anterior parou. Devolve undefined quando o arquivo não existe ou não pode ser lido.
 */
export async function readShellActivity(file: string): Promise<ShellActivity | undefined> {
	let stat: fs.Stats;
	try { stat = await fs.promises.stat(file); } catch { return undefined; }
	if (!stat.isFile()) { return undefined; }
	let entry = cache.get(file);
	if (entry && entry.size === stat.size && entry.mtime === stat.mtimeMs) { return { ...entry.activity, programs: [...entry.activity.programs] }; }
	let skipFirst = false;
	if (!entry || stat.size < entry.offset) {
		const start = Math.max(0, stat.size - SCAN_BYTES);
		entry = { size: 0, mtime: 0, offset: start, remainder: Bytes.alloc(0), activity: { ...emptyShellActivity(), partial: start > 0 } };
		skipFirst = start > 0;
	}
	const activity: ShellActivity = { ...entry.activity, programs: [...entry.activity.programs] };
	let offset = entry.offset, remainder = entry.remainder;
	if (stat.size - offset > SCAN_BYTES) { offset = stat.size - SCAN_BYTES; remainder = Bytes.alloc(0); skipFirst = true; activity.partial = true; }
	let chunk: Bytes;
	let handle: fs.promises.FileHandle | undefined;
	try {
		handle = await fs.promises.open(file, 'r');
		chunk = Bytes.alloc(stat.size - offset);
		const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
		chunk = chunk.subarray(0, bytesRead);
	} catch { return undefined; } finally { await handle?.close().catch(() => undefined); }
	const bytes = remainder.length ? Bytes.concat([remainder, chunk]) : chunk;
	// "\n" nunca aparece no meio de um caractere UTF-8: cortar nele não quebra texto.
	const end = bytes.lastIndexOf(0x0a);
	const complete = end >= 0 ? bytes.subarray(0, end).toString('utf8').split('\n') : [];
	remainder = end >= 0 ? bytes.subarray(end + 1) : bytes;
	if (remainder.length > MAX_LINE_BYTES) { remainder = Bytes.alloc(0); activity.partial = true; }
	if (skipFirst) { complete.shift(); }
	addShellActivity(activity, complete);
	cache.delete(file);
	cache.set(file, { size: stat.size, mtime: stat.mtimeMs, offset: offset + chunk.length, remainder: Bytes.from(remainder), activity });
	while (cache.size > MAX_CACHE) { cache.delete(cache.keys().next().value as string); }
	return { ...activity, programs: [...activity.programs] };
}
