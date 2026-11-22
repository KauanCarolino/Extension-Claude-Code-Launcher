/**
 * Instalação e conferência da captura por pasta: o script do hook, a política de cópias, os handlers
 * em `.claude/settings.local.json` e o ambiente em que o hook roda. O controlador da revisão decide
 * quando agir; aqui fica como cada passo é feito com segurança.
 */
import * as vscode from 'vscode';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { applyHookPlan, configFingerprint, HookCapability, HookPlan, planHooks, SettingsRead } from './hooks';
import { assessStoragePath, CAPTURE_POLICY_FILE, CapturePolicy, makeCapturePolicy, safeReadText, validateCapturePolicy } from './history';
import { findExecutable } from './node-runtime';
import { writeOwnedFile } from './owned-file';
import { ReviewError } from './review';
import type { ReviewStore } from './review-store';
import { excludedPatterns, HOOK_SCRIPT_RESTORED } from './changes-view';
import { existsLocal } from './changes-support';
import { t } from './i18n';

export const HOOK_FILE = 'launcher-record-change.js';
/** Identificador usado até a 0.13.x; o globalStorage de instalações antigas fica sob ele. */
const LEGACY_EXTENSION_ID = 'kauan.claude-code-launcher';
export const LOG_DIR = ['.claude', 'launcher-changes'];
export const SETTINGS_PATH = ['.claude', 'settings.local.json'];
/** Validade da busca pelo executável do hook no PATH. */
const NODE_LOOKUP_MS = 60 * 1000;

/** O que a configuração precisa do controlador: a posse dos dados da revisão de cada pasta. */
export interface CaptureSetupHost {
	ensureStore(folder: vscode.WorkspaceFolder, allowPurgeRecovery?: boolean): Promise<ReviewStore>;
	storeOf(folder: vscode.WorkspaceFolder): ReviewStore | undefined;
	/** A janela foi fechada: nenhum efeito novo deve começar. */
	cancelled(): boolean;
	/** Há manutenção em andamento: restaurações automáticas esperam. */
	inMaintenance(): boolean;
}

export class CaptureSetup {
	/** Última busca pelo `node` no PATH; testes podem fixá-la. */
	nodeLookup: { at: number; found: boolean } | undefined;
	private packagedHook: string | undefined;

	constructor(private readonly context: vscode.ExtensionContext, private readonly host: CaptureSetupHost) {}

	readSettings(folder: vscode.WorkspaceFolder): Promise<SettingsRead> { return safeReadText(nodePath.join(folder.uri.fsPath, ...SETTINGS_PATH), folder.uri.fsPath); }

	scriptUri(folder: vscode.WorkspaceFolder): vscode.Uri { return vscode.Uri.joinPath(folder.uri, ...LOG_DIR, HOOK_FILE); }

	scriptPath(folder: vscode.WorkspaceFolder): string { return this.scriptUri(folder).fsPath.replace(/\\/g, '/'); }

	/** Hooks legados no globalStorage: o desta extensão e o do identificador anterior à 1.0.0 (`kauan.claude-code-launcher`). */
	knownHookPaths(): string[] {
		const current = vscode.Uri.joinPath(this.context.globalStorageUri, HOOK_FILE).fsPath;
		const legacy = nodePath.join(nodePath.dirname(this.context.globalStorageUri.fsPath), LEGACY_EXTENSION_ID, HOOK_FILE);
		return current === legacy ? [current] : [current, legacy];
	}

