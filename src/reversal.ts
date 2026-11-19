import { activeReview, commitReviewDecision, copyReview, planReviewDecision, ReviewContent, ReviewDecisionPlan, ReviewDecisionRequest, ReviewError, ReviewOperation, ReviewUndoItem, sameContent } from './review';
import { ReviewStore } from './review-store';
import type { ReviewState } from './review';
declare const require: (id: string) => any;
const crypto = require('node:crypto');

export interface ResourceAdapter {
	read(file: string): Promise<ReviewContent>;
	readPersisted(file: string): Promise<ReviewContent>;
	write(file: string, target: ReviewContent, expected: ReviewContent): Promise<void>;
}
const queues = new WeakMap<ReviewStore, Map<string, Promise<unknown>>>();
async function serialized<T>(store: ReviewStore, file: string, work: () => Promise<T>): Promise<T> {
	let queue = queues.get(store); if (!queue) { queue = new Map(); queues.set(store, queue); }
	const next = (queue.get(file) ?? Promise.resolve()).then(work);
	const tail = next.catch(() => undefined); queue.set(file, tail);
	try { return await next; } finally { if (queue.get(file) === tail) { queue.delete(file); } }
}
function code(error: unknown): string { return error instanceof ReviewError ? error.code : error instanceof Error ? error.message : 'operationFailed'; }
function supported(content: ReviewContent): void {
	if (content.kind === 'unavailable') { throw new ReviewError('unknownSnapshot'); }
	if (content.kind === 'text' && (/\r(?!\n)/.test(content.text) || content.text.includes('\r\n') && content.text.replace(/\r\n/g, '').includes('\n'))) { throw new ReviewError('unsupportedEncoding'); }
}
function undoUnits(content: ReviewContent): number { return content.kind === 'text' ? content.text.length : 0; }
/** Reserve recovery capacity before an effect; pending/failed recovery is never silently evicted. */
function retiredUndo(state: ReviewState, operation: ReviewOperation): string[] {
	if (sameContent(operation.expected, operation.target)) { return []; }
	const maximum = 8 * 1024 * 1024;
	const items = state.undo.filter((item) => item.phase !== 'consumed');
	const pending = Object.values(state.operations).filter((op) => op.id !== operation.id && !['complete', 'blocked'].includes(op.stage) && op.kind !== 'undo' && op.kind !== 'migration' && !sameContent(op.expected, op.target));
	let units = items.reduce((sum, item) => sum + undoUnits(item.previous) + undoUnits(item.restored), 0)
		+ pending.reduce((sum, item) => sum + undoUnits(item.expected) + undoUnits(item.target), 0) + undoUnits(operation.expected) + undoUnits(operation.target);
	const incomingBatch = String(operation.batchId || operation.id);
	const batches = new Set([...items.map((item) => String(item.batchId || item.id)), ...pending.map((op) => String(op.batchId || op.id)), incomingBatch]);
	const removed: string[] = [];
	for (const batch of [...new Set(items.map((item) => String(item.batchId || item.id)))]) {
		if (units <= maximum && batches.size <= 5) { break; }
		const group = items.filter((item) => String(item.batchId || item.id) === batch);
		if (batch === incomingBatch || group.some((item) => item.phase !== 'available') || pending.some((op) => String(op.batchId || op.id) === batch)) { continue; }
		for (const item of group) { removed.push(item.id); units -= undoUnits(item.previous) + undoUnits(item.restored); }
		batches.delete(batch);
	}
	if (units > maximum || batches.size > 5) { throw new ReviewError('undoCapacity'); }
	return removed;
}
async function complete(store: ReviewStore, op: ReviewOperation): Promise<void> {
	if (!op.plan) { throw new ReviewError('needsReconciliation'); }
	await store.update((state) => {
		const before = activeReview(state, op.file);
		const retired = new Set(retiredUndo(state, op));
		state.undo = state.undo.filter((item) => !retired.has(item.id));
		commitReviewDecision(state, op.plan!);
		state.operations[op.id] = { ...op, stage: 'complete', reason: undefined };
		if (!sameContent(op.expected, op.target)) {
			state.undo.push({ id: op.id, operationId: op.id, file: op.file, ids: [...op.ids], previous: copyReview(op.expected), restored: copyReview(op.target), phase: 'available', reviewBefore: before && copyReview(before), reviewAfterRevision: op.plan!.next.revision, batchId: op.batchId || op.id, createdAt: op.createdAt || new Date().toISOString(), completedAt: new Date().toISOString() });
		}
	});
}
async function recordFailure(store: ReviewStore, op: ReviewOperation, adapter: ResourceAdapter, error: unknown): Promise<void> {
	let stage: ReviewOperation['stage'] = 'needsReconciliation';
	try { const current = await adapter.read(op.file), disk = await adapter.readPersisted(op.file);
		if (sameContent(current, op.target) && !sameContent(disk, op.target)) { stage = 'bufferApplied'; }
		else if (sameContent(current, op.expected) && sameContent(disk, op.expected)) { stage = 'blocked'; }
	} catch { /* Unknown is intentionally not absence. */ }
	try { await store.update((state) => { if (state.operations[op.id]?.stage !== 'complete') { state.operations[op.id] = { ...op, stage, reason: code(error) }; } }); } catch { /* Prepared intent remains authoritative on disk. */ }
}

