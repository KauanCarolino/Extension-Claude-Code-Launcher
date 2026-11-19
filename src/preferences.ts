/** Gestão opt-in: só restaura valores que ainda pertencem à extensão. */
export interface ManagedPreference {
	section: string; key: string; target: 'global' | 'workspace'; scope: string;
	previous?: unknown; written: unknown; relinquished?: boolean; observedOnly?: boolean;
}
export interface PreferenceAdapter {
	load(): readonly ManagedPreference[];
	persist(records: readonly ManagedPreference[]): Promise<void>;
	read(section: string, key: string, target: 'global' | 'workspace'): unknown;
	write(section: string, key: string, value: unknown, target: 'global' | 'workspace'): Promise<void>;
}
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
export class PreferenceManager {
	private chain: Promise<void> = Promise.resolve();
	constructor(private readonly adapter: PreferenceAdapter, private readonly workspaceScope: string) {}
	set(section: string, key: string, value: unknown, target: 'global' | 'workspace'): Promise<void> {
		return this.enqueue(async () => {
			const scope = this.workspaceScope;
			const current = this.adapter.read(section, key, target);
			const records = this.adapter.load().map((record) => ({ ...record }));
			const existing = records.find((r) => r.section === section && r.key === key && r.target === target && r.scope === scope);
			if (existing?.relinquished) { return; }
			if (!existing && equal(current, value)) { records.push({ section, key, target, scope, previous: current, written: value, observedOnly: true }); await this.adapter.persist(records); return; }
			if (existing && equal(current, value)) { return; }
			if (existing && !equal(current, existing.written)) { existing.relinquished = true; await this.adapter.persist(records); return; }
			if (existing) { existing.written = value; existing.observedOnly = false; }
			else { records.push({ section, key, target, scope, previous: current, written: value }); }
			await this.adapter.persist(records);
			await this.adapter.write(section, key, value, target);
		});
	}
	restore(): Promise<void> {
		return this.enqueue(async () => {
			const records = this.adapter.load().map((record) => ({ ...record }));
			const remaining: ManagedPreference[] = [];
			for (let index = 0; index < records.length; index += 1) {
				const record = records[index];
				if (record.scope !== this.workspaceScope) { remaining.push(record); continue; }
				try {
					if (!record.relinquished && !record.observedOnly && equal(this.adapter.read(record.section, record.key, record.target), record.written)) {
						await this.adapter.write(record.section, record.key, record.previous, record.target);
					}
				} catch (error) {
					await this.adapter.persist([...remaining, ...records.slice(index)]);
					throw error;
				}
			}
			await this.adapter.persist(remaining);
		});
	}
	private enqueue(work: () => Promise<void>): Promise<void> {
		const next = this.chain.then(work); this.chain = next.catch(() => undefined); return next;
	}
}
