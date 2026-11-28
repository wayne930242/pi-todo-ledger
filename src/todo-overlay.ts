/**
 * todo-overlay.ts — Persistent widget showing todo list above the editor.
 *
 * Lifecycle controller for Pi's `setWidget` contract: factory-form
 * registration in widgetContainerAbove, register-once + requestRender()
 * refresh, a cycle key (focus → full → collapsed), configurable
 * collapse-not-scroll (default 12 content rows via getMaxWidgetLines(); plus a trailing spacer row so the widget renders up
 * to 13 lines), Pi tool-output expansion awareness, auto-hide when empty.
 *
 * Reads live state via `getRenderState()` (the ctx-less foreground slot) at render
 * time — NEVER `replayFromBranch` from `tool_execution_end` (branch is stale;
 * `message_end` runs after).
 */

import type {
	ExtensionUIContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	COLLAPSE_KEY_OFF,
	getMaxWidgetLines,
	getView,
	type OverlayView,
	resolveCollapseKey,
} from "./config.ts";
import { formatStatusLabel, formatWorkerCount, t } from "./state/i18n-bridge.ts";
import {
	selectHasActive,
	selectShowTaskIds,
	selectTodoCounts,
	selectVisibleTasks,
} from "./state/selectors.ts";
import { getRenderState } from "./state/store.ts";
import { formatPlanTaskLine } from "./view/format.ts";
import { type PlanRow, planView } from "./view/plan.ts";
import type { Task } from "./tool/types.ts";

import { history } from "./ledger/herdr-runs.ts";
import { liveRows, runLine, type Query, type RunRow } from "./view/live-runs.ts";
import { attribute, budget, children, type Group, type Live, mostActive, type RowsContext, runsOf } from "./view/allot.ts";
import { askLine, askRows, carLine, carRows, type SbQuery } from "./view/sb-rows.ts";

const WIDGET_KEY = "rpiv-todos";

// English fallbacks for localized overlay chrome strings.
const OVERLAY_HEADING = "Todos";
const OVERLAY_MORE = "more";
const OVERLAY_KEY_HINT = "{key} {next}";
const OVERLAY_COLLAPSED = "collapsed";
const OVERLAY_SEPARATOR = ", ";

/** What the panel shows: one of the two views, or the two-line collapsed state. */
type PanelState = OverlayView | "collapsed";
/** The cycle key's order, from any starting state. */
const NEXT_STATE: Record<PanelState, PanelState> = { focus: "full", full: "collapsed", collapsed: "focus" };
/** English names of the state the key goes to next, as the hint shows them. */
const NEXT_STATE_NAME: Record<PanelState, string> = { focus: "focus", full: "full", collapsed: "collapse" };

/** Run rows drawn on one frame, for the claim bookkeeping. */
interface Frame {
	/** Inline: runs drawn whole. */
	drawn: string[];
	/** Fullscreen: runs drawn whole, with their marked line. */
	marked: Map<string, string>;
	ticking: boolean;
}

/** Narrowest left part (branch, glyph, id, start of the subject) a compact row keeps before its run. */
const COMPACT_MIN_LEFT = 12;

/** What one frame's row drawing needs, shared by the full and focus views. */
interface DrawContext extends RowsContext {
	theme: Theme;
	width: number;
	truncate: (line: string) => string;
	/** Live runs of this session bound to no task on the panel, in the host's order. */
	others: RunRow[];
	/** The groups of the frame, as the allotment gave them rows. */
	groups: { group: Group; n: number }[];
	showIds: boolean;
	now: number;
	evidence: "inline" | "screen" | undefined;
	/** Compact mode: a task's runs, and the Other workers group, share one row with it (see budgeted). */
	compact: boolean;
}

/** A live row's words: a run as the host's row, a car as sb words it, an ask with its question. `grouped`: under the asks' heading. */
function liveText(l: Live, draw: DrawContext, grouped: boolean): string {
	const fg = (color: Parameters<Theme["fg"]>[0], text: string) => draw.theme.fg(color, text);
	if (l.kind === "run") return runLine(l.run, draw.now, fg);
	return l.kind === "car" ? carLine(l.car, draw.now, fg) : askLine(l.ask, draw.now, fg, grouped);
}

