#!/usr/bin/env node
// Standalone observability hook. Never approves a tool or executes workspace code.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');

const MAX_FILE_BYTES = 512 * 1024;
// Two valid 512 KiB Edit strings can expand past 1 MiB when serialized as JSON.
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const CAPTURE_MAINTENANCE_FILE = 'capture-maintenance.lock';
const CAPTURE_DIAGNOSTICS_DIR = 'capture-diagnostics/v2';
const MAX_DIAGNOSTIC_BYTES = 2048;
const MAX_DIAGNOSTIC_FILES = 128;
const RETAIN_DIAGNOSTIC_FILES = 32;
const DIAGNOSTIC_STAGES = ['input', 'scope', 'policy', 'inventory', 'snapshot', 'pending', 'append', 'completion', 'maintenance'];
const DIAGNOSTIC_CODES = [
	'capturePrepared', 'captureRecorded', 'capturePaused', 'captureMaintenance', 'captureGenerationChanged',
	'quotaExceeded', 'invalidPolicy', 'excludedByPolicy', 'resourceOutsideScope', 'inputBudgetExceeded',
	'storagePermissionDenied', 'storageReadOnly', 'storageFull', 'storageInventoryBudget', 'unsafeStorageType',
	'blobIntegrityFailed', 'pendingGenerationChanged', 'invalidPending', 'storageUnavailable',
];
const DEFAULT_EXCLUDED_PATTERNS = [
	'**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx',
	'**/id_rsa', '**/id_ed25519', '**/credentials.json',
];
const DEFAULT_POLICY = Object.freeze({
	schemaVersion: 1, generation: 'legacy-default', paused: false,
	excludedPatterns: DEFAULT_EXCLUDED_PATTERNS, maxStorageBytes: 128 * 1024 * 1024, retentionDays: 30,
});

function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function string(value, maximum) {
	return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
}
function validatePolicy(value) {
	return plain(value) && value.schemaVersion === 1 && string(value.generation, 256)
		&& typeof value.paused === 'boolean' && Array.isArray(value.excludedPatterns)
		&& value.excludedPatterns.length <= 100 && value.excludedPatterns.every((item) =>
			string(item, 512) && !item.startsWith('/') && !item.split(/[\\/]/).includes('..'))
		&& Number.isSafeInteger(value.maxStorageBytes) && value.maxStorageBytes >= 1024 * 1024
		&& value.maxStorageBytes <= 2 * 1024 * 1024 * 1024
		&& Number.isSafeInteger(value.retentionDays) && value.retentionDays >= 0 && value.retentionDays <= 3650;
}
function globExpression(pattern) {
	let expression = '';
	for (let i = 0; i < pattern.length; i += 1) {
		const char = pattern[i];
		if (char === '*' && pattern[i + 1] === '*' && pattern[i + 2] === '/') { expression += '(?:.*/)?'; i += 2; }
		else if (char === '*' && pattern[i + 1] === '*') { expression += '.*'; i += 1; }
		else if (char === '*') { expression += '[^/]*'; }
		else if (char === '?') { expression += '[^/]'; }
		else { expression += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
	}
	return new RegExp(`^${expression}$`);
}
function compileGlobs(patterns) { return patterns.map(globExpression); }
function matchesGlobs(relative, expressions) {
	const name = relative.replace(/\\/g, '/');
	return expressions.some((expression) => expression.test(name));
}
function excluded(relative, patterns) { return matchesGlobs(relative, compileGlobs(patterns)); }
function isMissing(error) { return error && error.code === 'ENOENT'; }
function inside(root, file) {
	const relative = path.relative(root, file);
	return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Injection point permits defensive filesystem-contract tests without external IO. */
function storage(root, io = fs) {
	const canonicalRoot = io.realpathSync(root);
	function checked(file) {
		if (!inside(canonicalRoot, file)) { throw new Error('storageOutsideScope'); }
		const parts = path.relative(canonicalRoot, file).split(path.sep).filter(Boolean);
		let current = canonicalRoot;
		for (let i = 0; i < parts.length; i += 1) {
			current = path.join(current, parts[i]);
			try {
				const stat = io.lstatSync(current);
				if (stat.isSymbolicLink() || (i < parts.length - 1 && !stat.isDirectory())
					|| (i === parts.length - 1 && !stat.isDirectory() && !stat.isFile())) {
					throw new Error('unsafeStorageType');
				}
			} catch (error) {
				if (!isMissing(error)) { throw error; }
				break;
			}
		}
		return file;
	}
	function directory(file) {
		checked(file);
		let current = canonicalRoot;
		for (const part of path.relative(canonicalRoot, file).split(path.sep).filter(Boolean)) {
			current = path.join(current, part);
			try { io.mkdirSync(current, { mode: 0o700 }); }
			catch (error) { if (!error || error.code !== 'EEXIST') { throw error; } }
			const stat = io.lstatSync(current);
			if (stat.isSymbolicLink() || !stat.isDirectory()) { throw new Error('unsafeStorageType'); }
		}
	}
	function read(file, maximum) {
		checked(file);
		let fd;
		try {
			fd = io.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
			const stat = io.fstatSync(fd);
			if (!stat.isFile() || stat.size > maximum) { throw new Error('readBudgetOrType'); }
			const buffer = Buffer.alloc(maximum + 1);
			let length = 0;
			while (length < buffer.length) {
				const count = io.readSync(fd, buffer, length, buffer.length - length, length);
				if (count === 0) { break; }
				length += count;
			}
			if (length > maximum) { throw new Error('readBudgetExceeded'); }
			return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length));
		} finally { if (fd !== undefined) { io.closeSync(fd); } }
	}
	function writeNew(file, text, durable = false) {
		checked(file);
		const fd = io.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
		try { io.writeFileSync(fd, text, 'utf8'); if (durable) { io.fsyncSync(fd); } }
		finally { io.closeSync(fd); }
	}
	return { root: canonicalRoot, checked, directory, read, writeNew };
}

function readSmall(file, io = fs) {
	let fd;
	try {
		fd = io.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
		const stat = io.fstatSync(fd);
		if (!stat.isFile()) { return null; }
		if (stat.size > MAX_FILE_BYTES) { return { exists: true, large: true, text: undefined }; }
		const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
		let length = 0;
		while (length < bytes.length) {
			const count = io.readSync(fd, bytes, length, bytes.length - length, length);
			if (!count) { break; }
			length += count;
		}
		if (length > MAX_FILE_BYTES) { return { exists: true, large: true, text: undefined }; }
		return { exists: true, large: false, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length)) };
	} catch (error) {
		return isMissing(error) ? { exists: false, large: false, text: undefined } : null;
	} finally { if (fd !== undefined) { io.closeSync(fd); } }
}

