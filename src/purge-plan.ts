/** Read-only inventory and redacted purge results. The controller owns confirmation, locks and effects. */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export const PURGE_CATEGORIES = ['capture', 'history', 'blobs', 'canonical', 'metadata', 'projection', 'undo', 'backups', 'cache'] as const;
export type PurgeCategory = typeof PURGE_CATEGORIES[number];
export type PurgeReason = 'none' | 'ownershipRequired' | 'captureInProgress' | 'scanBudget' | 'scanDepth'
	| 'unsafeType' | 'scopeUnknown' | 'readUnavailable' | 'unknownPreserved' | 'changedSincePlan'
	| 'operationFailed' | 'cancelled' | 'memoryUnavailable';
export interface PurgeItem { relativePath: string; category: PurgeCategory; kind: 'file' | 'directory' }
export interface PurgeUnknown { category: PurgeCategory | 'unknown'; kind: 'file' | 'directory' | 'link' | 'unknown' }
export interface PurgeMemory { undoCount: number | null; cacheCount: number | null; complete: boolean }
export const PURGE_MEMORY_PATHS = { undo: '@memory/undo', cache: '@memory/cache' } as const;
export interface PurgeInventory {
	coverage: 'complete' | 'partial'; issues: PurgeReason[]; items: PurgeItem[];
	unknown: PurgeUnknown[]; protectedDirectories: string[]; activeProducer: boolean; memory: PurgeMemory;
}
export interface PurgeIO {
	realpath(file: string): Promise<string>;
	lstat(file: string): Promise<{ isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }>;
	opendir(file: string, options?: { bufferSize: number }): Promise<{ read(): Promise<{ name: string } | null>; close(): Promise<void> }>;
}
export interface PurgeEffect {
	relativePath: string; category: PurgeCategory; outcome: 'removed' | 'remaining' | 'blocked' | 'failed'; reason?: PurgeReason;
}
export interface PurgeCategoryResult {
	category: PurgeCategory | 'unknown'; outcome: PurgeEffect['outcome'];
	beforeCount: number | null; remainingCount: number | null; removedCount: number; reasons: PurgeReason[];
}
export interface PurgeReport {
	outcome: 'complete' | 'partial' | 'blocked' | 'failed'; coverage: 'complete' | 'partial';
	categories: PurgeCategoryResult[]; unknownPreserved: number; unknownCountIsLowerBound: boolean;
}
const REASONS: readonly PurgeReason[] = ['none', 'ownershipRequired', 'captureInProgress', 'scanBudget', 'scanDepth',
	'unsafeType', 'scopeUnknown', 'readUnavailable', 'unknownPreserved', 'changedSincePlan', 'operationFailed', 'cancelled', 'memoryUnavailable'];
const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const control = new Set(['.gitignore', 'capture-policy.json', 'launcher-record-change.js', 'review-writer.lock', 'review-recovery.lock', 'capture-maintenance.lock', 'purge-state.v1.json']);
const rootFiles: Record<string, PurgeCategory> = { 'log.jsonl': 'history', 'status.json': 'projection', 'meta.json': 'metadata',
	'capture-status.json': 'capture', 'review-state.v1.json': 'canonical', 'review-state.v1.json.prev': 'canonical' };
const rootDirectories: Record<string, PurgeCategory> = { blobs: 'blobs', 'review-blobs': 'blobs', pending: 'capture', completed: 'capture',
	'capture-diagnostics': 'capture', 'review-migration-backups': 'backups', 'settings-backups': 'backups' };
