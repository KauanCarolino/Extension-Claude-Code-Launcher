import { diffLines, groupsOf, groupSignature, joinText, splitText } from './diff';
import { RawEntry, Snapshot, Status } from './logic';
import * as fingerprintHash from 'node:crypto';

export type ReviewResolution = Status | 'mixed';
export type ReviewContent = { kind: 'absent' } | { kind: 'text'; text: string } | { kind: 'unavailable'; reason: string };
export interface SharedReview {
	file: string;
	revision: number;
	ids: string[];
	firstId: string;
	lastId: string;
	base: ReviewContent;
	expected: ReviewContent;
	phase: 'pending' | 'blocked' | 'complete';
	resolution?: ReviewResolution;
	accepted: number;
	rejected: number;
	reason: string | null;
	blockReason?: string;
}
export interface ReviewDecisionRequest { action: 'accept' | 'reject'; index?: number; signature?: string; revision?: number }
export interface ReviewDecisionPlan {
	file: string;
	ids: string[];
	sourceRevision: number;
	expected: ReviewContent;
	target: ReviewContent;
	next: SharedReview;
}
export interface ReviewOperation {
	id: string;
	file: string;
	ids: string[];
	expected: ReviewContent;
	target: ReviewContent;
	stage: 'prepared' | 'bufferApplied' | 'contentVerified' | 'complete' | 'blocked' | 'needsReconciliation';
	plan?: ReviewDecisionPlan;
	reason?: string;
	[key: string]: unknown;
}
export interface ReviewUndoItem {
	id: string;
	operationId: string;
	file: string;
	ids: string[];
	previous: ReviewContent;
	restored: ReviewContent;
	phase: 'available' | 'retryable' | 'needsReconciliation' | 'consumed';
	reviewBefore?: SharedReview;
	reviewAfterRevision?: number;
	[key: string]: unknown;
}
export interface ReviewState {
	schemaVersion: 1;
	generation: number;
	contextId: string;
	reviews: Record<string, SharedReview[]>;
	statuses: Record<string, ReviewResolution>;
	operations: Record<string, ReviewOperation>;
	undo: ReviewUndoItem[];
	legacyProjection: { phase: 'complete' | 'pending'; observedHash: string | null; targetHash: string | null; targetGeneration: number };
	entryFingerprints?: Record<string, string>;
}

export class ReviewError extends Error {
	constructor(public readonly code: string, message = code) { super(message); this.name = 'ReviewError'; }
}
/** Immutable strings are shared; JSON roundtrips would multiply large snapshot payloads. */
export function copyReview<T>(value: T): T {
	if (Array.isArray(value)) { return value.map((item) => copyReview(item)) as T; }
	if (value && typeof value === 'object') {
		const result: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) {
			if (['__proto__', 'constructor', 'prototype'].includes(key)) { throw new ReviewError('invalidReviewState'); }
			result[key] = copyReview(item);
		}
		return result as T;
	}
	return value;
}
export function contentOfSnapshot(snapshot: Snapshot | null): ReviewContent {
	if (!snapshot || typeof snapshot.exists !== 'boolean' || typeof snapshot.large !== 'boolean' || snapshot.large) { return { kind: 'unavailable', reason: 'unknownSnapshot' }; }
	if (!snapshot.exists) { return { kind: 'absent' }; }
	return typeof snapshot.text === 'string' ? { kind: 'text', text: snapshot.text } : { kind: 'unavailable', reason: 'missingSnapshot' };
}
export function sameContent(a: ReviewContent, b: ReviewContent): boolean {
	return a.kind === 'absent' && b.kind === 'absent' || a.kind === 'text' && b.kind === 'text' && a.text === b.text;
}
export function activeReview(state: ReviewState, file: string): SharedReview | undefined {
	return state.reviews[file]?.slice().reverse().find((review) => review.phase !== 'complete');
}

function snapshotIdentity(snapshot: Snapshot | null): unknown {
	if (snapshot && typeof snapshot.hash === 'string' && /^[a-f0-9]{40}$/.test(snapshot.hash)) {
		if (typeof snapshot.text === 'string' && fingerprintHash.createHash('sha1').update(snapshot.text, 'utf8').digest('hex') !== snapshot.hash) { throw new ReviewError('invalidSnapshot'); }
		return [snapshot.exists, snapshot.large, snapshot.hash];
	}
	return snapshot;
}

