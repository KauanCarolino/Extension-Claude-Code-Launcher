import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { t } from './i18n';

/** Peças de disco comuns às abas de regras, agentes e MCP. Sem dependência do VS Code, para ser testável. */
export type EntryState = 'active' | 'disabled' | 'broken';

/** Mesma convenção das skills: sem a extensão `.md`, o Claude Code deixa de carregar o arquivo. */
export const DISABLED_SUFFIX = '.disabled';
const MAX_DEPTH = 8;
const MAX_FILES = 500;
const HEAD_BYTES = 64 * 1024;

/** Pasta de configuração do Claude: `$CLAUDE_CONFIG_DIR` quando definido, senão `~/.claude`. */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
	return env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
}

/** Pasta das políticas da organização (CLAUDE.md e managed-mcp.json gerenciados). */
export function managedDir(platform: NodeJS.Platform = process.platform): string {
	if (platform === 'darwin') { return '/Library/Application Support/ClaudeCode'; }
	if (platform === 'win32') { return 'C:\\Program Files\\ClaudeCode'; }
	return '/etc/claude-code';
}

export async function isFile(file: string): Promise<boolean> {
	try { return (await fs.stat(file)).isFile(); } catch { return false; }
}

export async function isBrokenLink(file: string): Promise<boolean> {
	try { await fs.stat(file); return false; } catch { return (await fs.lstat(file).catch(() => undefined))?.isSymbolicLink() === true; }
}

/** Começo do arquivo, o bastante para o frontmatter e a primeira linha. */
export async function readHead(file: string, bytes = HEAD_BYTES): Promise<string> {
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(file, 'r');
		const buffer = Buffer.alloc(bytes);
		const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
		return buffer.subarray(0, bytesRead).toString('utf8');
	} catch { return ''; } finally { await handle?.close().catch(() => undefined); }
}