/** `2 waiting on you`, as the collapsed panel and the summary count the asks. */
const askCount = (n: number) => t("overlay.asks.count", "{n} waiting on you").replace("{n}", String(n));

/** What each group leaves out, for the summary row: workers, asks, or cars by their group. */
function groupsLeft(groups: readonly { group: Group; n: number }[]): string[] {
	return groups
		.filter(({ group, n }) => n < group.rows.length)
		.map(({ group, n }) => {
			const k = group.rows.length - n;
			return group.kind === "run" ? formatWorkerCount(k) : group.kind === "ask" ? `⏸ ${askCount(k)}` : `${k} ${group.title}`;
		});
}

export class TodoOverlay {
	private uiCtx: ExtensionUIContext | undefined;
	private widgetRegistered = false;
	private tui: TUI | undefined;
	private completedTaskIdsPendingHide = new Set<number>();
	private hiddenCompletedTaskIds = new Set<number>();
	private lastNextId: number | undefined;
	/** Set by the cycle key; until then the panel follows the configured `view`. */
	private state?: PanelState;

	private previous: string[] = [];
	private claimed: string[] = [];
	/** Run rows (with markers) drawn on the frame being painted, awaiting the screen check. */
	private onScreen?: Map<string, string>;
	private screenCheckQueued = false;
	private markers = new Map<string, string>();
	private readonly nonce = Math.random().toString(36).slice(2, 10);
	private tick?: ReturnType<typeof setInterval>;
	private query?: Query;
	private sb?: SbQuery;
	constructor(query?: Query, sb?: SbQuery) {
		this.query = query;
		this.sb = sb;
	}

	private sendClaim(ids: string[]) {
		// An empty claim is a release; send it only to retract an earlier claim.
		if (!ids.length && !this.claimed.length) return;
		this.claimed = ids;
		try {
			this.query?.({ claim: { by: "pi-todo-ledger", ids } });
		} catch {
			/* host lease expires */
		}
	}

	/**
	 * How the panel learns that a drawn run row reached the screen.
	 * - `inline`: Pi's regular renderer writes every widget line.
	 * - `screen`: Pi's fullscreen layout clips the widget after render() returns,
	 *   so each run row carries a marker and the painted frame is searched for it.
	 * - `undefined`: no evidence; nothing is claimed.
	 */
	private evidence(): "inline" | "screen" | undefined {
		const tui = this.tui as
			| { mode?: string; getScreenLines?: unknown }
			| undefined;
		if (tui?.mode === "regular") return "inline";
		if (tui?.mode === "fullscreen" && typeof tui.getScreenLines === "function")
			return "screen";
		return undefined;
	}

	/**
	 * An invisible marker unique to this panel and run. It has the form of an OSC 8
	 * sequence with an `id` parameter and no URI; Pi counts it as zero width, and
	 * terminals drop it (Ghostty and Herdr discard it as an invalid OSC 8). It only
	 * makes the row's text unique, so the screen check can find the row.
	 */
	private marker(id: string): string {
		let m = this.markers.get(id);
		if (!m) {
			m = `\x1b]8;id=pi-todo-ledger-${this.nonce}-${this.markers.size};\x07`;
			this.markers.set(id, m);
		}
		return m;
	}

	/**
	 * Claim the rows Pi painted unchanged on the frame it just wrote. render() runs
	 * inside Pi's synchronous frame, so a microtask reads that frame's screen. A
	 * row counts only when a screen line starts with the exact row drawn: a clipped
	 * row is absent, and a popup, highlight or selection drawn over it changes the
	 * line. A changed claim asks for one more frame so the Subagents widget follows.
	 */
	private checkScreen(rows: Map<string, string>) {
		this.onScreen = rows;
		if (this.screenCheckQueued) return;
		this.screenCheckQueued = true;
		queueMicrotask(() => {
			this.screenCheckQueued = false;
			const pending = this.onScreen;
			this.onScreen = undefined;
			if (!pending) return;
			let screen: string[] = [];
			try {
				screen =
					(this.tui as { getScreenLines?: () => string[] } | undefined)
						?.getScreenLines?.() ?? [];
			} catch {
				/* no evidence */
			}
			const ids = [...pending]
				.filter(([, row]) => screen.some((line) => line.startsWith(row)))
				.map(([id]) => id);
			const changed =
				ids.length !== this.claimed.length ||
				ids.some((id) => !this.claimed.includes(id));
			this.sendClaim(ids);
			if (changed) this.tui?.requestRender();
		});
	}

