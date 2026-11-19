/* The runtime is Node; keep the dependency surface local instead of adding a type package. */
declare const require: (id: string) => any;
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const runtimeProcess = require('node:process');
const BufferImpl = require('node:buffer').Buffer;

import { copyReview, ReviewError, ReviewState, ReviewResolution } from './review';

export interface ReviewStoreOptions {
	fault?: (stage: 'blob' | 'state' | 'projection' | 'backup') => void;
	maxStateBytes?: number;
	maxBlobBytes?: number;
	maxMaterializedBytes?: number;
	maxDepth?: number;
}
export class ReviewStore {
	readonly root: string;
	readonly directory: string;
	blockReason: string | undefined;
	private readonly token = crypto.randomUUID() as string;
	private owner = false;
	private state!: ReviewState;
	private chain: Promise<unknown> = Promise.resolve();
	private decodedBlobs = new Map<string, string>();
	private materializedBytes = 0;
	private encodedBlobs = new Set<string>();
	private encodedBytes = 0;
	private constructor(root: string, private readonly options: ReviewStoreOptions) {
		this.root = fs.realpathSync(root);
		this.directory = path.join(this.root, '.claude', 'launcher-changes');
	}
	static async open(root: string, legacyStatus: Record<string, ReviewResolution> = {}, options: ReviewStoreOptions = {}): Promise<ReviewStore> {
		const store = new ReviewStore(root, options);
		try {
			store.ensureDirectories();
			store.acquireWriter();
			store.readState(legacyStatus);
			if (store.owner) {
				if (!fs.existsSync(store.file('review-state.v1.json'))) { store.backupLegacy(); await store.update(() => undefined); }
				else { store.recoverProjection(); }
			}
			return store;
		} catch (error) { await store.close(); throw error; }
	}
	get writable(): boolean { return this.owner && (!this.blockReason || this.blockReason === 'legacyProjectionPending'); }
	get(): ReviewState { return copyReview(this.state); }
	private file(name: string): string { return path.join(this.directory, name); }
	private ensureDirectories(): void {
		if (fs.realpathSync(this.root) !== this.root || !fs.lstatSync(this.root).isDirectory()) { throw new ReviewError('unsupportedStore'); }
		for (const relative of ['.claude', '.claude/launcher-changes', '.claude/launcher-changes/review-blobs', '.claude/launcher-changes/review-blobs/v1']) {
			const dir = path.join(this.root, relative);
			try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (error) { if ((error as { code?: string }).code !== 'EEXIST') { throw error; } }
			const stat = fs.lstatSync(dir);
			if (!stat.isDirectory() || stat.isSymbolicLink()) { throw new ReviewError('unsupportedStore'); }
		}
	}
	private assertRegular(file: string): void {
		try { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) { throw new ReviewError('unsupportedStore'); } }
		catch (error) { if ((error as { code?: string }).code !== 'ENOENT') { throw error; } }
	}
	private readOptional(file: string): string | null {
		this.assertRegular(file);
		let fd: number | undefined;
		try {
			const limit = file.includes(`${path.sep}review-blobs${path.sep}`) ? (this.options.maxBlobBytes ?? 2 * 1024 * 1024) : (this.options.maxStateBytes ?? 16 * 1024 * 1024);
			fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
			const stat = fs.fstatSync(fd);
			if (!stat.isFile()) { throw new ReviewError('unsupportedStore'); }
			if (stat.size > limit) { throw new ReviewError('storeBudgetExceeded'); }
			const chunks: unknown[] = [];
			let length = 0;
			while (length <= limit) {
				const chunk = BufferImpl.alloc(Math.min(64 * 1024, limit + 1 - length));
				const read: number = fs.readSync(fd, chunk, 0, chunk.length, length);
				if (read === 0) { break; }
				length += read;
				if (length > limit) { throw new ReviewError('storeBudgetExceeded'); }
				chunks.push(chunk.subarray(0, read));
			}
			const bytes = BufferImpl.concat(chunks, length);
			const text: string = bytes.toString('utf8');
			if (!BufferImpl.from(text, 'utf8').equals(bytes)) { throw new ReviewError('unsupportedEncoding'); }
			return text;
		} catch (error) { if ((error as { code?: string }).code === 'ENOENT') { return null; } throw error; }
		finally { if (fd !== undefined) { fs.closeSync(fd); } }
	}
	private hash(text: string | null): string | null { return text === null ? null : crypto.createHash('sha256').update(text, 'utf8').digest('hex'); }
	acquireWriter(): boolean {
		if (this.owner) { this.assertOwner(); return true; }
		this.ensureDirectories();
		const file = this.file('review-writer.lock');
		try {
			const fd = fs.openSync(file, 'wx', 0o600);
			try { fs.writeFileSync(fd, JSON.stringify({ schemaVersion: 1, token: this.token, pid: runtimeProcess.pid, started: new Date().toISOString() })); fs.fsyncSync(fd); }
			finally { fs.closeSync(fd); }
			this.owner = true; this.blockReason = undefined; return true;
		} catch (error) { if ((error as { code?: string }).code === 'EEXIST') { this.blockReason = 'anotherWriter'; return false; } throw error; }
	}
	private assertOwner(): void {
		this.ensureDirectories();
		if (!this.owner || !this.writable) { throw new ReviewError(this.blockReason || 'readOnlyOwner'); }
		const lock = JSON.parse(this.readOptional(this.file('review-writer.lock')) || 'null');
		if (!lock || lock.token !== this.token) { this.owner = false; this.blockReason = 'ownerLost'; throw new ReviewError('ownerLost'); }
	}
	/** Explicit recovery only: a live/ambiguous PID or age never permits taking a lock. */
	async recoverWriter(): Promise<boolean> {
		if (this.owner) { this.assertOwner(); await this.reload(); return this.writable; }
		const file = this.file('review-writer.lock');
		// Serialize cooperating recovery attempts, which otherwise could unlink a new owner's lock.
		const guard = this.file('review-recovery.lock');
		let fd: number;
		try { fd = fs.openSync(guard, 'wx', 0o600); }
		catch (error) {
			if ((error as { code?: string }).code !== 'EEXIST') { throw error; }
			const existing = JSON.parse(this.readOptional(guard) || 'null');
			if (!existing || !Number.isSafeInteger(existing.pid) || existing.pid <= 0 || typeof existing.token !== 'string') { throw new ReviewError('ambiguousRecoveryGuard'); }
			try { runtimeProcess.kill(existing.pid, 0); throw new ReviewError('recoveryInProgress'); }
			catch (probe) {
				if ((probe as { code?: string }).code !== 'ESRCH') { throw probe; }
				throw new ReviewError('orphanedRecoveryGuard', 'Uma recuperação anterior foi interrompida. Feche todas as janelas e sessões deste projeto, faça backup de .claude/launcher-changes, confirme que o PID do guard não está ativo e remova somente review-recovery.lock. Reabra e use Recuperar escritor. Não remova o lock de um processo ativo.');
			}
		}
		try {
			fs.writeFileSync(fd, JSON.stringify({ schemaVersion: 1, token: this.token, pid: runtimeProcess.pid, started: new Date().toISOString() })); fs.fsyncSync(fd);
			const original = this.readOptional(file);
			if (original !== null) {
				const lock = JSON.parse(original);
				if (!lock || !Number.isSafeInteger(lock.pid) || lock.pid <= 0 || typeof lock.token !== 'string') { throw new ReviewError('ambiguousOwner'); }
				try { runtimeProcess.kill(lock.pid, 0); throw new ReviewError('writerStillAlive'); }
				catch (error) { if ((error as { code?: string }).code !== 'ESRCH') { throw error; } }
				this.backupLegacy();
				if (this.readOptional(file) !== original) { throw new ReviewError('ownerChanged'); }
				fs.unlinkSync(file);
			}
			const acquired = this.acquireWriter();
			if (acquired) { await this.reload(); }
			return acquired;
		} finally {
			fs.closeSync(fd);
			if (JSON.parse(this.readOptional(guard) || 'null')?.token === this.token) { fs.unlinkSync(guard); }
		}
	}
	private empty(statuses: Record<string, ReviewResolution>): ReviewState {
		const legacy = this.readOptional(this.file('status.json'));
		const parsed = legacy === null ? statuses : JSON.parse(legacy);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { throw new ReviewError('invalidLegacyStatus'); }
		const admitted: Record<string, ReviewResolution> = {};
		for (const [id, status] of Object.entries(parsed)) {
			if (['__proto__', 'constructor', 'prototype'].includes(id)) { throw new ReviewError('invalidLegacyStatus'); }
			if (status === 'accepted' || status === 'rejected' || status === 'mixed') { admitted[id] = status; }
			else { throw new ReviewError('invalidLegacyStatus'); }
		}
		return { schemaVersion: 1, generation: 0, contextId: this.root, reviews: {}, statuses: admitted, operations: {}, undo: [],
			legacyProjection: { phase: 'complete', observedHash: this.hash(legacy), targetHash: this.hash(legacy), targetGeneration: 0 } };
	}
	private readState(legacyStatus: Record<string, ReviewResolution> = {}): void {
		const text = this.readOptional(this.file('review-state.v1.json'));
		if (text === null) { this.state = this.empty(legacyStatus); return; }
		const raw = JSON.parse(text);
		if (raw.schemaVersion !== 1) { throw new ReviewError('unsupportedSchema'); }
		if (!Number.isSafeInteger(raw.generation) || raw.generation < 0 || raw.contextId !== this.root || !raw.reviews || !raw.statuses || !raw.operations || !Array.isArray(raw.undo) || !raw.legacyProjection) { throw new ReviewError('invalidReviewState'); }
		this.decodedBlobs.clear(); this.materializedBytes = 0;
		this.state = this.decode(raw) as ReviewState;
		this.validate(this.state);
	}
	private validate(state: ReviewState): void {
		const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
		const ids = (value: unknown): boolean => Array.isArray(value) && value.every((id) => typeof id === 'string' && id.length > 0);
		const content = (value: unknown): boolean => object(value) && (value.kind === 'absent' || value.kind === 'text' && typeof value.text === 'string' || value.kind === 'unavailable' && typeof value.reason === 'string');
		const review = (value: unknown): boolean => object(value) && typeof value.file === 'string' && Number.isSafeInteger(value.revision) && (value.revision as number) > 0
			&& ids(value.ids) && typeof value.firstId === 'string' && typeof value.lastId === 'string' && content(value.base) && content(value.expected)
			&& ['pending', 'blocked', 'complete'].includes(String(value.phase)) && Number.isSafeInteger(value.accepted) && Number.isSafeInteger(value.rejected)
			&& (value.reason === null || typeof value.reason === 'string') && (value.resolution === undefined || ['accepted', 'rejected', 'mixed'].includes(String(value.resolution)));
		if (state.schemaVersion !== 1 || !Number.isSafeInteger(state.generation) || state.generation < 0 || state.contextId !== this.root
			|| !object(state.reviews) || !object(state.statuses) || !object(state.operations) || !Array.isArray(state.undo)
			|| !object(state.legacyProjection) || !['complete', 'pending'].includes(state.legacyProjection.phase)) { throw new ReviewError('invalidReviewState'); }
		const validHash = (value: unknown): boolean => value === null || typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
		if (!validHash(state.legacyProjection.observedHash) || !validHash(state.legacyProjection.targetHash) || !Number.isSafeInteger(state.legacyProjection.targetGeneration)) { throw new ReviewError('invalidReviewState'); }
		if (state.entryFingerprints !== undefined && (!object(state.entryFingerprints) || Object.values(state.entryFingerprints).some((hash) => typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)))) { throw new ReviewError('invalidReviewState'); }
		for (const [file, list] of Object.entries(state.reviews)) { if (!Array.isArray(list) || list.some((item) => !review(item) || item.file !== file)) { throw new ReviewError('invalidReviewState'); } }
		for (const status of Object.values(state.statuses)) { if (!['accepted', 'rejected', 'mixed'].includes(status)) { throw new ReviewError('invalidReviewState'); } }
		for (const [id, op] of Object.entries(state.operations)) {
			if (!object(op) || op.id !== id || typeof op.file !== 'string' || !ids(op.ids) || !content(op.expected) || !content(op.target)
				|| !['prepared', 'bufferApplied', 'contentVerified', 'complete', 'blocked', 'needsReconciliation'].includes(String(op.stage))) { throw new ReviewError('invalidReviewState'); }
			if (op.plan !== undefined && (!object(op.plan) || op.plan.file !== op.file || !ids(op.plan.ids) || !Number.isSafeInteger(op.plan.sourceRevision) || !content(op.plan.expected) || !content(op.plan.target) || !review(op.plan.next))) { throw new ReviewError('invalidReviewState'); }
		}
		for (const item of state.undo) { if (!object(item) || typeof item.id !== 'string' || typeof item.operationId !== 'string' || typeof item.file !== 'string'
			|| !ids(item.ids) || !content(item.previous) || !content(item.restored) || !['available', 'retryable', 'needsReconciliation', 'consumed'].includes(String(item.phase))
			|| item.reviewBefore !== undefined && !review(item.reviewBefore)) { throw new ReviewError('invalidReviewState'); } }
	}
	private decode(value: unknown, depth = 0): unknown {
		if (depth > (this.options.maxDepth ?? 64)) { throw new ReviewError('storeDepthExceeded'); }
		if (Array.isArray(value)) { return value.map((item) => this.decode(item, depth + 1)); }
		if (!value || typeof value !== 'object') { return value; }
		const obj = value as Record<string, unknown>;
		if (obj.kind === 'text') {
			const ref = obj.contentRef as { algorithm?: unknown; digest?: unknown } | undefined;
			if (!ref || ref.algorithm !== 'sha256' || typeof ref.digest !== 'string' || !/^[a-f0-9]{64}$/.test(ref.digest)) { throw new ReviewError('invalidSnapshot'); }
			const cached = this.decodedBlobs.has(ref.digest);
			const text = cached ? this.decodedBlobs.get(ref.digest)! : this.readOptional(this.file(`review-blobs/v1/${ref.digest}.txt`));
			if (text === null || this.hash(text) !== ref.digest || BufferImpl.byteLength(text, 'utf8') !== obj.byteLength) { throw new ReviewError('invalidSnapshot'); }
			if (!cached) {
				this.materializedBytes += BufferImpl.byteLength(text, 'utf8');
				if (this.materializedBytes > (this.options.maxMaterializedBytes ?? 64 * 1024 * 1024)) { throw new ReviewError('storeBudgetExceeded'); }
				this.decodedBlobs.set(ref.digest, text);
			}
			return { kind: 'text', text };
		}
		const result: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(obj)) { if (['__proto__', 'constructor', 'prototype'].includes(key)) { throw new ReviewError('invalidReviewState'); } result[key] = this.decode(item, depth + 1); }
		return result;
	}
	private encode(value: unknown, depth = 0): unknown {
		if (depth > (this.options.maxDepth ?? 64)) { throw new ReviewError('storeDepthExceeded'); }
		if (Array.isArray(value)) { return value.map((item) => this.encode(item, depth + 1)); }
		if (!value || typeof value !== 'object') { return value; }
		const obj = value as Record<string, unknown>;
		if (obj.kind === 'text') {
			if (typeof obj.text !== 'string') { throw new ReviewError('invalidSnapshot'); }
			if (BufferImpl.from(obj.text, 'utf8').toString('utf8') !== obj.text) { throw new ReviewError('unsupportedEncoding'); }
			const digest = this.hash(obj.text)!;
			const size = BufferImpl.byteLength(obj.text, 'utf8');
			if (size > (this.options.maxBlobBytes ?? 2 * 1024 * 1024)) { throw new ReviewError('storeBudgetExceeded'); }
			if (!this.encodedBlobs.has(digest)) {
				this.encodedBlobs.add(digest); this.encodedBytes += size;
				if (this.encodedBytes > (this.options.maxMaterializedBytes ?? 64 * 1024 * 1024)) { throw new ReviewError('storeBudgetExceeded'); }
			}
			const file = this.file(`review-blobs/v1/${digest}.txt`);
			this.options.fault?.('blob'); this.assertRegular(file);
			try { const fd = fs.openSync(file, 'wx', 0o600); try { fs.writeFileSync(fd, obj.text, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
			catch (error) { if ((error as { code?: string }).code !== 'EEXIST' || this.readOptional(file) !== obj.text) { throw error; } }
			const crlf = obj.text.includes('\r\n');
			const eol = /\r(?!\n)/.test(obj.text) || crlf && obj.text.replace(/\r\n/g, '').includes('\n') ? 'mixed' : crlf ? 'CRLF' : obj.text.includes('\n') ? 'LF' : 'none';
			return { kind: 'text', contentRef: { algorithm: 'sha256', digest }, byteLength: BufferImpl.byteLength(obj.text, 'utf8'), encoding: 'utf8', bom: obj.text.startsWith('\uFEFF'), eol, finalNewline: obj.text.endsWith('\n') };
		}
		const result: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(obj)) { if (['__proto__', 'constructor', 'prototype'].includes(key)) { throw new ReviewError('invalidReviewState'); } result[key] = this.encode(item, depth + 1); }
		return result;
	}
	private atomic(file: string, text: string): void {
		this.assertRegular(file);
		const temp = `${file}.${this.token}.tmp`;
		try {
			const fd = fs.openSync(temp, 'wx', 0o600);
			try { fs.writeFileSync(fd, text, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
			fs.renameSync(temp, file);
		} finally { if (fs.existsSync(temp)) { fs.unlinkSync(temp); } }
	}
	private backupLegacy(): void {
		this.options.fault?.('backup');
		const parent = this.file('review-migration-backups');
		try { fs.mkdirSync(parent, { mode: 0o700 }); } catch (error) { if ((error as { code?: string }).code !== 'EEXIST') { throw error; } }
		if (!fs.lstatSync(parent).isDirectory() || fs.lstatSync(parent).isSymbolicLink()) { throw new ReviewError('unsupportedStore'); }
		const dir = path.join(parent, crypto.randomUUID()); fs.mkdirSync(dir, { mode: 0o700 });
		const manifest: Record<string, { sha256: string | null; byteLength: number }> = {};
		for (const name of ['status.json', 'review-state.v1.json', 'review-state.v1.json.prev', 'review-writer.lock']) {
			const content = this.readOptional(this.file(name)); if (content !== null) { fs.writeFileSync(path.join(dir, name), content, { flag: 'wx', mode: 0o600 }); manifest[name] = { sha256: this.hash(content), byteLength: BufferImpl.byteLength(content, 'utf8') }; }
		}
		fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest) + '\n', { flag: 'wx', mode: 0o600 });
	}
	private projection(state: ReviewState): string {
		const result: Record<string, string> = {};
		for (const [id, status] of Object.entries(state.statuses)) { if (status === 'accepted' || status === 'rejected') { result[id] = status; } }
		return `${JSON.stringify(result)}\n`;
	}
	private writeCanonical(next: ReviewState): void {
		this.validate(next);
		this.options.fault?.('state');
		this.encodedBlobs.clear(); this.encodedBytes = 0;
		const encoded = JSON.stringify(this.encode(next)) + '\n';
		if (BufferImpl.byteLength(encoded, 'utf8') > (this.options.maxStateBytes ?? 16 * 1024 * 1024)) { throw new ReviewError('storeBudgetExceeded'); }
		const old = this.readOptional(this.file('review-state.v1.json'));
		if (old !== null) { this.atomic(this.file('review-state.v1.json.prev'), old); }
		this.atomic(this.file('review-state.v1.json'), encoded);
		this.state = next;
	}
	private recoverProjection(): void {
		this.assertOwner();
		const actual = this.hash(this.readOptional(this.file('status.json')));
		const projection = this.state.legacyProjection;
		if (projection.phase === 'complete') {
			if (actual !== projection.targetHash) { this.blockReason = 'legacyWriterConflict'; throw new ReviewError('legacyWriterConflict'); }
			return;
		}
		if (actual !== projection.observedHash && actual !== projection.targetHash) { this.blockReason = 'legacyWriterConflict'; throw new ReviewError('legacyWriterConflict'); }
		try {
			if (actual !== projection.targetHash) { this.options.fault?.('projection'); this.atomic(this.file('status.json'), this.projection(this.state)); }
			const next = copyReview(this.state); next.generation += 1; next.legacyProjection.phase = 'complete'; next.legacyProjection.observedHash = next.legacyProjection.targetHash;
			this.writeCanonical(next); this.blockReason = undefined;
		} catch { this.blockReason = 'legacyProjectionPending'; }
	}
	async update(mutator: (draft: ReviewState) => void): Promise<void> {
		const work = this.chain.then(() => {
			this.assertOwner(); this.recoverProjection();
			if (this.state.legacyProjection.phase === 'pending') { throw new ReviewError('legacyProjectionPending'); }
			const disk = this.readOptional(this.file('review-state.v1.json'));
			if (disk !== null && JSON.parse(disk).generation !== this.state.generation) { this.blockReason = 'stateChanged'; throw new ReviewError('stateChanged'); }
			const next = copyReview(this.state); mutator(next); next.generation = this.state.generation + 1;
			next.legacyProjection = { phase: 'pending', observedHash: this.hash(this.readOptional(this.file('status.json'))), targetHash: this.hash(this.projection(next)), targetGeneration: next.generation };
			this.writeCanonical(next); this.recoverProjection();
		});
		this.chain = work.catch(() => undefined);
		return work;
	}
	async reload(): Promise<void> { await this.chain; this.readState(); if (this.owner) { this.recoverProjection(); } }
	/** Release never writes/recreates canonical state; safe after a coordinated purge. */
	async close(): Promise<void> {
		await this.chain;
		if (this.owner) {
			try { const lock = JSON.parse(this.readOptional(this.file('review-writer.lock')) || 'null'); if (lock?.token === this.token) { fs.unlinkSync(this.file('review-writer.lock')); } }
			finally { this.owner = false; this.blockReason = 'releasedWriter'; }
		}
	}
}
