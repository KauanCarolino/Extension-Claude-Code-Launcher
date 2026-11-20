/** Validation and local IO boundaries for history. No VS Code dependency. */
import type { RawEntry, Snapshot } from './logic';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Buffer as Bytes } from 'node:buffer';
import { TextDecoder as Utf8Decoder } from 'node:util';

export const CAPTURE_POLICY_FILE = 'capture-policy.json';
export const CAPTURE_STATUS_FILE = 'capture-status.json';
export const CAPTURE_DIAGNOSTICS_DIR = 'capture-diagnostics/v2';
export const MAX_CAPTURE_DIAGNOSTIC_BYTES = 2048;
export const MAX_CAPTURE_DIAGNOSTIC_FILES = 128;
export const CAPTURE_DIAGNOSTIC_STAGES = ['input', 'scope', 'policy', 'inventory', 'snapshot', 'pending', 'append', 'completion', 'maintenance'] as const;
export const CAPTURE_DIAGNOSTIC_CODES = [
	'capturePrepared', 'captureRecorded', 'capturePaused', 'captureMaintenance', 'captureGenerationChanged',
	'quotaExceeded', 'invalidPolicy', 'excludedByPolicy', 'resourceOutsideScope', 'inputBudgetExceeded',
	'storagePermissionDenied', 'storageReadOnly', 'storageFull', 'storageInventoryBudget', 'unsafeStorageType',
	'blobIntegrityFailed', 'pendingGenerationChanged', 'invalidPending', 'storageUnavailable',
] as const;
export type CaptureDiagnosticStage = typeof CAPTURE_DIAGNOSTIC_STAGES[number];
export type CaptureDiagnosticCode = typeof CAPTURE_DIAGNOSTIC_CODES[number];
export interface CaptureDiagnosticEvent {
	schemaVersion: 2; id: string; kind: 'observation' | 'completion'; phase: 'pre' | 'post';
	stage: CaptureDiagnosticStage; code: CaptureDiagnosticCode;
	contentCoverage: 'complete' | 'limited' | 'none' | 'unknown'; observedAt: string;
}
export type CaptureDiagnosticIssue = 'legacyStatus' | 'unsupportedVersion' | 'invalidEvent' | 'futureEvent'
	| 'fileBudget' | 'readUnavailable' | 'unsafeStorage';
