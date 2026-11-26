// O que o `status` mostra: estado, passos e os quatro tempos, com a espera de cota à parte.
import { quotaWaitMs, wallMs } from './job';
import type { Job } from './types';

export function formatDuration(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
	return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

export function formatStatus(job: Job, now: Date): string {
	const lines: string[] = [];
	lines.push(`Job ${job.id}  ${job.state}${job.reason ? ` — ${job.reason}` : ''}`);
	lines.push(`Request: ${job.request}`);
	lines.push(`Branch:  ${job.branch}`);
	if (job.plan) {
		if (!job.planConfirmed) lines.push('Plan:    waiting for confirmation');
		lines.push(`Goal:    ${job.plan.goal}`);
		for (const s of job.steps) {
			const mark = s.status === 'done' ? 'x' : s.status === 'running' ? '>' : ' ';
			const extra = [s.provider, s.commit?.slice(0, 8), `conf ${s.confidence.toFixed(2)}`, s.risk].filter(Boolean).join(', ');
			lines.push(`  [${mark}] ${s.id}. ${s.title} (${extra})`);
		}
	}
	if (job.repairCycles) lines.push(`Repairs: ${job.repairCycles}`);
	const model = Object.entries(job.timing.modelMs)
		.map(([id, ms]) => `${id} ${formatDuration(ms ?? 0)}`)
		.join(', ');
	lines.push('Time:');
	lines.push(`  wall    ${formatDuration(wallMs(job, now))}`);
	lines.push(`  model   ${model || '0s'}`);
	lines.push(`  test    ${formatDuration(job.timing.testMs)}`);
	lines.push(`  quota   ${formatDuration(quotaWaitMs(job, now))}`);
	lines.push(`Input:   ~${job.budget.inputTokensEstimate} tokens sent in ${job.budget.calls} call(s) (local estimate, not your subscription usage)`);
	if (job.budget.reportedInputTokens !== undefined) {
		lines.push(`Usage:   ${job.budget.reportedInputTokens} in / ${job.budget.reportedOutputTokens ?? 0} out, as reported by the CLIs (with cache and tool turns)`);
	}
	if (job.lastTest) {
		const t = job.lastTest;
		lines.push(`Last test: ${t.passed ? 'passed' : 'failed'} — ${t.command} (${t.timedOut ? 'timeout' : `exit ${String(t.exitCode)}`}, ${formatDuration(t.durationMs)})`);
	}
	if (job.pr) lines.push(`PR:      ${job.pr.url}`);
	return lines.join('\n');
}

export function formatPlan(job: Job): string {
	if (!job.plan) return 'No plan yet.';
	const lines = [`Goal: ${job.plan.goal}`];
	for (const s of job.plan.steps) {
		lines.push(`  ${s.id}. ${s.title}`);
		lines.push(`     files: ${s.files.join(', ') || '(none)'}  confidence ${s.confidence.toFixed(2)}  risk ${s.risk}`);
		if (s.doneWhen) lines.push(`     done when: ${s.doneWhen}`);
	}
	return lines.join('\n');
}

export function formatList(jobs: Job[]): string {
	if (!jobs.length) return 'No jobs in .orquestra/jobs.';
	return jobs
		.map((j) => {
			const done = j.steps.filter((s) => s.status === 'done').length;
			return `${j.id}  ${j.state.padEnd(13)}  ${done}/${j.steps.length} steps  ${j.request.slice(0, 60)}`;
		})
		.join('\n');
}