	async hookCapability(): Promise<HookCapability> {
		const config = vscode.workspace.getConfiguration('claudeCodeLauncher'); const mode = config.get<string>('hookExecutionMode', 'auto');
		if (mode === 'disabled') { return { status: 'unsupported', harness: 'disabled' }; }
		if (mode === 'exec') { return { status: 'confirmed', harness: 'operator-selected-exec', evidence: 'Explicit command+args contract selected in settings.' }; }
		if (vscode.workspace.getConfiguration('claudeCode').get<string>('claudeProcessWrapper')) { return { status: 'unknown', harness: 'external-wrapper' }; }
		const extension = vscode.extensions.getExtension('anthropic.claude-code');
		if (extension) {
			try {
				const file = nodePath.join(extension.extensionPath, 'claude-code-settings.schema.json');
				const stat = await nodeFs.promises.stat(file); if (stat.size > 4 * 1024 * 1024) { throw new Error('schemaBudget'); }
				const schema = JSON.parse(await nodeFs.promises.readFile(file, 'utf8'));
				const variants = schema?.properties?.hooks?.additionalProperties?.items?.properties?.hooks?.items?.anyOf;
				if (Array.isArray(variants) && variants.some((variant: any) => variant?.properties?.type?.const === 'command' && variant?.properties?.command?.type === 'string' && variant?.properties?.args?.type === 'array' && variant?.properties?.args?.items?.type === 'string')) {
					return { status: 'confirmed', harness: 'anthropic.claude-code', version: extension.packageJSON?.version, evidence: 'Installed command-hook schema variant supports exec args.' };
				}
			} catch { /* Unknown does not enable a shell fallback. */ }
		}
		return { status: 'unknown', harness: 'unverified-runtime' };
	}

	async readCapturePolicy(folder: vscode.WorkspaceFolder): Promise<CapturePolicy | undefined> {
		const read = await safeReadText(nodePath.join(folder.uri.fsPath, ...LOG_DIR, CAPTURE_POLICY_FILE), folder.uri.fsPath, 64 * 1024);
		if (read.kind === 'absent') { return undefined; }
		if (read.kind === 'error') { throw new ReviewError(read.code); }
		let parsed: unknown; try { parsed = JSON.parse(read.text.replace(/^﻿/, '')); } catch { throw new ReviewError('invalidCapturePolicy'); }
		if (!validateCapturePolicy(parsed)) { throw new ReviewError('unsupportedCapturePolicy'); }
		return parsed;
	}

	async writeCapturePolicy(folder: vscode.WorkspaceFolder, paused: boolean, allowPurgeRecovery = false): Promise<void> {
		const store = await this.host.ensureStore(folder, allowPurgeRecovery); const config = vscode.workspace.getConfiguration('claudeCodeLauncher');
		const policy = makeCapturePolicy({ paused, excludedPatterns: excludedPatterns(config), maxStorageMB: config.get<number>('historyMaxStorageMB', 128), retentionDays: config.get<number>('historyRetentionDays', 30) });
		const file = nodePath.join(store.directory, CAPTURE_POLICY_FILE), read = await safeReadText(file, store.root);
		if (read.kind === 'error') { throw new ReviewError(read.code); }
		if (read.kind === 'content') {
			const prior = await this.readCapturePolicy(folder); if (prior && JSON.stringify({ ...prior, generation: '' }) === JSON.stringify({ ...policy, generation: '' })) { return; }
		}
		await this.writeOwned(store, file, JSON.stringify(policy) + '\n', read.kind === 'content' ? read.text : undefined);
	}

	async installHookScript(folder: vscode.WorkspaceFolder): Promise<void> {
		const store = await this.host.ensureStore(folder), dir = store.directory;
		const ignore = nodePath.join(dir, '.gitignore');
		if (!(await existsLocal(ignore))) { await this.writeOwned(store, ignore, '*\n', undefined); }
		const text = await this.packagedHookText();
		const file = this.scriptUri(folder).fsPath, read = await safeReadText(file, store.root);
		if (read.kind === 'error') { throw new ReviewError(read.code); }
		if (read.kind !== 'content' || read.text !== text) { await this.writeOwned(store, file, text, read.kind === 'content' ? read.text : undefined); }
	}

	async prepareHookPlan(folder: vscode.WorkspaceFolder, enable: boolean): Promise<HookPlan> {
		return planHooks({ read: await this.readSettings(folder), scriptPath: this.scriptPath(folder), knownScriptPaths: this.knownHookPaths(), enable, capability: await this.hookCapability() });
	}

