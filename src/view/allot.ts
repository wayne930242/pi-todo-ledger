/**
 * Which live rows belong to which todo, and which rows one budget gives: pure, for the panel (todo-overlay.ts) to draw.
 * A live row is a run of the host (live-runs.ts), or a car or a question of pi-straw-boss (sb-rows.ts).
 */
import { history } from "../ledger/herdr-runs.ts";
import { t } from "../state/i18n-bridge.ts";
import type { Task } from "../tool/types.ts";
import { type liveRows, type RunRow, runState } from "./live-runs.ts";
import { type AskRow, type AskRows, askTodo, type CarRow, carNames } from "./sb-rows.ts";

const OVERLAY_OTHERS = "Other workers";
const OVERLAY_ASKS = "Waiting on you";
const OVERLAY_CARS = "Other cars";

/** One live row under a todo or in a group: a run of the host, or a car or an ask of sb (src/view/sb-rows.ts). `key` is unique on a panel. */
export type Live =
	| { kind: "run"; key: string; run: RunRow }
	| { kind: "car"; key: string; car: CarRow }
	| { kind: "ask"; key: string; ask: AskRow };

/** A group of live rows whose todo has no row: the asks waiting on the boss, the Other workers, or a group of cars sb names. */
export interface Group {
	kind: Live["kind"];
	title: string;
	rows: Live[];
}

/** The rows one budget gives, decided by rank (see allot). */
export interface Allotment {
	/** Tasks that get a row, in display order. */
	shown: Task[];
	/** Shown tasks whose run rows are drawn; any other shown task with runs counts them on its row. */
	withRuns: Set<Task>;
	/** The groups, in display order, each with how many of its rows get a row under its heading (compact: all, on its one row). */
	groups: { group: Group; n: number }[];
	/** Rows the budget leaves unused. */
	left: number;
}

/** What the attribution reads of one frame. */
export interface RowsContext {
	bound: Map<number, ReturnType<typeof history>>;
	live: ReturnType<typeof liveRows>;
	/** sb's car rows, and the asks of this session waiting on the boss; none without sb. */
	cars: CarRow[];
	asks: AskRows;
	runOwners: Map<string, number>;
	/** The task each bound car or ask (by key) belongs to, for its row and the `#id` of a row in a group. */
	owners: Map<string, number>;
}

/** Rows of a group that fit `rows`: the heading and at least one row, or none. */
const groupFit = (rows: number, runs: number) => (runs > 0 && rows >= 2 ? Math.min(runs, rows - 1) : 0);

/**
 * How a live row ranks for the one spot on a compact row: a question waiting on the boss (the todo's blocker), a returned or dropped
 * car, a working run, a run waiting for a reply or a car that warns, then the rest, idle runs last.
 */
const ACTIVITY: Record<string, number> = { running: 0, waiting: 1, idle: 3 };
const CAR_RANK: Record<CarRow["tone"], number> = { bad: -1, warn: 1, wait: 2, ok: 2 };
const attention = (l: Live) =>
	l.kind === "ask" ? -2 : l.kind === "car" ? CAR_RANK[l.car.tone] : (ACTIVITY[runState(l.run) ?? ""] ?? 2);
export const mostActive = (rows: readonly Live[]) => rows.reduce((best, l) => (attention(l) < attention(best) ? l : best));
export const runsOf = (rows: readonly Live[]) => rows.flatMap((l) => (l.kind === "run" ? [l.run] : []));

/** The task each car and ask belongs to (by `car:<id>`, `ask:<id>`), among the tasks the panel may show. */
export function attribute(tasks: readonly Task[], cars: readonly CarRow[], asks: AskRows): Map<string, number> {
	const owners = new Map<string, number>();
	for (const c of cars) {
		const owner = tasks.find((task) => carNames(c, task));
		if (owner) owners.set(`car:${c.id}`, owner.id);
	}
	for (const a of asks.rows) {
		const id = askTodo(a, asks.session);
		if (id !== undefined && tasks.some((task) => task.id === id)) owners.set(`ask:${a.id}`, id);
	}
	return owners;
}

/** Live rows of a task: the asks it is blocked on, its runs the host lists, then its cars (empty without either). */
export function children(task: Task, ctx: RowsContext): Live[] {
	const { runs } = ctx.bound.get(task.id) ?? history(undefined);
	return [
		...ctx.asks.rows.flatMap((ask): Live[] => (ctx.owners.get(`ask:${ask.id}`) === task.id ? [{ kind: "ask", key: `ask:${ask.id}`, ask }] : [])),
		...runs.flatMap((r): Live[] => {
			const run = ctx.live?.get(r.id);
			return run ? [{ kind: "run", key: `run:${run.id}`, run }] : [];
		}),
		...ctx.cars.flatMap((car): Live[] => (ctx.owners.get(`car:${car.id}`) === task.id ? [{ kind: "car", key: `car:${car.id}`, car }] : [])),
	];
}

