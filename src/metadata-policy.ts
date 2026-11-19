/** Policy permits for NEW metadata reads/copies. Existing saved metadata is never removed here. */
import { matchesExcludedPath, validateCapturePolicy } from './history';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

export interface MetadataPolicyContext {
	policy: unknown;
	canonicalRoot: string;
	canonicalFile: string;
	/** The caller must establish filesystem/provider identity; lexical membership alone is insufficient. */
	scopeVerified: boolean;
}
export type MetadataPolicyReason = 'policyUnknown' | 'policyPaused' | 'scopeUnknown' | 'resourceOutsideScope'
	| 'excludedByPolicy' | 'policyChanged' | 'resourceChanged';
/** Internal permit only; do not serialize policy generations/fingerprints into product diagnostics. */
export interface MetadataPermit {
	readonly generation: string;
	readonly policyFingerprint: string;
	readonly resourceFingerprint: string;
}
export type MetadataPolicyDecision = { allowed: true; permit: MetadataPermit } | { allowed: false; reason: MetadataPolicyReason };
const fingerprint = (value: unknown): string => crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
function pathValue(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/[\u0000-\u001f\u007f]/.test(value);
}

export function evaluateMetadataPolicy(context: MetadataPolicyContext): MetadataPolicyDecision {
	if (!validateCapturePolicy(context.policy)) { return { allowed: false, reason: 'policyUnknown' }; }
	if (context.policy.paused) { return { allowed: false, reason: 'policyPaused' }; }
	if (context.scopeVerified !== true || !pathValue(context.canonicalRoot) || !pathValue(context.canonicalFile)) {
		return { allowed: false, reason: 'scopeUnknown' };
	}
	const paths = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(context.canonicalRoot) ? path.win32 : path.posix;
	if (!paths.isAbsolute(context.canonicalRoot) || !paths.isAbsolute(context.canonicalFile)) { return { allowed: false, reason: 'scopeUnknown' }; }
	const root = paths.normalize(context.canonicalRoot), file = paths.normalize(context.canonicalFile);
	const relative: string = paths.relative(root, file);
	if (!relative || relative === '..' || relative.startsWith('..' + paths.sep) || paths.isAbsolute(relative)) {
		return { allowed: false, reason: 'resourceOutsideScope' };
	}
	// Reuse capture's policy matcher; do not reinterpret glob syntax or fold directory/file case.
	if (matchesExcludedPath(relative, context.policy.excludedPatterns)) { return { allowed: false, reason: 'excludedByPolicy' }; }
	const policy = context.policy;
	return { allowed: true, permit: Object.freeze({ generation: policy.generation,
		policyFingerprint: fingerprint([policy.schemaVersion, policy.generation, policy.paused, policy.excludedPatterns, policy.maxStorageBytes, policy.retentionDays]),
		resourceFingerprint: fingerprint([root, file]) }) };
}

/** Call again after every relevant await/configuration change and immediately before a new cache/persist effect. */
export function revalidateMetadataPermit(permit: MetadataPermit, context: MetadataPolicyContext): MetadataPolicyDecision {
	const next = evaluateMetadataPolicy(context);
	if (!next.allowed) { return next; }
	if (permit.resourceFingerprint !== next.permit.resourceFingerprint) { return { allowed: false, reason: 'resourceChanged' }; }
	if (permit.generation !== next.permit.generation || permit.policyFingerprint !== next.permit.policyFingerprint) {
		return { allowed: false, reason: 'policyChanged' };
	}
	return next;
}