const DIAGNOSTIC_ISSUES: readonly CaptureDiagnosticIssue[] = ['legacyStatus', 'unsupportedVersion', 'invalidEvent', 'futureEvent', 'fileBudget', 'readUnavailable', 'unsafeStorage'];
export interface CaptureDiagnostics {
	kind: 'known' | 'unknown' | 'absent'; latestObservation: CaptureDiagnosticEvent | null;
	lastCompletion: CaptureDiagnosticEvent | null; coverage: 'complete' | 'partial'; issues: CaptureDiagnosticIssue[];
}
/** Strict allowlist: diagnostic records never carry source paths, text or exception messages. */
export function validateCaptureDiagnostic(value: unknown, now = Date.now()): CaptureDiagnosticEvent | undefined {
	if (!Number.isFinite(now) || !object(value) || Object.keys(value).length !== 8 || Object.keys(value).some((key) =>
		!['schemaVersion', 'id', 'kind', 'phase', 'stage', 'code', 'contentCoverage', 'observedAt'].includes(key))) { return undefined; }
	return validateDiagnosticFields(value, now);
}
function validateDiagnosticFields(value: Record<string, unknown>, now: number): CaptureDiagnosticEvent | undefined {
	const date = typeof value.observedAt === 'string' ? Date.parse(value.observedAt) : NaN;
	if (value.schemaVersion !== 2 || typeof value.id !== 'string' || !/^[a-f0-9]{32}$/.test(value.id)
		|| !['observation', 'completion'].includes(value.kind as string) || !['pre', 'post'].includes(value.phase as string)
		|| !CAPTURE_DIAGNOSTIC_STAGES.includes(value.stage as CaptureDiagnosticStage)
		|| !CAPTURE_DIAGNOSTIC_CODES.includes(value.code as CaptureDiagnosticCode)
		|| !['complete', 'limited', 'none', 'unknown'].includes(value.contentCoverage as string)
		|| !Number.isFinite(date) || date < 0 || date > now + 5 * 60 * 1000 || new Date(date).toISOString() !== value.observedAt
		|| (value.kind === 'completion' && (value.phase !== 'post' || value.stage !== 'append' || value.code !== 'captureRecorded'))
		|| (value.code === 'captureRecorded' && (value.phase !== 'post' || value.stage !== 'append'))
		|| (value.code === 'capturePrepared' && (value.phase !== 'pre' || value.stage !== 'pending'))) { return undefined; }
	return { schemaVersion: 2, id: value.id, kind: value.kind as CaptureDiagnosticEvent['kind'], phase: value.phase as CaptureDiagnosticEvent['phase'],
		stage: value.stage as CaptureDiagnosticStage, code: value.code as CaptureDiagnosticCode,
		contentCoverage: value.contentCoverage as CaptureDiagnosticEvent['contentCoverage'], observedAt: value.observedAt };
}
export function captureDiagnosticFilename(event: CaptureDiagnosticEvent): string {
	return `${event.observedAt.replace(/[-:.]/g, '')}-${event.id}.json`;
}
export function projectCaptureDiagnostics(events: readonly unknown[], issues: readonly CaptureDiagnosticIssue[] = [], now = Date.now()): CaptureDiagnostics {
	let latestObservation: CaptureDiagnosticEvent | null = null, lastCompletion: CaptureDiagnosticEvent | null = null;
	const detected = new Set<CaptureDiagnosticIssue>(issues.map((issue) => DIAGNOSTIC_ISSUES.includes(issue) ? issue : 'invalidEvent'));
	const newer = (candidate: CaptureDiagnosticEvent, previous: CaptureDiagnosticEvent | null) => !previous
		|| candidate.observedAt > previous.observedAt || candidate.observedAt === previous.observedAt && candidate.id > previous.id;
	for (const value of events) {
		const event = validateCaptureDiagnostic(value, now);
		if (!event) {
			detected.add(object(value) && value.schemaVersion !== undefined && value.schemaVersion !== 2 ? 'unsupportedVersion'
				: object(value) && typeof value.observedAt === 'string' && Date.parse(value.observedAt) > now + 5 * 60 * 1000 ? 'futureEvent' : 'invalidEvent');
			continue;
		}
		if (event.kind === 'completion' && newer(event, lastCompletion)) { lastCompletion = event; }
		if (event.kind === 'observation' && newer(event, latestObservation)) { latestObservation = event; }
	}
	return { kind: latestObservation || lastCompletion ? 'known' : detected.size ? 'unknown' : 'absent', latestObservation, lastCompletion,
		coverage: detected.size ? 'partial' : 'complete', issues: [...detected].sort() };
}
/** Immutable evidence is projected by max(timestamp,id), never by a mutable last-writer pointer. */
export async function readCaptureDiagnostics(historyDir: string, workspaceRoot: string): Promise<CaptureDiagnostics> {
	const events: unknown[] = [], issues: CaptureDiagnosticIssue[] = [];
	for (const [bucket, kind] of [['observations', 'observation'], ['completions', 'completion']] as const) {
		const directory = path.join(historyDir, ...CAPTURE_DIAGNOSTICS_DIR.split('/'), bucket);
		const scope = await assessStoragePath(directory, workspaceRoot);
		if (!scope.allowed) { issues.push('unsafeStorage'); continue; }
		const names: string[] = [];
		let handle: fs.Dir | undefined;
		try {
			handle = await fs.promises.opendir(directory, { bufferSize: 16 });
			for (let index = 0; index <= MAX_CAPTURE_DIAGNOSTIC_FILES; index += 1) {
				const entry = await handle.read();
				if (entry === null) { break; }
				if (index === MAX_CAPTURE_DIAGNOSTIC_FILES) { issues.push('fileBudget'); break; }
				names.push(entry.name);
			}
		} catch (error) { if (!absent(error)) { issues.push('readUnavailable'); } }
		finally { await handle?.close().catch(() => undefined); }
		for (const name of names.sort().reverse()) {
			if (!/^\d{8}T\d{9}Z-[a-f0-9]{32}\.json$/.test(name)) { issues.push('invalidEvent'); continue; }
			const read = await safeReadText(path.join(directory, name), workspaceRoot, MAX_CAPTURE_DIAGNOSTIC_BYTES);
			if (read.kind !== 'content') { issues.push('readUnavailable'); continue; }
			try {
				const value: unknown = JSON.parse(read.text);
				const event = validateCaptureDiagnostic(value);
				if (event && (event.kind !== kind || captureDiagnosticFilename(event) !== name)) { issues.push('invalidEvent'); continue; }
				events.push(value);
			} catch { issues.push('invalidEvent'); }
		}
	}
	const projection = projectCaptureDiagnostics(events, issues);
	if (projection.kind === 'known') { return projection; }
	const legacy = await safeReadText(path.join(historyDir, CAPTURE_STATUS_FILE), workspaceRoot, MAX_CAPTURE_DIAGNOSTIC_BYTES);
	if (legacy.kind === 'content') {
		try { const value = JSON.parse(legacy.text); issues.push(value?.schemaVersion === 1 ? 'legacyStatus' : 'unsupportedVersion'); }
		catch { issues.push('invalidEvent'); }
	} else if (legacy.kind === 'error') { issues.push('readUnavailable'); }
	return projectCaptureDiagnostics(events, issues);
}
export const CAPTURE_MAINTENANCE_FILE = 'capture-maintenance.lock';
export const MAX_SNAPSHOT_BYTES = 512 * 1024;
export const DEFAULT_EXCLUDED_PATTERNS = [
	'**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx',
	'**/id_rsa', '**/id_ed25519', '**/credentials.json',
];
export interface CapturePolicy {
	schemaVersion: 1;
	generation: string;
	paused: boolean;
	excludedPatterns: string[];
	maxStorageBytes: number;
	retentionDays: number;
}
export function makeCapturePolicy(options: {
	generation?: string; paused?: boolean; excludedPatterns?: string[];
	maxStorageMB?: number; retentionDays?: number;
} = {}): CapturePolicy {
	const candidate = {
		schemaVersion: 1, generation: options.generation ?? crypto.randomUUID(), paused: options.paused ?? false,
		excludedPatterns: options.excludedPatterns ?? [...DEFAULT_EXCLUDED_PATTERNS],
		maxStorageBytes: Math.floor((options.maxStorageMB ?? 128) * 1024 * 1024),
		retentionDays: options.retentionDays ?? 30,
	};
	if (!validateCapturePolicy(candidate)) {
		throw new Error('invalidCapturePolicy');
	}
	return candidate;
}
function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function limitedString(value: unknown, maximum: number, allowEmpty = false): value is string {
	return typeof value === 'string' && (allowEmpty || value.length > 0)
		&& value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
}
export function validateCapturePolicy(value: unknown): value is CapturePolicy {
	return object(value) && value.schemaVersion === 1 && limitedString(value.generation, 256)
		&& typeof value.paused === 'boolean' && Array.isArray(value.excludedPatterns)
		&& value.excludedPatterns.length <= 100 && value.excludedPatterns.every((pattern) =>
			limitedString(pattern, 512) && !pattern.startsWith('/') && !pattern.split(/[\\/]/).includes('..'))
		&& Number.isSafeInteger(value.maxStorageBytes) && (value.maxStorageBytes as number) >= 1024 * 1024
		&& (value.maxStorageBytes as number) <= 2 * 1024 * 1024 * 1024
		&& Number.isSafeInteger(value.retentionDays) && (value.retentionDays as number) >= 0
		&& (value.retentionDays as number) <= 3650;
}

