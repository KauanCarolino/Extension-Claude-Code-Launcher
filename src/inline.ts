import * as vscode from 'vscode';
import { DiffLine, diffLines, Group, groupsOf, groupSignature, joinText, sameText, splitText } from './diff';
import { changeUri, RawEntry, Snapshot } from './changes';

const CONFIG_SECTION = 'claudeCodeLauncher';
const CONFIG_KEY = 'inlineChanges';
const REVIEWED_KEY = 'claudeCodeLauncher.reviewedEntries';
const MAX_REVIEWED = 1000;
const MAX_GHOST_CHARS = 90;
const MAX_HOVER_REASON = 900;
const MAX_LENS_REASON = 70;

export interface EntrySource {
	readonly onDidChangeEntries: vscode.Event<void>;
	getEntries(): readonly RawEntry[];
}

/**
 * Revisão em andamento de um arquivo. `base` é o texto de antes das edições do
 * Claude; as marcas mostram a diferença entre `base` e o arquivo atual.
 * Aceitar um trecho copia o trecho novo para `base`; recusar copia o trecho
 * antigo de volta para o arquivo. Quando os dois ficam iguais, a revisão acaba.
 */
interface Review {
	base: string;
	ids: string[];
	first: RawEntry;
	last: RawEntry;
	reason: string | null;
}

interface Built {
	added: vscode.DecorationOptions[];
	modified: vscode.DecorationOptions[];
	words: vscode.Range[];
	removedAbove: vscode.DecorationOptions[];
	removedBelow: vscode.DecorationOptions[];
	ghosts: vscode.DecorationOptions[];
	lenses: vscode.CodeLens[];
	firstLine: number;
}

export function registerInline(context: vscode.ExtensionContext, source: EntrySource): void {
	const inline = new InlineChanges(source, context.workspaceState);
	context.subscriptions.push(
		inline,
		vscode.languages.registerCodeLensProvider({ scheme: 'file' }, inline),
		vscode.commands.registerCommand('claude-code-launcher.showInlineChanges', (id?: string) => inline.show(id)),
		vscode.commands.registerCommand('claude-code-launcher.hideInlineChanges', (uri?: string) => inline.acceptAll(uri)),
		vscode.commands.registerCommand('claude-code-launcher.toggleInlineChanges', () => inline.toggle()),
		vscode.commands.registerCommand(
			'claude-code-launcher.compareInline',
			(firstId: string, lastId: string) => inline.compare(firstId, lastId),
		),
		vscode.commands.registerCommand(
			'claude-code-launcher.acceptChange',
			(uri: string, index: number, signature: string) => inline.accept(uri, index, signature),
		),
		vscode.commands.registerCommand(
			'claude-code-launcher.rejectChange',
			(uri: string, index: number, signature: string) => inline.reject(uri, index, signature),
		),
		vscode.commands.registerCommand('claude-code-launcher.acceptAllChanges', (uri?: string) => inline.acceptAll(uri)),
		vscode.commands.registerCommand('claude-code-launcher.rejectAllChanges', (uri?: string) => inline.rejectAll(uri)),
	);
}

class InlineChanges implements vscode.CodeLensProvider, vscode.Disposable {
	private readonly addedType = vscode.window.createTextEditorDecorationType({
		isWholeLine: true,
		backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
		borderColor: new vscode.ThemeColor('editorGutter.addedBackground'),
		borderStyle: 'solid',
		borderWidth: '0 0 0 3px',
		overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
		overviewRulerLane: vscode.OverviewRulerLane.Left,
	});

	private readonly modifiedType = vscode.window.createTextEditorDecorationType({
		isWholeLine: true,
		backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
		borderColor: new vscode.ThemeColor('editorGutter.modifiedBackground'),
		borderStyle: 'solid',
		borderWidth: '0 0 0 3px',
		overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.modifiedForeground'),
		overviewRulerLane: vscode.OverviewRulerLane.Left,
	});

	private readonly wordType = vscode.window.createTextEditorDecorationType({
		backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
		borderRadius: '2px',
	});

	private readonly removedAboveType = vscode.window.createTextEditorDecorationType({
		isWholeLine: true,
		borderColor: new vscode.ThemeColor('editorGutter.deletedBackground'),
		borderStyle: 'dashed',
		borderWidth: '2px 0 0 0',
		overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
		overviewRulerLane: vscode.OverviewRulerLane.Left,
	});