/**
 * The groups for the tasks that got a row, in display order: the asks waiting on the boss, the Other workers, then the cars by
 * the group sb names (a car whose todo has no row goes in Other cars). Each holds the rows of its kind whose task has no row.
 */
function groupCandidates(visible: readonly Task[], ctx: RowsContext): Group[] {
	const ids = new Set(visible.map((task) => task.id));
	const orphan = (key: string) => !ids.has(ctx.owners.get(key) ?? -1);
	const asks: Live[] = ctx.asks.rows.map((ask) => ({ kind: "ask" as const, key: `ask:${ask.id}`, ask })).filter((l) => orphan(l.key));
	const runs: Live[] = [...(ctx.live?.values() ?? [])]
		.filter((run) => !ids.has(ctx.runOwners.get(run.id) ?? -1))
		.map((run) => ({ kind: "run" as const, key: `run:${run.id}`, run }));
	const cars = new Map<string, Live[]>();
	for (const car of ctx.cars) {
		const key = `car:${car.id}`;
		if (!orphan(key)) continue;
		const title = (car.item === undefined && car.group) || t("overlay.cars", OVERLAY_CARS);
		cars.set(title, [...(cars.get(title) ?? []), { kind: "car", key, car }]);
	}
	return [
		{ kind: "ask" as const, title: t("overlay.asks", OVERLAY_ASKS), rows: asks },
		{ kind: "run" as const, title: t("overlay.others", OVERLAY_OTHERS), rows: runs },
		...[...cars].map(([title, rows]) => ({ kind: "car" as const, title, rows })),
	].filter((g) => g.rows.length > 0);
}

/**
 * Give `slots` rows to the candidates (in display order) by rank:
 * 1. in-progress task rows;
 * 2. live rows (runs, cars and asks), all of one task's together, with that task's row when it has none yet;
 * 3. the groups, holding every live row whose task got no row;
 * 4. open tasks without a live row;
 * 5. completed tasks without a live row.
 * A task with live rows that missed rank 2 gets no row, so its rows join the groups.
 * An in-progress task whose rows do not fit keeps its row and counts its runs.
 * `compact`: live rows take no rows of their own, and each group takes one row.
 */
export function allot(candidates: readonly Task[], slots: number, ctx: RowsContext, compact: boolean): Allotment {
	const chosen = new Set<Task>();
	const withRuns = new Set<Task>();
	let used = 0;
	const take = (rows: number) => {
		if (used + rows > slots) return false;
		used += rows;
		return true;
	};
	for (const task of candidates) if (task.status === "in_progress" && take(1)) chosen.add(task);
	for (const task of candidates) {
		const runs = children(task, ctx).length;
		if (runs && take((compact ? 0 : runs) + Number(!chosen.has(task)))) {
			chosen.add(task);
			withRuns.add(task);
		}
	}
	const groups = groupCandidates([...chosen], ctx).map((group) => {
		if (compact) return { group, n: take(1) ? group.rows.length : 0 };
		const n = groupFit(slots - used, group.rows.length);
		used += n ? 1 + n : 0;
		return { group, n };
	});
	for (const done of [false, true])
		for (const task of candidates)
			if ((task.status === "completed") === done && !chosen.has(task) && !children(task, ctx).length && take(1))
				chosen.add(task);
	return { shown: candidates.filter((task) => chosen.has(task)), withRuns, groups, left: slots - used };
}

/**
 * The allotment for `rows` rows, keeping one for the summary when anything of `total` tasks or the groups is left out.
 * `compact` is set when some live row would get no row of its own: each live row then joins its task's row, and each
 * group takes one row.
 */
export function budget(candidates: readonly Task[], total: number, rows: number, ctx: RowsContext) {
	const cut = (a: Allotment) => a.shown.length < total || a.groups.some((g) => g.n < g.group.rows.length);
	const fit = (compact: boolean) => {
		const first = allot(candidates, rows, ctx, compact);
		return cut(first)
			? { shown: allot(candidates, rows - 1, ctx, compact), summarized: true }
			: { shown: first, summarized: false };
	};
	let { shown, summarized } = fit(false);
	const compact =
		shown.groups.some((g) => g.n < g.group.rows.length) ||
		shown.shown.some((task) => children(task, ctx).length > 0 && !shown.withRuns.has(task));
	if (compact) ({ shown, summarized } = fit(true));
	return { shown, summarized, compact };
}
