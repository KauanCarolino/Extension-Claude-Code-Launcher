import { ReviewError } from './review';
import { ReviewStore } from './review-store';
import { assessStoragePath, CAPTURE_MAINTENANCE_FILE } from './history';
declare const require: (name: string) => any;
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), runtime = require('node:process');
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const queues = new WeakMap<ReviewStore, Promise<unknown>>();
async function serialized<T>(store: ReviewStore, work: () => Promise<T>): Promise<T> {
	const next = (queues.get(store) ?? Promise.resolve()).then(work); const tail = next.catch(() => undefined); queues.set(store, tail);
	try { return await next; } finally { if (queues.get(store) === tail) { queues.delete(store); } }
}
export async function captureQuiescent(store: ReviewStore): Promise<boolean> {
	for (const name of ['active', 'pending']) {
		const dir = path.join(store.directory, name); if (!(await assessStoragePath(dir, store.root)).allowed) { return false; }
		try { const names: string[] = await fs.promises.readdir(dir); if (name === 'active' ? names.length > 0 : names.some((item) => item.endsWith('.post'))) { return false; } }
		catch (error) { if ((error as { code?: string }).code !== 'ENOENT') { return false; } }
	}
	return true;
}
/** Cooperative guard: producer leases precede all content writes and recheck this guard. */
export async function withCaptureMaintenance<T>(store: ReviewStore, work: () => Promise<T>, timeoutMs = 1500): Promise<T> {
	return serialized(store, () => performMaintenance(store, work, timeoutMs));
}
async function performMaintenance<T>(store: ReviewStore, work: () => Promise<T>, timeoutMs: number): Promise<T> {
	if (!store.writable) { throw new ReviewError('readOnlyOwner'); }
	await store.update(() => undefined);
	const guard = path.join(store.directory, CAPTURE_MAINTENANCE_FILE);
	if (!(await assessStoragePath(guard, store.root)).allowed) { throw new ReviewError('unsafeStorageType'); }
	const token = crypto.randomUUID();
	try { await fs.promises.writeFile(guard, JSON.stringify({ schemaVersion: 1, token, pid: runtime.pid }), { flag: 'wx', mode: 0o600 }); }
	catch (error) { if ((error as { code?: string }).code === 'EEXIST') { throw new ReviewError('captureMaintenanceLocked'); } throw error; }
	try {
		const deadline = Date.now() + timeoutMs; let quiet = false;
		do { quiet = await captureQuiescent(store); if (quiet) { break; } await wait(20); } while (Date.now() < deadline);
		if (!quiet) { throw new ReviewError('captureInProgress'); }
		return await work();
	} finally {
		const contents = JSON.parse(await fs.promises.readFile(guard, 'utf8'));
		if (contents.token !== token) { throw new ReviewError('captureMaintenanceOwnerLost'); }
		await fs.promises.unlink(guard);
	}
}
export async function recoverCaptureMaintenance(store: ReviewStore): Promise<void> {
	return serialized(store, () => recoverGuard(store));
}
async function recoverGuard(store: ReviewStore): Promise<void> {
	if (!store.writable) { throw new ReviewError('readOnlyOwner'); }
	const guard = path.join(store.directory, CAPTURE_MAINTENANCE_FILE);
	if (!(await assessStoragePath(guard, store.root)).allowed) { throw new ReviewError('unsafeStorageType'); }
	let original: string; try { original = await fs.promises.readFile(guard, 'utf8'); } catch (error) { if ((error as { code?: string }).code === 'ENOENT') { return; } throw error; }
	const record = JSON.parse(original);
	if (!Number.isSafeInteger(record.pid) || record.pid <= 0 || typeof record.token !== 'string') { throw new ReviewError('ambiguousCaptureMaintenance'); }
	try { runtime.kill(record.pid, 0); throw new ReviewError('captureMaintenanceStillAlive'); }
	catch (error) { if ((error as { code?: string }).code !== 'ESRCH') { throw error; } }
	const backup = path.join(store.directory, 'review-migration-backups'); if (!(await assessStoragePath(backup, store.root)).allowed) { throw new ReviewError('unsafeStorageType'); }
	await fs.promises.mkdir(backup, { recursive: true, mode: 0o700 });
	await fs.promises.writeFile(path.join(backup, 'capture-maintenance-' + crypto.randomUUID() + '.json'), original, { flag: 'wx', mode: 0o600 });
	if (await fs.promises.readFile(guard, 'utf8') !== original) { throw new ReviewError('captureMaintenanceOwnerChanged'); }
	await fs.promises.unlink(guard);
}
