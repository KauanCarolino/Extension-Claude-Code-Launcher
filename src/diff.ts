import { t } from './i18n';

export interface Segment {
	text: string;
	changed: boolean;
}

export interface DiffLine {
	kind: 'ctx' | 'add' | 'del';
	text: string;
	oldNo?: number;
	newNo?: number;
	/** Linha removida/adicionada que corresponde a uma modificação da mesma linha. */
	pair?: 'antes' | 'depois';
	segments?: Segment[];
}

export interface Hunk {
	label: string;
	lines: DiffLine[];
}

export interface DiffResult {
	added: number;
	removed: number;
	modified: number;
	hunks: Hunk[];
	/** O arquivo era grande demais para um diff linha a linha. */
	approximate: boolean;
	/** Parte das linhas foi omitida para não pesar o painel. */
	clipped: boolean;
}

type Op = '=' | '-' | '+';

const MAX_CELLS = 4_000_000; // acima disso, as linhas são comparadas em bloco
const MAX_LINES_SHOWN = 1500; // limite de linhas mostradas no painel
const MIN_PAIR_SIMILARITY = 0.4; // quão parecidas duas linhas precisam ser para virar "modificada"
const MAX_PAIR_CANDIDATES = 2500; // acima disso, o pareamento é feito por posição
const TOKEN = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;

export function computeDiff(before: string, after: string, context = 3): DiffResult {
	const { lines, approximate } = diffLines(before, after);
	const modified = lines.filter((line) => line.pair === 'depois').length;
	const dels = lines.filter((line) => line.kind === 'del').length;
	const adds = lines.filter((line) => line.kind === 'add').length;
	const { hunks, clipped } = buildHunks(lines, context);

	return {
		added: adds - modified,
		removed: dels - modified,
		modified,
		hunks,
		approximate,
		clipped,
	};
}

/** Todas as linhas do diff, inclusive as sem mudança, com as linhas modificadas já pareadas. */
export function diffLines(before: string, after: string): { lines: DiffLine[]; approximate: boolean } {
	const a = splitLines(before);
	const b = splitLines(after);
	const { ops, approximate } = diffOps(a, b);

	const lines: DiffLine[] = [];
	let i = 0;
	let j = 0;
	for (const op of ops) {
		if (op === '=') {
			lines.push({ kind: 'ctx', text: a[i], oldNo: i + 1, newNo: j + 1 });
			i += 1;
			j += 1;
		} else if (op === '-') {
			lines.push({ kind: 'del', text: a[i], oldNo: i + 1 });
			i += 1;
		} else {
			lines.push({ kind: 'add', text: b[j], newNo: j + 1 });
			j += 1;
		}
	}

	pairModifiedLines(lines);
	return { lines, approximate };
}

function splitLines(text: string): string[] {
	if (text === '') {
		return [];
	}
	const lines = text.replace(/\r\n/g, '\n').split('\n');
	if (lines[lines.length - 1] === '') {
		lines.pop();
	}
	return lines;
}

function diffOps<T>(a: readonly T[], b: readonly T[]): { ops: Op[]; approximate: boolean } {
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) {
		start += 1;
	}
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA -= 1;
		endB -= 1;
	}

	const ops: Op[] = new Array<Op>(start).fill('=');
	const n = endA - start;
	const m = endB - start;
	let approximate = false;

	if (n > 0 && m > 0 && n * m <= MAX_CELLS) {
		const width = m + 1;
		const dp = new Uint32Array((n + 1) * width);
		for (let x = n - 1; x >= 0; x -= 1) {
			for (let y = m - 1; y >= 0; y -= 1) {
				dp[x * width + y] = a[start + x] === b[start + y]
					? dp[(x + 1) * width + y + 1] + 1
					: Math.max(dp[(x + 1) * width + y], dp[x * width + y + 1]);
			}
		}
		let x = 0;
		let y = 0;
		while (x < n && y < m) {
			if (a[start + x] === b[start + y]) {
				ops.push('=');
				x += 1;
				y += 1;
			} else if (dp[(x + 1) * width + y] >= dp[x * width + y + 1]) {
				ops.push('-');
				x += 1;
			} else {
				ops.push('+');
				y += 1;
			}
		}
		for (; x < n; x += 1) {
			ops.push('-');
		}
		for (; y < m; y += 1) {
			ops.push('+');
		}
	} else {
		approximate = n > 0 && m > 0;
		for (let x = 0; x < n; x += 1) {
			ops.push('-');
		}
		for (let y = 0; y < m; y += 1) {
			ops.push('+');
		}
	}

	for (let k = endA; k < a.length; k += 1) {
		ops.push('=');
	}
	return { ops, approximate };
}