function storageBytes(dir, io = fs, maxFiles = 10000) {
	let count = 0;
	let bytes = 0;
	const queue = [dir];
	while (queue.length) {
		const current = queue.pop();
		let names;
		try { names = io.readdirSync(current); }
		catch (error) { if (isMissing(error)) { continue; } throw error; }
		for (const name of names) {
			if (++count > maxFiles) { throw new Error('storageInventoryBudget'); }
			const file = path.join(current, name);
			let stat;
			try { stat = io.lstatSync(file); }
			catch (error) { if (isMissing(error)) { continue; } throw error; }
			if (stat.isSymbolicLink()) { throw new Error('unsafeStorageType'); }
			if (stat.isDirectory()) { queue.push(file); }
			else if (stat.isFile()) { bytes += stat.size; }
			else { throw new Error('unsafeStorageType'); }
		}
	}
	return bytes;
}
function rebuildBefore(tool, input, after) {
	if (tool !== 'Edit' || !after || typeof after.text !== 'string') { return null; }
	const oldString = input.old_string;
	const newString = input.new_string;
	if (typeof oldString !== 'string' || typeof newString !== 'string' || !newString || !after.text.includes(newString)) { return null; }
	const occurrences = after.text.split(newString).length - 1;
	// Existing occurrences cannot be distinguished from replacements without pre.
	if (occurrences !== 1) { return null; }
	const text = input.replace_all ? after.text.split(newString).join(oldString) : after.text.replace(newString, () => oldString);
	return Buffer.byteLength(text, 'utf8') <= MAX_FILE_BYTES ? { exists: true, large: false, text } : null;
}

/** Guarda `text` em `directory/<sha1>.txt` (conferindo uma cópia que já exista) e renova a data dela para a coleta. */
function putBlob(store, io, directory, text) {
	const hash = crypto.createHash('sha1').update(text, 'utf8').digest('hex');
	const file = path.join(directory, `${hash}.txt`);
	try { store.writeNew(file, text); }
	catch (error) {
		if (!error || error.code !== 'EEXIST') { throw error; }
		if (store.read(file, MAX_FILE_BYTES) !== text) { throw new Error('blobIntegrityFailed'); }
	}
	let fd;
	try {
		store.checked(file);
		// Windows requires write access on the existing handle to update file times.
		fd = io.openSync(file, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0));
		if (!io.fstatSync(fd).isFile()) { throw new Error('unsafeStorageType'); }
		const now = new Date(); io.futimesSync(fd, now, now);
	} finally { if (fd !== undefined) { io.closeSync(fd); } }
	return hash;
}

function maintenanceExists(store, dir, io) {
	const file = store.checked(path.join(dir, CAPTURE_MAINTENANCE_FILE));
	try { io.lstatSync(file); return true; }
	catch (error) { if (isMissing(error)) { return false; } throw error; }
}

function diagnosticTime(options) {
	const candidate = options.now ? options.now() : Date.now();
	const value = new Date(candidate);
	return Number.isFinite(value.getTime()) && value.getTime() >= 0 ? value.toISOString() : new Date().toISOString();
}
function diagnosticErrorCode(error) {
	if (error && ['EACCES', 'EPERM'].includes(error.code)) { return 'storagePermissionDenied'; }
	if (error && error.code === 'EROFS') { return 'storageReadOnly'; }
	if (error && ['ENOSPC', 'EDQUOT'].includes(error.code)) { return 'storageFull'; }
	const known = { storageInventoryBudget: 'storageInventoryBudget', unsafeStorageType: 'unsafeStorageType',
		blobIntegrityFailed: 'blobIntegrityFailed', pendingGenerationChanged: 'pendingGenerationChanged', invalidPending: 'invalidPending' };
	return error && Object.hasOwn(known, error.message) ? known[error.message] : 'storageUnavailable';
}
function snapshotCoverage(snapshots) {
	if (snapshots.every((snapshot) => snapshot === null)) { return 'unknown'; }
	return snapshots.some((snapshot) => snapshot === null || snapshot.large
		|| snapshot.exists && !/^[a-f0-9]{40}$/.test(snapshot.hash)) ? 'limited' : 'complete';
}
function diagnosticNames(directory, io) {
	const directoryHandle = io.opendirSync(directory, { bufferSize: 16 });
	const names = [];
	try {
		for (let index = 0; index <= MAX_DIAGNOSTIC_FILES; index += 1) {
			const entry = directoryHandle.readSync();
			if (entry === null) { return { names, complete: true }; }
			if (index === MAX_DIAGNOSTIC_FILES) { return { names, complete: false }; }
			names.push(entry.name);
		}
		return { names, complete: false };
	} finally { directoryHandle.closeSync(); }
}
function diagnosticFilename(event) { return `${event.observedAt.replace(/[-:.]/g, '')}-${event.id}.json`; }
function validDiagnostic(event, now) {
	if (!plain(event) || Object.keys(event).length !== 8 || Object.keys(event).some((key) =>
		!['schemaVersion', 'id', 'kind', 'phase', 'stage', 'code', 'contentCoverage', 'observedAt'].includes(key))) { return false; }
	const time = typeof event.observedAt === 'string' ? Date.parse(event.observedAt) : NaN;
	return event.schemaVersion === 2 && typeof event.id === 'string' && /^[a-f0-9]{32}$/.test(event.id) && ['observation', 'completion'].includes(event.kind)
		&& ['pre', 'post'].includes(event.phase) && DIAGNOSTIC_STAGES.includes(event.stage) && DIAGNOSTIC_CODES.includes(event.code)
		&& ['complete', 'limited', 'none', 'unknown'].includes(event.contentCoverage)
		&& Number.isFinite(time) && time >= 0 && time <= now + 5 * 60 * 1000 && new Date(time).toISOString() === event.observedAt
		&& (event.kind !== 'completion' || (event.phase === 'post' && event.stage === 'append' && event.code === 'captureRecorded'))
		&& (event.code !== 'captureRecorded' || (event.phase === 'post' && event.stage === 'append'))
		&& (event.code !== 'capturePrepared' || (event.phase === 'pre' && event.stage === 'pending'));
}
function pruneDiagnostics(own, directory, dir, io, now) {
	if (maintenanceExists(own, dir, io)) { return; }
	const inventory = diagnosticNames(directory, io);
	if (!inventory.complete) { return; }
	const names = inventory.names;
	const valid = [];
	for (const name of names) {
		if (!/^\d{8}T\d{9}Z-[a-f0-9]{32}\.json$/.test(name)) { continue; }
		try {
			const event = JSON.parse(own.read(path.join(directory, name), MAX_DIAGNOSTIC_BYTES));
			if (validDiagnostic(event, now) && diagnosticFilename(event) === name
				&& event.kind === (path.basename(directory) === 'completions' ? 'completion' : 'observation')) { valid.push(name); }
		} catch { /* Unknown evidence is never a deletion candidate. */ }
	}
	for (const name of valid.sort().reverse().slice(RETAIN_DIAGNOSTIC_FILES)) {
		if (maintenanceExists(own, dir, io)) { return; }
		const file = own.checked(path.join(directory, name));
		// Revalidate before deletion; a replaced/unknown file is preserved.
		try {
			const event = JSON.parse(own.read(file, MAX_DIAGNOSTIC_BYTES));
			if (validDiagnostic(event, now) && diagnosticFilename(event) === name
				&& event.kind === (path.basename(directory) === 'completions' ? 'completion' : 'observation')) { io.unlinkSync(file); }
		} catch { /* Preserve evidence if its identity is no longer known. */ }
	}
}