/** Input order is the validated log ordinal, never a timestamp-only causal guess. */
export function ingestEntries(state: ReviewState, entries: readonly RawEntry[]): boolean {
	let changed = false;
	const represented = new Set(Object.values(state.reviews).flatMap((list) => list.flatMap((review) => review.ids)));
	const fingerprints = state.entryFingerprints ?? {};
	for (const entry of entries) {
		if (!entry.id || !entry.file || ['__proto__', 'constructor', 'prototype'].includes(entry.file) || ['__proto__', 'constructor', 'prototype'].includes(entry.id)) { throw new ReviewError('invalidEntry'); }
		const fingerprint: string = fingerprintHash.createHash('sha256').update(JSON.stringify([entry.file, snapshotIdentity(entry.before), snapshotIdentity(entry.after), entry.tool ?? null, entry.toolUseId ?? null])).digest('hex');
		if (Object.hasOwn(fingerprints, entry.id) && fingerprints[entry.id] !== fingerprint) { throw new ReviewError('conflictingEntry'); }
		if (!Object.hasOwn(fingerprints, entry.id)) { state.entryFingerprints = fingerprints; fingerprints[entry.id] = fingerprint; changed = true; }
		if (represented.has(entry.id) || Object.hasOwn(state.statuses, entry.id)) {
			for (const existing of state.reviews[entry.file] ?? []) {
				if (existing.lastId === entry.id && entry.reason?.trim() && existing.reason !== entry.reason.trim()) { existing.reason = entry.reason.trim(); changed = true; }
				if (existing.phase === 'blocked' && existing.blockReason === 'unknownSnapshot') {
					const before = contentOfSnapshot(entry.before), after = contentOfSnapshot(entry.after);
					if (existing.firstId === entry.id && existing.base.kind === 'unavailable' && before.kind !== 'unavailable') { existing.base = before; changed = true; }
					if (existing.lastId === entry.id && existing.expected.kind === 'unavailable' && after.kind !== 'unavailable') { existing.expected = after; changed = true; }
					if (existing.base.kind !== 'unavailable' && existing.expected.kind !== 'unavailable') { existing.phase = 'pending'; delete existing.blockReason; existing.revision += 1; changed = true; }
				}
			}
			continue;
		}
		const before = contentOfSnapshot(entry.before);
		const after = contentOfSnapshot(entry.after);
		const list = state.reviews[entry.file] ?? (state.reviews[entry.file] = []);
		let current = list[list.length - 1];
		if (current?.phase === 'pending' && sameContent(current.expected, before)) {
			current.ids.push(entry.id);
			current.lastId = entry.id;
			current.expected = after;
			current.revision += 1;
			current.reason = entry.reason?.trim() || current.reason;
		} else {
			if (current && current.phase !== 'complete') { current.phase = 'blocked'; current.blockReason = 'externalChange'; current.revision += 1; }
			current = { file: entry.file, revision: (current?.revision ?? 0) + 1, ids: [entry.id], firstId: entry.id, lastId: entry.id,
				base: before, expected: after, phase: 'pending', accepted: 0, rejected: 0, reason: entry.reason?.trim() || null };
			list.push(current);
		}
		if (before.kind === 'unavailable' || after.kind === 'unavailable') { current.phase = 'blocked'; current.blockReason = 'unknownSnapshot'; }
		represented.add(entry.id);
		changed = true;
	}
	return changed;
}

function text(content: ReviewContent): string {
	if (content.kind === 'unavailable') { throw new ReviewError('unknownSnapshot'); }
	return content.kind === 'text' ? content.text : '';
}
function serializeLines(logical: string, exemplar: string): string {
	const hasCrLf = exemplar.includes('\r\n');
	if (hasCrLf && exemplar.replace(/\r\n/g, '').includes('\n') || /\r(?!\n)/.test(exemplar)) { throw new ReviewError('unsupportedEncoding'); }
	return hasCrLf ? logical.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n') : logical.replace(/\r\n/g, '\n');
}

export function planReviewDecision(review: SharedReview, observed: ReviewContent, request: ReviewDecisionRequest): ReviewDecisionPlan {
	if (review.base.kind === 'unavailable' || review.expected.kind === 'unavailable' || observed.kind === 'unavailable') { throw new ReviewError('unknownSnapshot'); }
	const acceptCurrent = request.action === 'accept' && request.index === undefined
		&& (review.phase === 'pending' || review.phase === 'blocked' && review.blockReason === 'externalChange');
	if (review.phase !== 'pending' && !acceptCurrent) { throw new ReviewError(review.blockReason || 'blockedReview'); }
	if (request.revision !== undefined && request.revision !== review.revision) { throw new ReviewError('staleRevision'); }
	if (!sameContent(review.expected, observed) && !acceptCurrent) { throw new ReviewError('externalChange'); }
	const next = copyReview(review);
	if (acceptCurrent) { next.phase = 'pending'; delete next.blockReason; }
	let target = copyReview(observed);
	if (request.index !== undefined) {
		const group = groupsOf(diffLines(text(review.base), text(observed)).lines)[request.index];
		if (!group || !request.signature || groupSignature(group) !== request.signature) { throw new ReviewError('staleRevision'); }
		if (request.action === 'accept') {
			const base = splitText(text(review.base));
			if (review.base.kind === 'absent') { base.trailingNewline = splitText(text(observed)).trailingNewline; }
			base.lines.splice(group.oldStart, group.oldLines.length, ...group.newLines);
			next.base = { kind: 'text', text: serializeLines(joinText(base), text(observed)) };
			next.accepted += 1;
		} else {
			const current = splitText(text(observed));
			current.lines.splice(group.newStart, group.newLines.length, ...group.oldLines);
			target = { kind: 'text', text: serializeLines(joinText(current), text(observed)) };
			// Rejecting the last insertion in a created resource restores absence.
			if (review.base.kind === 'absent' && target.text === '') { target = { kind: 'absent' }; }
			next.rejected += 1;
		}
	} else if (request.action === 'accept') {
		next.base = copyReview(observed); next.accepted += 1;
	} else {
		target = copyReview(review.base); next.rejected += 1;
	}
	next.expected = copyReview(target);
	next.revision += 1;
	if (sameContent(next.base, target)) {
		next.phase = 'complete';
		next.resolution = next.accepted > 0 && next.rejected > 0 ? 'mixed' : next.accepted > 0 ? 'accepted' : 'rejected';
	}
	return { file: review.file, ids: [...review.ids], sourceRevision: review.revision, expected: copyReview(observed), target, next };
}

export function commitReviewDecision(state: ReviewState, plan: ReviewDecisionPlan): void {
	const list = state.reviews[plan.file];
	const index = list?.findIndex((review) => review.firstId === plan.next.firstId) ?? -1;
	if (index < 0 || list[index].revision !== plan.sourceRevision) { throw new ReviewError('staleRevision'); }
	list[index] = copyReview(plan.next);
	if (plan.next.phase === 'complete' && plan.next.resolution) {
		for (const id of plan.ids) { state.statuses[id] = plan.next.resolution; }
	}
}
