import * as path from 'node:path';
import * as vscode from 'vscode';
import { createSkill, DISABLED_FILE, globalSkillsRoot, scanSkills, scanSynced, setSkillEnabled, SKILL_FILE, validSkillName, type SkillInfo, type SkillScope } from './skills';
import { t } from './i18n';

const globalRoot = () => globalSkillsRoot();
/** `.claude/skills` de cada pasta local do workspace, na ordem do editor. */
const projectRoots = (): Array<{ root: string; name: string }> => (vscode.workspace.workspaceFolders ?? [])
	.filter((folder) => folder.uri.scheme === undefined || folder.uri.scheme === 'file')
	.map((folder) => ({ root: path.join(folder.uri.fsPath, '.claude', 'skills'), name: folder.name || path.basename(folder.uri.fsPath) }));

type ListedSkill = SkillInfo & { folder?: string };

async function loadSkills(): Promise<ListedSkill[]> {
	const projects = projectRoots();
	const [globalSkills, synced, ...projectSkills] = await Promise.all([
		scanSkills(globalRoot(), 'global'),
		scanSynced(globalRoot()),
		// A primeira pasta mantém os ids de sempre; as outras recebem um sufixo.
		...projects.map(async (project, position) => (await scanSkills(project.root, 'project')).map((skill): ListedSkill => ({
			...skill, id: position === 0 ? skill.id : `${skill.id}@${position}`, folder: projects.length > 1 ? project.name : undefined,
		}))),
	]);
	return [...projectSkills.flat(), ...globalSkills, ...synced];
}

/** Pasta de skills onde criar: a única aberta ou a que o usuário escolher. */
async function pickProjectRoot(): Promise<string | undefined> {
	const projects = projectRoots();
	if (projects.length <= 1) { return projects[0]?.root; }
	const picked = await vscode.window.showWorkspaceFolderPick({ placeHolder: t('Em qual pasta do workspace?') });
	return picked ? path.join(picked.uri.fsPath, '.claude', 'skills') : undefined;
}

/** Lista de skills desenhada dentro da view do launcher (a mesma página das conversas). */
export class SkillsController implements vscode.Disposable {
	private skills = new Map<string, ListedSkill>();
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
			type: 'skills', hasProject: projectRoots().length > 0,
			skills: skills.map(({ id, name, description, scope, state, folder }) => ({ id, name, description, scope, state, ...(folder ? { folder } : {}) })),
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
					const remove = t('Excluir');
					const ok = await vscode.window.showWarningMessage(t('Excluir a skill "{0}"? A pasta vai para a lixeira.', skill.name),
						{ modal: true, detail: skill.dir }, remove);
					if (ok === remove) { await vscode.workspace.fs.delete(vscode.Uri.file(skill.dir), { recursive: true, useTrash: true }); }
				} break;
				case 'skills.create': await this.create(key === 'project' ? 'project' : 'global'); break;
			}
		} catch (error) {
			void vscode.window.showErrorMessage(t('Skills: {0}', error instanceof Error ? error.message : String(error)));
		}
		await this.post();
	}

	private async create(scope: Exclude<SkillScope, 'claudeai'>): Promise<void> {
		if (scope === 'project' && !projectRoots().length) { void vscode.window.showWarningMessage(t('Abra uma pasta para criar uma skill do projeto.')); return; }
		const root = scope === 'project' ? await pickProjectRoot() : globalRoot();
		if (!root) { return; }
		const name = await vscode.window.showInputBox({
			prompt: scope === 'project' ? t('Nome da skill do projeto (minúsculas, números e hífens)') : t('Nome da skill global (minúsculas, números e hífens)'),
			validateInput: (v) => validSkillName(v) ? undefined : t('Ex.: {0}', t('minha-skill')),
		});
		if (!name) { return; }
		const description = await vscode.window.showInputBox({ prompt: t('Quando o Claude deve usar esta skill? (descrição)') });
		if (description === undefined) { return; }
		await vscode.window.showTextDocument(vscode.Uri.file(await createSkill(root, name, description)));
	}
}

export function registerSkills(context: vscode.ExtensionContext, postToView: (message: unknown) => void): SkillsController {
	const controller = new SkillsController(postToView);
	// A troca de abas (e o contexto que esconde o painel de Mudanças) fica em catalog-view.ts.
	let watchers: vscode.Disposable[] = [];
	const rewatch = () => {
		watchers.forEach((w) => w.dispose());
		watchers = [globalRoot(), ...projectRoots().map((project) => project.root)].map((root) => {
			const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(root), '**'));
			w.onDidCreate(() => controller.refresh()); w.onDidDelete(() => controller.refresh()); w.onDidChange(() => controller.refresh());
			return w;
		});
	};
	rewatch();
	context.subscriptions.push(controller, { dispose: () => watchers.forEach((w) => w.dispose()) },
		vscode.workspace.onDidChangeWorkspaceFolders(() => { rewatch(); controller.refresh(0); }),
		vscode.commands.registerCommand('claude-code-launcher.skills.refresh', () => controller.refresh(0)),
	);
	return controller;
}
