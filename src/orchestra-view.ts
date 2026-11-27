import { spawn, execFile, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { t } from './i18n';
import { findExecutable } from './node-runtime';
import {
	actionArgs, cliError, jobActions, parseProviders, projectTemplate, PROVIDERS, readJobs, resolveCli, validJobId, validRequest,
	type CliCommand, type JobView, type OrchestraAction, type OrchestraProvider, type ProvidersView,
} from './orchestra';

/** Linhas do log ao vivo que a página mostra; o canal de saída guarda tudo. */
const LOG_LINES = 14;
const SETTING = 'claudeCodeLauncher.orchestrator.cliPath';

interface Running {
	child: ChildProcess;
	label: string;
	jobId?: string;
	startedAt: number;
	log: string[];
	stopping: boolean;
}

interface Folder { root: string; name: string }

const localFolders = (): Folder[] => (vscode.workspace.workspaceFolders ?? [])
	.filter((folder) => folder.uri.scheme === 'file')
	.map((folder) => ({ root: folder.uri.fsPath, name: folder.name || path.basename(folder.uri.fsPath) }));

/** Mata a CLI. No Windows vai a árvore inteira; no resto, a CLI recebe SIGTERM e encerra o modelo e o teste ela mesma. */
function stopProcess(child: ChildProcess): void {
	if (!child.pid || child.exitCode !== null) { return; }
	if (process.platform === 'win32') {
		execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => { /* já saiu */ });
	} else {
		child.kill('SIGTERM');
	}
}

/** Aba "Orquestrador" da view do launcher: pedido, plano, passos e PR, sempre pela CLI `orquestra`. */
export class OrchestraController implements vscode.Disposable {
	active = false;
	private folderIndex = 0;
	private jobs: JobView[] = [];
	private providers: ProvidersView | undefined;
	private checkingProviders = false;
	private cli: CliCommand | undefined;
	private cliChecked = false;
	private running: Running | undefined;
	private lastError: string | undefined;
	private postTimer: NodeJS.Timeout | undefined;
	private jobsTimer: NodeJS.Timeout | undefined;
	private watchers: vscode.Disposable[] = [];
	private disposed = false;
	private readonly output = vscode.window.createOutputChannel('Orquestra');