	private finishFrame(
		ids: string[],
		ticking = ids.length > 0,
		rows?: Map<string, string>,
	) {
		if (rows?.size) {
			this.previous = [];
			this.checkScreen(rows);
		} else {
			this.onScreen = undefined;
			// Inline: only renew claims for children drawn on both this and the preceding frame.
			this.sendClaim(this.previous.filter((id) => ids.includes(id)));
			this.previous = ids;
		}
		if (ticking && !this.tick) {
			this.tick = setInterval(() => this.tui?.requestRender(), 1000);
			this.tick.unref();
		}
		if (!ticking && this.tick) {
			clearInterval(this.tick);
			this.tick = undefined;
		}
	}

	setUICtx(ctx: ExtensionUIContext): void {
		// Identity-compare so repeat session_start handlers are idempotent;
		// on identity change (/reload) invalidate so update() re-registers.
		if (ctx !== this.uiCtx) {
			this.finishFrame([]);
			this.uiCtx = ctx;
			this.widgetRegistered = false;
			this.tui = undefined;
		}
	}

	update(): void {
		if (!this.uiCtx) return;
		const snapshot = this.getSnapshot();
		const visible = this.selectOverlayTasks(snapshot);

		// With no task to show, the panel stays for this session's runs (the Other workers group), cars and asks.
		if (visible.length === 0 && !liveRows(this.query)?.size && !carRows(this.sb).length && !askRows(this.sb).rows.length) {
			this.finishFrame([]);
			if (this.widgetRegistered) {
				this.uiCtx.setWidget(WIDGET_KEY, undefined);
				this.widgetRegistered = false;
				this.tui = undefined;
			}
			return;
		}

		if (!this.widgetRegistered) {
			this.uiCtx.setWidget(
				WIDGET_KEY,
				(tui, factoryTheme) => {
					this.tui = tui;
					return {
						render: (width: number) =>
							this.renderWidget(this.uiCtx?.theme ?? factoryTheme, width),
						invalidate: () => {
							// No rendered strings are cached. Pi invalidates on theme changes;
							// the next render reads uiCtx.theme.
						},
					};
				},
				{ placement: "aboveEditor" },
			);
			this.widgetRegistered = true;
		} else {
			this.tui?.requestRender();
		}
	}

	resetCompletedDisplayState(): void {
		this.finishFrame([]);
		this.completedTaskIdsPendingHide.clear();
		this.hiddenCompletedTaskIds.clear();
		this.lastNextId = undefined;
	}

	hideCompletedTasksFromPreviousTurn(): void {
		if (this.completedTaskIdsPendingHide.size === 0) return;
		for (const taskId of this.completedTaskIdsPendingHide) {
			this.hiddenCompletedTaskIds.add(taskId);
		}
		this.completedTaskIdsPendingHide.clear();
		this.tui?.requestRender();
	}

	private current(): PanelState {
		return this.state ?? getView();
	}

	/** Step the panel to the next state: focus → full → collapsed → focus. */
	cycleView(): void {
		this.state = NEXT_STATE[this.current()];
		// Release before the redraw: the host may draw its widget first in that frame.
		if (this.state === "collapsed") this.finishFrame([]);
		// Forced full redraw on every height step, mirroring the
		// lane-dock's requestRender(shapeChanged); distinct from the non-forced
		// requestRender() refresh paths in update()/hideCompletedTasksFromPreviousTurn().
		this.tui?.requestRender(true);
	}