function capture(phase, input, options = {}) {
	if (!['pre', 'post'].includes(phase) || !plain(input) || !plain(input.tool_input)) { return { state: 'ignored' }; }
	const io = options.fs || fs;
	const env = options.env || process.env;
	const diagnostic = options.diagnostic || {};
	const stage = (value) => { diagnostic.stage = value; };
	const rawFile = input.tool_input.file_path || input.tool_input.notebook_path;
	const requestedRoot = env.CLAUDE_PROJECT_DIR || input.cwd || options.cwd || process.cwd();
	if (!string(rawFile, 8192) || !string(requestedRoot, 8192)
		|| !['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(input.tool_name)) { return { state: 'ignored' }; }
	let store;
	let processing;
	try {
		stage('scope');
		store = storage(requestedRoot, io);
		const suppliedFile = path.isAbsolute(rawFile) ? rawFile : path.resolve(input.cwd || store.root, rawFile);
		const lexicalRoot = path.resolve(requestedRoot);
		const absolute = inside(store.root, suppliedFile) ? suppliedFile
			: inside(lexicalRoot, suppliedFile) ? path.join(store.root, path.relative(lexicalRoot, suppliedFile)) : undefined;
		if (!absolute) { return { state: 'blocked', code: 'resourceOutsideScope' }; }
		store.checked(absolute);
		const dir = path.join(store.root, '.claude', 'launcher-changes');
		store.checked(dir);
		const operation = String(input.tool_use_id || `${input.session_id || ''}|${absolute}`);
		if (operation.length > 512 || (input.session_id !== undefined && !string(input.session_id, 256))) { return { state: 'ignored' }; }
		const key = crypto.createHash('sha256').update(`${input.session_id || ''}|${operation}|${absolute}`).digest('hex').slice(0, 32);
		// Only minimum control directories and this own lease may precede the guard check.
		// Maintenance preserves active/ so producers arriving during a purge remain visible.
		store.directory(dir);
		const activeDir = path.join(dir, 'active'); store.directory(activeDir);
		const lease = path.join(activeDir, `${process.pid}-${crypto.randomBytes(8).toString('hex')}.json`);
		store.writeNew(lease, JSON.stringify({ schemaVersion: 1, operation: key, pid: process.pid }));
		// Keep one continuous producer lease through diagnostic publication and pruning.
		diagnostic.releaseLease = () => { store.checked(lease); io.unlinkSync(lease); };
		stage('maintenance');
		if (maintenanceExists(store, dir, io)) { return { state: 'paused', code: 'captureMaintenance' }; }
		stage('policy');
		let policy = DEFAULT_POLICY;
		try {
			const parsed = JSON.parse(store.read(path.join(dir, 'capture-policy.json'), 64 * 1024).replace(/^\uFEFF/, ''));
			if (!validatePolicy(parsed)) { return { state: 'blocked', code: 'invalidPolicy' }; }
			policy = parsed;
		} catch (error) { if (!isMissing(error)) {
			const code = diagnosticErrorCode(error); if (code !== 'storageUnavailable') { diagnostic.code = code; }
			return { state: 'blocked', code: 'invalidPolicy' };
		} }
		if (maintenanceExists(store, dir, io)) { return { state: 'paused', code: 'captureMaintenance' }; }
		if (policy.paused) { return { state: 'paused', code: 'capturePaused' }; }
		const relative = path.relative(store.root, absolute).replace(/\\/g, '/');
		if (relative === '.claude' || relative.startsWith('.claude/') || excluded(relative, policy.excludedPatterns)) {
			return { state: 'excluded', code: 'excludedByPolicy' };
		}
		const ignore = path.join(dir, '.gitignore');
		try { store.writeNew(ignore, '*\n'); }
		catch (error) { if (!error || error.code !== 'EEXIST') { throw error; } }
		stage('inventory');
		if (storageBytes(dir, io) + 2 * MAX_FILE_BYTES + 16384 > policy.maxStorageBytes) {
			return { state: 'paused', code: 'quotaExceeded' };
		}
		const pendingDir = path.join(dir, 'pending');
		const blobDir = path.join(dir, 'blobs');
		const completedDir = path.join(dir, 'completed');
		store.directory(pendingDir); store.directory(blobDir); store.directory(completedDir);
		const pendingFile = path.join(pendingDir, `${key}.json`);
		const completed = path.join(completedDir, `${key}.json`);
		try { store.read(completed, 1024); return { state: 'duplicate' }; }
		catch (error) { if (!isMissing(error)) { throw error; } }
		function snapshot(read) {
			if (read === null) { return null; }
			if (!read.exists || read.large || typeof read.text !== 'string') {
				return { exists: read.exists, text: null, large: read.large };
			}
			return { exists: true, text: null, large: false, hash: putBlob(store, io, blobDir, read.text) };
		}
		if (phase === 'pre') {
			stage('pending');
			let previous;
			try { previous = store.read(pendingFile, 4096); }
			catch (error) { if (!isMissing(error)) { throw error; } }
			if (previous !== undefined) { return { state: 'duplicate' }; }
			stage('snapshot');
			const before = snapshot(readSmall(absolute, io));
			diagnostic.contentCoverage = snapshotCoverage([before]);
			stage('pending');
			store.writeNew(pendingFile, JSON.stringify({ before, schemaVersion: 1, generation: policy.generation }));
			return { state: 'prepared' };
		}
		stage('pending');
		processing = path.join(pendingDir, `${key}.post`);
		try { store.writeNew(processing, '{}'); }
		catch (error) { if (error && error.code === 'EEXIST') { processing = undefined; return { state: 'duplicate' }; } throw error; }
		stage('snapshot');
		const afterText = readSmall(absolute, io);
		const after = snapshot(afterText);
		let before;
		stage('pending');
		try {
			const pending = JSON.parse(store.read(pendingFile, 4096));
			if (!plain(pending) || pending.schemaVersion !== 1 || pending.generation !== policy.generation) { throw new Error('pendingGenerationChanged'); }
			before = pending.before;
			if (before !== null && (!plain(before) || typeof before.exists !== 'boolean' || typeof before.large !== 'boolean'
				|| before.text !== null || (before.hash !== undefined && !/^[a-f0-9]{40}$/.test(before.hash)))) { throw new Error('invalidPending'); }
		} catch (error) {
			if (!isMissing(error)) { throw error; }
			before = snapshot(rebuildBefore(input.tool_name, input.tool_input, afterText));
		}
		diagnostic.contentCoverage = snapshotCoverage([before, after]);
		const entry = {
			schemaVersion: 1, id: key, time: new Date().toISOString(), session: input.session_id || null,
			tool: input.tool_name, file: absolute, before, after, reason: null,
			transcript: string(input.transcript_path, 8192) ? input.transcript_path : null,
			toolUseId: string(input.tool_use_id, 256) ? input.tool_use_id : null,
		};
		stage('policy');
		try {
			const latest = JSON.parse(store.read(path.join(dir, 'capture-policy.json'), 64 * 1024).replace(/^\uFEFF/, ''));
			if (!validatePolicy(latest) || latest.paused || latest.generation !== policy.generation) { return { state: 'paused', code: 'captureGenerationChanged' }; }
		} catch (error) { if (!isMissing(error) || policy.generation !== 'legacy-default') { throw error; } }
		stage('maintenance');
		if (maintenanceExists(store, dir, io)) { return { state: 'paused', code: 'captureMaintenance' }; }
		stage('append');
		const log = store.checked(path.join(dir, 'log.jsonl'));
		const fd = io.openSync(log, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND
			| (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0), 0o600);
		try {
			if (!io.fstatSync(fd).isFile()) { throw new Error('unsafeStorageType'); }
			io.writeFileSync(fd, `${JSON.stringify(entry)}\n`, 'utf8');
			io.fsyncSync(fd);
		} finally { io.closeSync(fd); }
		diagnostic.appendConfirmedAt = diagnosticTime(options);
		stage('completion');
		store.writeNew(completed, JSON.stringify({ id: key, time: entry.time }));
		try { store.checked(pendingFile); io.unlinkSync(pendingFile); }
		catch (error) { if (!isMissing(error)) { throw error; } }
		return { state: 'recorded' };
	} catch (error) {
		diagnostic.code = diagnosticErrorCode(error);
		return { state: 'blocked', code: 'storageUnavailable' };
	} finally {
		for (const file of [processing]) {
			if (file && store) { try { store.checked(file); io.unlinkSync(file); } catch { /* Preserve unknown recovery. */ } }
		}
	}
}

function writeStatus(input, result, options, diagnostic = {}) {
	if (!plain(input) || !plain(input.tool_input) || ['ignored', 'duplicate'].includes(result.state)) { return; }
	const io = options.fs || fs;
	const env = options.env || process.env;
	const root = env.CLAUDE_PROJECT_DIR || input.cwd || options.cwd;
	if (!string(root, 8192)) { return; }
	let own;
	let activeFile;
	const created = [];
	try {
		own = storage(root, io);
		const dir = path.join(own.root, '.claude', 'launcher-changes');
		own.directory(dir);
		if (!diagnostic.releaseLease) {
			const activeDir = path.join(dir, 'active'); own.directory(activeDir);
			const lease = path.join(activeDir, `${process.pid}-status-${crypto.randomBytes(8).toString('hex')}.json`);
			own.writeNew(lease, JSON.stringify({ schemaVersion: 1, pid: process.pid, diagnostic: true }));
			activeFile = lease;
		}
		if (maintenanceExists(own, dir, io)) { return; }
		const phase = options.phase === 'post' ? 'post' : 'pre';
		const code = diagnostic.code || result.code || (result.state === 'prepared' ? 'capturePrepared' : result.state === 'recorded' ? 'captureRecorded' : 'storageUnavailable');
		const stages = { capturePrepared: 'pending', captureRecorded: 'append', captureMaintenance: 'maintenance',
			capturePaused: 'policy', captureGenerationChanged: 'policy', quotaExceeded: 'inventory', invalidPolicy: 'policy',
			excludedByPolicy: 'policy', resourceOutsideScope: 'scope', inputBudgetExceeded: 'input' };
		const observation = { schemaVersion: 2, id: crypto.randomBytes(16).toString('hex'), kind: 'observation', phase,
			stage: stages[code] || diagnostic.stage || 'input', code,
			contentCoverage: diagnostic.contentCoverage || 'none', observedAt: diagnosticTime(options) };
		const events = [];
		if (diagnostic.appendConfirmedAt) {
			events.push({ ...observation, id: crypto.randomBytes(16).toString('hex'), kind: 'completion', phase: 'post',
				stage: 'append', code: 'captureRecorded', observedAt: diagnostic.appendConfirmedAt });
		}
		events.push(observation);
		for (const event of events) {
			if (!validDiagnostic(event, Date.now()) || maintenanceExists(own, dir, io)) { continue; }
			const directory = path.join(dir, ...CAPTURE_DIAGNOSTICS_DIR.split('/'), event.kind === 'completion' ? 'completions' : 'observations');
			own.directory(directory);
			const inventory = diagnosticNames(directory, io);
			if (!inventory.complete || inventory.names.length >= MAX_DIAGNOSTIC_FILES || maintenanceExists(own, dir, io)) { continue; }
			const file = path.join(directory, diagnosticFilename(event));
			own.writeNew(file, `${JSON.stringify(event)}\n`, true); created.push(file);
			if (maintenanceExists(own, dir, io)) { return; }
			pruneDiagnostics(own, directory, dir, io, Date.now());
		}
	} catch { /* Diagnostics must not turn an observation failure into an effect elsewhere. */ }
	finally {
		if (own) {
			try { const dir = path.join(own.root, '.claude', 'launcher-changes'); if (maintenanceExists(own, dir, io)) {
				for (const file of created) { try { own.checked(file); io.unlinkSync(file); } catch { /* Only own created events may be removed. */ } }
			} } catch { /* Preserve unknown evidence. */ }
		}
		for (const file of [activeFile]) {
			if (file && own) { try { own.checked(file); io.unlinkSync(file); } catch { /* Never remove another producer's lease. */ } }
		}
	}
}
function run(phase, input, options = {}) {
	const diagnostic = { stage: 'input', contentCoverage: 'none' };
	try {
		const result = capture(phase, input, { ...options, diagnostic });
		writeStatus(input, result, { ...options, phase }, diagnostic);
		return result;
	} finally {
		if (diagnostic.releaseLease) { try { diagnostic.releaseLease(); } catch { /* Preserve unknown recovery. */ } }
	}
}
// ---- Captura do turno: o que comandos e outras ferramentas mudaram -------------------------
//
// Edit, Write, MultiEdit e NotebookEdit são capturados por chamada (pre/post). Um comando de
// terminal, uma ferramenta MCP ou um gerador mudam arquivos sem passar por eles. Para esses, o
// UserPromptSubmit ("turn-start") anota o estado do projeto e guarda uma cópia dos arquivos de
// texto em turn-blobs/; o Stop ("turn-end") compara o projeto com a anotação e grava no log, como
// tool "Command", o que mudou e não foi explicado por uma edição capturada no mesmo turno.
// Nunca executa nada do projeto (nem git): só lê arquivos, com limites fixos de quantidade e tempo.

const TURN_PHASES = ['turn-start', 'turn-end'];
const TURN_DIR = 'turns';
const TURN_BLOB_DIR = 'turn-blobs';
const TURN_INDEX = 'index.json';
/** Nunca percorridos: controle de versão, dependências instaladas e os dados do próprio Claude. */
const TURN_SKIPPED_NAMES = ['.git', '.hg', '.svn', 'node_modules', '.claude'];
const TURN_LIMITS = Object.freeze({
	files: 5000, depth: 24, mirrorFiles: 2000, mirrorBytes: 48 * 1024 * 1024, changes: 200,
	millis: 4000, manifestBytes: 16 * 1024 * 1024, logBytes: 64 * 1024 * 1024, mirrorGraceMs: 10 * 60 * 1000,
});
const SHA1 = /^[a-f0-9]{40}$/;

/** Limites da leitura dos .gitignore: quantos arquivos por percurso, regras por arquivo e tamanho. */
const GITIGNORE_LIMITS = Object.freeze({ files: 200, rules: 400, bytes: 64 * 1024 });

function regexLiteral(text) { return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'); }

/** Corpo de expressão regular de um padrão do .gitignore (`*`, `**`, `?`, `[...]` e `\`); `null` se malformado. */
function gitignoreExpression(pattern) {
	let out = '';
	for (let i = 0; i < pattern.length; i += 1) {
		const char = pattern[i];
		if (char === '\\') {
			i += 1;
			if (i >= pattern.length) { return null; }
			out += regexLiteral(pattern[i]);
		} else if (char === '*') {
			const segmentStart = i === 0 || pattern[i - 1] === '/';
			if (pattern[i + 1] === '*' && segmentStart && (i + 2 === pattern.length || pattern[i + 2] === '/')) {
				// "**/" casa zero ou mais pastas; "/**" no fim casa tudo o que está dentro.
				if (pattern[i + 2] === '/') { out += '(?:.*/)?'; i += 2; } else { out += '.*'; i += 1; }
				continue;
			}
			while (pattern[i + 1] === '*') { i += 1; }
			out += '[^/]*';
		} else if (char === '?') {
			out += '[^/]';
		} else if (char === '[') {
			let j = i + 1;
			const negated = pattern[j] === '!' || pattern[j] === '^';
			if (negated) { j += 1; }
			// Um "]" logo no começo da classe é literal.
			const end = pattern.indexOf(']', pattern[j] === ']' ? j + 1 : j);
			if (end < 0) { out += '\\['; continue; }
			const members = pattern.slice(j, end).replace(/\\(.)/g, '$1').replace(/[\\\]^]/g, '\\$&');
			out += negated ? `[^/${members}]` : `(?!/)[${members}]`;
			i = end;
		} else {
			out += regexLiteral(char);
		}
	}
	return out;
}

/**
 * Regras de um .gitignore, na ordem do arquivo. Como no git: `!` reinclui, `/` no começo ou no meio
 * prende o padrão à pasta do arquivo, `/` no fim vale só para pastas e `\` escapa `#`, `!` e espaços.
 */
function gitignoreRules(text) {
	const rules = [];
	for (const raw of text.split(/\r?\n/)) {
		// Espaços no fim são ignorados, a não ser que escapados com "\".
		let line = raw.replace(/(^|[^\\])\s+$/, '$1');
		if (!line || line.startsWith('#')) { continue; }
		let negate = false;
		if (line.startsWith('!')) { negate = true; line = line.slice(1); }
		const dirOnly = line.endsWith('/');
		line = line.replace(/\/+$/, '');
		const anchored = line.includes('/');
		line = line.replace(/^\/+/, '');
		if (!line || line.split('/').includes('..')) { continue; }
		const body = gitignoreExpression(line);
		if (body === null) { continue; }
		rules.push({ negate, dirOnly, expression: new RegExp(`^${anchored ? '' : '(?:.*/)?'}${body}$`) });
		if (rules.length >= GITIGNORE_LIMITS.rules) { break; }
	}
	return rules;
}

/** Aplica as regras dos .gitignore da raiz até a pasta do caminho; a última regra que casa decide. */
function gitignored(relative, isDirectory, layers) {
	let ignored = false;
	for (const { base, rules } of layers) {
		const local = base ? relative.slice(base.length + 1) : relative;
		for (const rule of rules) {
			if (rule.dirOnly && !isDirectory) { continue; }
			if (rule.expression.test(local)) { ignored = !rule.negate; }
		}
	}
	return ignored;
}

function validTurnPath(relative) {
	return typeof relative === 'string' && relative.length > 0 && relative.length <= 4096
		&& !/[\u0000-\u001f\u007f\\:]/.test(relative) && !relative.startsWith('/')
		&& relative.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}
function validTurnFile(relative, value) {
	return validTurnPath(relative) && plain(value) && Number.isSafeInteger(value.size) && value.size >= 0
		&& Number.isFinite(value.mtimeMs) && (value.hash === null || typeof value.hash === 'string' && SHA1.test(value.hash))
		&& typeof value.mirrored === 'boolean';
}
function validTurnFiles(files) {
	return plain(files) && Object.keys(files).length <= TURN_LIMITS.files
		&& Object.entries(files).every(([relative, value]) => validTurnFile(relative, value));
}
function validManifest(value, session) {
	return plain(value) && value.schemaVersion === 1 && value.session === session
		&& typeof value.turnId === 'string' && /^[a-f0-9]{32}$/.test(value.turnId)
		&& typeof value.startedAt === 'string' && Number.isFinite(Date.parse(value.startedAt))
		&& Number.isSafeInteger(value.revision) && value.revision >= 0
		&& typeof value.complete === 'boolean' && typeof value.limited === 'boolean' && validTurnFiles(value.files);
}

/**
 * Arquivos comuns do projeto, sem seguir links. Cada pasta percorrida contribui com o próprio
 * .gitignore. `complete` é falso quando um limite cortou o percurso.
 */
function walkProject(store, io, globs, deadline, now) {
	const files = new Map();
	let complete = true, gitignoreFiles = 0;
	/** @type {Array<{ dir: string, relative: string, depth: number, layers: Array<{ base: string, rules: ReturnType<typeof gitignoreRules> }> }>} */
	const stack = [{ dir: store.root, relative: '', depth: 0, layers: [] }];
	while (stack.length) {
		if (now() > deadline) { return { files, complete: false }; }
		const top = stack.pop();
		if (!top) { break; }
		const { dir, relative, depth } = top;
		let names;
		try { names = io.readdirSync(dir); } catch { complete = false; continue; }
		let layers = top.layers;
		if (names.includes('.gitignore') && gitignoreFiles < GITIGNORE_LIMITS.files) {
			gitignoreFiles += 1;
			try {
				const rules = gitignoreRules(store.read(path.join(dir, '.gitignore'), GITIGNORE_LIMITS.bytes));
				if (rules.length) { layers = [...layers, { base: relative, rules }]; }
			} catch { /* Unreadable or too large: the folder is walked without it. */ }
		}
		for (const name of names.sort()) {
			const child = relative ? `${relative}/${name}` : name;
			if (TURN_SKIPPED_NAMES.includes(name) || !validTurnPath(child) || matchesGlobs(child, globs)) { continue; }
			const full = path.join(dir, name);
			let stat;
			try { stat = io.lstatSync(full); } catch { continue; }
			if (stat.isSymbolicLink()) { continue; }
			if (layers.length && gitignored(child, stat.isDirectory(), layers)) { continue; }
			if (stat.isDirectory()) {
				if (depth + 1 > TURN_LIMITS.depth) { complete = false; continue; }
				stack.push({ dir: full, relative: child, depth: depth + 1, layers });
			} else if (stat.isFile()) {
				if (files.size >= TURN_LIMITS.files) { return { files, complete: false }; }
				files.set(child, { size: stat.size, mtimeMs: stat.mtimeMs });
			}
		}
	}
	return { files, complete };
}

/** JSON próprio (manifesto, índice): `undefined` quando ausente, `null` quando ilegível ou grande demais. */
function readOwnJson(store, file, maximum) {
	try { return JSON.parse(store.read(file, maximum)); }
	catch (error) { return isMissing(error) ? undefined : null; }
}
/** Troca atômica de um arquivo próprio: temporário exclusivo ao lado e rename. */
function writeOwnJson(store, io, file, value) {
	const temp = `${file}.${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`;
	store.writeNew(temp, JSON.stringify(value), true);
	try { store.checked(file); io.renameSync(temp, file); }
	catch (error) { try { store.checked(temp); io.unlinkSync(temp); } catch { /* The temp name is unique to this run. */ } throw error; }
}

function mirrorBlobExists(store, io, ctx, hash) {
	try { const stat = io.lstatSync(store.checked(path.join(ctx.mirrorDir, `${hash}.txt`))); return stat.isFile(); }
	catch { return false; }
}

/** Estado de cada arquivo, reaproveitando o hash do índice quando tamanho e data não mudaram. */
function snapshotProject(ctx, walk, previous) {
	const { store, io } = ctx;
	const files = {};
	let limited = !walk.complete, mirrorFiles = 0, mirrorBytes = 0;
	const fits = (size) => mirrorFiles < TURN_LIMITS.mirrorFiles && mirrorBytes + size <= TURN_LIMITS.mirrorBytes
		&& ctx.used + size <= ctx.policy.maxStorageBytes / 2;
	for (const [relative, stat] of walk.files) {
		const cached = previous[relative];
		let hash = null, mirrored = false;
		if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs && cached.hash) {
			hash = cached.hash;
			mirrored = cached.mirrored && mirrorBlobExists(store, io, ctx, hash);
		}
		if (!mirrored && stat.size <= MAX_FILE_BYTES) {
			if (ctx.now() > ctx.deadline) { limited = true; }
			else if (hash === null || fits(stat.size)) {
				const read = readSmall(store.checked(path.join(store.root, ...relative.split('/'))), io);
				if (read && read.exists && !read.large && typeof read.text === 'string') {
					if (fits(stat.size)) { hash = putBlob(store, io, ctx.mirrorDir, read.text); mirrored = true; ctx.used += stat.size; }
					else { hash = crypto.createHash('sha1').update(read.text, 'utf8').digest('hex'); limited = true; }
				}
			} else { limited = true; }
		}
		if (mirrored) { mirrorFiles += 1; mirrorBytes += stat.size; }
		files[relative] = { size: stat.size, mtimeMs: stat.mtimeMs, hash, mirrored };
	}
	return { files, limited };
}

/** Apaga cópias de turn-blobs/ que nenhum manifesto nem o índice citam, depois de uma folga. */
function collectMirror(ctx, keep) {
	const { store, io } = ctx;
	for (const name of io.readdirSync(ctx.turnsDir)) {
		if (!/^[a-f0-9]{32}\.json$/.test(name)) { continue; }
		const value = readOwnJson(store, path.join(ctx.turnsDir, name), TURN_LIMITS.manifestBytes);
		if (!plain(value) || !validTurnFiles(value.files)) { return; } // Unknown evidence: keep every copy.
		for (const item of Object.values(value.files)) { if (item.hash) { keep.add(item.hash); } }
	}
	const now = ctx.now();
	for (const name of io.readdirSync(ctx.mirrorDir).slice(0, 20000)) {
		if (!/^[a-f0-9]{40}\.txt$/.test(name) || keep.has(name.slice(0, 40)) || maintenanceExists(store, ctx.dir, io)) { continue; }
		const file = store.checked(path.join(ctx.mirrorDir, name));
		try { const stat = io.lstatSync(file); if (stat.isFile() && now - stat.mtimeMs > TURN_LIMITS.mirrorGraceMs) { io.unlinkSync(file); } }
		catch { /* A concurrent producer may own it now. */ }
	}
}

function turnStart(ctx) {
	const { store, io } = ctx;
	store.directory(ctx.turnsDir); store.directory(ctx.mirrorDir);
	const walk = walkProject(store, io, ctx.globs, ctx.deadline, ctx.now);
	const index = readOwnJson(store, path.join(ctx.turnsDir, TURN_INDEX), TURN_LIMITS.manifestBytes);
	const previous = plain(index) && index.schemaVersion === 1 && validTurnFiles(index.files) ? index.files : {};
	const state = snapshotProject(ctx, walk, previous);
	if (maintenanceExists(store, ctx.dir, io)) { return { state: 'paused', code: 'captureMaintenance' }; }
	const manifest = { schemaVersion: 1, session: ctx.session, turnId: crypto.randomBytes(16).toString('hex'),
		startedAt: new Date(ctx.now()).toISOString(), revision: 0, complete: walk.complete, limited: state.limited, files: state.files };
	writeOwnJson(store, io, ctx.manifestFile, manifest);
	writeOwnJson(store, io, path.join(ctx.turnsDir, TURN_INDEX), { schemaVersion: 1, files: state.files });
	collectMirror(ctx, new Set(Object.values(state.files).flatMap((item) => item.hash ? [item.hash] : [])));
	return { state: 'prepared', files: walk.files.size, limited: state.limited };
}

/** Último "depois" de cada arquivo editado por Edit/Write (ou por um Stop anterior) nesta conversa, desde o início do turno. */
function editsSince(ctx, startedAt) {
	const edits = new Map();
	let text;
	try { text = ctx.store.read(path.join(ctx.dir, 'log.jsonl'), TURN_LIMITS.logBytes); }
	catch (error) { if (isMissing(error)) { return edits; } throw error; }
	const since = Date.parse(startedAt);
	for (const line of text.split('\n')) {
		if (!line.includes(ctx.session)) { continue; }
		let entry;
		try { entry = JSON.parse(line); } catch { continue; }
		if (plain(entry) && entry.session === ctx.session && typeof entry.file === 'string' && Date.parse(entry.time) >= since) {
			edits.set(entry.file, plain(entry.after) ? entry.after : null);
		}
	}
	return edits;
}

/** O "antes" de um arquivo mudado por comando, a partir do manifesto do início do turno. */
function turnBefore(ctx, previous, blobDir) {
	if (!previous) { return { exists: false, text: null, large: false }; }
	if (previous.hash && previous.mirrored) {
		try {
			const text = ctx.store.read(path.join(ctx.mirrorDir, `${previous.hash}.txt`), MAX_FILE_BYTES);
			if (crypto.createHash('sha1').update(text, 'utf8').digest('hex') === previous.hash) {
				return { exists: true, text: null, large: false, hash: putBlob(ctx.store, ctx.io, blobDir, text) };
			}
		} catch { /* Fall through: content unknown. */ }
	}
	return { exists: true, text: null, large: previous.hash === null && previous.size > MAX_FILE_BYTES };
}

function turnEnd(ctx, input) {
	const { store, io } = ctx;
	const manifest = readOwnJson(store, ctx.manifestFile, TURN_LIMITS.manifestBytes);
	if (manifest === undefined) { return { state: 'ignored' }; }
	if (!validManifest(manifest, ctx.session)) { return { state: 'blocked', code: 'invalidPending' }; }
	store.directory(ctx.mirrorDir);
	if (ctx.used + 2 * MAX_FILE_BYTES + 16384 > ctx.policy.maxStorageBytes) { return { state: 'paused', code: 'quotaExceeded' }; }
	const walk = walkProject(store, io, ctx.globs, ctx.deadline, ctx.now);
	const edits = editsSince(ctx, manifest.startedAt);
	const blobDir = path.join(ctx.dir, 'blobs'); store.directory(blobDir);
	const time = new Date(ctx.now()).toISOString();
	const transcript = string(input.transcript_path, 8192) ? input.transcript_path : null;
	const entries = [], next = { ...manifest.files };
	let limited = manifest.limited || !walk.complete;
	const record = (relative, absolute, before, after) => {
		const id = crypto.createHash('sha256').update(`${ctx.session}|turn|${manifest.turnId}|${manifest.revision}|${absolute}`).digest('hex').slice(0, 32);
		entries.push({ schemaVersion: 1, id, time, session: ctx.session, tool: 'Command', file: absolute, before, after, reason: null, transcript, toolUseId: null });
	};
	for (const [relative, stat] of walk.files) {
		if (entries.length >= TURN_LIMITS.changes || ctx.now() > ctx.deadline + 2000) { limited = true; break; }
		const previous = manifest.files[relative];
		if (previous && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs) { continue; }
		const absolute = store.checked(path.join(store.root, ...relative.split('/')));
		const read = readSmall(absolute, io);
		// Binário, ilegível ou sumido no meio: não há texto para revisar.
		if (read === null || !read.exists || !read.large && typeof read.text !== 'string') { continue; }
		const text = read.large ? undefined : read.text;
		const hash = text === undefined ? null : crypto.createHash('sha1').update(text, 'utf8').digest('hex');
		const current = { size: stat.size, mtimeMs: stat.mtimeMs, hash, mirrored: false };
		if (previous && previous.hash && hash === previous.hash) { next[relative] = { ...current, mirrored: previous.mirrored }; continue; }
		const edit = edits.get(absolute);
		if (edit && edit.exists && hash && edit.hash === hash) { next[relative] = current; continue; }
		const before = edits.has(absolute) ? edit : turnBefore(ctx, previous, blobDir);
		const after = text === undefined ? { exists: true, text: null, large: true } : { exists: true, text: null, large: false, hash: putBlob(store, io, blobDir, text) };
		if (text !== undefined && ctx.used + stat.size <= ctx.policy.maxStorageBytes / 2) {
			putBlob(store, io, ctx.mirrorDir, text); current.mirrored = true; ctx.used += stat.size;
		}
		record(relative, absolute, before, after);
		next[relative] = current;
	}
	// Só um percurso completo prova que um arquivo do manifesto deixou de existir.
	if (walk.complete) {
		for (const [relative, previous] of Object.entries(manifest.files)) {
			if (walk.files.has(relative) || entries.length >= TURN_LIMITS.changes) { continue; }
			const absolute = store.checked(path.join(store.root, ...relative.split('/')));
			try { io.lstatSync(absolute); continue; } catch (error) { if (!isMissing(error)) { continue; } }
			delete next[relative];
			const edit = edits.get(absolute);
			if (edits.has(absolute) && (!edit || edit.exists === false)) { continue; }
			record(relative, absolute, edits.has(absolute) ? edit : turnBefore(ctx, previous, blobDir), { exists: false, text: null, large: false });
		}
	}
	if (entries.length) {
		// Same guards as an edit capture: a purge or a new policy generation wins over this turn.
		try {
			const latest = JSON.parse(store.read(path.join(ctx.dir, 'capture-policy.json'), 64 * 1024).replace(/^﻿/, ''));
			if (!validatePolicy(latest) || latest.paused || latest.generation !== ctx.policy.generation) { return { state: 'paused', code: 'captureGenerationChanged' }; }
		} catch (error) { if (!isMissing(error) || ctx.policy.generation !== 'legacy-default') { throw error; } }
		if (maintenanceExists(store, ctx.dir, io)) { return { state: 'paused', code: 'captureMaintenance' }; }
		const log = store.checked(path.join(ctx.dir, 'log.jsonl'));
		const fd = io.openSync(log, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND
			| (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0), 0o600);
		try {
			if (!io.fstatSync(fd).isFile()) { throw new Error('unsafeStorageType'); }
			io.writeFileSync(fd, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''), 'utf8');
			io.fsyncSync(fd);
		} finally { io.closeSync(fd); }
	}
	// Um segundo Stop no mesmo turno (outro hook pediu para continuar) compara a partir daqui.
	writeOwnJson(store, io, ctx.manifestFile, { ...manifest, revision: manifest.revision + 1, limited, files: next });
	return { state: entries.length ? 'recorded' : 'unchanged', changes: entries.length, limited };
}

