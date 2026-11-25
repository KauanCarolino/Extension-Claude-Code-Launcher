import * as vscode from 'vscode';
import { DiffLine, diffLines, Group, groupsOf, groupSignature } from './diff';
import { DROP_REVIEW_COMMAND } from './changes';
import { fileKey, RawEntry, Status } from './logic';
import { ReviewDecisionRequest, SharedReview } from './review';
import { blockedReviewResult, formatReviewItemResult, ReviewResultError } from './review-results';
import { htmlLanguage, plural, t } from './i18n';

const CONFIG_SECTION = 'claudeCodeLauncher';
const CONFIG_KEY = 'inlineChanges';
const MAX_GHOST_CHARS = 90;
const MAX_HOVER_REASON = 900;
const MAX_LENS_REASON = 70;

export interface EntrySource {
	readonly onDidChangeEntries: vscode.Event<void>;
	getEntries(): readonly RawEntry[];
	isReviewed(id: string): boolean;
	setStatus(ids: readonly string[], status: Status | undefined): void;
	/** Arquivos com mudanças pendentes, na ordem do painel. */
	pendingFiles(): string[];
	getSharedReview(file: string): SharedReview | undefined;
	executeReviewDecision(file: string, request: ReviewDecisionRequest): Promise<void>;
	compareReview?(file: string): Promise<void>;
	canOpenResource?(file: string): Promise<boolean>;
}

