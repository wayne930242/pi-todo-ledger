/**
 * A skald main session's todo list and live runs (2026-11-28), as the boss saw it:
 * 71 todos (54 completed, 8 in progress, 9 pending), 9 live subagents, 7 of them
 * bound to in-progress todos and 2 bound to none.
 */
import type { RunRow } from "../src/view/live-runs.ts";

export type Spec = { id: number; subject: string; status: string; owner?: string; blockedBy?: number[]; metadata?: object };

/** Open todos, with the session's subjects, owners and blockers. */
const OPEN: Array<[number, "in_progress" | "pending", string, string?, number[]?]> = [
	[35, "in_progress", "Final BitD UAT round for the boss"],
	[55, "in_progress", "S3 地圖 tab on core Table Maps, BitD map retired", "coremaptab-ui", [52, 53]],
	[56, "in_progress", "F1 faction tracker storage (migration 198)", "factionsdb-build", [53]],
	[57, "pending", "S4 map ports + two-way claims ↔ turf sync", undefined, [55]],
	[58, "pending", "S5 GM-uploaded custom maps (migration 199)", undefined, [55]],
	[59, "pending", "S6 map frame → new whiteboard (migration 200)", undefined, [55]],
	[60, "pending", "F2 派系 tab + crew sheet faction section", undefined, [56, 55, 57]],
	[61, "pending", "F3 勢力棋盤 relationship board on crew sheet", undefined, [60]],
	[62, "pending", "S7b map-frame links in whiteboard notes", undefined, [59, 54]],
	[65, "in_progress", "EP sheet: centering, morph grid, 更換義體, Select, pictures"],
	[66, "in_progress", "Site-wide: native selects → shared Select, then lint guard", "selectsweep-ui"],
	[67, "in_progress", "EP rules book: add Flexbot Confidential + Rules Primer; Flexbot library rows", "epbooks-build"],
	[68, "in_progress", "EP scenarios: 心智獵人, 小心WMD, 異噬, 超企業劫案, 奈米任務", "epscen-build"],
	[69, "pending", "BitD SRD text: broken bold in 盯迫 list"],
	[70, "in_progress", "Table session: reading dialogs dock to the workspace pane, chat stays usable"],
	[71, "pending", "EP scenarios 心智獵人（換體版）+ 奈米任務 as built-in scenarios", undefined, [68]],
	[72, "pending", "Fix 196 flake: submit_organization_draft returns org by created_at"],
];

/** Live runs bound to each todo (run ids; the run's name is its todo's owner). */
const BOUND: Record<number, string[]> = {
	55: ["coremaptab-ui"],
	56: ["factionsdb-build"],
	66: ["selectsweep-ui"],
	67: ["epbooks-build"],
	68: ["epscen-build", "epscen-review", "epscen-fix"],
};
/** Live runs of the session bound to no todo. */
export const UNBOUND = ["skald-scout", "bitd-uat-review"];
export const BOUND_RUNS = Object.values(BOUND).flat();

export function skaldTasks(): Spec[] {
	const open = new Map(OPEN.map(([id, status, subject, owner, blockedBy]) => [id, { id, status, subject, owner, blockedBy }]));
	const tasks: Spec[] = [];
	for (let id = 1; id <= 72; id++) {
		const o = open.get(id);
		if (id === 11) tasks.push({ id, subject: "Design name generator", status: "deleted", blockedBy: [1, 20] });
		else if (!o) tasks.push({ id, subject: `done ${id}`, status: "completed" });
		else {
			const runs = BOUND[id];
			tasks.push({
				id, subject: o.subject, status: o.status,
				...(o.owner ? { owner: o.owner } : {}),
				...(o.blockedBy ? { blockedBy: o.blockedBy } : {}),
				...(runs ? { metadata: { herdr: { runs: runs.map((r) => ({ id: r, name: r.startsWith("epscen") ? "epscen-build" : r })) } } } : {}),
			});
		}
	}
	return tasks;
}

/** The 9 live rows the host reports, bound runs first, as of `now`. */
export function skaldRows(now: number): RunRow[] {
	const row = (id: string, mins: number, extra: Partial<RunRow> = {}): RunRow => ({
		id, name: id, model: "claude-bridge/claude-opus-5-5", agent: "worker", startedAt: now - mins * 60_000, phase: { kind: "active" }, ...extra,
	});
	return [
		row("coremaptab-ui", 4),
		row("factionsdb-build", 21),
		row("selectsweep-ui", 39),
		row("epbooks-build", 30),
		row("epscen-build", 30, { phase: { kind: "waiting", since: now - 120_000 } }),
		row("epscen-review", 6, { agent: "reviewer" }),
		row("epscen-fix", 2),
		row("skald-scout", 3, { agent: "scout" }),
		row("bitd-uat-review", 1, { agent: "reviewer" }),
	];
}
