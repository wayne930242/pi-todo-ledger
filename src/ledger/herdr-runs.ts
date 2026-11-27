export interface BoundRun {
	id: string;
	name: string;
	pane?: string;
	session?: string;
	agent?: string;
}
export function history(value: unknown): { runs: BoundRun[]; older: number } {
	if (!value || typeof value !== "object") return { runs: [], older: 0 };
	const h = value as Record<string, unknown>;
	const runs = (Array.isArray(h.runs) ? h.runs : [h])
		.filter(
			(r): r is BoundRun =>
				r && typeof r.id === "string" && typeof r.name === "string",
		)
		.slice(-6);
	return {
		runs,
		older:
			typeof h.older === "number" &&
			Number.isSafeInteger(h.older) &&
			h.older > 0
				? h.older
				: 0,
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
	};
}
