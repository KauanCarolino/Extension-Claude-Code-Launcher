/** Ambiente das páginas em media/: a API que o editor injeta e as funções que os scripts compartilham. */

interface VsCodeApi {
	postMessage(message: unknown): void;
	getState(): any;
	setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

type WebviewSend = (command: string, extra?: Record<string, unknown>) => void;

interface LauncherL10n {
	t(message: string, ...args: Array<string | number>): string;
	plural(count: number, one: string, many: string): string;
	/** Locale das datas, igual ao `lang` da página. */
	locale: string;
}

interface Window {
	/** l10n.js, carregado antes dos outros scripts. */
	launcherL10n: LauncherL10n;
	/** skills.js */
	renderSkills(host: HTMLElement, state: any, send: WebviewSend): void;
	/** catalog.js */
	renderCatalog(host: HTMLElement, kind: string, state: any, send: WebviewSend): void;
	/** changes-time.js */
	launcherTime: {
		shortTime(iso: string | undefined): string;
		relativeLabel(iso: string | undefined): string;
		exactLabel(iso: string | undefined): string;
		dayLabel(iso: string | undefined): string;
	};
	/** changes-diff.js */
	launcherDiff: {
		renderLine(line: any): HTMLElement;
		renderSplitRow(pair: any[]): HTMLElement;
		splitRows(lines: any[]): any[][];
	};
}