	private readonly removedBelowType = vscode.window.createTextEditorDecorationType({
		isWholeLine: true,
		borderColor: new vscode.ThemeColor('editorGutter.deletedBackground'),
		borderStyle: 'dashed',
		borderWidth: '0 0 2px 0',
		overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
		overviewRulerLane: vscode.OverviewRulerLane.Left,
	});

	private readonly ghostType = vscode.window.createTextEditorDecorationType({
		after: {
			color: new vscode.ThemeColor('editorCodeLens.foreground'),
			fontStyle: 'italic',
			margin: '0 0 0 2.5em',
		},
	});

	private readonly lensEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeCodeLenses = this.lensEmitter.event;

	private readonly lenses = new Map<string, vscode.CodeLens[]>();
	private readonly reviews = new Map<string, Review>();
	private readonly reviewed: Set<string>;
	private readonly pending = new Map<string, unknown>();
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly source: EntrySource, private readonly memento: vscode.Memento) {
		this.reviewed = new Set(memento.get<string[]>(REVIEWED_KEY, []));
		this.disposables.push(
			this.addedType,
			this.modifiedType,
			this.wordType,
			this.removedAboveType,
			this.removedBelowType,
			this.ghostType,
			this.lensEmitter,
			source.onDidChangeEntries(() => this.applyAll()),
			vscode.window.onDidChangeVisibleTextEditors(() => this.applyAll()),
			vscode.workspace.onDidChangeTextDocument((event) => this.scheduleDocument(event.document)),
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration(`${CONFIG_SECTION}.${CONFIG_KEY}`)) {
					this.applyAll();
				}
			}),
		);
		this.applyAll();
	}

	dispose(): void {
		this.pending.forEach((timer) => clearTimeout(timer));
		this.disposables.forEach((disposable) => disposable.dispose());
	}

	provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		return this.lenses.get(document.uri.toString()) ?? [];
	}

	async show(id: string | undefined): Promise<void> {
		const entry = this.source.getEntries().find((item) => item.id === id);
		if (!entry) {
			return;
		}
		if (!this.enabled()) {
			await vscode.workspace
				.getConfiguration(CONFIG_SECTION)
				.update(CONFIG_KEY, true, vscode.ConfigurationTarget.Global);
		}
		const uri = vscode.Uri.file(entry.file);
		for (const item of this.entriesFor(uri.toString())) {
			this.reviewed.delete(item.id);
		}
		this.reviews.delete(uri.toString());
		void this.saveReviewed();

		let editor: vscode.TextEditor;
		try {
			editor = await vscode.window.showTextDocument(uri, { preview: false });
		} catch {
			void vscode.window.showWarningMessage(`O arquivo ${basename(entry.file)} não existe mais.`);
			return;
		}
		const built = this.apply(editor);
		if (!built) {
			void vscode.window.showInformationMessage(
				'Este arquivo mudou depois da edição do Claude, então as marcas não batem mais com o código. '
				+ 'Use "Lado a lado" no painel Mudanças.',
			);
			return;
		}
		const line = new vscode.Range(built.firstLine, 0, built.firstLine, 0);
		editor.revealRange(line, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
	}

	async toggle(): Promise<void> {
		const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
		await config.update(CONFIG_KEY, !this.enabled(), vscode.ConfigurationTarget.Global);
	}

	async compare(firstId: string, lastId: string): Promise<void> {
		const entries = this.source.getEntries();
		const first = entries.find((item) => item.id === firstId);
		const last = entries.find((item) => item.id === lastId);
		if (!first || !last) {
			return;
		}
		const name = basename(last.file);
		await vscode.commands.executeCommand(
			'vscode.diff',
			changeUri(first, 'antes'),
			changeUri(last, 'depois'),
			`${name} (antes ↔ depois do Claude)`,
			{ preview: true },
		);
	}

	/** Mantém o trecho como o Claude deixou e tira as marcas dele. */
	accept(uri: string, index: number, signature: string): void {
		const target = this.groupAt(uri, index, signature);
		if (!target) {
			return;
		}
		const { review, group } = target;
		const base = splitText(review.base);
		base.lines.splice(group.oldStart, group.oldLines.length, ...group.newLines);
		review.base = joinText(base);
		this.applyAll();
	}

	/** Volta o trecho para o código de antes do Claude e salva o arquivo. */
	async reject(uri: string, index: number, signature: string): Promise<void> {
		const target = this.groupAt(uri, index, signature);
		if (!target) {
			return;
		}
		const { document, group } = target;
		const current = splitText(document.getText());
		current.lines.splice(group.newStart, group.newLines.length, ...group.oldLines);
		await this.replaceDocument(document, joinText(current));
	}

	acceptAll(uri: string | undefined): void {
		const key = uri ?? vscode.window.activeTextEditor?.document.uri.toString();
		const review = key ? this.reviews.get(key) : undefined;
		if (key && review) {
			this.finish(key, review);
		}
		this.applyAll();
	}

	async rejectAll(uri: string | undefined): Promise<void> {
		const key = uri ?? vscode.window.activeTextEditor?.document.uri.toString();
		const review = key ? this.reviews.get(key) : undefined;
		const document = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === key);
		if (!review || !document) {
			return;
		}
		await this.replaceDocument(document, review.base);
	}

	private groupAt(uri: string, index: number, signature: string):
		{ document: vscode.TextDocument; review: Review; group: Group } | undefined {
		const document = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === uri);
		const review = this.reviews.get(uri);
		if (!document || !review) {
			return undefined;
		}
		const group = groupsOf(diffLines(review.base, document.getText()).lines)[index];
		if (!group || groupSignature(group) !== signature) {
			this.applyAll();
			void vscode.window.showInformationMessage('Esse trecho mudou desde que as marcas foram desenhadas. Tente de novo.');
			return undefined;
		}
		return { document, review, group };
	}

	private async replaceDocument(document: vscode.TextDocument, text: string): Promise<void> {
		const content = document.eol === vscode.EndOfLine.CRLF ? text.replace(/\n/g, '\r\n') : text;
		const edit = new vscode.WorkspaceEdit();
		edit.replace(document.uri, document.validateRange(new vscode.Range(0, 0, document.lineCount, 0)), content);
		if (!(await vscode.workspace.applyEdit(edit))) {
			void vscode.window.showErrorMessage('Não foi possível recusar a mudança: o editor rejeitou a edição.');
			return;
		}
		await document.save();
		this.applyAll();
	}

	private enabled(): boolean {
		return vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>(CONFIG_KEY, true);
	}

	private scheduleDocument(document: vscode.TextDocument): void {
		const key = document.uri.toString();
		const visible = vscode.window.visibleTextEditors.filter((editor) => editor.document.uri.toString() === key);
		if (visible.length === 0) {
			return;
		}
		clearTimeout(this.pending.get(key));
		this.pending.set(key, setTimeout(() => {
			this.pending.delete(key);
			visible.forEach((editor) => this.apply(editor));
		}, 400));
	}

	private applyAll(): void {
		for (const editor of vscode.window.visibleTextEditors) {
			this.apply(editor);
		}
	}

	private apply(editor: vscode.TextEditor): Built | undefined {
		const document = editor.document;
		const key = document.uri.toString();
		const review = document.uri.scheme === 'file' && this.enabled() ? this.evaluate(document) : undefined;
		const built = review ? build(review, document) : undefined;

		editor.setDecorations(this.addedType, built?.added ?? []);
		editor.setDecorations(this.modifiedType, built?.modified ?? []);
		editor.setDecorations(this.wordType, built?.words ?? []);
		editor.setDecorations(this.removedAboveType, built?.removedAbove ?? []);
		editor.setDecorations(this.removedBelowType, built?.removedBelow ?? []);
		editor.setDecorations(this.ghostType, built?.ghosts ?? []);

		const hadLenses = this.lenses.has(key);
		if (built) {
			this.lenses.set(key, built.lenses);
		} else {
			this.lenses.delete(key);
		}
		if (built || hadLenses) {
			this.lensEmitter.fire();
		}
		return built;
	}

	// Começa uma revisão quando o arquivo está exatamente como o Claude deixou,
	// junta novas edições do Claude a uma revisão aberta e encerra a revisão
	// quando não sobra diferença.
	private evaluate(document: vscode.TextDocument): Review | undefined {
		const key = document.uri.toString();
		const text = document.getText();
		const entries = this.entriesFor(key);
		const latest = entries[entries.length - 1];
		let review = this.reviews.get(key);

		if (latest && !this.reviewed.has(latest.id) && !review?.ids.includes(latest.id)) {
			const after = textOf(latest.after);
			if (after !== undefined && sameText(after, text)) {
				if (review) {
					review.ids.push(latest.id);
					review.last = latest;
					review.reason = latest.reason?.trim() || review.reason;
				} else {
					review = this.startReview(entries);
					if (review) {
						this.reviews.set(key, review);
					}
				}
			}
		}

		if (review && !review.reason) {
			// A explicação pode chegar depois do registro (ver ChangesController.fillReasons).
			const last = entries.find((entry) => entry.id === review?.last.id);
			review.reason = last?.reason?.trim() || null;
		}
		if (review && sameText(review.base, text)) {
			this.finish(key, review);
			return undefined;
		}
		return review;
	}

	private startReview(entries: RawEntry[]): Review | undefined {
		const last = entries[entries.length - 1];
		let before = textOf(last.before);
		if (before === undefined) {
			return undefined;
		}
		const ids = [last.id];
		let first = last;
		for (let index = entries.length - 2; index >= 0; index -= 1) {
			const previous = entries[index];
			const previousAfter = textOf(previous.after);
			const previousBefore = textOf(previous.before);
			if (
				this.reviewed.has(previous.id)
				|| previousAfter === undefined
				|| previousBefore === undefined
				|| !sameText(previousAfter, before)
			) {
				break;
			}
			before = previousBefore;
			first = previous;
			ids.unshift(previous.id);
		}
		return { base: before, ids, first, last, reason: last.reason?.trim() || null };
	}

	private finish(key: string, review: Review): void {
		review.ids.forEach((id) => this.reviewed.add(id));
		this.reviews.delete(key);
		void this.saveReviewed();
	}

	private async saveReviewed(): Promise<void> {
		await this.memento.update(REVIEWED_KEY, [...this.reviewed].slice(-MAX_REVIEWED));
	}

	private entriesFor(key: string): RawEntry[] {
		return this.source
			.getEntries()
			.filter((entry) => vscode.Uri.file(entry.file).toString() === key)
			.sort((a, b) => a.time.localeCompare(b.time));
	}
}