/** Read-only projection; durable authority belongs to EntrySource. */
interface Review {
	base: string;
	current: string;
	hiddenBom: boolean;
	revision: number;
	file: string;
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
	const inline = new InlineChanges(source);
	context.subscriptions.push(
		vscode.commands.registerCommand(DROP_REVIEW_COMMAND, (uri: string) => inline.drop(uri)),
		vscode.commands.registerCommand('claude-code-launcher.nextChange', () => inline.navigate(1)),
		vscode.commands.registerCommand('claude-code-launcher.previousChange', () => inline.navigate(-1)),
		inline,
		vscode.languages.registerCodeLensProvider({ scheme: 'file' }, inline),
		vscode.commands.registerCommand('claude-code-launcher.showInlineChanges', (id?: string) => inline.show(id)),
		vscode.commands.registerCommand('claude-code-launcher.hideInlineChanges', (uri?: string) => inline.acceptAll(uri)),
		vscode.commands.registerCommand('claude-code-launcher.toggleInlineChanges', () => inline.toggle()),
		vscode.commands.registerCommand(
			'claude-code-launcher.compareInline',
			(firstId: string, lastId: string, file?: string) => inline.compare(firstId, lastId, file),
		),
		vscode.commands.registerCommand(
			'claude-code-launcher.acceptChange',
			(uri: string, index: number, signature: string, revision?: number) => inline.accept(uri, index, signature, revision),
		),
		vscode.commands.registerCommand(
			'claude-code-launcher.rejectChange',
			(uri: string, index: number, signature: string, revision?: number) => inline.reject(uri, index, signature, revision),
		),
		vscode.commands.registerCommand('claude-code-launcher.acceptChangeAtCursor', () => inline.decideAtCursor('accept')),
		vscode.commands.registerCommand('claude-code-launcher.rejectChangeAtCursor', () => inline.decideAtCursor('reject')),
		vscode.commands.registerCommand('claude-code-launcher.acceptAllChanges', (uri?: string, revision?: number) => inline.acceptAll(uri, revision)),
		vscode.commands.registerCommand('claude-code-launcher.rejectAllChanges', (uri?: string, revision?: number) => inline.rejectAll(uri, revision)),
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
	private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly source: EntrySource) {
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
		if (this.source.canOpenResource) {
			let allowed = false;
			try { allowed = await this.source.canOpenResource(entry.file); } catch { /* Unknown scope never authorizes reading. */ }
			if (!allowed) {
				void vscode.window.showWarningMessage(t('Não abri este recurso: ele está fora do escopo autorizado ou sua identidade não pôde ser confirmada.'));
				return;
			}
		}
		if (!this.enabled()) {
			await vscode.workspace
				.getConfiguration(CONFIG_SECTION)
				.update(CONFIG_KEY, true, vscode.ConfigurationTarget.Global);
		}
		const uri = vscode.Uri.file(entry.file);
		let editor: vscode.TextEditor;
		try {
			editor = await vscode.window.showTextDocument(uri, { preview: false });
		} catch {
			void vscode.window.showWarningMessage(t('O arquivo {0} não existe mais.', basename(entry.file)));
			return;
		}

		const built = this.apply(editor);
		if (!built) {
			void vscode.window.showInformationMessage(
				t('Este arquivo mudou depois da edição do Claude, então as marcas não batem mais com o código. Use "Lado a lado" no painel Mudanças.'),
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

	async compare(firstId: string, lastId: string, file?: string): Promise<void> {
		const last = this.source.getEntries().find((entry) => entry.id === lastId || entry.id === firstId);
		const target = file ?? last?.file;
		if (target && this.source.compareReview) { await this.source.compareReview(target); }
	}

	async accept(uri: string, index: number, signature: string, revision?: number): Promise<void> { await this.decide(uri, { action: 'accept', index, signature, revision }); }
	async reject(uri: string, index: number, signature: string, revision?: number): Promise<void> { await this.decide(uri, { action: 'reject', index, signature, revision }); }
	async acceptAll(uri?: string, revision?: number): Promise<void> { await this.decide(uri, { action: 'accept', revision }); }
	async rejectAll(uri?: string, revision?: number): Promise<void> { await this.decide(uri, { action: 'reject', revision }); }

	private async decide(uri: string | undefined, request: ReviewDecisionRequest): Promise<void> {
		const target = uri ? vscode.Uri.parse(uri) : vscode.window.activeTextEditor?.document.uri;
		if (!target) { return; }
		if (target.scheme !== 'file') {
			void vscode.window.showWarningMessage(formatReviewItemResult(blockedReviewResult('', [], request.action, 'unsupportedResource')));
			return;
		}
		const review = this.source.getSharedReview(target.fsPath);
		if (!review) { return; }
		try {
			await this.source.executeReviewDecision(target.fsPath, { ...request, revision: request.revision ?? review.revision });
			this.applyAll();
		} catch (error) {
			const result = error instanceof ReviewResultError ? error.result : {
				...blockedReviewResult(target.fsPath, review.ids, request.action, error),
				outcome: 'failed' as const, content: 'unknown' as const, nextAction: 'reconcile' as const,
			};
			void vscode.window.showWarningMessage(formatReviewItemResult(result));
		}
	}

	/**
	 * Aceita ou recusa o trecho do Claude em que está o cursor, com a mesma assinatura que a lente usa.
	 * Fora de um trecho não decide nada: o atalho nunca escolhe um trecho que a pessoa não está vendo.
	 */
	async decideAtCursor(action: 'accept' | 'reject'): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		const review = editor && editor.document.uri.scheme === 'file' ? this.evaluate(editor.document) : undefined;
		if (!editor || !review) { void vscode.window.showInformationMessage(t('Não há trecho do Claude para revisar neste arquivo.')); return; }
		const last = Math.max(0, editor.document.lineCount - 1);
		const line = editor.selection.active.line;
		const span = (group: Group) => {
			const start = Math.min(group.newStart, last);
			return { start, end: Math.min(start + Math.max(group.newLines.length, 1) - 1, last) };
		};
		const group = groupsOf(diffLines(review.base, review.current).lines).find((item) => { const { start, end } = span(item); return line >= start && line <= end; });
		if (!group) { void vscode.window.showInformationMessage(t('Coloque o cursor num trecho do Claude. Alt+] e Alt+[ vão para o próximo e o anterior.')); return; }
		await this.decide(editor.document.uri.toString(), { action, index: group.index, signature: groupSignature(group), revision: review.revision });
	}

	/** Only invalidate local presentation; never discard shared decisions. */
	drop(uri: string): void { this.lenses.delete(uri); this.applyAll(); }

	/**
	 * Vai para o próximo (1) ou anterior (-1) trecho do Claude no arquivo atual.
	 * No fim do arquivo, passa para o próximo arquivo pendente.
	 */
	async navigate(direction: 1 | -1): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		const anchors = editor ? this.anchors(editor) : [];
		if (editor && anchors.length > 0) {
			const line = editor.selection.active.line;
			const target = direction > 0
				? anchors.find((anchor) => anchor > line)
				: [...anchors].reverse().find((anchor) => anchor < line);
			if (target !== undefined) {
				reveal(editor, target);
				return;
			}
		}

		const files = this.source.pendingFiles();
		const current = editor ? fileKey(editor.document.uri.fsPath) : '';
		const index = files.findIndex((file) => fileKey(file) === current);
		const order = index < 0
			? (direction > 0 ? files : [...files].reverse())
			: Array.from({ length: files.length }, (_, step) => files[(index + direction * (step + 1) + files.length * 2) % files.length]);
		for (const file of order) {
			let next: vscode.TextEditor;
			try {
				next = await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
			} catch {
				continue;
			}
			const found = this.anchors(next);
			if (found.length > 0) {
				reveal(next, direction > 0 ? found[0] : found[found.length - 1]);
				return;
			}
		}
		void vscode.window.showInformationMessage(
			files.length === 0
				? t('Nenhuma mudança do Claude para revisar.')
				: t('As mudanças pendentes não batem mais com o código. Revise pelo painel Mudanças.'),
		);
	}

	/** Linha de início de cada trecho do Claude no editor. */
	private anchors(editor: vscode.TextEditor): number[] {
		const built = this.apply(editor);
		const review = this.evaluate(editor.document);
		if (!built || !review) {
			return [];
		}
		const last = Math.max(0, editor.document.lineCount - 1);
		return groupsOf(diffLines(review.base, review.current).lines)
			.map((group) => Math.min(group.newStart, last));
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
			vscode.window.visibleTextEditors.filter((editor) => editor.document.uri.toString() === key).forEach((editor) => this.apply(editor));
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

	private evaluate(document: vscode.TextDocument): Review | undefined {
		const shared = this.source.getSharedReview(document.uri.fsPath);
		if (!shared || shared.phase !== 'pending' || shared.base.kind === 'unavailable'
			|| shared.expected.kind !== 'text') { return undefined; }
		// TextDocument omits an encoding BOM. Keep full snapshot identity for the
		// domain diff/signature; the executor still verifies actual persisted bytes.
		const text = document.getText();
		const hiddenBom = shared.expected.text.startsWith('\uFEFF') && !text.startsWith('\uFEFF');
		const current = (hiddenBom ? '\uFEFF' : '') + text;
		if (shared.expected.text !== current) { return undefined; }
		const entries = this.source.getEntries();
		const placeholder = (id: string): RawEntry => ({ id, file: shared.file, time: '', before: null, after: null });
		return { base: shared.base.kind === 'text' ? shared.base.text : '', current, hiddenBom, revision: shared.revision, file: shared.file, ids: [...shared.ids],
			first: entries.find((entry) => entry.id === shared.firstId) ?? placeholder(shared.firstId),
			last: entries.find((entry) => entry.id === shared.lastId) ?? placeholder(shared.lastId), reason: shared.reason };
	}

}

function build(review: Review, document: vscode.TextDocument): Built {
	const { lines } = diffLines(review.base, review.current);
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
			const label = plural(removed.length, '{0} linha removida', '{0} linhas removidas');
			const hover = markdown(`${head}**${capitalize(t('{0} neste ponto:', label))}**\n\n${codeBlock(removed.join('\n'), language)}`);
			const anchor = nextNewLine(lines, end);
			if (anchor !== undefined) {
				built.removedAbove.push({ range: lineRange(anchor), hoverMessage: hover });
				addGhost(anchor, t('↑ {0} aqui', label));
			} else {
				built.removedBelow.push({ range: lineRange(lastLine), hoverMessage: hover });
				addGhost(lastLine, t('↓ {0} no fim do arquivo', label));
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
					`${head}**${t('Linha modificada')}**\n\n${t('Antes:')}\n${codeBlock(oldText, language)}\n${t('Depois:')}\n${codeBlock(line.text, language)}`,
				),
			});
			let offset = 0;
			for (const segment of line.segments ?? []) {
				if (segment.changed && segment.text.trim()) {
					const hidden = lineIndex === 0 && review.hiddenBom ? 1 : 0;
					const start = Math.max(0, offset - hidden), end = Math.max(0, offset + segment.text.length - hidden);
					if (end > start) { built.words.push(new vscode.Range(lineIndex, start, lineIndex, end)); }
				}
				offset += segment.text.length;
			}
			addGhost(lineIndex, t('antes: {0}', oldText.trim() || t('(linha vazia)')));
		} else {
			built.added.push({ range: lineRange(lineIndex), hoverMessage: markdown(`${head}**${t('Linha nova')}**`) });
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
					tooltip: review.reason ?? t('Abrir o painel Mudanças'),
					command: 'claude-code-launcher.showChanges',
				}),
				new vscode.CodeLens(range, {
					title: '$(diff) ' + t('Lado a lado'),
					command: 'claude-code-launcher.compareInline',
					arguments: [review.first.id, review.last.id, review.file],
				}),
			);
		} else {
			built.lenses.push(new vscode.CodeLens(range, {
				title: '$(sparkle) ' + t('Claude · trecho {0} de {1}', group.index + 1, groups.length),
				command: 'claude-code-launcher.showChanges',
			}));
		}
		built.lenses.push(
			new vscode.CodeLens(range, {
				title: '$(check) ' + t('Aceitar'),
				tooltip: t('Manter este trecho como o Claude deixou'),
				command: 'claude-code-launcher.acceptChange',
					arguments: [uri, group.index, signature, review.revision],
			}),
			new vscode.CodeLens(range, {
				title: '$(close) ' + t('Recusar'),
				tooltip: t('Voltar este trecho para o código de antes e salvar o arquivo'),
				command: 'claude-code-launcher.rejectChange',
					arguments: [uri, group.index, signature, review.revision],
			}),
		);
		if (group.index === 0 && groups.length > 1) {
			built.lenses.push(
				new vscode.CodeLens(range, {
					title: '$(check-all) ' + t('Aceitar tudo ({0})', groups.length),
					command: 'claude-code-launcher.acceptAllChanges',
						arguments: [uri, review.revision],
				}),
				new vscode.CodeLens(range, {
					title: '$(discard) ' + t('Recusar tudo'),
					tooltip: t('Voltar o arquivo inteiro para antes das edições do Claude e salvar'),
					command: 'claude-code-launcher.rejectAllChanges',
						arguments: [uri, review.revision],
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
		: ` · ${date.toLocaleTimeString(htmlLanguage(), { hour: '2-digit', minute: '2-digit' })}`;
	const what = review.ids.length > 1 ? t('{0} edições do Claude', review.ids.length) : t('Edição do Claude');
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
		return review.ids.length > 1 ? t('{0} edições neste arquivo', review.ids.length) : t('alterou este arquivo');
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

function reveal(editor: vscode.TextEditor, line: number): void {
	const position = new vscode.Position(line, 0);
	editor.selection = new vscode.Selection(position, position);
	editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

function lineRange(line: number): vscode.Range {
	return new vscode.Range(line, 0, line, 0);
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
