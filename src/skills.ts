import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** Leitura e alteração das skills do Claude em disco. Sem dependência do VS Code, para ser testável. */
export type SkillState = 'active' | 'disabled' | 'broken';
export type SkillScope = 'global' | 'project' | 'claudeai';

export interface SkillInfo {
	id: string;
	name: string;
	description: string;
	dir: string;
	scope: SkillScope;
	state: SkillState;
}

export const SKILL_FILE = 'SKILL.md';
export const DISABLED_FILE = 'SKILL.md.disabled';

export function parseFrontmatter(text: string): { name?: string; description?: string } {
	const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	if (!match) { return {}; }
	const out: Record<string, string> = {};
	let key: string | undefined;
	for (const line of match[1].split(/\r?\n/)) {
		const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
		if (kv) { key = kv[1]; out[key] = kv[2].replace(/^(>|\|)[-+]?$/, '').trim(); }
		else if (key && /^\s+\S/.test(line)) { out[key] = `${out[key]} ${line.trim()}`.trim(); }
	}
	const clean = (v?: string) => v?.replace(/^(["'])(.*)\1$/, (_m, q: string, s: string) => q === '"' ? s.replace(/\\(["\\])/g, '$1') : s);
	return { name: clean(out.name), description: clean(out.description) };
}

async function exists(file: string): Promise<boolean> {
	try { return (await fs.stat(file)).isFile(); } catch { return false; }
}

/** `synced` guarda as skills sincronizadas da conta claude.ai; ficam fora da lista global. */
export const SYNCED_DIR = 'synced';

/** Skills sincronizadas do claude.ai: `<root>/synced/<id da conta>/<skill>`. Somente leitura. */
export async function scanSynced(globalRoot: string): Promise<SkillInfo[]> {
	const base = path.join(globalRoot, SYNCED_DIR);
	const out: SkillInfo[] = [];
	for (const account of await fs.readdir(base).catch(() => [] as string[])) {
		if (account.startsWith('.')) { continue; }
		out.push(...await scanSkills(path.join(base, account), 'claudeai'));
	}
	return out;
}

export async function scanSkills(root: string, scope: SkillScope): Promise<SkillInfo[]> {
	let entries: string[];
	try { entries = await fs.readdir(root); } catch { return []; }
	const skills: SkillInfo[] = [];
	for (const entry of entries.filter((e) => !e.startsWith('.') && !(scope === 'global' && e === SYNCED_DIR)).sort((a, b) => a.localeCompare(b))) {
		const dir = path.join(root, entry);
		let isDir = false;
		try { isDir = (await fs.stat(dir)).isDirectory(); } catch { isDir = false; }
		const broken = !isDir && (await fs.lstat(dir).catch(() => undefined))?.isSymbolicLink() === true;
		if (!isDir && !broken) { continue; }
		let state: SkillState = 'broken';
		let file = path.join(dir, SKILL_FILE);
		if (isDir) {
			if (await exists(file)) { state = 'active'; }
			else if (await exists(path.join(dir, DISABLED_FILE))) { state = 'disabled'; file = path.join(dir, DISABLED_FILE); }
		}
		let meta: { name?: string; description?: string } = {};
		if (state !== 'broken') { meta = parseFrontmatter(await fs.readFile(file, 'utf8').catch(() => '')); }
		skills.push({ id: `${scope}:${entry}`, name: meta.name || entry, description: meta.description ?? '', dir, scope, state });
	}
	return skills;
}

export async function setSkillEnabled(skill: SkillInfo, enabled: boolean): Promise<void> {
	if (skill.state === 'broken') { throw new Error('Skill sem SKILL.md.'); }
	const from = path.join(skill.dir, enabled ? DISABLED_FILE : SKILL_FILE);
	const to = path.join(skill.dir, enabled ? SKILL_FILE : DISABLED_FILE);
	if (await exists(to)) { throw new Error(`Já existe ${path.basename(to)} nesta pasta.`); }
	await fs.rename(from, to);
}

export const validSkillName = (name: string): boolean => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) && name.length <= 64;

export async function createSkill(root: string, name: string, description: string): Promise<string> {
	if (!validSkillName(name)) { throw new Error('Use letras minúsculas, números e hífens (ex.: minha-skill).'); }
	const dir = path.join(root, name);
	await fs.mkdir(root, { recursive: true });
	await fs.mkdir(dir); // falha se já existir: nunca sobrescreve
	const file = path.join(dir, SKILL_FILE);
	const safe = description.replace(/\r?\n/g, ' ').replace(/"/g, '\\"');
	await fs.writeFile(file, `---\nname: ${name}\ndescription: "${safe}"\n---\n\n# ${name}\n\nDescreva aqui as instruções da skill.\n`, { flag: 'wx' });
	return file;
}