function build(review: Review, document: vscode.TextDocument): Built {
	const { lines } = diffLines(review.base, document.getText());
	const language = document.languageId;
	const head = hoverHeader(review);
	const built: Built = {
		added: [],
		modified: [],
		words: [],
		removedAbove: [],
		removedBelow: [],
		ghosts: [],
		lenses: [],
		firstLine: 0,
	};
	const ghostTexts = new Map<number, string[]>();
	const addGhost = (line: number, text: string) => {
		const list = ghostTexts.get(line) ?? [];
		list.push(text);
		ghostTexts.set(line, list);
	};
	const lastLine = Math.max(0, document.lineCount - 1);
	const pairedOld: DiffLine[] = [];

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (line.kind === 'ctx') {
			continue;
		}

		if (line.kind === 'del') {
			if (line.pair === 'antes') {
				pairedOld.push(line);
				continue;
			}
			let end = index;
			while (end < lines.length && lines[end].kind === 'del' && !lines[end].pair) {
				end += 1;
			}
			const removed = lines.slice(index, end).map((item) => item.text);
			const label = removed.length === 1 ? '1 linha removida' : `${removed.length} linhas removidas`;
			const hover = markdown(`${head}**${capitalize(label)} neste ponto:**\n\n${codeBlock(removed.join('\n'), language)}`);
			const anchor = nextNewLine(lines, end);
			if (anchor !== undefined) {
				built.removedAbove.push({ range: lineRange(anchor), hoverMessage: hover });
				addGhost(anchor, `↑ ${label} aqui`);
			} else {
				built.removedBelow.push({ range: lineRange(lastLine), hoverMessage: hover });
				addGhost(lastLine, `↓ ${label} no fim do arquivo`);
			}
			index = end - 1;
			continue;
		}

		const lineIndex = (line.newNo ?? 1) - 1;
		if (line.pair === 'depois') {
			const old = pairedOld.shift();
			const oldText = old?.text ?? '';
			built.modified.push({
				range: lineRange(lineIndex),
				hoverMessage: markdown(
					`${head}**Linha modificada**\n\nAntes:\n${codeBlock(oldText, language)}\nDepois:\n${codeBlock(line.text, language)}`,
				),
			});
			let offset = 0;
			for (const segment of line.segments ?? []) {
				if (segment.changed && segment.text.trim()) {
					built.words.push(new vscode.Range(lineIndex, offset, lineIndex, offset + segment.text.length));
				}
				offset += segment.text.length;
			}
			addGhost(lineIndex, `antes: ${oldText.trim() || '(linha vazia)'}`);
		} else {
			built.added.push({ range: lineRange(lineIndex), hoverMessage: markdown(`${head}**Linha nova**`) });
		}
	}

	for (const [line, texts] of ghostTexts) {
		const end = document.lineAt(Math.min(line, lastLine)).range.end;
		built.ghosts.push({
			range: new vscode.Range(end, end),
			renderOptions: { after: { contentText: truncate(texts.join('  ·  '), MAX_GHOST_CHARS) } },
		});
	}

	const uri = document.uri.toString();
	const groups = groupsOf(lines);
	for (const group of groups) {
		const anchor = Math.min(group.newStart, lastLine);
		const range = lineRange(anchor);
		const signature = groupSignature(group);
		if (group.index === 0) {
			built.lenses.push(
				new vscode.CodeLens(range, {
					title: `$(sparkle) Claude: ${shortReason(review)}`,
					tooltip: review.reason ?? 'Abrir o painel Mudanças',
					command: 'claude-code-launcher.showChanges',
				}),
				new vscode.CodeLens(range, {
					title: '$(diff) Lado a lado',
					command: 'claude-code-launcher.compareInline',
					arguments: [review.first.id, review.last.id],
				}),
			);
		} else {
			built.lenses.push(new vscode.CodeLens(range, {
				title: `$(sparkle) Claude · trecho ${group.index + 1} de ${groups.length}`,
				command: 'claude-code-launcher.showChanges',
			}));
		}
		built.lenses.push(
			new vscode.CodeLens(range, {
				title: '$(check) Aceitar',
				tooltip: 'Manter este trecho como o Claude deixou',
				command: 'claude-code-launcher.acceptChange',
				arguments: [uri, group.index, signature],
			}),
			new vscode.CodeLens(range, {
				title: '$(close) Recusar',
				tooltip: 'Voltar este trecho para o código de antes e salvar o arquivo',
				command: 'claude-code-launcher.rejectChange',
				arguments: [uri, group.index, signature],
			}),
		);
		if (group.index === 0 && groups.length > 1) {
			built.lenses.push(
				new vscode.CodeLens(range, {
					title: `$(check-all) Aceitar tudo (${groups.length})`,
					command: 'claude-code-launcher.acceptAllChanges',
					arguments: [uri],
				}),
				new vscode.CodeLens(range, {
					title: '$(discard) Recusar tudo',
					tooltip: 'Voltar o arquivo inteiro para antes das edições do Claude e salvar',
					command: 'claude-code-launcher.rejectAllChanges',
					arguments: [uri],
				}),
			);
		}
	}
	built.firstLine = groups.length > 0 ? Math.min(groups[0].newStart, lastLine) : 0;
	return built;
}