	async writeHooks(folder: vscode.WorkspaceFolder, enable: boolean, prepared?: HookPlan): Promise<void> {
		const store = await this.host.ensureStore(folder), file = nodePath.join(folder.uri.fsPath, ...SETTINGS_PATH);
		const plan = prepared ?? await this.prepareHookPlan(folder, enable);
		const result = await applyHookPlan(plan, {
			read: () => this.readSettings(folder),
			assertOwnership: async () => { if (!store.writable) { throw new ReviewError('readOnlyOwner'); } await store.update(() => undefined); },
			backup: async (text, fingerprint) => {
				const directory = nodePath.join(store.directory, 'settings-backups'); const scope = await assessStoragePath(directory, store.root); if (!scope.allowed) { throw new ReviewError('unsafeStorageType'); }
				await nodeFs.promises.mkdir(directory, { recursive: true, mode: 0o700 }); const backup = nodePath.join(directory, fingerprint + '.json');
				try { await nodeFs.promises.writeFile(backup, text, { flag: 'wx', mode: 0o600 }); } catch (error) { if ((error as { code?: string }).code !== 'EEXIST') { throw error; } }
			},
			write: async (text, fingerprint) => { const read = await this.readSettings(folder); if (read.kind === 'error' || configFingerprint(read.kind === 'content' ? read.text : undefined) !== fingerprint) { throw new ReviewError('settingsChanged'); } await this.writeOwned(store, file, text, read.kind === 'content' ? read.text : undefined); },
		});
		if (!['persisted', 'unchanged'].includes(result.kind)) { throw new ReviewError(result.code || result.kind); }
	}

	/**
	 * O script do hook fica no projeto e roda a cada edição do Claude, com as permissões do usuário.
	 * Qualquer processo com escrita na pasta pode trocá-lo, então a cópia é conferida a cada atualização
	 * e restaurada pela janela dona da revisão. A troca só deixa de valer a partir dessa conferência.
	 */
	async verifyHookScript(folder: vscode.WorkspaceFolder): Promise<'ok' | 'restored' | 'differs'> {
		const store = this.host.storeOf(folder);
		// Sem os dados da revisão abertos não há como restaurar; a ativação e a próxima atualização cobrem o caso.
		if (!store) { return 'ok'; }
		try {
			const read = await safeReadText(this.scriptUri(folder).fsPath, folder.uri.fsPath);
			if (read.kind === 'content' && read.text === await this.packagedHookText()) { return 'ok'; }
			if (!store.writable || this.host.inMaintenance() || this.host.cancelled()) { return 'differs'; }
			await this.installHookScript(folder);
			// Script ausente é reposto em silêncio; conteúdo diferente pode ser adulteração e merece aviso.
			if (read.kind === 'content') { void vscode.window.showWarningMessage(t(HOOK_SCRIPT_RESTORED)); }
			return 'restored';
		} catch { return 'differs'; }
	}

	/** O hook é registrado como `node <script> <fase>`; sem `node` no PATH ele nunca roda, e nada falha à vista. */
	async nodeAvailable(): Promise<boolean> {
		if (this.nodeLookup && Date.now() - this.nodeLookup.at < NODE_LOOKUP_MS) { return this.nodeLookup.found; }
		let found = true; // Uma busca que falha não é prova de ausência.
		try { found = Boolean(await findExecutable('node', { env: process.env, platform: process.platform })); } catch { /* Mantém o benefício da dúvida. */ }
		this.nodeLookup = { at: Date.now(), found };
		return found;
	}

	/** Gravação de um arquivo próprio, cancelada quando a janela fecha. */
	writeOwned(store: ReviewStore, file: string, text: string, expected: string | undefined, assertPermits?: () => Promise<void>): Promise<void> {
		return writeOwnedFile(store, file, text, expected, { cancelled: () => this.host.cancelled(), assertPermits });
	}

	private async packagedHookText(): Promise<string> {
		return this.packagedHook ??= await nodeFs.promises.readFile(vscode.Uri.joinPath(this.context.extensionUri, 'hooks', 'record-change.js').fsPath, 'utf8');
	}
}