export function matchesExcludedPath(relative: string, patterns: readonly string[]): boolean {
	const normalized = relative.replace(/\\/g, '/').replace(/^\.\//, '');
	return patterns.some((pattern) => {
		let expression = '';
		for (let i = 0; i < pattern.length; i += 1) {
			const char = pattern[i];
			if (char === '*' && pattern[i + 1] === '*' && pattern[i + 2] === '/') {
				expression += '(?:.*/)?'; i += 2;
			} else if (char === '*' && pattern[i + 1] === '*') {
				expression += '.*'; i += 1;
			} else if (char === '*') {
				expression += '[^/]*';
			} else if (char === '?') {
				expression += '[^/]';
			} else {
				expression += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			}
		}
		return new RegExp(`^${expression}$`).test(normalized);
	});
}

function snapshot(value: unknown): value is Snapshot | null {
	if (value === null) {
		return true;
	}
	if (!object(value) || typeof value.exists !== 'boolean' || typeof value.large !== 'boolean'
		|| (value.text !== null && typeof value.text !== 'string')) {
		return false;
	}
	if ((!value.exists || value.large) && value.text !== null) {
		return false;
	}
	if (typeof value.text === 'string' && Bytes.byteLength(value.text, 'utf8') > MAX_SNAPSHOT_BYTES) {
		return false;
	}
	return value.hash === undefined || value.hash === null
		|| (typeof value.hash === 'string' && /^[a-f0-9]{40}$/.test(value.hash));
}

export type EntryValidation = { ok: true; entry: RawEntry } | { ok: false; code: string };
export function validateRawEntry(value: unknown): EntryValidation {
	if (!object(value)) {
		return { ok: false, code: 'invalidEntryShape' };
	}
	if (value.schemaVersion !== undefined && value.schemaVersion !== 1) {
		return { ok: false, code: 'unsupportedCaptureSchema' };
	}
	if (!limitedString(value.id, 256) || !limitedString(value.file, 8192)
		|| !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value.file)
		|| !limitedString(value.time, 64) || !Number.isFinite(Date.parse(value.time))
		|| !snapshot(value.before) || !snapshot(value.after)) {
		return { ok: false, code: 'invalidEntryFields' };
	}
	for (const [field, max] of [['session', 256], ['tool', 128], ['toolUseId', 256], ['transcript', 8192]] as const) {
		if (value[field] !== undefined && value[field] !== null && !limitedString(value[field], max)) {
			return { ok: false, code: 'invalidEntryMetadata' };
		}
	}
	if (value.reason !== undefined && value.reason !== null
		&& (typeof value.reason !== 'string' || Bytes.byteLength(value.reason, 'utf8') > 64 * 1024)) {
		return { ok: false, code: 'invalidEntryMetadata' };
	}
	// Return only inert, validated fields. Unknown properties never become authority.
	return { ok: true, entry: {
		id: value.id, file: value.file, time: value.time, before: value.before, after: value.after,
		session: value.session as string | null | undefined, tool: value.tool as string | null | undefined,
		toolUseId: value.toolUseId as string | null | undefined,
		transcript: value.transcript as string | null | undefined,
		reason: value.reason,
	} };
}