	/**
	 * The dim key hint naming the next state, e.g. `ctrl+shift+t full`, or
	 * undefined when the key is "off". The key is resolved per render; a config
	 * edit needs /reload to re-bind the actual shortcut.
	 */
	private keyHint(): string | undefined {
		const key = resolveCollapseKey();
		if (key === COLLAPSE_KEY_OFF) return undefined;
		const next = NEXT_STATE[this.current()];
		const name = t(`overlay.next.${next}`, NEXT_STATE_NAME[next]);
		return t("overlay.keyHint", OVERLAY_KEY_HINT).replace(/\{(key|next)\}/g, (_m, k: string) => (k === "key" ? key : name));
	}

	/**
	 * The closing `└─` row: the summary, then ` · ` and the key hint when both fit
	 * the width (the hint is cut first), or the hint alone.
	 */
	private closingRow(draw: DrawContext, summary: string | undefined, hint: string | undefined): string {
		const { theme, width, truncate } = draw;
		const row = (text: string) => `${theme.fg("dim", "└─")} ${theme.fg("dim", text)}`;
		if (summary === undefined) return truncate(row(hint ?? ""));
		const both = hint ? row(`${summary} · ${hint}`) : undefined;
		return both && visibleWidth(both) <= width ? both : truncate(row(summary));
	}

	isRegistered(): boolean {
		return this.widgetRegistered;
	}

	private getSnapshot() {
		const state = getRenderState();
		if (this.lastNextId !== undefined && state.nextId < this.lastNextId) {
			this.resetCompletedDisplayState();
		}
		this.lastNextId = state.nextId;
		const completedTaskIds = new Set(
			state.tasks
				.filter((task) => task.status === "completed")
				.map((task) => task.id),
		);
		for (const taskId of this.completedTaskIdsPendingHide) {
			if (!completedTaskIds.has(taskId))
				this.completedTaskIdsPendingHide.delete(taskId);
		}
		for (const taskId of this.hiddenCompletedTaskIds) {
			if (!completedTaskIds.has(taskId))
				this.hiddenCompletedTaskIds.delete(taskId);
		}
		return { tasks: [...state.tasks], nextId: state.nextId };
	}

	private selectOverlayTasks(snapshot: ReturnType<TodoOverlay["getSnapshot"]>) {
		return snapshot.tasks.filter(
			(task) =>
				task.status !== "deleted" && !this.shouldHideCompletedTask(task),
		);
	}

	private shouldHideCompletedTask(
		task: ReturnType<TodoOverlay["getSnapshot"]>["tasks"][number],
	): boolean {
		return (
			task.status === "completed" && this.hiddenCompletedTaskIds.has(task.id)
		);
	}