/** Recover known intents by observing both buffer and persisted content, never by replaying blindly. */
export async function reconcileResource(store: ReviewStore, file: string, adapter: ResourceAdapter): Promise<boolean> {
	let recovered = false;
	for (const op of Object.values(store.get().operations).filter((item) => item.file === file && item.stage !== 'complete')) {
		if (op.kind === 'undo') { await resumeUndo(store, op, adapter); recovered = true; continue; }
		if (!op.plan) { throw new ReviewError('needsReconciliation'); }
		const current = await adapter.read(file), disk = await adapter.readPersisted(file);
		if (sameContent(op.expected, op.target) && sameContent(current, op.target)) { await complete(store, op); recovered = true; continue; }
		if (sameContent(current, op.target) && sameContent(disk, op.target)) { await complete(store, op); recovered = true; continue; }
		if (sameContent(current, op.target) && sameContent(disk, op.expected) && !sameContent(op.expected, op.target)) {
			try { await adapter.write(file, op.target, current); if (!sameContent(await adapter.readPersisted(file), op.target) || !sameContent(await adapter.read(file), op.target)) { throw new ReviewError('verificationFailed'); } await complete(store, op); recovered = true; continue; }
			catch (error) { await recordFailure(store, op, adapter, error); throw error; }
		}
		if (sameContent(current, op.expected) && sameContent(disk, op.expected)) {
			await store.update((state) => { delete state.operations[op.id]; }); continue;
		}
		throw new ReviewError('needsReconciliation');
	}
	return recovered;
}

export async function executeDecision(store: ReviewStore, file: string, request: ReviewDecisionRequest, adapter: ResourceAdapter, options: { batchId?: string } = {}): Promise<'committed' | 'recovered'> {
	return serialized(store, file, async () => {
		if (!store.writable) { throw new ReviewError(store.blockReason || 'readOnlyOwner'); }
		if (await reconcileResource(store, file, adapter)) { return 'recovered' as const; }
		const review = activeReview(store.get(), file); if (!review) { throw new ReviewError('missingReview'); }
		const observed = await adapter.read(file);
		const plan = planReviewDecision(review, observed, request);
		if (!sameContent(plan.expected, plan.target)) { supported(plan.expected); supported(plan.target); }
		const id = crypto.randomUUID() as string;
		const op: ReviewOperation = { id, file, ids: plan.ids, expected: plan.expected, target: plan.target, stage: 'prepared', plan, request: copyReview(request), batchId: options.batchId || id, createdAt: new Date().toISOString() };
		await store.update((state) => { if (activeReview(state, file)?.revision !== plan.sourceRevision) { throw new ReviewError('staleRevision'); } retiredUndo(state, op); state.operations[id] = op; });
		try {
			if (!sameContent(await adapter.read(file), observed)) { throw new ReviewError('externalChange'); }
			if (!sameContent(plan.expected, plan.target)) {
				await adapter.write(file, plan.target, observed);
				if (!sameContent(await adapter.read(file), plan.target) || !sameContent(await adapter.readPersisted(file), plan.target)) { throw new ReviewError('verificationFailed'); }
				await store.update((state) => { state.operations[id].stage = 'contentVerified'; });
			}
			await complete(store, op); return 'committed' as const;
		} catch (error) { await recordFailure(store, op, adapter, error); throw error; }
	});
}

