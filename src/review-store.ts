import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as runtimeProcess from 'node:process';
import { Buffer as BufferImpl } from 'node:buffer';

import { copyReview, ReviewError, ReviewState, ReviewResolution } from './review';
import { t } from './i18n';

/** Structural equality. Snapshot strings are shared by copyReview, so equal drafts compare by reference. */
function sameValue(a: unknown, b: unknown): boolean {
	if (a === b) { return true; }
	if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) { return false; }
	const left = a as Record<string, unknown>, right = b as Record<string, unknown>, keys = Object.keys(left);
	return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
}

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
	/**
	 * Blobs whose content this instance wrote or verified, with the file identity seen then.
	 * A later pass trusts the text only while that identity is unchanged; otherwise it reads again.
	 */
	private knownBlobs = new Map<string, { text: string; size: number; mtimeMs: number; ino: number }>();
	/** Digest and UTF-8 size of texts already hashed. Drafts share string instances, so the lookup is by reference. */
	private textDigests = new Map<string, { digest: string; size: number; eol?: string }>();
	private decodedBlobs = new Set<string>();
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
			const chunks: Uint8Array[] = [];
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
	private blobFile(digest: string): string { return this.file(`review-blobs/v1/${digest}.txt`); }
	/** Text already verified for this digest, only while the regular file on disk is the one verified. */
	private trustedBlob(digest: string): string | undefined {
		const known = this.knownBlobs.get(digest);
		if (!known) { return undefined; }
		try {
			const stat = fs.lstatSync(this.blobFile(digest));
			if (stat.isFile() && !stat.isSymbolicLink() && stat.size === known.size && stat.mtimeMs === known.mtimeMs && stat.ino === known.ino) { return known.text; }
		} catch (error) { if ((error as { code?: string }).code !== 'ENOENT') { throw error; } }
		this.knownBlobs.delete(digest);
		return undefined;
	}
	private rememberBlob(digest: string, text: string): void {
		const stat = fs.lstatSync(this.blobFile(digest));
		if (stat.isFile() && !stat.isSymbolicLink()) { this.knownBlobs.set(digest, { text, size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino }); }
	}
	private forgetUnused(used: ReadonlySet<string>): void {
		for (const digest of this.knownBlobs.keys()) { if (!used.has(digest)) { this.knownBlobs.delete(digest); } }
		for (const [text, known] of this.textDigests) { if (!used.has(known.digest)) { this.textDigests.delete(text); } }
	}
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
	/**
	 * True only when the recorded writer is provably gone. A live process, an unreadable or
	 * unrecognized lock and any other doubt answer false. It observes; it never takes the lock.
	 */
	writerExited(): boolean {
		if (this.owner) { return false; }
		try {
			const lock = JSON.parse(this.readOptional(this.file('review-writer.lock')) || 'null');
			if (!lock || !Number.isSafeInteger(lock.pid) || lock.pid <= 0 || typeof lock.token !== 'string') { return false; }
			try { runtimeProcess.kill(lock.pid, 0); return false; }
			catch (error) { return (error as { code?: string }).code === 'ESRCH'; }
		} catch { return false; }
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
				throw new ReviewError('orphanedRecoveryGuard', t('Uma recuperação anterior foi interrompida. Feche todas as janelas e sessões deste projeto, faça backup de .claude/launcher-changes, confirme que o PID do guard não está ativo e remova somente review-recovery.lock. Reabra e use Recuperar escritor. Não remova o lock de um processo ativo.'));
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
		this.forgetUnused(this.decodedBlobs);
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
			// Reading and hashing every snapshot on each reload blocks the Extension Host; a blob
			// already verified is reused while its file identity (size, mtime, inode) is unchanged.
			let text: string | null | undefined = this.trustedBlob(ref.digest);
			if (text === undefined) {
				text = this.readOptional(this.blobFile(ref.digest));
				if (text === null || this.hash(text) !== ref.digest) { throw new ReviewError('invalidSnapshot'); }
				this.rememberBlob(ref.digest, text);
			}
			// A text read back with its digest verified is valid UTF-8 by construction of readOptional.
			let identity = this.textDigests.get(text);
			if (!identity || identity.digest !== ref.digest) { identity = { digest: ref.digest, size: BufferImpl.byteLength(text, 'utf8') }; this.textDigests.set(text, identity); }
			if (identity.size !== obj.byteLength) { throw new ReviewError('invalidSnapshot'); }
			if (!this.decodedBlobs.has(ref.digest)) {
				this.materializedBytes += identity.size;
				if (this.materializedBytes > (this.options.maxMaterializedBytes ?? 64 * 1024 * 1024)) { throw new ReviewError('storeBudgetExceeded'); }
				this.decodedBlobs.add(ref.digest);
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
			// Encoding validity, digest and size depend only on the text, so they are computed once per text.
			let identity = this.textDigests.get(obj.text);
			if (!identity) {
				if (BufferImpl.from(obj.text, 'utf8').toString('utf8') !== obj.text) { throw new ReviewError('unsupportedEncoding'); }
				identity = { digest: this.hash(obj.text)!, size: BufferImpl.byteLength(obj.text, 'utf8') };
				this.textDigests.set(obj.text, identity);
			}
			const { digest, size } = identity;
			if (identity.eol === undefined) {
				const crlf = obj.text.includes('\r\n');
				identity.eol = /\r(?!\n)/.test(obj.text) || crlf && obj.text.replace(/\r\n/g, '').includes('\n') ? 'mixed' : crlf ? 'CRLF' : obj.text.includes('\n') ? 'LF' : 'none';
			}
			if (size > (this.options.maxBlobBytes ?? 2 * 1024 * 1024)) { throw new ReviewError('storeBudgetExceeded'); }
			if (!this.encodedBlobs.has(digest)) {
				this.encodedBlobs.add(digest); this.encodedBytes += size;
				if (this.encodedBytes > (this.options.maxMaterializedBytes ?? 64 * 1024 * 1024)) { throw new ReviewError('storeBudgetExceeded'); }
			}
			const file = this.blobFile(digest);
			this.options.fault?.('blob'); this.assertRegular(file);
			// The first reference in this instance writes the blob or compares an existing one byte
			// for byte. Later updates only confirm that the verified file is still the same.
			if (this.trustedBlob(digest) !== obj.text) {
				try { const fd = fs.openSync(file, 'wx', 0o600); try { fs.writeFileSync(fd, obj.text, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
				catch (error) { if ((error as { code?: string }).code !== 'EEXIST' || this.readOptional(file) !== obj.text) { throw error; } }
				this.rememberBlob(digest, obj.text);
			}
			return { kind: 'text', contentRef: { algorithm: 'sha256', digest }, byteLength: size, encoding: 'utf8', bom: obj.text.startsWith('\uFEFF'), eol: identity.eol, finalNewline: obj.text.endsWith('\n') };
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
		this.forgetUnused(this.encodedBlobs);
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
			const next = copyReview(this.state); mutator(next);
			// Ownership and generation were just proven; an unchanged draft has nothing to persist.
			if (disk !== null && sameValue(next, this.state)) { return; }
			next.generation = this.state.generation + 1;
			const observedHash = this.hash(this.readOptional(this.file('status.json'))), targetHash = this.hash(this.projection(next));
			// The two-phase projection exists to survive a crash between the canonical state and
			// status.json. When status.json already holds the target there is no second write to protect.
			next.legacyProjection = { phase: observedHash === targetHash ? 'complete' : 'pending', observedHash, targetHash, targetGeneration: next.generation };
			this.writeCanonical(next);
			if (next.legacyProjection.phase === 'pending') { this.recoverProjection(); }
		});
		this.chain = work.catch(() => undefined);
		return work;
	}
	/**
	 * Removes snapshot copies that no canonical, previous or backed-up state mentions. It runs in the
	 * update queue, so no draft of this writer can reference a blob while it is being collected.
	 * Any unreadable reference source cancels the collection: unknown references keep every blob.
	 */
	async collectUnreferencedBlobs(graceMs = 10 * 60 * 1000): Promise<number> {
		const work = this.chain.then(() => {
			this.assertOwner();
			if (this.state.legacyProjection.phase === 'pending') { throw new ReviewError('legacyProjectionPending'); }
			const referenced = new Set<string>();
			const collect = (file: string) => { for (const match of (this.readOptional(file) ?? '').matchAll(/[a-f0-9]{64}/g)) { referenced.add(match[0]); } };
			collect(this.file('review-state.v1.json')); collect(this.file('review-state.v1.json.prev'));
			const backups = this.file('review-migration-backups');
			let names: string[] = [];
			try { const stat = fs.lstatSync(backups); if (!stat.isDirectory() || stat.isSymbolicLink()) { throw new ReviewError('unsupportedStore'); } names = fs.readdirSync(backups); }
			catch (error) { if ((error as { code?: string }).code !== 'ENOENT') { throw error; } }
			for (const name of names) {
				const directory = path.join(backups, name), stat = fs.lstatSync(directory);
				if (stat.isSymbolicLink()) { throw new ReviewError('unsupportedStore'); }
				if (stat.isDirectory()) { collect(path.join(directory, 'review-state.v1.json')); collect(path.join(directory, 'review-state.v1.json.prev')); }
			}
			const directory = this.file('review-blobs/v1'), now = Date.now();
			let removed = 0;
			for (const name of fs.readdirSync(directory)) {
				const digest = /^([a-f0-9]{64})\.txt$/.exec(name)?.[1];
				if (!digest || referenced.has(digest)) { continue; }
				const file = path.join(directory, name), stat = fs.lstatSync(file);
				if (!stat.isFile() || stat.isSymbolicLink() || now - stat.mtimeMs <= graceMs) { continue; }
				fs.unlinkSync(file); this.knownBlobs.delete(digest); removed += 1;
			}
			return removed;
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