	private renderWidget(theme: Theme, width: number): string[] {
		const snapshot = this.getSnapshot();
		const overlayTasks = this.selectOverlayTasks(snapshot);
		// Every state asks the host: runs bound to no task join the Other workers group, or its count.
		const live = liveRows(this.query);
		const cars = carRows(this.sb);
		const asks = askRows(this.sb);
		if (overlayTasks.length === 0 && !live?.size && !cars.length && !asks.rows.length) {
			this.finishFrame([]);
			return [];
		}
		const bound = new Map(
			overlayTasks.map((t) => [t.id, history(t.metadata?.herdr)] as const),
		);
		const hasRuns = [...bound.values()].some((h) => h.runs.length > 0);
		const boundIds = new Set([...bound.values()].flatMap((h) => h.runs.map((r) => r.id)));
		const others = [...(live?.values() ?? [])].filter((r) => !boundIds.has(r.id));

		const plan = planView(overlayTasks);
		// Keep completed rows in their old slots; fill open slots in display order before budgeting.
		let nextOpen = 0;
		const tasks = overlayTasks.map((t) =>
			t.status === "completed" ? t : plan.ordered[nextOpen++],
		);
		const overlayState = { tasks, nextId: snapshot.nextId };
		const truncate = (line: string): string =>
			truncateToWidth(line, width, "…");
		const counts = selectTodoCounts(overlayState);
		const hasActive = selectHasActive(overlayState);
		const owners = attribute(overlayTasks, cars, asks);
		const showIds = (hasRuns && !!live?.size) || owners.size > 0 || selectShowTaskIds(overlayState);

		const headingColor = hasActive ? "accent" : "dim";
		const headingIcon = hasActive ? "●" : "○";
		const headingText = `${t("overlay.heading", OVERLAY_HEADING)} (${counts.completed}/${counts.total})`;
		const graph = plan.sharedGraph
			? ` · ${theme.fg("dim", hasRuns && plan.sharedGraph === "fan-out/fan-in" ? "fan-out" : plan.sharedGraph)}`
			: "";
		const heading = truncate(
			`${theme.fg(headingColor, headingIcon)} ${theme.fg(headingColor, headingText)}${graph}`,
		);

		const draw: DrawContext = {
			theme,
			width,
			truncate,
			bound,
			live,
			cars,
			asks,
			others,
			groups: [],
			runOwners: new Map([...bound].flatMap(([id, h]) => h.runs.map(r => [r.id, id] as const))),
			owners,
			showIds,
			now: Date.now(),
			evidence: this.evidence(),
			compact: false,
		};

		// Collapsed view: just the heading + a dim "└─" hint naming the next state,
		// after the count of other workers, then the trailing spacer. Short-circuit
		// before the budget math and the completed-display tracking — nothing is
		// shown to track, and skipping the tracking when nothing is rendered is
		// correctness, not optimization. The "off" sentinel is reachable here
		// mid-session (config edited after the shortcut was bound and the overlay
		// collapsed) — render a static collapsed label instead of advertising an
		// unbound key. Nothing is claimed; the tick keeps the count current.
		if (this.current() === "collapsed") {
			this.finishFrame([], others.length > 0 || asks.rows.length > 0);
			const hint = this.keyHint() ?? t("overlay.collapsed", OVERLAY_COLLAPSED);
			const counts = [
				others.length ? `+${formatWorkerCount(others.length)}` : "",
				asks.rows.length ? `⏸ ${askCount(asks.rows.length)}` : "",
			].filter(Boolean);
			const count = counts.length ? counts.join(t("overlay.separator", OVERLAY_SEPARATOR)) : undefined;
			return this.withTrailingSpacer([heading, this.closingRow(draw, count, hint)]);
		}

		// Budget for content rows below the heading (tasks, run rows, summary). The
		// rendered widget is one line taller — withTrailingSpacer() appends a blank row
		// below the panel. Pi's global tool-output expansion mode is read on every
		// render so its expand/collapse shortcut also lifts this budget. Optional
		// chaining preserves compatibility with hosts predating getToolsExpanded().
		const bodyBudget =
			this.uiCtx?.getToolsExpanded?.() === true
				? Infinity
				: getMaxWidgetLines() - 1;
		const body =
			this.current() === "full"
				? this.fullBody(overlayState, plan, bodyBudget, draw)
				: this.focusBody(overlayTasks, plan, bodyBudget, draw);

		const newlyDisplayedCompletedTaskIds = overlayTasks
			.filter(
				(task) =>
					task.status === "completed" &&
					!this.completedTaskIdsPendingHide.has(task.id) &&
					!this.hiddenCompletedTaskIds.has(task.id),
			)
			.map((task) => task.id);
		for (const taskId of newlyDisplayedCompletedTaskIds) {
			this.completedTaskIdsPendingHide.add(taskId);
		}
		return this.withTrailingSpacer([heading, ...body]);
	}