function own(value: object, key: string): boolean { return Object.hasOwn(value, key); }
function rule(relative: string): { category: PurgeCategory; kind: PurgeItem['kind'] } | undefined {
	if (own(rootFiles, relative)) { return { category: rootFiles[relative], kind: 'file' }; }
	if (own(rootDirectories, relative)) { return { category: rootDirectories[relative], kind: 'directory' }; }
	if (/^blobs\/[a-f0-9]{40}\.txt$/.test(relative)) { return { category: 'blobs', kind: 'file' }; }
	if (relative === 'review-blobs/v1') { return { category: 'blobs', kind: 'directory' }; }
	if (/^review-blobs\/v1\/[a-f0-9]{64}\.txt$/.test(relative)) { return { category: 'blobs', kind: 'file' }; }
	if (/^(?:pending\/[a-f0-9]{32}\.(?:json|post)|completed\/[a-f0-9]{32}\.json)$/.test(relative)) { return { category: 'capture', kind: 'file' }; }
	if (/^capture-diagnostics\/v2(?:\/(?:observations|completions))?$/.test(relative)) { return { category: 'capture', kind: 'directory' }; }
	if (/^capture-diagnostics\/v2\/(?:observations|completions)\/\d{8}T\d{9}Z-[a-f0-9]{32}\.json$/.test(relative)) { return { category: 'capture', kind: 'file' }; }
	if (/^settings-backups\/[a-f0-9]{64}\.json$/.test(relative)) { return { category: 'backups', kind: 'file' }; }
	if (new RegExp(`^review-migration-backups/${UUID}$`).test(relative)) { return { category: 'backups', kind: 'directory' }; }
	if (new RegExp(`^review-migration-backups/${UUID}/(?:status\\.json|review-state\\.v1\\.json(?:\\.prev)?|review-writer\\.lock|manifest\\.json)$`).test(relative)
		|| new RegExp(`^review-migration-backups/capture-maintenance-${UUID}\\.json$`).test(relative)) { return { category: 'backups', kind: 'file' }; }
	return undefined;
}
function validPath(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/[\u0000-\u001f\u007f]/.test(value); }
function inside(root: string, file: string): boolean { const relative = path.relative(root, file); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); }
function missing(error: unknown): boolean { return !!error && typeof error === 'object' && (error as { code?: string }).code === 'ENOENT'; }
function memory(value: PurgeMemory | undefined): PurgeMemory {
	const count = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= 1000000;
	return value?.complete === true && count(value.undoCount) && count(value.cacheCount)
		? { undoCount: value.undoCount, cacheCount: value.cacheCount, complete: true } : { undoCount: null, cacheCount: null, complete: false };
}

