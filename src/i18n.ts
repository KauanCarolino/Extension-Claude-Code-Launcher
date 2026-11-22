/**
 * Tradução da interface. O texto em português fica no próprio código e é a chave; `l10n/en.json`
 * dá o inglês. Português vale quando o editor está em português (ou a opção
 * `claudeCodeLauncher.language` pede); qualquer outro idioma usa inglês.
 *
 * Toda chamada de `t` acontece na hora de mostrar o texto, nunca no carregamento do módulo:
 * o idioma só é conhecido depois de `configureLanguage`, chamado na ativação. Tabelas de textos
 * marcam cada frase com `m` (que não traduz) e passam o valor por `t` quando o usam.
 * Sem dependência do VS Code, para os módulos puros e os testes usarem igual.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export type Language = 'pt-br' | 'en';
type Dictionary = Record<string, string>;

let language: Language = 'pt-br';
let dictionary: Dictionary | undefined;

/** Idioma efetivo: a preferência explícita, ou o do editor quando ela é "auto". */
export function resolveLanguage(editorLanguage: string | undefined, preference: string | undefined): Language {
	if (preference === 'en' || preference === 'pt-br') { return preference; }
	// Sem idioma do editor conhecido, fica o português de sempre.
	if (typeof editorLanguage !== 'string' || !editorLanguage) { return 'pt-br'; }
	return /^pt(?:$|[-_])/i.test(editorLanguage) ? 'pt-br' : 'en';
}

function loadDictionary(root: string): Dictionary | undefined {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(path.join(root, 'l10n', 'en.json'), 'utf8'));
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { return undefined; }
		return Object.fromEntries(Object.entries(parsed).filter((pair): pair is [string, string] => typeof pair[1] === 'string'));
	} catch { return undefined; }
}

/** `root` é a pasta da extensão (onde fica `l10n/`). Sem dicionário legível, a interface fica em português. */
export function configureLanguage(next: Language, root = path.join(__dirname, '..')): void {
	language = next;
	dictionary = next === 'en' ? loadDictionary(root) : undefined;
}

export function currentLanguage(): Language { return dictionary ? 'en' : 'pt-br'; }

/** Valor de `lang` das páginas e locale das datas. */
export function htmlLanguage(): string { return currentLanguage() === 'en' ? 'en' : 'pt-BR'; }

/** Marca um texto para tradução sem traduzir agora (tabelas montadas no carregamento do módulo). */
export function m(message: string): string { return message; }

/** Texto no idioma da interface. `{0}`, `{1}`… são trocados por `args`, na ordem. */
export function t(message: string, ...args: Array<string | number>): string {
	const template = dictionary?.[message] ?? message;
	return args.length ? template.replace(/\{(\d+)\}/g, (match, index: string) => Number(index) < args.length ? String(args[Number(index)]) : match) : template;
}

/** `one` quando `count` é 1, senão `many`; os dois recebem `count` em `{0}`. */
export function plural(count: number, one: string, many: string): string {
	return t(count === 1 ? one : many, count);
}

/**
 * Bloco de dados com o dicionário, para as páginas das views. É JSON dentro de `<script type="application/json">`:
 * o navegador não o executa, e `<` vira escape para o conteúdo não fechar a tag.
 */
export function webviewDictionaryScript(): string {
	const json = JSON.stringify(dictionary ?? {}).replace(/</g, '\\u003c');
	return `<script type="application/json" id="launcher-l10n">${json}</script>`;
}

/** Ainda o idioma pedido, mesmo quando o dicionário não pôde ser lido. */
export function requestedLanguage(): Language { return language; }
