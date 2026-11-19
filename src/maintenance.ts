import { ReviewError } from './review';
import { ReviewStore } from './review-store';
import { assessStoragePath, CAPTURE_MAINTENANCE_FILE } from './history';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as runtime from 'node:process';
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
/** The hook runs under a 10 s timeout; a lease this old cannot belong to a producer that is still working. */
export const STALE_PRODUCER_MS = 30 * 1000;
const LEASE_NAME = /^(\d{1,10})-(?:status-)?[a-f0-9]{16}\.json$/;
function processGone(pid: number): boolean {
	try { runtime.kill(pid, 0); return false; }
	catch (error) { return (error as { code?: string }).code === 'ESRCH'; }
}
/**
 * A hook killed mid-run (timeout, crash, power loss) leaves its lease in active/ and possibly a
 * pending/<key>.post marker, which would block maintenance forever. Only what is provably orphaned is
 * removed: a lease in the hook's own name format, older than the hook timeout, whose process no longer
 * exists; and .post markers once no lease remains. Unknown names and live processes keep blocking.
 * Call only while holding the maintenance guard: a producer arriving now stops before any content write.
 */
export async function reapStaleProducers(store: ReviewStore, now = Date.now()): Promise<number> {
	const active = path.join(store.directory, 'active'), pending = path.join(store.directory, 'pending');
	const list = async (dir: string): Promise<string[] | undefined> => {
		if (!(await assessStoragePath(dir, store.root)).allowed) { return undefined; }
		try { return await fs.promises.readdir(dir); }
		catch (error) { return (error as { code?: string }).code === 'ENOENT' ? [] : undefined; }
	};
	const removeAged = async (file: string, accept: (text: string) => boolean): Promise<boolean> => {
		try {
			if (!(await assessStoragePath(file, store.root)).allowed) { return false; }
			const stat = await fs.promises.lstat(file);
			if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 || now - stat.mtimeMs <= STALE_PRODUCER_MS) { return false; }
			if (!accept(await fs.promises.readFile(file, 'utf8'))) { return false; }
			await fs.promises.unlink(file); return true;
		} catch { return false; /* Unknown evidence stays and keeps maintenance blocked. */ }
	};
	let removed = 0;
	const leases = await list(active); if (!leases) { return removed; }
	for (const name of leases) {
		const pid = Number(LEASE_NAME.exec(name)?.[1]);
		if (!Number.isSafeInteger(pid) || pid <= 0 || pid === runtime.pid || !processGone(pid)) { continue; }
		// A lease truncated by the kill has no readable record; a readable one must name the same process.
		if (await removeAged(path.join(active, name), (text) => {
			try { const record = JSON.parse(text); return !!record && typeof record === 'object' && record.pid === pid; } catch { return true; }
		})) { removed += 1; }
	}
	const remaining = await list(active); if (!remaining || remaining.length > 0) { return removed; }
	// Every producer holds its lease from before the marker is created until after it is removed,
	// so a marker without any lease belongs to a producer that no longer exists.
	for (const name of await list(pending) ?? []) {
		if (/^[a-f0-9]{32}\.post$/.test(name) && await removeAged(path.join(pending, name), () => true)) { removed += 1; }
	}
	return removed;
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
		await reapStaleProducers(store);
		const deadline = Date.now() + timeoutMs; let quiet = false;
		do { quiet = await captureQuiescent(store); if (quiet) { break; } await wait(20); } while (Date.now() < deadline);
		if (!quiet) { throw new ReviewError('captureInProgress'); }
		return await work();
	} finally {
		const contents = JSON.parse(await fs.promises.readFile(guard, 'utf8'));
		// Deliberate: an effect that ran under a guard it no longer owns must not report success.
		// eslint-disable-next-line no-unsafe-finally
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