function nextNewLine(lines: DiffLine[], from: number): number | undefined {
	for (let index = from; index < lines.length; index += 1) {
		const newNo = lines[index].newNo;
		if (newNo !== undefined) {
			return newNo - 1;
		}
	}
	return undefined;
}

function hoverHeader(review: Review): string {
	const date = new Date(review.last.time);
	const when = isNaN(date.getTime())
		? ''
		: ` · ${date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
	const what = review.ids.length > 1 ? `${review.ids.length} edições do Claude` : 'Edição do Claude';
	let text = `$(sparkle) **${what}**${when}\n\n`;
	if (review.reason) {
		text += `${truncate(review.reason, MAX_HOVER_REASON)
			.split('\n')
			.map((line) => `> ${line}`)
			.join('\n')}\n\n---\n\n`;
	}
	return text;
}

function shortReason(review: Review): string {
	if (!review.reason) {
		return review.ids.length > 1 ? `${review.ids.length} edições neste arquivo` : 'alterou este arquivo';
	}
	const firstLine = review.reason.split('\n').find((line) => line.trim()) ?? '';
	return truncate(firstLine.replace(/[*_`#>]/g, '').trim(), MAX_LENS_REASON);
}

function markdown(text: string): vscode.MarkdownString {
	const result = new vscode.MarkdownString(text);
	result.supportThemeIcons = true;
	return result;
}

function codeBlock(code: string, language: string): string {
	const fence = code.includes('```') ? '~~~~' : '```';
	return `${fence}${language}\n${code}\n${fence}\n`;
}

function lineRange(line: number): vscode.Range {
	return new vscode.Range(line, 0, line, 0);
}

function textOf(snapshot: Snapshot | null): string | undefined {
	if (!snapshot || snapshot.large) {
		return undefined;
	}
	if (!snapshot.exists) {
		return '';
	}
	return snapshot.text ?? undefined;
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function capitalize(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

function basename(file: string): string {
	const parts = file.split(/[\\/]/);
	return parts[parts.length - 1] || file;
}
