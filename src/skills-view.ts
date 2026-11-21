import * as path from 'node:path';
import * as vscode from 'vscode';
import { createSkill, DISABLED_FILE, globalSkillsRoot, scanSkills, scanSynced, setSkillEnabled, SKILL_FILE, validSkillName, type SkillInfo, type SkillScope } from './skills';

const globalRoot = () => globalSkillsRoot();
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

/** Lista de skills desenhada dentro da view do launcher (a mesma página das conversas). */
export class SkillsController implements vscode.Disposable {
	private skills = new Map<string, SkillInfo>();
	private timer?: NodeJS.Timeout;
	private disposed = false;
	constructor(private readonly postToView: (message: unknown) => void) {}

	refresh(delay = 250): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => { void this.post(); }, delay);
	}

	dispose(): void { this.disposed = true; clearTimeout(this.timer); }

	async post(): Promise<void> {
		if (this.disposed) { return; }
		const skills = await loadSkills();
		this.skills = new Map(skills.map((s) => [s.id, s]));
		this.postToView({
			type: 'skills', hasProject: Boolean(projectRoot()),
			skills: skills.map(({ id, name, description, scope, state }) => ({ id, name, description, scope, state })),
		});
	}

	/** `command` já validado pela lista de comandos da view; `id` só vale se for de uma skill listada. */
	async handle(command: string, id?: string, key?: string): Promise<void> {
		const skill = id ? this.skills.get(id) : undefined;
		try {
			switch (command) {
				case 'skills.refresh': break;
				case 'skills.open': if (skill && skill.state !== 'broken') {
					await vscode.window.showTextDocument(vscode.Uri.file(path.join(skill.dir, skill.state === 'disabled' ? DISABLED_FILE : SKILL_FILE)));
				} break;
				case 'skills.reveal': if (skill) { await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(skill.dir)); } break;
				case 'skills.toggle': if (skill && skill.scope !== 'claudeai') { await setSkillEnabled(skill, skill.state === 'disabled'); } break;
				case 'skills.delete': if (skill && skill.scope !== 'claudeai') {
					const ok = await vscode.window.showWarningMessage(`Excluir a skill "${skill.name}"? A pasta vai para a lixeira.`,
						{ modal: true, detail: skill.dir }, 'Excluir');
					if (ok === 'Excluir') { await vscode.workspace.fs.delete(vscode.Uri.file(skill.dir), { recursive: true, useTrash: true }); }
				} break;
				case 'skills.create': await this.create(key === 'project' ? 'project' : 'global'); break;
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
}

export function registerSkills(context: vscode.ExtensionContext, postToView: (message: unknown) => void): SkillsController {
	const controller = new SkillsController(postToView);
	// Só o painel de Mudanças depende deste contexto: aparece na aba de conversas e some na de skills.
	const setPanel = (panel: 'chats' | 'skills') => vscode.commands.executeCommand('setContext', 'claudeCodeLauncher.panel', panel);
	void setPanel('chats');
	const watchers = [globalRoot(), projectRoot()].filter((r): r is string => Boolean(r)).map((root) => {
		const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(root), '**'));
		w.onDidCreate(() => controller.refresh()); w.onDidDelete(() => controller.refresh()); w.onDidChange(() => controller.refresh());
		return w;
	});
	context.subscriptions.push(controller, ...watchers,
		vscode.workspace.onDidChangeWorkspaceFolders(() => controller.refresh(0)),
		vscode.commands.registerCommand('claude-code-launcher.showSkills', () => setPanel('skills')),
		vscode.commands.registerCommand('claude-code-launcher.showChats', () => setPanel('chats')),
		vscode.commands.registerCommand('claude-code-launcher.skills.refresh', () => controller.refresh(0)),
	);
	return controller;
}