function runTurn(phase, input, options = {}) {
	if (!TURN_PHASES.includes(phase) || !plain(input) || !string(input.session_id, 256)) { return { state: 'ignored' }; }
	const io = options.fs || fs;
	const env = options.env || process.env;
	const now = options.now || Date.now;
	const requestedRoot = env.CLAUDE_PROJECT_DIR || input.cwd || options.cwd || process.cwd();
	if (!string(requestedRoot, 8192)) { return { state: 'ignored' }; }
	let store, lease;
	try {
		store = storage(requestedRoot, io);
		const dir = path.join(store.root, '.claude', 'launcher-changes');
		store.checked(dir);
		const sessionKey = crypto.createHash('sha256').update(input.session_id).digest('hex').slice(0, 32);
		store.directory(dir);
		const activeDir = path.join(dir, 'active'); store.directory(activeDir);
		lease = path.join(activeDir, `${process.pid}-${crypto.randomBytes(8).toString('hex')}.json`);
		store.writeNew(lease, JSON.stringify({ schemaVersion: 1, operation: sessionKey, pid: process.pid }));
		if (maintenanceExists(store, dir, io)) { return { state: 'paused', code: 'captureMaintenance' }; }
		let policy = DEFAULT_POLICY;
		try {
			const parsed = JSON.parse(store.read(path.join(dir, 'capture-policy.json'), 64 * 1024).replace(/^﻿/, ''));
			if (!validatePolicy(parsed)) { return { state: 'blocked', code: 'invalidPolicy' }; }
			policy = parsed;
		} catch (error) { if (!isMissing(error)) { return { state: 'blocked', code: 'invalidPolicy' }; } }
		if (policy.paused) { return { state: 'paused', code: 'capturePaused' }; }
		try { store.writeNew(path.join(dir, '.gitignore'), '*\n'); }
		catch (error) { if (!error || error.code !== 'EEXIST') { throw error; } }
		const turnsDir = path.join(dir, TURN_DIR), mirrorDir = path.join(dir, TURN_BLOB_DIR);
		const ctx = { store, io, dir, turnsDir, mirrorDir, policy, session: input.session_id, now,
			manifestFile: path.join(turnsDir, `${sessionKey}.json`), deadline: now() + TURN_LIMITS.millis,
			globs: compileGlobs(policy.excludedPatterns), used: storageBytes(dir, io) };
		return phase === 'turn-start' ? turnStart(ctx) : turnEnd(ctx, input);
	} catch (error) {
		return { state: 'blocked', code: diagnosticErrorCode(error) };
	} finally {
		if (lease && store) { try { store.checked(lease); io.unlinkSync(lease); } catch { /* Preserve unknown recovery. */ } }
	}
}

