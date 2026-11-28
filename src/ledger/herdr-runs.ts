export interface BoundRun {
	id: string;
	name: string;
	pane?: string;
	session?: string;
	agent?: string;
	/** Session files the run went on to (a fallback's final attempt), from an end tied to it by its run id: a resume of one of them is this binding's. */
	also?: string[];
}
/** Whether a bound run is the one of session file `path`: its own, or one its ends named. */
export const runOfPath = (r: BoundRun, path: string) => r.session === path || (Array.isArray(r.also) && r.also.includes(path));
/** Run records kept for `also`, newest last. */
const ALSO = 4;
/** `herdr` with session file `path` recorded on its run `id` (`also`), when that run is bound and the path is not its own yet; else `herdr` as it is. */
export function aliasRun(herdr: Record<string, unknown>, id: string, path: string): Record<string, unknown> {
	if (!Array.isArray(herdr.runs)) return herdr;
	let changed = false;
	const runs = herdr.runs.map((r: unknown) => {
		const run = r as BoundRun;
		if (!run || typeof run !== "object" || run.id !== id || runOfPath(run, path)) return r;
		changed = true;
		return { ...run, also: [...(Array.isArray(run.also) ? run.also.filter((p) => typeof p === "string") : []), path].slice(-ALSO) };
	});
	return changed ? { ...herdr, runs } : herdr;
}
export function history(value: unknown): { runs: BoundRun[]; older: number } {
	if (!value || typeof value !== "object") return { runs: [], older: 0 };
	const h = value as Record<string, unknown>;
	const valid = (Array.isArray(h.runs) ? h.runs : [h]).filter(
		(r): r is BoundRun =>
			r && typeof r.id === "string" && typeof r.name === "string",
	);
	// Imported or hand-edited metadata may repeat an id: keep its last record, in its last position.
	const seen = new Set<string>();
	const unique: BoundRun[] = [];
	for (let i = valid.length - 1; i >= 0; i--) {
		if (seen.has(valid[i].id)) continue;
		seen.add(valid[i].id);
		unique.push(valid[i]);
	}
	unique.reverse();
	const stored =
		typeof h.older === "number" && Number.isSafeInteger(h.older) && h.older > 0
			? h.older
			: 0;
	return {
		runs: unique.slice(-6),
		older: stored + Math.max(0, unique.length - 6),
	};
}
export function bindRun(previous: unknown, newest: BoundRun) {
	const { runs, older } = history(previous);
	const next = [...runs.filter((r) => r.id !== newest.id), newest];
	const dropped = older + Math.max(0, next.length - 6);
	return {
		name: newest.name,
		id: newest.id,
		...(newest.pane ? { pane: newest.pane } : {}),
		runs: next.slice(-6),
		...(dropped ? { older: dropped } : {}),
		// What the todo's runs spent (herdr-spend.ts) outlives a new binding.
		...(previous && typeof previous === "object" && "spend" in previous ? { spend: (previous as { spend: unknown }).spend } : {}),
	};
}
