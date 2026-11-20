import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { createSkill, DISABLED_FILE, scanSkills, scanSynced, setSkillEnabled, SKILL_FILE, validSkillName, type SkillInfo, type SkillScope } from './skills';

const VIEW_ID = 'claude-code-launcher.skills';
const globalRoot = () => path.join(os.homedir(), '.claude', 'skills');
const projectRoot = () => {
	const folder = vscode.workspace.workspaceFolders?.[0];
	return folder ? path.join(folder.uri.fsPath, '.claude', 'skills') : undefined;
};

async function loadSkills(): Promise<SkillInfo[]> {
	const project = projectRoot();
	const [projectSkills, globalSkills, synced] = await Promise.all([
		project ? scanSkills(project, 'project') : Promise.resolve([]),
		scanSkills(globalRoot(), 'global'),
		scanSynced(globalRoot()),
	]);
	return [...projectSkills, ...globalSkills, ...synced];
}

const nonce = (): string => Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');

class SkillsViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	private view?: vscode.WebviewView;
	private skills = new Map<string, SkillInfo>();
	private timer?: NodeJS.Timeout;
	private disposed = false;
	constructor(private readonly context: vscode.ExtensionContext) {}

	resolveWebviewView(view: vscode.WebviewView): void {
		const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
		this.view = view;
		view.webview.options = { enableScripts: true, localResourceRoots: [media] };
		view.webview.html = this.html(view.webview, media);
		const subs = [
			view.webview.onDidReceiveMessage((message: unknown) => { void this.handle(message); }),
			view.onDidChangeVisibility(() => { if (view.visible) { void this.post(); } }),
		];
		view.onDidDispose(() => { subs.forEach((s) => s.dispose()); if (this.view === view) { this.view = undefined; } });
	}

	refresh(delay = 250): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => { void this.post(); }, delay);
	}

	dispose(): void { this.disposed = true; clearTimeout(this.timer); }

	async post(): Promise<void> {
		if (this.disposed || !this.view?.visible) { return; }
		const skills = await loadSkills();
		this.skills = new Map(skills.map((s) => [s.id, s]));
		void this.view?.webview.postMessage({
			type: 'state', hasProject: Boolean(projectRoot()),
			skills: skills.map(({ id, name, description, scope, state }) => ({ id, name, description, scope, state })),
		});
	}

	private async handle(value: unknown): Promise<void> {
		const message = (value && typeof value === 'object' ? value : {}) as { command?: unknown; id?: unknown; scope?: unknown };
		const skill = typeof message.id === 'string' ? this.skills.get(message.id) : undefined;
		try {
			switch (message.command) {
				case 'ready': case 'refresh': break;
				case 'open': if (skill && skill.state !== 'broken') {
					await vscode.window.showTextDocument(vscode.Uri.file(path.join(skill.dir, skill.state === 'disabled' ? DISABLED_FILE : SKILL_FILE)));
				} break;
				case 'reveal': if (skill) { await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(skill.dir)); } break;
				case 'toggle': if (skill && skill.scope !== 'claudeai') { await setSkillEnabled(skill, skill.state === 'disabled'); } break;
				case 'delete': if (skill && skill.scope !== 'claudeai') {
					const ok = await vscode.window.showWarningMessage(`Excluir a skill "${skill.name}"? A pasta vai para a lixeira.`,
						{ modal: true, detail: skill.dir }, 'Excluir');
					if (ok === 'Excluir') { await vscode.workspace.fs.delete(vscode.Uri.file(skill.dir), { recursive: true, useTrash: true }); }
				} break;
				case 'create': await this.create(message.scope === 'project' ? 'project' : 'global'); break;
			}
		} catch (error) {
			void vscode.window.showErrorMessage(`Skills: ${error instanceof Error ? error.message : String(error)}`);
		}
		await this.post();
	}

	private async create(scope: Exclude<SkillScope, 'claudeai'>): Promise<void> {
		const root = scope === 'project' ? projectRoot() : globalRoot();
		if (!root) { void vscode.window.showWarningMessage('Abra uma pasta para criar uma skill do projeto.'); return; }
		const name = await vscode.window.showInputBox({
			prompt: `Nome da skill ${scope === 'project' ? 'do projeto' : 'global'} (minúsculas, números e hífens)`,
			validateInput: (v) => validSkillName(v) ? undefined : 'Ex.: minha-skill',
		});
		if (!name) { return; }
		const description = await vscode.window.showInputBox({ prompt: 'Quando o Claude deve usar esta skill? (descrição)' });
		if (description === undefined) { return; }
		await vscode.window.showTextDocument(vscode.Uri.file(await createSkill(root, name, description)));
	}

	private html(webview: vscode.Webview, media: vscode.Uri): string {
		const n = nonce();
		const uri = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(media, ...p));
		return `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${n}';" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="${uri('codicons', 'codicon.css')}" /><link rel="stylesheet" href="${uri('base.css')}" /><link rel="stylesheet" href="${uri('skills.css')}" />
<title>Skills</title></head>
<body><div id="root"><p class="loading muted"><span class="codicon codicon-loading codicon-modifier-spin"></span> Carregando…</p></div>
<script nonce="${n}" src="${uri('skills.js')}"></script></body></html>`;
	}
}

export function registerSkills(context: vscode.ExtensionContext): void {
	const provider = new SkillsViewProvider(context);
	const watchers = [globalRoot(), projectRoot()].filter((r): r is string => Boolean(r)).map((root) => {
		const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(root), '**'));
		w.onDidCreate(() => provider.refresh()); w.onDidDelete(() => provider.refresh()); w.onDidChange(() => provider.refresh());
		return w;
	});
	context.subscriptions.push(provider, ...watchers,
		vscode.window.registerWebviewViewProvider(VIEW_ID, provider),
		vscode.workspace.onDidChangeWorkspaceFolders(() => provider.refresh(0)),
		vscode.commands.registerCommand('claude-code-launcher.skills.refresh', () => provider.refresh(0)),
		vscode.commands.registerCommand('claude-code-launcher.skills.create', () => vscode.commands.executeCommand(`${VIEW_ID}.focus`)),
	);
}
