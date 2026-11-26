// Cota só quando a saída casa com uma mensagem guardada como fixture de uma execução real.
// A lista começa pequena de propósito: cota mal classificada gastaria o outro modelo num bug.
import * as fs from 'node:fs';
import * as path from 'node:path';

/** `orchestrator/fixtures`, igual a partir de `src/providers` e de `out/src/providers`. */
export const FIXTURES_DIR = (() => {
	let dir = __dirname;
	for (let i = 0; i < 5; i++) {
		const candidate = path.join(dir, 'fixtures');
		if (fs.existsSync(path.join(candidate, 'quota'))) return candidate;
		dir = path.dirname(dir);
	}
	return path.resolve(__dirname, '..', '..', 'fixtures');
})();

export function quotaFixture(name: string): string {
	return fs.readFileSync(path.join(FIXTURES_DIR, 'quota', name), 'utf8');
}

/** Todas as fixtures `fixtures/quota/<provider>/*.txt`. Pasta vazia ou ausente: nada é cota. */
export function loadQuotaFixtures(provider: string): string[] {
	const dir = path.join(FIXTURES_DIR, 'quota', provider);
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir)
		.filter((n) => n.endsWith('.txt'))
		.map((n) => fs.readFileSync(path.join(dir, n), 'utf8').trim())
		.filter(Boolean);
}

function normalize(text: string): string {
	return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Casa a fixture inteira (sem diferença de espaço e caixa), nunca uma palavra solta como "limit". */
export function matchesQuotaFixtures(text: string, fixtures: readonly string[]): boolean {
	const haystack = normalize(text);
	return fixtures.some((f) => {
		const needle = normalize(f);
		return needle.length > 0 && haystack.includes(needle);
	});
}
