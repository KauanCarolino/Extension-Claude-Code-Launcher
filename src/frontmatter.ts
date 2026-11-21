/** Leitura do frontmatter YAML dos arquivos do Claude (skills, regras e agentes). Só o subconjunto que eles usam. */

const BLOCK = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/;

function unquote(value: string): string {
	return value.replace(/^(["'])(.*)\1$/, (_m, q: string, s: string) => q === '"' ? s.replace(/\\(["\\])/g, '$1') : s);
}

/** Chaves de primeiro nível como texto. Linhas indentadas continuam o valor anterior (escalares dobrados). */
export function frontmatterFields(text: string): Record<string, string> {
	const match = BLOCK.exec(text);
	if (!match) { return {}; }
	const out: Record<string, string> = {};
	let key: string | undefined;
	for (const line of match[1].split(/\r?\n/)) {
		const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
		if (kv) { key = kv[1]; out[key] = kv[2].replace(/^(>|\|)[-+]?$/, '').trim(); }
		else if (key && /^\s+\S/.test(line)) { out[key] = `${out[key]} ${line.trim()}`.trim(); }
	}
	for (const k of Object.keys(out)) { out[k] = unquote(out[k]); }
	return out;
}

export function parseFrontmatter(text: string): { name?: string; description?: string } {
	if (!BLOCK.test(text)) { return {}; }
	const fields = frontmatterFields(text);
	return { name: fields.name, description: fields.description };
}

/** Divide por vírgulas fora de chaves, para `{a,b}` continuar sendo um glob só. */
export function splitOutsideBraces(text: string): string[] {
	const parts: string[] = [];
	let depth = 0, current = '';
	for (const ch of text) {
		if (ch === '{') { depth += 1; } else if (ch === '}') { depth = Math.max(0, depth - 1); }
		if (ch === ',' && depth === 0) { parts.push(current); current = ''; } else { current += ch; }
	}
	parts.push(current);
	return parts.map((p) => unquote(p.trim())).filter(Boolean);
}

/**
 * Lista de primeiro nível, nos três formatos que o Claude Code aceita em `paths`:
 * itens `- x` nas linhas seguintes, `[a, b]` ou texto separado por vírgulas.
 */
export function frontmatterList(text: string, key: string): string[] {
	const match = BLOCK.exec(text);
	if (!match) { return []; }
	const lines = match[1].split(/\r?\n/);
	const start = lines.findIndex((line) => line.startsWith(`${key}:`));
	if (start < 0) { return []; }
	const inline = lines[start].slice(key.length + 1).trim();
	if (inline) {
		const flow = /^\[(.*)\]$/.exec(inline);
		return splitOutsideBraces(flow ? flow[1] : inline);
	}
	const items: string[] = [];
	for (const line of lines.slice(start + 1)) {
		const item = /^\s*-\s+(.*)$/.exec(line);
		if (item) { items.push(unquote(item[1].trim())); continue; }
		if (/^\S/.test(line)) { break; }
	}
	return items.filter(Boolean);
}

/** Texto depois do frontmatter. */
export function frontmatterBody(text: string): string {
	const match = BLOCK.exec(text);
	return match ? text.slice(match[0].length).replace(/^[^\n]*\n?/, '') : text.replace(/^\uFEFF/, '');
}

/** Escalar YAML entre aspas duplas: barra invertida e aspas escapadas, quebras e controles viram espaço. */
export function yamlQuoted(value: string): string {
	return `"${value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