/** Reads metadata only. Unknown subtrees are preserved, not followed or presented as exhaustively counted. */
export async function inventoryPurge(historyDir: string, workspaceRoot: string, options: {
	io?: PurgeIO; maxEntries?: number; maxDepth?: number; memory?: PurgeMemory;
} = {}): Promise<PurgeInventory> {
	const result: PurgeInventory = { coverage: 'complete', issues: [], items: [], unknown: [], protectedDirectories: [], activeProducer: false, memory: memory(options.memory) };
	const issue = (reason: PurgeReason) => { result.coverage = 'partial'; if (!result.issues.includes(reason)) { result.issues.push(reason); } };
	const io = options.io ?? fs, maximum = options.maxEntries ?? 4096, maximumDepth = options.maxDepth ?? 8;
	if (!validPath(historyDir) || !validPath(workspaceRoot) || !path.isAbsolute(historyDir) || !path.isAbsolute(workspaceRoot)
		|| path.relative(path.resolve(workspaceRoot), path.resolve(historyDir)) !== path.join('.claude', 'launcher-changes')
		|| !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 10000 || !Number.isSafeInteger(maximumDepth) || maximumDepth < 1 || maximumDepth > 16) {
		issue('scopeUnknown'); return result;
	}
	let root: string, directory: string;
	try {
		root = await io.realpath(workspaceRoot);
		const rootStat = await io.lstat(root);
		if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) { issue('unsafeType'); return result; }
	} catch { issue('scopeUnknown'); return result; }
	try {
		let current = root;
		for (const part of ['.claude', 'launcher-changes']) {
			current = path.join(current, part); const stat = await io.lstat(current);
			if (stat.isSymbolicLink() || !stat.isDirectory()) { issue('unsafeType'); return result; }
		}
		directory = current;
	} catch (error) { if (!missing(error)) { issue('readUnavailable'); } return result; }
	const protectedDirs = new Set<string>(), queue = ['']; let visited = 0;
	const protect = (relative: string) => { let parent = relative.split('/').slice(0, -1); while (parent.length) { protectedDirs.add(parent.join('/')); parent = parent.slice(0, -1); } };
	while (queue.length) {
		const parent = queue.shift()!; let handle: Awaited<ReturnType<PurgeIO['opendir']>> | undefined;
		try {
			let current = root!;
			for (const part of ['.claude', 'launcher-changes', ...parent.split('/').filter(Boolean)]) {
				current = path.join(current, part); const stat = await io.lstat(current);
				if (stat.isSymbolicLink() || !stat.isDirectory()) { throw new Error('unsafeType'); }
			}
			const opened = await io.opendir(current, { bufferSize: 16 }); handle = opened;
			while (true) {
				const entry = await opened.read(); if (entry === null) { break; }
				if (++visited > maximum) { issue('scanBudget'); break; }
				if (!validPath(entry.name) || entry.name === '.' || entry.name === '..' || /[\\/]/.test(entry.name)) { issue('unsafeType'); continue; }
				const relative = parent ? parent + '/' + entry.name : entry.name;
				const file = path.join(directory!, ...relative.split('/')); if (!inside(directory!, file)) { issue('scopeUnknown'); continue; }
				const stat = await io.lstat(file);
				if (!parent && control.has(entry.name)) { continue; }
				if (parent === 'active') { result.activeProducer = true; continue; }
				if (relative === 'active') {
					if (stat.isSymbolicLink() || !stat.isDirectory()) { issue('unsafeType'); } else { queue.push(relative); }
					continue;
				}
				const allowed = rule(relative);
				if (!allowed) {
					const first = relative.split('/')[0], category = own(rootDirectories, first) ? rootDirectories[first] : 'unknown';
					result.unknown.push({ category, kind: stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'unknown' });
					protect(relative); continue;
				}
				if (stat.isSymbolicLink() || (allowed.kind === 'directory' ? !stat.isDirectory() : !stat.isFile())) { issue('unsafeType'); protect(relative); continue; }
				result.items.push({ relativePath: relative, category: allowed.category, kind: allowed.kind });
				if (/^pending\/[^/]+\.post$/.test(relative)) { result.activeProducer = true; }
				if (allowed.kind === 'directory') {
					if (relative.split('/').length >= maximumDepth) { issue('scanDepth'); protect(relative + '/unknown'); }
					else { queue.push(relative); }
				}
			}
		} catch (error) { issue(missing(error) ? 'changedSincePlan' : error instanceof Error && error.message === 'unsafeType' ? 'unsafeType' : 'readUnavailable'); }
		finally { await handle?.close().catch(() => undefined); }
		if (visited > maximum) { break; }
	}
	result.protectedDirectories = [...protectedDirs].sort();
	return result;
}

export function planPurge(inventory: PurgeInventory, ownership: { owned: boolean; quiescent: boolean }): {
	kind: 'ready' | 'blocked'; reason: PurgeReason; items: PurgeItem[]; memoryCategories: readonly ['undo', 'cache'];
} {
	const blocked = (reason: PurgeReason) => ({ kind: 'blocked' as const, reason, items: [], memoryCategories: ['undo', 'cache'] as const });
	if (!ownership.owned) { return blocked('ownershipRequired'); }
	if (!ownership.quiescent || inventory.activeProducer) { return blocked('captureInProgress'); }
	if (inventory.coverage !== 'complete') { return blocked(inventory.issues[0] ?? 'readUnavailable'); }
	if (!inventory.memory.complete) { return blocked('memoryUnavailable'); }
	if (inventory.items.some(item => rule(item.relativePath)?.category !== item.category || rule(item.relativePath)?.kind !== item.kind)) { return blocked('changedSincePlan'); }
	const items = inventory.items.filter(item => !(item.kind === 'directory' && inventory.protectedDirectories.includes(item.relativePath)))
		.sort((a, b) => b.relativePath.split('/').length - a.relativePath.split('/').length || (a.kind === 'file' ? -1 : 1) - (b.kind === 'file' ? -1 : 1) || a.relativePath.localeCompare(b.relativePath));
	return { kind: 'ready', reason: 'none', items, memoryCategories: ['undo', 'cache'] };
}