	/** The whole dependency tree, budgeted by rank (see view/allot.ts), then the groups (the `"full"` view). */
	private fullBody(
		overlayState: { tasks: Task[]; nextId: number },
		plan: ReturnType<typeof planView>,
		bodyBudget: number,
		draw: DrawContext,
	): string[] {
		const all = [...selectVisibleTasks(overlayState)];
		const { shown, summarized, hintRow, hint } = this.budgeted(all, all.length, bodyBudget, draw);
		const frame: Frame = { drawn: [], marked: new Map(), ticking: false };
		const lines = this.drawTasks(
			shown.shown.map((task) => ({ task, row: plan.rows.get(task.id) })),
			shown.withRuns,
			!summarized && !hintRow && !shown.groups.some((g) => g.n),
			draw,
			frame,
		);
		lines.push(...this.drawGroups(shown.groups, !summarized && !hintRow, draw, frame));
		this.endFrame(frame, draw);
		if (hintRow) lines.push(this.closingRow(draw, undefined, hint));
		if (!summarized) return lines;

		const parts: string[] = [];
		const isShown = new Set(shown.shown);
		const hiddenBy = (status: string) => all.filter((task) => task.status === status && !isShown.has(task)).length;
		const overflowParts = (["completed", "in_progress", "pending"] as const)
			.map((status) => [hiddenBy(status), status] as const)
			.filter(([n]) => n > 0);
		const overflow = overflowParts.reduce((sum, [n]) => sum + n, 0);
		if (overflow > 0) {
			const more = t("overlay.more", OVERLAY_MORE);
			parts.push(`+${overflow} ${more} (${overflowParts.map(([n, status]) => `${n} ${formatStatusLabel(status)}`).join(", ")})`);
		}
		for (const left of groupsLeft(shown.groups)) parts.push(`${parts.length ? "" : "+"}${left}`);
		lines.push(this.closingRow(draw, parts.join(t("overlay.separator", OVERLAY_SEPARATOR)), hint));
		return lines;
	}

	/**
	 * The focus view (default): in-progress tasks with their runs, the next open
	 * tasks (two, or three when nothing is in progress), the groups, then this
	 * turn's completed rows, budgeted by rank (see view/allot.ts), and one summary row
	 * counting whatever is hidden. Completed rows are drawn before the groups.
	 * Rows are flat, so every unfinished blocker goes to the `⛓` tail.
	 */
	private focusBody(
		overlayTasks: Task[],
		plan: ReturnType<typeof planView>,
		bodyBudget: number,
		draw: DrawContext,
	): string[] {
		const inProgress = plan.ordered.filter((t) => t.status === "in_progress");
		const pending = plan.ordered.filter((t) => t.status === "pending");
		const completed = overlayTasks.filter((t) => t.status === "completed");
		const next = pending.slice(0, inProgress.length ? 2 : 3);
		const total = inProgress.length + pending.length + completed.length;
		const { shown, summarized, hintRow, hint } = this.budgeted(
			[...inProgress, ...next, ...completed],
			total,
			bodyBudget,
			draw,
		);

		const openIds = new Set(plan.ordered.map((t) => t.id));
		const flat = (task: Task): PlanRow | undefined => {
			const row = plan.rows.get(task.id);
			return row
				? {
						depth: 0,
						graph: row.graph,
						otherBlockers: (task.blockedBy ?? []).filter((id) => openIds.has(id)),
					}
				: undefined;
		};
		const frame: Frame = { drawn: [], marked: new Map(), ticking: false };
		const lines = this.drawTasks(
			shown.shown.map((task) => ({ task, row: flat(task) })),
			shown.withRuns,
			!summarized && !hintRow && !shown.groups.some((g) => g.n),
			draw,
			frame,
		);
		lines.push(...this.drawGroups(shown.groups, !summarized && !hintRow, draw, frame));
		this.endFrame(frame, draw);
		if (hintRow) lines.push(this.closingRow(draw, undefined, hint));
		if (!summarized) return lines;

		const isShown = new Set(shown.shown);
		const hidden = (list: Task[]) => list.filter((t) => !isShown.has(t)).length;
		const parts = (
			[
				[hidden(inProgress), "in_progress"],
				[hidden(pending), "pending"],
				[hidden(completed), "completed"],
			] as const
		)
			.filter(([n]) => n > 0)
			.map(([n, status]) => `${n} ${formatStatusLabel(status)}`);
		parts.push(...groupsLeft(shown.groups));
		const summary = `+${parts.join(t("overlay.separator", OVERLAY_SEPARATOR))}`;
		lines.push(this.closingRow(draw, summary, hint));
		return lines;
	}