/** Primeira linha com texto, sem marcas de título, lista ou citação. */
export function firstLine(body: string, max = 160): string {
	const line = body.split(/\r?\n/).map((l) => l.replace(/^\s*(?:#+|[-*>]|\d+\.)\s*/, '').trim()).find(Boolean) ?? '';
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export interface MarkdownEntry {
	/** Caminho do arquivo ativo (`x.md`), exista ele ou só a versão desativada. */
	file: string;
	/** Caminho real no disco: `x.md` ou `x.md.disabled`. */
	actual: string;
	/** Relativo à raiz, com `/`, sempre terminando em `.md`. */
	rel: string;
	state: EntryState;
}

/**
 * Arquivos `.md` (e `.md.disabled`) de uma pasta, com subpastas, como o Claude Code lê regras e agentes.
 * Ignora ocultos, segue links para pastas sem entrar em ciclos e para em limites fixos de profundidade e quantidade.
 */
export async function scanMarkdownTree(root: string): Promise<MarkdownEntry[]> {
	const out: MarkdownEntry[] = [];
	const seen = new Set<string>();
	async function visit(dir: string, depth: number): Promise<void> {
		const real = await fs.realpath(dir).catch(() => undefined);
		if (!real || seen.has(real) || depth > MAX_DEPTH) { return; }
		seen.add(real);
		const names = await fs.readdir(dir).catch(() => [] as string[]);
		const set = new Set(names);
		for (const name of names.filter((n) => !n.startsWith('.')).sort((a, b) => a.localeCompare(b))) {
			if (out.length >= MAX_FILES) { return; }
			const full = path.join(dir, name);
			const stat = await fs.stat(full).catch(() => undefined);
			if (stat?.isDirectory()) { await visit(full, depth + 1); continue; }
			const disabled = name.endsWith(`.md${DISABLED_SUFFIX}`);
			if (!name.endsWith('.md') && !disabled) { continue; }
			const activeName = disabled ? name.slice(0, -DISABLED_SUFFIX.length) : name;
			// Com as duas versões presentes, vale a ativa (é a que o Claude Code lê).
			if (disabled && set.has(activeName)) { continue; }
			const file = path.join(dir, activeName);
			const state: EntryState = !stat ? 'broken' : disabled ? 'disabled' : 'active';
			if (!stat && !(await isBrokenLink(full))) { continue; }
			if (stat && !stat.isFile()) { continue; }
			out.push({ file, actual: full, rel: path.relative(root, file).split(path.sep).join('/'), state });
		}
	}
	await visit(root, 0);
	return out;
}

/** Um arquivo avulso (como `CLAUDE.md`), ativo, desativado ou ausente. */
export async function markdownFile(file: string): Promise<{ actual: string; state: EntryState } | undefined> {
	if (await isFile(file)) { return { actual: file, state: 'active' }; }
	if (await isBrokenLink(file)) { return { actual: file, state: 'broken' }; }
	const disabled = file + DISABLED_SUFFIX;
	if (await isFile(disabled)) { return { actual: disabled, state: 'disabled' }; }
	return undefined;
}

/** Ativa ou desativa renomeando `x.md` para `x.md.disabled` e vice-versa. Nunca sobrescreve. */
export async function setFileEnabled(file: string, enabled: boolean, what = t('O arquivo')): Promise<void> {
	const from = enabled ? file + DISABLED_SUFFIX : file;
	const to = enabled ? file : file + DISABLED_SUFFIX;
	if (!(await isFile(from))) { throw new Error(enabled ? t('{0} já está ativo ou foi alterado fora do launcher.', what) : t('{0} já está desativado ou foi alterado fora do launcher.', what)); }
	if (await isFile(to) || await isBrokenLink(to)) { throw new Error(t('Já existe {0} nesta pasta.', path.basename(to))); }
	await fs.rename(from, to);
}

/** Cria `file` sem sobrescrever nada, nem a versão desativada. */
export async function createFileExclusive(file: string, text: string): Promise<void> {
	if (await isFile(file + DISABLED_SUFFIX)) { throw new Error(t('Já existe {0} (desativado).', path.basename(file) + DISABLED_SUFFIX)); }
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, text, { flag: 'wx' });
}

export const validKebabName = (name: string): boolean => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) && name.length <= 64;

export type TextRead = { kind: 'content'; text: string } | { kind: 'absent' };

export async function readText(file: string, maxBytes: number): Promise<TextRead> {
	let size: number;
	try { size = (await fs.stat(file)).size; } catch (error) {
		if ((error as { code?: string }).code === 'ENOENT') { return { kind: 'absent' }; }
		throw error;
	}
	if (size > maxBytes) { throw new Error(t('{0} passa de {1} MB.', path.basename(file), Math.round(maxBytes / 1024 / 1024))); }
	return { kind: 'content', text: await fs.readFile(file, 'utf8') };
}

/**
 * Grava só se o arquivo ainda tiver o conteúdo lido antes (`expected`, ou ausente).
 * Escreve num temporário ao lado e troca por rename: quem lê nunca vê um JSON pela metade.
 */
export async function writeTextIfUnchanged(file: string, expected: string | undefined, next: string, maxBytes = 2 * 1024 * 1024): Promise<void> {
	const same = async () => {
		const now = await readText(file, maxBytes);
		return (now.kind === 'content' ? now.text : undefined) === expected;
	};
	if (!(await same())) { throw new Error(t('{0} mudou enquanto era editado. Tente de novo.', path.basename(file))); }
	await fs.mkdir(path.dirname(file), { recursive: true });
	const temp = `${file}.${randomUUID()}.tmp`;
	try {
		await fs.writeFile(temp, next, { flag: 'wx' });
		if (!(await same())) { throw new Error(t('{0} mudou enquanto era editado. Tente de novo.', path.basename(file))); }
		await fs.rename(temp, file);
	} finally {
		await fs.unlink(temp).catch(() => undefined);
	}
}