/** Redacted result only: no relative/absolute names, contents, exceptions, tokens or process IDs leave this projection. */
export function summarizePurge(before: PurgeInventory, after: PurgeInventory, effects: readonly PurgeEffect[] = [], options: { blockedReason?: PurgeReason } = {}): PurgeReport {
	const known = new Map(before.items.map(item => [item.relativePath, item.category]));
	known.set(PURGE_MEMORY_PATHS.undo, 'undo'); known.set(PURGE_MEMORY_PATHS.cache, 'cache');
	const accepted = effects.filter(effect => known.get(effect.relativePath) === effect.category && ['removed', 'remaining', 'blocked', 'failed'].includes(effect.outcome));
	const reason = (value: unknown): PurgeReason => REASONS.includes(value as PurgeReason) ? value as PurgeReason : 'operationFailed';
	const blockedReason = options.blockedReason && options.blockedReason !== 'none' ? reason(options.blockedReason) : undefined;
	const partial = before.coverage !== 'complete' || after.coverage !== 'complete' || !before.memory.complete || !after.memory.complete;
	const categories: PurgeCategoryResult[] = [...PURGE_CATEGORIES, 'unknown' as const].map(category => {
		const original = before.items.filter(item => item.category === category), remaining = after.items.filter(item => item.category === category);
		const categoryEffects = accepted.filter(effect => effect.category === category), reasons = new Set<PurgeReason>();
		const unknown = after.unknown.filter(item => item.category === category).length;
		let beforeCount: number | null = original.length + before.unknown.filter(item => item.category === category).length,
			remainingCount: number | null = after.coverage === 'complete' ? remaining.length + unknown : null;
		if (category === 'undo' || category === 'cache') {
			beforeCount = category === 'undo' ? before.memory.undoCount : before.memory.cacheCount;
			remainingCount = category === 'undo' ? after.memory.undoCount : after.memory.cacheCount;
		}
		if (unknown) { reasons.add('unknownPreserved'); }
		if (partial) { for (const issue of after.issues) { reasons.add(reason(issue)); } if (remainingCount === null) { reasons.add(category === 'undo' || category === 'cache' ? 'memoryUnavailable' : 'readUnavailable'); } }
		for (const effect of categoryEffects) { if (effect.reason && effect.reason !== 'none') { reasons.add(reason(effect.reason)); } }
		if (blockedReason) { reasons.add(blockedReason); }
		const failed = categoryEffects.some(effect => effect.outcome === 'failed'), blocked = Boolean(blockedReason) || categoryEffects.some(effect => effect.outcome === 'blocked');
		const effectRemains = categoryEffects.some(effect => effect.outcome === 'remaining');
		const remainingPaths = new Set(remaining.map(item => item.relativePath));
		const removedCount = category === 'undo' || category === 'cache' ? beforeCount !== null && remainingCount !== null ? Math.max(0, beforeCount - remainingCount) : 0
			: category === 'unknown' ? 0 : after.coverage === 'complete' ? original.filter(item => !remainingPaths.has(item.relativePath)).length
				: new Set(categoryEffects.filter(effect => effect.outcome === 'removed').map(effect => effect.relativePath)).size;
		return { category, outcome: failed ? 'failed' : blocked ? 'blocked' : effectRemains || remainingCount === null || remainingCount > 0 || unknown ? 'remaining' : 'removed', beforeCount, remainingCount, removedCount, reasons: [...reasons] };
	});
	const hasIncompleteEffect = categories.some(category => category.outcome !== 'removed');
	return { outcome: blockedReason ? 'blocked' : hasIncompleteEffect || partial || after.unknown.length ? 'partial' : 'complete',
		coverage: partial ? 'partial' : 'complete', categories, unknownPreserved: after.unknown.length,
		unknownCountIsLowerBound: after.coverage !== 'complete' || after.unknown.some(item => item.kind === 'directory') };
}