	/**
	 * The allotment for `budget` rows (see `budget` in view/allot.ts). With nothing to summarize, the hint takes its own
	 * row only when one is spare. Sets `draw.groups` and `draw.compact`.
	 */
	private budgeted(candidates: readonly Task[], total: number, rows: number, draw: DrawContext) {
		const { shown, summarized, compact } = budget(candidates, total, rows, draw);
		draw.compact = compact;
		draw.groups = shown.groups;
		const hint = this.keyHint();
		const hintRow = !summarized && hint !== undefined && shown.left > 0;
		return { shown, summarized, hintRow, hint };
	}

	/** End the frame's claim bookkeeping; a group folded into the summary keeps the tick so its count stays current. */
	private endFrame(frame: Frame, draw: DrawContext) {
		this.finishFrame(frame.drawn, frame.ticking || draw.groups.length > 0, frame.marked);
	}

	/**
	 * One run row under the dim tree branch. Only a row shown in full is
	 * claimed; a truncated one carries no marker.
	 */
	private drawRun(lines: string[], r: RunRow, branch: string, draw: DrawContext, frame: Frame) {
		const { theme, width, truncate, now, evidence } = draw;
		const line = theme.fg("dim", branch) + runLine(r, now, (color, text) => theme.fg(color, text));
		const whole = visibleWidth(line) <= width;
		frame.ticking = true;
		if (whole && evidence === "screen") {
			const marked = line + this.marker(r.id);
			frame.marked.set(r.id, marked);
			lines.push(marked);
		} else {
			lines.push(truncate(line));
			if (whole && evidence === "inline") frame.drawn.push(r.id);
		}
	}

	/** One live row under the dim tree branch: a run as drawRun draws it, a car or an ask as sb words it. `grouped`: under the asks' heading. */
	private drawLive(lines: string[], l: Live, branch: string, draw: DrawContext, frame: Frame, grouped = false) {
		if (l.kind === "run") return this.drawRun(lines, l.run, branch, draw, frame);
		frame.ticking = true;
		lines.push(draw.truncate(draw.theme.fg("dim", branch) + liveText(l, draw, grouped)));
	}

	/**
	 * A compact row: `left` (a task row or a group heading), then ` ⟶ ` and the live row
	 * that most wants attention, then `+N` for the others. The left part is cut first, so the
	 * live row stays whole. A row shown in full claims every run it stands for; one cut into
	 * the live row, or with no room for the left part, carries no marker and claims none.
	 * In a group (`group`), a row of a hidden task carries its task number.
	 */
	private drawCompact(lines: string[], left: string, rows: Live[], draw: DrawContext, frame: Frame, group?: Group) {
		const { theme, width, truncate, evidence } = draw;
		const lead = mostActive(rows);
		const owner = lead.kind === "run" ? draw.runOwners.get(lead.run.id) : draw.owners.get(lead.key);
		let right =
			theme.fg("dim", " ⟶ ") +
			(group && owner !== undefined ? `#${owner} ` : "") +
			liveText(lead, draw, group?.kind === "ask") +
			(rows.length > 1 ? theme.fg("dim", ` +${rows.length - 1}`) : "");
		// sb's words can run long (a return's reason); a run row is short and stays whole to be claimed.
		if (lead.kind !== "run" && visibleWidth(right) > width - COMPACT_MIN_LEFT)
			right = truncateToWidth(right, Math.max(width - COMPACT_MIN_LEFT, 0), "…");
		const room = width - visibleWidth(right);
		const roomy = visibleWidth(left) <= room || room >= COMPACT_MIN_LEFT;
		const line = roomy ? truncateToWidth(left, Math.max(room, 0), "…") + right : truncate(left + right);
		const whole = roomy && visibleWidth(line) <= width;
		const runs = runsOf(rows);
		frame.ticking = true;
		if (whole && runs.length && evidence === "screen") {
			const marked = line + this.marker(lead.key);
			for (const r of runs) frame.marked.set(r.id, marked);
			lines.push(marked);
		} else {
			lines.push(truncate(line));
			if (whole && evidence === "inline") frame.drawn.push(...runs.map((r) => r.id));
		}
	}

