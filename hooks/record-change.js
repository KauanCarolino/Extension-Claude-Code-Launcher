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
function excluded(relative, patterns) {
	const name = relative.replace(/\\/g, '/');
	return patterns.some((pattern) => {
		let expression = '';
		for (let i = 0; i < pattern.length; i += 1) {
			const char = pattern[i];
			if (char === '*' && pattern[i + 1] === '*' && pattern[i + 2] === '/') { expression += '(?:.*/)?'; i += 2; }
			else if (char === '*' && pattern[i + 1] === '*') { expression += '.*'; i += 1; }
			else if (char === '*') { expression += '[^/]*'; }
			else if (char === '?') { expression += '[^/]'; }
			else { expression += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
		}
		return new RegExp(`^${expression}$`).test(name);
	});
}
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
			const hash = crypto.createHash('sha1').update(read.text, 'utf8').digest('hex');
			const file = path.join(blobDir, `${hash}.txt`);
			try { store.writeNew(file, read.text); }
			catch (error) {
				if (!error || error.code !== 'EEXIST') { throw error; }
				if (store.read(file, MAX_FILE_BYTES) !== read.text) { throw new Error('blobIntegrityFailed'); }
			}
			let fd;
			try {
				store.checked(file);
				// Windows requires write access on the existing handle to update file times.
				fd = io.openSync(file, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0));
				if (!io.fstatSync(fd).isFile()) { throw new Error('unsafeStorageType'); }
				const now = new Date(); io.futimesSync(fd, now, now);
			} finally { if (fd !== undefined) { io.closeSync(fd); } }
			return { exists: true, text: null, large: false, hash };
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
			try { run(process.argv[2], JSON.parse(raw)); } catch { /* No private exception output. */ }
		} else if (string(process.env.CLAUDE_PROJECT_DIR, 8192)) {
			writeStatus({ tool_input: {} }, { state: 'blocked', code: 'inputBudgetExceeded' }, { phase: process.argv[2] });
		}
		process.exitCode = 0;
	});
	process.stdin.on('error', () => { process.exitCode = 0; });
}
module.exports = { run, validatePolicy, excluded, storage, readSmall, storageBytes, rebuildBefore, DEFAULT_POLICY, MAX_FILE_BYTES, MAX_INPUT_BYTES,
	CAPTURE_MAINTENANCE_FILE, CAPTURE_DIAGNOSTICS_DIR, DIAGNOSTIC_STAGES, DIAGNOSTIC_CODES };
if (require.main === module) { main(); }