function main() {
	let raw = '';
	let size = 0;
	let exceeded = false;
	process.stdin.setEncoding('utf8');
	process.stdin.on('data', (chunk) => {
		size += Buffer.byteLength(chunk, 'utf8');
		if (size > MAX_INPUT_BYTES) { exceeded = true; raw = ''; return; }
		if (!exceeded) { raw += chunk; }
	});
	process.stdin.on('end', () => {
		if (!exceeded) {
			// Nothing goes to stdout: UserPromptSubmit output would become context for Claude.
			try {
				const phase = process.argv[2] || '', input = JSON.parse(raw);
				if (TURN_PHASES.includes(phase)) { runTurn(phase, input); } else { run(phase, input); }
			} catch { /* No private exception output. */ }
		} else if (string(process.env.CLAUDE_PROJECT_DIR, 8192) && !TURN_PHASES.includes(process.argv[2])) {
			writeStatus({ tool_input: {} }, { state: 'blocked', code: 'inputBudgetExceeded' }, { phase: process.argv[2] });
		}
		process.exitCode = 0;
	});
	process.stdin.on('error', () => { process.exitCode = 0; });
}
module.exports = { run, runTurn, TURN_LIMITS, TURN_PHASES, gitignoreRules, gitignored, validatePolicy, excluded, storage, readSmall, storageBytes, rebuildBefore, DEFAULT_POLICY, MAX_FILE_BYTES, MAX_INPUT_BYTES,
	CAPTURE_MAINTENANCE_FILE, CAPTURE_DIAGNOSTICS_DIR, DIAGNOSTIC_STAGES, DIAGNOSTIC_CODES };
if (require.main === module) { main(); }