function sameDecision(a: import('./review').SharedReview, b: import('./review').SharedReview): boolean {
	return a.firstId === b.firstId && a.accepted === b.accepted && a.rejected === b.rejected && a.phase === b.phase && a.resolution === b.resolution
		&& sameContent(a.base, b.base) && sameContent(a.expected, b.expected) && a.ids.join('\0') === b.ids.join('\0');
}
async function completeUndo(store: ReviewStore, op: ReviewOperation): Promise<void> {
	await store.update((state) => {
		const saved = state.undo.find((candidate) => candidate.id === op.undoItemId);
		if (!saved || saved.phase === 'consumed') { state.operations[op.id].stage = 'complete'; return; }
		if (saved.reviewBefore) {
			const list = state.reviews[saved.file]; const index = list?.findIndex((r) => r.firstId === saved.reviewBefore!.firstId) ?? -1;
			if (index < 0 || saved.reviewAfterRevision !== undefined && list[index].revision !== saved.reviewAfterRevision) { throw new ReviewError('staleRevision'); }
			const restored = copyReview(saved.reviewBefore); restored.revision = list[index].revision + 1; list[index] = restored;
			// An earlier undo may target the logical state just restored by this undo.
			for (const previous of state.undo) {
				const after = state.operations[previous.operationId]?.plan?.next;
				if (previous.id !== saved.id && previous.phase !== 'consumed' && previous.file === saved.file && after && sameDecision(after, restored)) { previous.reviewAfterRevision = restored.revision; }
			}
		}
		for (const id of saved.ids) { delete state.statuses[id]; }
		saved.phase = 'consumed'; state.operations[op.id].stage = 'complete';
	});
}
async function resumeUndo(store: ReviewStore, op: ReviewOperation, adapter: ResourceAdapter): Promise<void> {
	const current = await adapter.read(op.file), disk = await adapter.readPersisted(op.file);
	if (sameContent(current, op.target) && sameContent(disk, op.target)) { await completeUndo(store, op); return; }
	if (sameContent(current, op.target) && sameContent(disk, op.expected)) {
		await adapter.write(op.file, op.target, current);
		if (!sameContent(await adapter.read(op.file), op.target) || !sameContent(await adapter.readPersisted(op.file), op.target)) { throw new ReviewError('verificationFailed'); }
		await completeUndo(store, op); return;
	}
	if (sameContent(current, op.expected) && sameContent(disk, op.expected)) {
		await adapter.write(op.file, op.target, current);
		if (!sameContent(await adapter.read(op.file), op.target) || !sameContent(await adapter.readPersisted(op.file), op.target)) { throw new ReviewError('verificationFailed'); }
		await completeUndo(store, op); return;
	}
	throw new ReviewError('needsReconciliation');
}

/** Restore only the decision delta and content belonging to the item that actually succeeded. */
export async function undoItem(store: ReviewStore, itemId: string, adapter: ResourceAdapter): Promise<void> {
	const original = store.get().undo.find((item) => item.id === itemId);
	if (!original || original.phase === 'consumed') { throw new ReviewError('missingUndo'); }
	return serialized(store, original.file, async () => {
		if (!store.writable) { throw new ReviewError(store.blockReason || 'readOnlyOwner'); }
		const previousIntent = Object.values(store.get().operations).find((op) => op.kind === 'undo' && op.undoItemId === itemId && op.stage !== 'complete');
		if (previousIntent) { await resumeUndo(store, previousIntent, adapter); return; }
		const item = store.get().undo.find((candidate) => candidate.id === itemId)!;
		const view = store.get().reviews[item.file]?.find((r) => r.firstId === item.reviewBefore?.firstId);
		if (item.reviewAfterRevision !== undefined && view?.revision !== item.reviewAfterRevision) { throw new ReviewError('staleRevision'); }
		const current = await adapter.read(item.file);
		if (!sameContent(current, item.restored)) { throw new ReviewError('externalChange'); }
		supported(item.previous); supported(current);
		const operationId = crypto.randomUUID() as string;
		const op: ReviewOperation = { id: operationId, file: item.file, ids: item.ids, expected: item.restored, target: item.previous, stage: 'prepared', kind: 'undo', undoItemId: item.id };
		await store.update((state) => { state.operations[operationId] = op; });
		try { await resumeUndo(store, op, adapter); }
		catch (error) {
			try { await store.update((state) => { const saved = state.undo.find((candidate) => candidate.id === item.id); if (saved) { saved.phase = 'needsReconciliation'; } state.operations[operationId].stage = 'needsReconciliation'; state.operations[operationId].reason = code(error); }); } catch { /* Intent remains available. */ }
			throw error;
		}
	});
}