export interface LogCursor { offset: number; line: number }
export interface LogOptions {
	cursor?: LogCursor;
	/** Absolute byte offset represented by input[0], for reads from a file slice. */
	baseOffset?: number;
	maxBytes?: number;
	maxEntries?: number;
	maxLineBytes?: number;
	allowLargeLines?: boolean;
}
export interface LogParseResult {
	entries: RawEntry[];
	sources: Array<{ id: string; offset: number; ordinal: number }>;
	rejections: Array<{ code: string; offset: number; size: number; digest: string }>;
	cursor: LogCursor;
	coverage: { status: 'complete' | 'partial'; reason?: string; bytesRead: number; linesRead: number };
}

export function parseLog(input: string | Uint8Array, options: LogOptions = {}): LogParseResult {
	const data = typeof input === 'string' ? Bytes.from(input, 'utf8') : Bytes.from(input);
	const base = options.baseOffset ?? 0;
	const initial = options.cursor ?? { offset: base, line: 0 };
	const result: LogParseResult = {
		entries: [], sources: [], rejections: [], cursor: { ...initial },
		coverage: { status: 'complete', bytesRead: 0, linesRead: 0 },
	};
	const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
	const maxEntries = options.maxEntries ?? 1000;
	const fastLine = options.maxLineBytes ?? 2 * 1024 * 1024 + 64 * 1024;
	const maxLine = options.allowLargeLines ? Math.max(fastLine, 8 * 1024 * 1024) : fastLine;
	let position = initial.offset - base;
	if (!Number.isSafeInteger(position) || position < 0 || position > data.length) {
		result.coverage = { ...result.coverage, status: 'partial', reason: 'cursorChanged' };
		return result;
	}
	const seen = new Map<string, string>();
	const reject = (code: string, start: number, line: Uint8Array) => result.rejections.push({
		code, offset: base + start, size: line.byteLength,
		digest: crypto.createHash('sha256').update(line).digest('hex'),
	});
	while (position < data.length) {
		const end = data.indexOf(10, position);
		if (end < 0) {
			result.coverage.status = 'partial'; result.coverage.reason = 'incompleteLine'; break;
		}
		const size = end - position;
		if (size > maxLine) {
			result.coverage.status = 'partial'; result.coverage.reason = 'deferredByBudget'; break;
		}
		if (result.coverage.bytesRead + size + 1 > maxBytes || result.coverage.linesRead >= maxEntries) {
			result.coverage.status = 'partial'; result.coverage.reason = 'budget'; break;
		}
		const line = data.subarray(position, end);
		let text: string | undefined;
		try {
			const decoded: string = new Utf8Decoder('utf-8', { fatal: true }).decode(line);
			text = decoded;
			if (decoded.trim()) {
				const validated = validateRawEntry(JSON.parse(decoded));
				if (!validated.ok) {
					reject(validated.code, position, line);
				} else {
					const signature = crypto.createHash('sha256').update(JSON.stringify(validated.entry)).digest('hex');
					const previous = seen.get(validated.entry.id);
					if (previous && previous !== signature) {
						reject('conflictingEntryId', position, line);
					} else if (!previous) {
						seen.set(validated.entry.id, signature);
						result.entries.push(validated.entry);
						result.sources.push({ id: validated.entry.id, offset: base + position, ordinal: result.cursor.line });
					}
				}
			}
		} catch {
			reject(text === undefined ? 'invalidUtf8' : 'invalidEntryJson', position, line);
		}
		result.coverage.bytesRead += size + 1;
		result.coverage.linesRead += 1;
		position = end + 1;
		result.cursor = { offset: base + position, line: result.cursor.line + 1 };
	}
	if (result.rejections.length > 0) {
		result.coverage.status = 'partial'; result.coverage.reason ??= 'invalidEntries';
	}
	return result;
}

