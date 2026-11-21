import * as path from 'node:path';
import { createFileExclusive, readHead, scanMarkdownTree, validKebabName, type EntryState } from './catalog';
import { frontmatterFields, yamlQuoted } from './frontmatter';

/** Subagentes do Claude Code: um `.md` por agente em `.claude/agents/`, com subpastas. */
export type AgentScope = 'project' | 'global';

export interface AgentInfo {
	id: string;
	/** `name` do frontmatter: é por ele que o Claude Code identifica o agente. */
	name: string;
	description: string;
	scope: AgentScope;
	state: EntryState;
	file: string;
	actual: string;
	/** Arquivo relativo à pasta de agentes. */
	rel: string;
	model: string;
	/** Um agente ativo do projeto com o mesmo nome tem prioridade sobre este. */
	shadowed: boolean;
}

export const AGENTS_DIR = 'agents';

export async function scanAgents(root: string, scope: AgentScope): Promise<AgentInfo[]> {
	const out: AgentInfo[] = [];
	for (const entry of await scanMarkdownTree(root)) {
		const fields = entry.state === 'broken' ? {} : frontmatterFields(await readHead(entry.actual));
		out.push({
			id: `${scope}:${entry.rel}`, name: fields.name || path.posix.basename(entry.rel, '.md'), description: fields.description ?? '',
			scope, state: entry.state, file: entry.file, actual: entry.actual, rel: entry.rel, model: fields.model ?? '', shadowed: false,
		});
	}
	return out;
}

/** Marca os agentes globais encobertos por um agente ativo do projeto com o mesmo nome. */
export function markShadowedAgents(agents: AgentInfo[]): AgentInfo[] {
	const project = new Set(agents.filter((a) => a.scope === 'project' && a.state === 'active').map((a) => a.name));
	return agents.map((a) => ({ ...a, shadowed: a.scope === 'global' && a.state === 'active' && project.has(a.name) }));
}

export async function createAgent(root: string, name: string, description: string): Promise<string> {
	if (!validKebabName(name)) { throw new Error('Use letras minúsculas, números e hífens (ex.: revisor-de-codigo).'); }
	const file = path.join(root, `${name}.md`);
	await createFileExclusive(file, `---\nname: ${name}\ndescription: ${yamlQuoted(description)}\n---\n\n`
		+ 'Descreva aqui o papel do agente, como ele deve trabalhar e o formato da resposta.\n');
	return file;
}