// Junta cada bloco "removidas seguidas de adicionadas" linha a linha e marca as
// palavras que mudaram, para mostrar "antes" e "depois" da mesma linha.
function pairModifiedLines(lines: DiffLine[]): number {
	let modified = 0;
	let k = 0;
	while (k < lines.length) {
		if (lines[k].kind !== 'del') {
			k += 1;
			continue;
		}
		let delEnd = k;
		while (delEnd < lines.length && lines[delEnd].kind === 'del') {
			delEnd += 1;
		}
		let addEnd = delEnd;
		while (addEnd < lines.length && lines[addEnd].kind === 'add') {
			addEnd += 1;
		}
		modified += pairBlock(lines.slice(k, delEnd), lines.slice(delEnd, addEnd));
		k = Math.max(addEnd, k + 1);
	}
	return modified;
}

// Pareia cada linha removida com a linha adicionada mais parecida que vem depois
// do último par, mantendo a ordem. Linhas idênticas não viram "modificadas": elas
// só mudaram de lugar. Blocos muito grandes caem no pareamento por posição.
function pairBlock(dels: DiffLine[], adds: DiffLine[]): number {
	let modified = 0;
	const link = (oldLine: DiffLine, newLine: DiffLine, words: ReturnType<typeof wordSegments>) => {
		oldLine.pair = 'antes';
		oldLine.segments = words.oldSegments;
		newLine.pair = 'depois';
		newLine.segments = words.newSegments;
		modified += 1;
	};

	if (dels.length * adds.length > MAX_PAIR_CANDIDATES) {
		const pairs = Math.min(dels.length, adds.length);
		for (let p = 0; p < pairs; p += 1) {
			const words = wordSegments(dels[p].text, adds[p].text);
			if (words.similarity >= MIN_PAIR_SIMILARITY && dels[p].text.trim() !== adds[p].text.trim()) {
				link(dels[p], adds[p], words);
			}
		}
		return modified;
	}

	let from = 0;
	for (const oldLine of dels) {
		let best = -1;
		let bestWords: ReturnType<typeof wordSegments> | undefined;
		for (let q = from; q < adds.length; q += 1) {
			if (adds[q].text.trim() === oldLine.text.trim()) {
				continue;
			}
			const words = wordSegments(oldLine.text, adds[q].text);
			if (words.similarity >= MIN_PAIR_SIMILARITY && (!bestWords || words.similarity > bestWords.similarity)) {
				best = q;
				bestWords = words;
			}
		}
		if (bestWords) {
			link(oldLine, adds[best], bestWords);
			from = best + 1;
		}
	}
	return modified;
}

function wordSegments(oldText: string, newText: string): {
	oldSegments: Segment[];
	newSegments: Segment[];
	similarity: number;
} {
	const a = oldText.match(TOKEN) ?? [];
	const b = newText.match(TOKEN) ?? [];
	const { ops } = diffOps(a, b);
	const oldSegments: Segment[] = [];
	const newSegments: Segment[] = [];
	let equalChars = 0;
	let i = 0;
	let j = 0;
	for (const op of ops) {
		if (op === '=') {
			pushSegment(oldSegments, a[i], false);
			pushSegment(newSegments, b[j], false);
			if (a[i].trim()) {
				equalChars += a[i].length;
			}
			i += 1;
			j += 1;
		} else if (op === '-') {
			pushSegment(oldSegments, a[i], true);
			i += 1;
		} else {
			pushSegment(newSegments, b[j], true);
			j += 1;
		}
	}
	const total = oldText.trim().length + newText.trim().length;
	const similarity = total === 0 ? 1 : (2 * equalChars) / total;
	return { oldSegments, newSegments, similarity };
}