	constructor(private readonly context: vscode.ExtensionContext, private readonly postToView: (message: unknown) => void) {
		this.rewatch();
		context.subscriptions.push(this.output,
			vscode.workspace.onDidChangeWorkspaceFolders(() => { this.folderIndex = 0; this.rewatch(); this.refreshJobs(0); }),
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration(SETTING)) { this.cliChecked = false; this.providers = undefined; void this.refresh(true); }
			}));
	}

	dispose(): void {
		this.disposed = true;
		clearTimeout(this.postTimer); clearTimeout(this.jobsTimer);
		this.watchers.forEach((w) => w.dispose());
		// Fechar o editor não deixa um modelo editando sozinho.
		if (this.running) { stopProcess(this.running.child); }
	}

	private folder(): Folder | undefined {
		const folders = localFolders();
		return folders[Math.min(this.folderIndex, folders.length - 1)];
	}

	/** Jobs e `project.json` mudam pela CLI: o watcher redesenha sem precisar perguntar a ela. */
	private rewatch(): void {
		this.watchers.forEach((w) => w.dispose());
		this.watchers = localFolders().map((folder) => {
			const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(folder.root), '.orquestra/{project.json,jobs/*.json}'));
			const changed = () => this.refreshJobs();
			w.onDidCreate(changed); w.onDidChange(changed); w.onDidDelete(changed);
			return w;
		});
	}

	private async findCli(): Promise<CliCommand | undefined> {
		if (this.cliChecked) { return this.cli; }
		const env = process.env as Record<string, string | undefined>;
		const [onPath, node] = await Promise.all([
			findExecutable('orquestra', { env, platform: process.platform }),
			findExecutable('node', { env, platform: process.platform }),
		]);
		this.cli = resolveCli({
			setting: vscode.workspace.getConfiguration().inspect<string>(SETTING)?.globalValue,
			extensionPath: this.context.extensionPath, onPath, node, fallbackNode: process.execPath, platform: process.platform,
		});
		this.cliChecked = true;
		return this.cli;
	}

	/** `providers --json`: confere claude, codex e gh sem chamar modelo. Leva um ou dois segundos. */
	private async checkProviders(): Promise<void> {
		const folder = this.folder();
		const cli = await this.findCli();
		if (!folder || !cli || this.checkingProviders) { return; }
		this.checkingProviders = true;
		this.schedulePost(0);
		try {
			const { stdout } = await this.capture(cli, actionArgs({ kind: 'providers' }), folder.root);
			this.providers = parseProviders(stdout);
		} finally {
			this.checkingProviders = false;
			this.schedulePost(0);
		}
	}

	/** Roda a CLI até o fim e devolve a saída. Para consultas curtas (providers, status). */
	private capture(cli: CliCommand, args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
		return new Promise((resolve) => {
			const child = spawn(cli.file, [...cli.prefix, ...args], { cwd, env: this.env(cli), windowsHide: true, shell: false });
			let stdout = '', stderr = '';
			child.stdout?.on('data', (b: Buffer) => { stdout += b.toString('utf8'); });
			child.stderr?.on('data', (b: Buffer) => { stderr += b.toString('utf8'); });
			child.stdin?.end();
			const timer = setTimeout(() => stopProcess(child), 60_000);
			child.on('error', (error) => { clearTimeout(timer); resolve({ code: null, stdout, stderr: `${stderr}\norquestra: ${error.message}` }); });
			child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
		});
	}

	private env(cli: CliCommand): NodeJS.ProcessEnv {
		const env: NodeJS.ProcessEnv = { ...process.env };
		if (cli.electronAsNode) { env.ELECTRON_RUN_AS_NODE = '1'; } else { delete env.ELECTRON_RUN_AS_NODE; }
		return env;
	}

	/** Uma ação longa por vez: o log vai para a aba e para o canal "Orquestra". */
	private async start(action: OrchestraAction, label: string, input?: string): Promise<void> {
		const folder = this.folder();
		const cli = await this.findCli();
		if (this.running || !folder || !cli) { return; }
		const args = actionArgs(action);
		this.lastError = undefined;
		this.output.appendLine(`\n$ orquestra ${args.join(' ')}   (${folder.root})`);
		const child = spawn(cli.file, [...cli.prefix, ...args], { cwd: folder.root, env: this.env(cli), windowsHide: true, shell: false });
		const running: Running = { child, label, jobId: 'id' in action ? action.id : undefined, startedAt: Date.now(), log: [], stopping: false };
		this.running = running;
		this.schedulePost(0);
		let stderr = '';
		const onText = (text: string, isErr: boolean) => {
			if (isErr) { stderr = (stderr + text).slice(-20_000); }
			this.output.append(text);
			for (const line of text.split(/\r?\n/)) {
				if (line.trim()) { running.log.push(line.slice(0, 400)); }
			}
			running.log.splice(0, Math.max(0, running.log.length - 200));
			this.schedulePost();
		};
		child.stdout?.on('data', (b: Buffer) => onText(b.toString('utf8'), false));
		child.stderr?.on('data', (b: Buffer) => onText(b.toString('utf8'), true));
		child.stdin?.on('error', () => { /* a CLI pode sair antes de ler */ });
		child.stdin?.end(input ?? '');
		await new Promise<void>((resolve) => {
			let done = false;
			const finish = (code: number | null, spawnError?: string) => {
				if (done) { return; }
				done = true;
				this.running = undefined;
				const message = spawnError ?? cliError(stderr);
				if (message && !running.stopping) {
					this.lastError = message;
					void vscode.window.showErrorMessage(t('Orquestrador: {0}', message));
				}
				this.output.appendLine(running.stopping ? t('[parado]') : t('[saiu com código {0}]', String(code)));
				this.refreshJobs(0);
				resolve();
			};
			child.on('error', (error) => finish(null, error.message));
			child.on('close', (code) => finish(code));
		});
	}

	/** Agrupa as atualizações: o log chega linha a linha. */
	private schedulePost(delay = 200): void {
		if (this.disposed) { return; }
		clearTimeout(this.postTimer);
		this.postTimer = setTimeout(() => { void this.post(); }, delay);
	}

	refreshJobs(delay = 300): void {
		if (this.disposed) { return; }
		clearTimeout(this.jobsTimer);
		this.jobsTimer = setTimeout(() => {
			const folder = this.folder();
			void (folder ? readJobs(folder.root) : Promise.resolve([])).then((jobs) => { this.jobs = jobs; this.schedulePost(0); });
		}, delay);
	}

	/** Atualiza tudo. `providers` refaz a checagem dos CLIs (mais lenta). */
	async refresh(providers = false): Promise<void> {
		const folder = this.folder();
		this.jobs = folder ? await readJobs(folder.root) : [];
		await this.post();
		if (providers || (!this.providers && !this.checkingProviders)) { void this.checkProviders(); }
	}

	async post(): Promise<void> {
		if (this.disposed) { return; }
		const folders = localFolders();
		const folder = this.folder();
		const cli = await this.findCli();
		const running = this.running;
		this.postToView({
			type: 'orchestra',
			folders: folders.map((f) => f.name),
			folderIndex: folders.length ? Math.min(this.folderIndex, folders.length - 1) : 0,
			hasFolder: !!folder,
			hasProject: folder ? fs.existsSync(path.join(folder.root, '.orquestra', 'project.json')) : false,
			cli: cli ? { found: true, source: cli.source } : { found: false },
			providers: this.providers ?? null,
			checkingProviders: this.checkingProviders,
			running: running ? { label: running.label, jobId: running.jobId, startedAt: running.startedAt, log: running.log.slice(-LOG_LINES), stopping: running.stopping } : null,
			lastError: this.lastError ?? null,
			jobs: this.jobs.map((job) => ({ ...job, actions: jobActions(job) })),
		});
	}

	private job(id: string | undefined): JobView | undefined {
		return validJobId(id) ? this.jobs.find((j) => j.id === id) : undefined;
	}

	private async confirm(message: string, detail: string, action: string): Promise<boolean> {
		return (await vscode.window.showWarningMessage(message, { modal: true, detail }, action)) === action;
	}

	/** `command` já passou pela lista da view. `id` só vale se for de um job listado; `text` é o pedido. */
	async handle(command: string, id?: string, key?: string, text?: string): Promise<void> {
		const job = this.job(id);
		try {
			switch (command) {
				case 'orchestra.refresh': await this.refresh(key === 'providers'); return;
				case 'orchestra.folder': {
					const index = Number(key);
					if (Number.isInteger(index) && index >= 0 && index < localFolders().length) { this.folderIndex = index; this.providers = undefined; await this.refresh(true); }
					return;
				}
				case 'orchestra.plan': {
					if (!validRequest(text)) { return; }
					const provider = PROVIDERS.includes(key as OrchestraProvider) ? key as OrchestraProvider : undefined;
					// O texto do pedido vai pelo stdin: nada dele chega à linha de comando.
					void this.start({ kind: 'plan', provider }, t('Planejando…'), text);
					return;
				}
				case 'orchestra.confirm': if (job && !job.planConfirmed) {
					void this.start({ kind: 'confirm', id: job.id, pr: key === 'pr' }, t('Executando o plano…'));
				} return;
				case 'orchestra.resume': if (job) { void this.start({ kind: 'resume', id: job.id, discard: false }, t('Retomando…')); } return;
				case 'orchestra.discard': if (job && await this.confirm(t('Descartar as mudanças não commitadas e retomar?'),
					t('Volta a árvore ao último commit do branch {0}. O que um passo interrompido deixou pela metade é apagado; os passos já commitados ficam.', job.branch), t('Descartar e retomar'))) {
					void this.start({ kind: 'resume', id: job.id, discard: true }, t('Retomando…'));
				} return;
				case 'orchestra.pr': if (job && await this.confirm(t('Enviar o branch e abrir o pull request?'),
					t('O branch {0} vai para o remoto do projeto (git push, sem forçar) e o gh abre um PR com o seu login.', job.branch), t('Enviar e abrir PR'))) {
					void this.start({ kind: 'pr', id: job.id }, t('Abrindo o pull request…'));
				} return;
				case 'orchestra.drop': if (job && !job.planConfirmed && await this.confirm(t('Descartar este plano?'),
					t('Nada foi editado e nenhum branch foi criado. O job sai da lista.'), t('Descartar plano'))) {
					void this.start({ kind: 'drop', id: job.id }, t('Descartando…'));
				} return;
				case 'orchestra.stop': if (this.running && !this.running.stopping) {
					this.running.stopping = true;
					stopProcess(this.running.child);
					this.schedulePost(0);
				} return;
				case 'orchestra.openPr': if (job?.prUrl) { await vscode.env.openExternal(vscode.Uri.parse(job.prUrl, true)); } return;
				case 'orchestra.details': {
					const folder = this.folder();
					const cli = await this.findCli();
					if (job && folder && cli) {
						const r = await this.capture(cli, actionArgs({ kind: 'status', id: job.id }), folder.root);
						this.output.appendLine(`\n${r.stdout.trimEnd() || r.stderr.trimEnd()}`);
					}
					this.output.show(true);
					return;
				}
				case 'orchestra.log': this.output.show(true); return;
				case 'orchestra.createProject': await this.createProject(); return;
				case 'orchestra.settings': await vscode.commands.executeCommand('workbench.action.openSettings', SETTING); return;
			}
		} catch (error) {
			void vscode.window.showErrorMessage(t('Orquestrador: {0}', error instanceof Error ? error.message : String(error)));
		}
	}

	/** Cria `.orquestra/project.json` com um modelo e abre para a pessoa ajustar o teste. Nunca sobrescreve. */
	private async createProject(): Promise<void> {
		const folder = this.folder();
		if (!folder) { return; }
		const file = path.join(folder.root, '.orquestra', 'project.json');
		if (!fs.existsSync(file)) {
			let pkg: string | undefined;
			try { pkg = await fs.promises.readFile(path.join(folder.root, 'package.json'), 'utf8'); } catch { /* sem package.json */ }
			await fs.promises.mkdir(path.dirname(file), { recursive: true });
			await fs.promises.writeFile(file, projectTemplate(pkg), { flag: 'wx' });
		}
		await vscode.window.showTextDocument(vscode.Uri.file(file));
		this.schedulePost(0);
	}
}