	/** The groups that got rows, each a heading then its rows; `closed` means the last one ends the panel. */
	private drawGroups(groups: { group: Group; n: number }[], closed: boolean, draw: DrawContext, frame: Frame): string[] {
		const drawn = groups.filter((g) => g.n > 0);
		return drawn.flatMap(({ group, n }, i) => this.drawGroup(group, n, closed && i === drawn.length - 1, draw, frame));
	}

	/**
	 * A group: a heading row, then its first `n` rows, runs drawn and claimed like bound run rows, and a row of a todo
	 * that has no row with that todo's number. `closed` means it ends the panel.
	 */
	private drawGroup(group: Group, n: number, closed: boolean, draw: DrawContext, frame: Frame): string[] {
		const { theme, truncate } = draw;
		const heading = `${theme.fg("dim", closed ? "└─" : "├─")} ${theme.fg("muted", group.title)}`;
		if (draw.compact) {
			const lines: string[] = [];
			this.drawCompact(lines, heading, group.rows, draw, frame, group);
			return lines;
		}
		const lines = [truncate(heading)];
		const rows = group.rows.slice(0, n);
		for (const [j, l] of rows.entries()) {
			const owner = l.kind === "run" ? draw.runOwners.get(l.run.id) : draw.owners.get(l.key);
			const branch = `${closed ? " " : "│"}    ${j === rows.length - 1 ? "└" : "├"} ${owner !== undefined ? `#${owner} ` : ""}`;
			this.drawLive(lines, l, branch, draw, frame, group.kind === "ask");
		}
		return lines;
	}

	/**
	 * Draw task rows and, for the tasks in `withRuns`, their live rows; any other task
	 * with live runs shows `· N runs`. `closed` means nothing follows, so the last
	 * task row takes `└─`.
	 */
	private drawTasks(
		entries: { task: Task; row?: PlanRow }[],
		withRuns: ReadonlySet<Task>,
		closed: boolean,
		draw: DrawContext,
		frame: Frame,
	): string[] {
		const { theme, truncate, live, showIds } = draw;
		const lines: string[] = [];
		for (const [i, { task, row }] of entries.entries()) {
			const { older } = draw.bound.get(task.id) ?? history(undefined);
			const rows = children(task, draw);
			const runs = runsOf(rows);
			const fits = !rows.length || withRuns.has(task);
			const last = closed && i === entries.length - 1;
			const display =
				fits && runs.some((r) => r.name === task.owner)
					? { ...task, owner: undefined }
					: task;
			const count = !fits && runs.length
				? ` · ${runs.length} ${t("run.count", "runs")}`
				: "";
			const taskLine = `${theme.fg("dim", last ? "└─" : "├─")} ${formatPlanTaskLine(display, theme, showIds, row)}${count}${older && live ? ` +${older}` : ""}`;
			if (fits && rows.length && draw.compact) {
				this.drawCompact(lines, taskLine, rows, draw, frame);
				continue;
			}
			lines.push(truncate(taskLine));
			if (!fits) continue;
			const indent = "  ".repeat(row?.depth ?? 0);
			for (const [j, l] of rows.entries())
				this.drawLive(lines, l, `${last ? " " : "│"}    ${indent}${j === rows.length - 1 ? "└" : "├"} `, draw, frame);
		}
		return lines;
	}

	/**
	 * Append a trailing blank line so the overlay isn't flush against the
	 * editor box. Pi's host adds a leading spacer above the widget but none
	 * below, which leaves the last "└─" row (or the "+N more" summary) glued
	 * to the input box. The empty string gives the "Todos" panel a little
	 * breathing room.
	 */
	private withTrailingSpacer(lines: string[]): string[] {
		if (lines.length === 0) return lines;
		lines.push("");
		return lines;
	}

	dispose(): void {
		this.finishFrame([]);
		if (this.uiCtx) this.uiCtx.setWidget(WIDGET_KEY, undefined);
		this.widgetRegistered = false;
		this.tui = undefined;
		this.uiCtx = undefined;
		this.state = undefined;
		this.resetCompletedDisplayState();
	}
}