function pushSegment(segments: Segment[], text: string, changed: boolean): void {
	const last = segments[segments.length - 1];
	if (last && last.changed === changed) {
		last.text += text;
	} else {
		segments.push({ text, changed });
	}
}

function buildHunks(lines: DiffLine[], context: number): { hunks: Hunk[]; clipped: boolean } {
	const ranges: Array<[number, number]> = [];
	lines.forEach((line, index) => {
		if (line.kind === 'ctx') {
			return;
		}
		const start = Math.max(0, index - context);
		const end = Math.min(lines.length, index + context + 1);
		const last = ranges[ranges.length - 1];
		if (last && start <= last[1]) {
			last[1] = Math.max(last[1], end);
		} else {
			ranges.push([start, end]);
		}
	});

	const hunks: Hunk[] = [];
	let shown = 0;
	let clipped = false;
	for (const [start, end] of ranges) {
		if (shown >= MAX_LINES_SHOWN) {
			clipped = true;
			break;
		}
		let slice = lines.slice(start, end);
		if (shown + slice.length > MAX_LINES_SHOWN) {
			slice = slice.slice(0, MAX_LINES_SHOWN - shown);
			clipped = true;
		}
		shown += slice.length;
		hunks.push({ label: rangeLabel(slice), lines: slice });
	}
	return { hunks, clipped };
}

function rangeLabel(lines: DiffLine[]): string {
	const newNumbers = lines.map((line) => line.newNo).filter((no): no is number => no !== undefined);
	const numbers = newNumbers.length > 0
		? newNumbers
		: lines.map((line) => line.oldNo).filter((no): no is number => no !== undefined);
	const first = numbers[0];
	const last = numbers[numbers.length - 1];
	if (first === undefined || last === undefined) {
		return '';
	}
	return first === last ? t('linha {0}', first) : t('linhas {0}–{1} ({2} linhas)', first, last, last - first + 1);
}

/** Um bloco contínuo de linhas alteradas. */
export interface Group {
	index: number;
	/** Primeira linha do bloco no texto de antes (a partir de 0). */
	oldStart: number;
	/** Linhas que existiam antes e saíram. Recusar devolve estas. */
	oldLines: string[];
	/** Primeira linha do bloco no texto atual (a partir de 0). */
	newStart: number;
	/** Linhas que o Claude colocou. Aceitar mantém estas. */
	newLines: string[];
}

export function groupsOf(lines: DiffLine[]): Group[] {
	const groups: Group[] = [];
	let oldPos = 0;
	let newPos = 0;
	let index = 0;
	while (index < lines.length) {
		if (lines[index].kind === 'ctx') {
			oldPos += 1;
			newPos += 1;
			index += 1;
			continue;
		}
		const group: Group = { index: groups.length, oldStart: oldPos, oldLines: [], newStart: newPos, newLines: [] };
		while (index < lines.length && lines[index].kind !== 'ctx') {
			if (lines[index].kind === 'del') {
				group.oldLines.push(lines[index].text);
				oldPos += 1;
			} else {
				group.newLines.push(lines[index].text);
				newPos += 1;
			}
			index += 1;
		}
		groups.push(group);
	}
	return groups;
}

export function groupSignature(group: Group): string {
	return JSON.stringify([group.oldStart, group.newStart, group.oldLines, group.newLines]);
}

/** Linhas no mesmo formato que o diff usa: sem \r e sem a linha vazia final. */
export function splitText(text: string): { lines: string[]; trailingNewline: boolean } {
	const lines = text.replace(/\r\n/g, '\n').split('\n');
	const trailingNewline = lines.length > 1 && lines[lines.length - 1] === '';
	if (trailingNewline || (lines.length === 1 && lines[0] === '')) {
		lines.pop();
	}
	return { lines, trailingNewline };
}

export function joinText({ lines, trailingNewline }: { lines: string[]; trailingNewline: boolean }): string {
	return lines.join('\n') + (trailingNewline && lines.length > 0 ? '\n' : '');
}

/** Igualdade que ignora \r\n e a quebra de linha final, como o diff. */
export function sameText(a: string, b: string): boolean {
	const clean = (text: string) => text.replace(/\r\n/g, '\n').replace(/\n$/, '');
	return clean(a) === clean(b);
}