/** Local selected root may itself be an alias; descendants in storage may not be links. */
export interface PathIO {
	realpath(file: string): Promise<string>;
	lstat(file: string): Promise<{ isSymbolicLink(): boolean; isFile(): boolean; isDirectory(): boolean }>;
}
function inside(root: string, file: string): boolean {
	const relative = path.relative(root, file);
	return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function absent(error: unknown): boolean {
	return object(error) && error.code === 'ENOENT';
}
export async function assessResourceScope(file: string, root: string, io: PathIO = fs.promises): Promise<{
	allowed: boolean; code?: string; canonicalPath?: string;
}> {
	if (!limitedString(file, 8192) || !path.isAbsolute(file) || !path.isAbsolute(root) || !inside(path.resolve(root), path.resolve(file))) {
		return { allowed: false, code: 'resourceOutsideScope' };
	}
	try {
		const canonicalRoot = await io.realpath(root);
		let current = path.resolve(file);
		const missing: string[] = [];
		while (true) {
			try {
				current = await io.realpath(current); break;
			} catch (error) {
				if (!absent(error) || current === path.dirname(current)) { throw error; }
				missing.unshift(path.basename(current)); current = path.dirname(current);
			}
		}
		const canonicalPath = path.join(current, ...missing);
		return inside(canonicalRoot, canonicalPath)
			? { allowed: true, canonicalPath } : { allowed: false, code: 'resourceOutsideScope' };
	} catch {
		return { allowed: false, code: 'resourceIdentityUnavailable' };
	}
}

export async function assessStoragePath(file: string, root: string, io: PathIO = fs.promises): Promise<{
	allowed: boolean; code?: string; canonicalPath?: string;
}> {
	if (!path.isAbsolute(root) || !path.isAbsolute(file) || !inside(path.resolve(root), path.resolve(file))) {
		return { allowed: false, code: 'storageOutsideScope' };
	}
	try {
		const canonicalRoot = await io.realpath(root);
		const parts = path.relative(path.resolve(root), path.resolve(file)).split(path.sep).filter(Boolean);
		let current = canonicalRoot;
		for (let i = 0; i < parts.length; i += 1) {
			current = path.join(current, parts[i]);
			try {
				const metadata = await io.lstat(current);
				if (metadata.isSymbolicLink() || (i < parts.length - 1 && !metadata.isDirectory())
					|| (i === parts.length - 1 && !metadata.isDirectory() && !metadata.isFile())) {
					return { allowed: false, code: 'unsafeStorageType' };
				}
			} catch (error) {
				if (!absent(error)) { throw error; }
				return { allowed: true, canonicalPath: path.join(current, ...parts.slice(i + 1)) };
			}
		}
		return { allowed: true, canonicalPath: current };
	} catch {
		return { allowed: false, code: 'storageIdentityUnavailable' };
	}
}

export type SafeTextRead = { kind: 'content'; text: string } | { kind: 'absent' } | { kind: 'error'; code: string };
export async function safeReadText(file: string, root: string, maxBytes = 2 * 1024 * 1024): Promise<SafeTextRead> {
	const policy = await assessStoragePath(file, root);
	if (!policy.allowed || policy.canonicalPath === undefined) { return { kind: 'error', code: policy.code ?? 'unsafeStorage' }; }
	let handle: fs.promises.FileHandle | undefined;
	try {
		handle = await fs.promises.open(policy.canonicalPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
		const metadata = await handle.stat();
		if (!metadata.isFile() || metadata.size > maxBytes) { return { kind: 'error', code: 'readBudgetOrType' }; }
		const data = Bytes.alloc(maxBytes + 1);
		let read = 0;
		while (read < data.length) {
			const part = await handle.read(data, read, data.length - read, read);
			if (part.bytesRead === 0) { break; }
			read += part.bytesRead;
		}
		if (read > maxBytes) { return { kind: 'error', code: 'readBudgetExceeded' }; }
		return { kind: 'content', text: new Utf8Decoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data.subarray(0, read)) };
	} catch (error) {
		return absent(error) ? { kind: 'absent' } : { kind: 'error', code: 'readFailed' };
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

export async function readLogFile(file: string, root: string, options: LogOptions = {}): Promise<LogParseResult> {
	const initial = options.cursor ?? { offset: 0, line: 0 };
	const empty = () => parseLog(new Uint8Array(), { cursor: initial, baseOffset: initial.offset });
	const policy = await assessStoragePath(file, root);
	if (!policy.allowed || policy.canonicalPath === undefined) {
		const result = empty(); result.coverage.status = 'partial'; result.coverage.reason = policy.code ?? 'unsafeStorage'; return result;
	}
	let handle: fs.promises.FileHandle | undefined;
	try {
		handle = await fs.promises.open(policy.canonicalPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
		const metadata = await handle.stat();
		if (!metadata.isFile() || initial.offset > metadata.size) { throw new Error('invalidLogCursor'); }
		const budget = Math.min(options.maxBytes ?? 8 * 1024 * 1024, 16 * 1024 * 1024);
		const data = Bytes.alloc(Math.min(budget, metadata.size - initial.offset));
		let read = 0;
		while (read < data.length) {
			const part = await handle.read(data, read, data.length - read, initial.offset + read);
			if (part.bytesRead === 0) { break; }
			read += part.bytesRead;
		}
		let result = parseLog(data.subarray(0, read), { ...options, baseOffset: initial.offset });
		// A bounded compatibility path admits valid inline legacy snapshots with JSON escaping.
		if (result.coverage.reason === 'deferredByBudget' && !options.allowLargeLines) {
			result = parseLog(data.subarray(0, read), { ...options, baseOffset: initial.offset, allowLargeLines: true });
		}
		if (initial.offset + read < metadata.size && result.coverage.status === 'complete') {
			result.coverage.status = 'partial'; result.coverage.reason = 'budget';
		} else if (initial.offset + read < metadata.size && result.coverage.reason === 'incompleteLine') {
			result.coverage.reason = 'deferredByBudget';
		}
		return result;
	} catch (error) {
		const result = empty();
		if (!absent(error)) { result.coverage.status = 'partial'; result.coverage.reason = 'logReadFailed'; }
		return result;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

export function verifyBlob(text: string, hash: string): boolean {
	if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(hash) || Bytes.byteLength(text, 'utf8') > MAX_SNAPSHOT_BYTES) { return false; }
	return crypto.createHash(hash.length === 40 ? 'sha1' : 'sha256').update(text, 'utf8').digest('hex') === hash;
}
export async function readVerifiedBlob(file: string, root: string, hash: string): Promise<string | undefined> {
	const read = await safeReadText(file, root, MAX_SNAPSHOT_BYTES);
	return read.kind === 'content' && verifyBlob(read.text, hash) ? read.text : undefined;
}
export async function transcriptAllowed(file: string, expectedDirectories: readonly string[], io: PathIO = fs.promises): Promise<boolean> {
	if (!limitedString(file, 8192) || !/^[A-Za-z0-9_.-]+\.jsonl$/.test(path.basename(file))) { return false; }
	for (const root of expectedDirectories) {
		const result = await assessResourceScope(file, root, io);
		if (result.allowed && result.canonicalPath !== undefined && path.dirname(result.canonicalPath) === await io.realpath(root).catch(() => '')) { return true; }
	}
	return false;
}

export function validateSavedMeta(value: unknown): Record<string, { reason: string | null; request: { id: string; text: string } | null }> {
	const result = Object.create(null) as Record<string, { reason: string | null; request: { id: string; text: string } | null }>;
	if (!object(value)) { return result; }
	for (const [id, item] of Object.entries(value).slice(0, 10000)) {
		if (!limitedString(id, 256) || !object(item)) { continue; }
		const reason = typeof item.reason === 'string' && Bytes.byteLength(item.reason, 'utf8') <= 64 * 1024 ? item.reason : null;
		const request = object(item.request) && limitedString(item.request.id, 256)
			&& typeof item.request.text === 'string' && Bytes.byteLength(item.request.text, 'utf8') <= 64 * 1024
			? { id: item.request.id, text: item.request.text } : null;
		if (reason !== null || request !== null) { result[id] = { reason, request }; }
	}
	return result;
}

export interface HistoryMessage { command: string; id?: string; key?: string; request?: string; revision?: number }
const CHANGES_COMMANDS = new Set([
	'ready', 'refresh', 'toggleChatFilter', 'enable', 'disable', 'clear', 'purge', 'openPanel', 'compare', 'showInCode', 'openFile',
	'acceptAll', 'rejectAll', 'acceptFile', 'rejectFile', 'rejectRequest', 'undoReject',
	'release', 'recover', 'releaseWriter', 'recoverWriter', 'clearAllReviewData',
]);
const HOME_COMMANDS = new Set(['ready', 'install', 'newTab', 'openSidebar', 'refresh', 'openSession', 'focusTab', 'closeTab', 'showSkills', 'showChats',
	'skills.refresh', 'skills.open', 'skills.reveal', 'skills.toggle', 'skills.delete', 'skills.create']);
export function validateMessage(value: unknown, surface: 'changes' | 'home' = 'changes'): HistoryMessage | undefined {
	if (!object(value) || typeof value.command !== 'string'
		|| !(surface === 'changes' ? CHANGES_COMMANDS : HOME_COMMANDS).has(value.command)) { return undefined; }
	for (const field of ['id', 'key', 'request'] as const) {
		if (value[field] !== undefined && !limitedString(value[field], field === 'key' ? 8192 : 256)) { return undefined; }
	}
	if (value.revision !== undefined && (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0)) { return undefined; }
	const required = new Map([
		['compare', 'id'], ['showInCode', 'id'], ['openFile', 'id'], ['openSession', 'id'],
		['acceptFile', 'key'], ['rejectFile', 'key'], ['focusTab', 'key'], ['closeTab', 'key'], ['rejectRequest', 'request'],
	]);
	const field = required.get(value.command);
	if (field && value[field] === undefined) { return undefined; }
	return { command: value.command, id: value.id as string | undefined, key: value.key as string | undefined,
		request: value.request as string | undefined, revision: value.revision as number | undefined };
}

export const PROTECTED_HISTORY_PATHS = [
	'review-state.v1.json', 'review-state.v1.json.prev', 'review-writer.lock', 'review-recovery.lock',
	CAPTURE_MAINTENANCE_FILE, 'review-blobs', 'review-migration-backups',
];
export function isCanonicalHistoryPath(relative: string): boolean {
	const first = relative.replace(/\\/g, '/').split('/')[0];
	return PROTECTED_HISTORY_PATHS.includes(first);
}
export function collectContentHashes(value: unknown, maxNodes = 100000): { hashes: Set<string>; complete: boolean } {
	const hashes = new Set<string>();
	const queue: unknown[] = [value];
	let visited = 0;
	while (queue.length) {
		if (++visited > maxNodes) { return { hashes, complete: false }; }
		const next = queue.pop();
		if (typeof next === 'string') {
			const match = /(?:^|\/)([a-f0-9]{40}|[a-f0-9]{64})(?:\.txt)?$/.exec(next);
			if (match) { hashes.add(match[1]); }
		} else if (next && typeof next === 'object') {
			const children = Object.values(next);
			if (children.length + queue.length + visited > maxNodes) { return { hashes, complete: false }; }
			queue.push(...children);
		}
	}
	return { hashes, complete: true };
}
export interface HistoryFile { relative: string; mtime: number; size?: number; type?: 'file' | 'directory' | 'link' }
export function planLegacyGc(files: readonly HistoryFile[], references: ReadonlySet<string>, now: number,
	options: { referencesComplete?: boolean; graceMs?: number } = {}): string[] {
	if (options.referencesComplete === false) { return []; }
	return files.filter((file) => file.type !== 'link' && file.type !== 'directory'
		&& /^blobs\/[a-f0-9]{40}\.txt$/.test(file.relative)
		&& !references.has(file.relative.slice(6, 46))
		&& now - file.mtime > (options.graceMs ?? 10 * 60 * 1000)).map((file) => file.relative);
}
export function planFullCleanup(files: readonly HistoryFile[], ownership: { owned: boolean; quiescent: boolean }): {
	kind: 'ready' | 'blocked'; code?: string; paths: string[];
} {
	if (!ownership.owned || !ownership.quiescent) { return { kind: 'blocked', code: 'cleanupNeedsOwnershipAndQuiescence', paths: [] }; }
	if (files.some((file) => file.type !== 'directory' && (file.relative.startsWith('active/') || /^pending\/[^/]+\.post$/.test(file.relative)))) {
		return { kind: 'blocked', code: 'captureInProgress', paths: [] };
	}
	const own = /^(?:log\.jsonl|status\.json|meta\.json|capture-status\.json|review-state\.v1\.json(?:\.prev)?|(?:blobs|pending|completed|review-blobs|review-migration-backups|settings-backups|quarantine-index|capture-diagnostics)(?:\/[^\u0000]+)?)$/;
	if (files.some((file) => file.type === 'link' && own.test(file.relative))) {
		return { kind: 'blocked', code: 'cleanupUnsafeStorageType', paths: [] };
	}
	const paths = files.filter((file) => file.type !== 'link' && !file.relative.split(/[\\/]/).includes('..')
		&& own.test(file.relative) && file.relative !== 'review-writer.lock').map((file) => file.relative);
	return { kind: 'ready', paths };
}

export function retentionCandidates(entries: readonly RawEntry[], days: number, now: number, isReviewed: (id: string) => boolean): string[] {
	if (!Number.isFinite(days) || days <= 0) { return []; }
	const cutoff = now - days * 24 * 60 * 60 * 1000;
	return entries.filter((entry) => isReviewed(entry.id) && Date.parse(entry.time) < cutoff).map((entry) => entry.id);
}
