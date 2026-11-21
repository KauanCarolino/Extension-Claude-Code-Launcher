import * as path from 'node:path';
import { createFileExclusive, firstLine, markdownFile, readHead, scanMarkdownTree, validKebabName, type EntryState } from './catalog';
import { frontmatterBody, frontmatterFields, frontmatterList, splitOutsideBraces, yamlQuoted } from './frontmatter';

/**
 * Instruções que o Claude Code carrega em toda conversa: os arquivos de memória (`CLAUDE.md`)
 * e as regras em `.claude/rules/`, que podem valer só para alguns caminhos (`paths` no frontmatter).
 */
export type RuleScope = 'project' | 'global' | 'managed';
export type RuleKind = 'memory' | 'rule';

export interface RuleInfo {
	id: string;
	name: string;
	description: string;
	scope: RuleScope;
	kind: RuleKind;
	state: EntryState;
	/** Caminho ativo (`x.md`), usado para ativar e desativar. */
	file: string;
	/** Caminho real no disco. */
	actual: string;
	/** Globs de `paths`: vazio quando a regra vale sempre. */
	paths: string[];
}

/** Arquivos de memória do projeto, relativos à pasta, na ordem em que o Claude Code os lê. */
export const PROJECT_MEMORY = ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md'];
export const MEMORY_FILE = 'CLAUDE.md';
export const RULES_DIR = 'rules';

async function describe(actual: string, state: EntryState): Promise<{ description: string; paths: string[] }> {
	if (state === 'broken') { return { description: '', paths: [] }; }
	const text = await readHead(actual);
	return { description: frontmatterFields(text).description || firstLine(frontmatterBody(text)), paths: frontmatterList(text, 'paths') };
}

/** Arquivos de memória existentes (ativos ou desativados) entre `names`, relativos a `base`. */
export async function scanMemory(base: string, names: readonly string[], scope: RuleScope): Promise<RuleInfo[]> {
	const out: RuleInfo[] = [];
	for (const name of names) {
		const file = path.join(base, ...name.split('/'));
		const found = await markdownFile(file);
		if (!found) { continue; }
		const { description } = await describe(found.actual, found.state);
		out.push({ id: `${scope}:memory:${name}`, name, description, scope, kind: 'memory', state: found.state, file, actual: found.actual, paths: [] });
	}
	return out;
}

export async function scanRules(root: string, scope: RuleScope): Promise<RuleInfo[]> {
	const out: RuleInfo[] = [];
	for (const entry of await scanMarkdownTree(root)) {
		const { description, paths } = await describe(entry.actual, entry.state);
		out.push({ id: `${scope}:rule:${entry.rel}`, name: entry.rel, description, scope, kind: 'rule', state: entry.state, file: entry.file, actual: entry.actual, paths });
	}
	return out;
}

/** Globs digitados pelo usuário, separados por vírgula (respeitando `{a,b}`). */
export function parsePathsInput(input: string): string[] {
	return splitOutsideBraces(input.replace(/[\u0000-\u001f\u007f]+/g, ' ')).slice(0, 50);
}

export async function createRule(root: string, name: string, paths: readonly string[]): Promise<string> {
	if (!validKebabName(name)) { throw new Error('Use letras minúsculas, números e hífens (ex.: minha-regra).'); }
	const file = path.join(root, `${name}.md`);
	const head = paths.length ? `---\npaths:\n${paths.map((p) => `  - ${yamlQuoted(p)}`).join('\n')}\n---\n\n` : '';
	await createFileExclusive(file, `${head}# ${name}\n\n- Descreva aqui a regra.\n`);
	return file;
}
