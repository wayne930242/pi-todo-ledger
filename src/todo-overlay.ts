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
import { formatStatusLabel, t } from "./state/i18n-bridge.ts";
import {
	selectHasActive,
	selectOverlayLayout,
	selectShowTaskIds,
	selectTodoCounts,
} from "./state/selectors.ts";
import { getRenderState } from "./state/store.ts";
import { formatPlanTaskLine } from "./view/format.ts";
import { type PlanRow, planView } from "./view/plan.ts";
import type { Task } from "./tool/types.ts";

import { history } from "./ledger/herdr-runs.ts";
import { liveRows, runLine, runState, type Query, type RunRow } from "./view/live-runs.ts";

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

/** What one frame's row drawing needs, shared by the full and focus views. */
interface DrawContext {
	theme: Theme;
	width: number;
	truncate: (line: string) => string;
	bound: Map<number, ReturnType<typeof history>>;
	live: ReturnType<typeof liveRows>;
	showIds: boolean;
	now: number;
	evidence: "inline" | "screen" | undefined;
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
	constructor(query?: Query) {
		this.query = query;
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

		if (visible.length === 0) {
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
		if (overlayTasks.length === 0) {
			this.finishFrame([]);
			return [];
		}
		const bound = new Map(
			overlayTasks.map((t) => [t.id, history(t.metadata?.herdr)] as const),
		);
		const hasRuns = [...bound.values()].some((h) => h.runs.length > 0);
		// Ask the host only when some todo has bound runs and the tree is shown.
		const live =
			hasRuns && this.current() !== "collapsed" ? liveRows(this.query) : undefined;

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
		const showIds = !!live?.size || selectShowTaskIds(overlayState);

		const headingColor = hasActive ? "accent" : "dim";
		const headingIcon = hasActive ? "●" : "○";
		const headingText = `${t("overlay.heading", OVERLAY_HEADING)} (${counts.completed}/${counts.total})`;
		const graph = plan.sharedGraph
			? ` · ${theme.fg("dim", hasRuns && plan.sharedGraph === "fan-out/fan-in" ? "fan-out" : plan.sharedGraph)}`
			: "";
		const heading = truncate(
			`${theme.fg(headingColor, headingIcon)} ${theme.fg(headingColor, headingText)}${graph}`,
		);

		// Collapsed view: just the heading + a dim "└─" hint naming the next state,
		// then the trailing spacer. Short-circuit before the budget math and the
		// completed-display tracking — nothing is shown to track, and skipping the
		// tracking when nothing is rendered is correctness, not optimization. The
		// "off" sentinel is reachable here mid-session (config edited after the
		// shortcut was bound and the overlay collapsed) — render a static collapsed
		// label instead of advertising an unbound key.
		if (this.current() === "collapsed") {
			this.finishFrame([]);
			const hint = this.keyHint() ?? t("overlay.collapsed", OVERLAY_COLLAPSED);
			return this.withTrailingSpacer([
				heading,
				truncate(`${theme.fg("dim", "└─")} ${theme.fg("dim", hint)}`),
			]);
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
		const draw: DrawContext = {
			theme,
			width,
			truncate,
			bound,
			live,
			showIds,
			now: Date.now(),
			evidence: this.evidence(),
		};
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

	/** The whole dependency tree, budgeted by selectOverlayLayout (the `"full"` view). */
	private fullBody(
		overlayState: { tasks: Task[]; nextId: number },
		plan: ReturnType<typeof planView>,
		bodyBudget: number,
		draw: DrawContext,
	): string[] {
		const layout = selectOverlayLayout(overlayState, bodyBudget);
		const overflow = layout.hiddenCompleted + layout.truncatedTail;
		const hint = this.keyHint();
		// With nothing to summarize, the hint takes its own row only when one is spare.
		const needed = layout.visible.reduce((n, task) => n + 1 + this.children(task, draw).length, 0);
		const hintRow = overflow === 0 && hint !== undefined && needed < bodyBudget;
		const spare = bodyBudget - layout.visible.length - Number(overflow > 0 || hintRow);
		const lines = this.drawTasks(
			layout.visible.map((task) => ({ task, row: plan.rows.get(task.id) })),
			spare,
			overflow === 0 && !hintRow,
			draw,
		);
		if (hintRow) lines.push(this.closingRow(draw, undefined, hint));
		if (overflow === 0) return lines;

		const overflowParts: string[] = [];
		if (layout.hiddenCompleted > 0)
			overflowParts.push(
				`${layout.hiddenCompleted} ${formatStatusLabel("completed")}`,
			);
		if (layout.truncatedTail > 0)
			overflowParts.push(
				`${layout.truncatedTail} ${formatStatusLabel("pending")}`,
			);
		const more = t("overlay.more", OVERLAY_MORE);
		const summary =
			overflowParts.length > 0
				? `+${overflow} ${more} (${overflowParts.join(", ")})`
				: `+${overflow} ${more}`;
		lines.push(this.closingRow(draw, summary, hint));
		return lines;
	}

	/**
	 * The focus view (default): in-progress tasks with their runs, the next open
	 * tasks (two, or three when nothing is in progress), then this turn's completed
	 * rows if room is left, and one summary row counting whatever is hidden. Rows are
	 * flat, so every unfinished blocker goes to the `⛓` tail.
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

		// Task rows first, in priority order; runs take the spare rows in display order;
		// completed rows get what is left. The summary row is reserved only when needed.
		const fit = (slots: number) => {
			const core = [...inProgress, ...next].slice(0, slots);
			let spare = slots - core.length;
			for (const task of core) {
				const n = this.children(task, draw).length;
				if (n <= spare) spare -= n;
			}
			const done = completed.slice(0, spare);
			return { core, done, spare: slots - core.length - done.length, left: spare - done.length };
		};
		let shown = fit(bodyBudget);
		let summarized = shown.core.length + shown.done.length < total;
		if (summarized) shown = fit(bodyBudget - 1);
		// With nothing to summarize, the hint takes its own row only when one is spare;
		// one row less leaves the same layout then.
		const hint = this.keyHint();
		const hintRow = !summarized && hint !== undefined && shown.left > 0;
		if (hintRow) shown = { ...shown, spare: shown.spare - 1 };

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
		const lines = this.drawTasks(
			[...shown.core, ...shown.done].map((task) => ({ task, row: flat(task) })),
			shown.spare,
			!summarized && !hintRow,
			draw,
		);
		if (hintRow) lines.push(this.closingRow(draw, undefined, hint));
		if (!summarized) return lines;

		const isShown = new Set([...shown.core, ...shown.done]);
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
		const summary = `+${parts.join(t("overlay.separator", OVERLAY_SEPARATOR))}`;
		lines.push(this.closingRow(draw, summary, hint));
		return lines;
	}

	/** Live run rows bound to a task (empty when the host gave no rows). */
	private children(task: Task, draw: DrawContext): RunRow[] {
		const { runs } = draw.bound.get(task.id) ?? history(undefined);
		return runs.flatMap((r) => draw.live?.get(r.id) ?? []);
	}

	/**
	 * Draw task rows and, where `spare` rows remain, their run rows; a task whose
	 * runs do not fit shows `· N runs`. Ends the frame's claim bookkeeping. `closed`
	 * means no summary row follows, so the last task row takes `└─`.
	 */
	private drawTasks(
		entries: { task: Task; row?: PlanRow }[],
		spare: number,
		closed: boolean,
		draw: DrawContext,
	): string[] {
		const { theme, width, truncate, live, showIds, now, evidence } = draw;
		const lines: string[] = [];
		const drawn: string[] = [];
		let ticking = false;
		const marked = new Map<string, string>();
		for (const [i, { task, row }] of entries.entries()) {
			const { older } = draw.bound.get(task.id) ?? history(undefined);
			const children = this.children(task, draw);
			const fits = children.length <= spare;
			const last = closed && i === entries.length - 1;
			const display =
				fits && children.some((r) => r.name === task.owner)
					? { ...task, owner: undefined }
					: task;
			const count = !fits
				? ` · ${children.length} ${t("run.count", "runs")}`
				: "";
			lines.push(
				truncate(
					`${theme.fg("dim", last ? "└─" : "├─")} ${formatPlanTaskLine(display, theme, showIds, row)}${count}${older && live ? ` +${older}` : ""}`,
				),
			);
			if (!fits) continue;
			spare -= children.length;
			for (const [j, r] of children.entries()) {
				const indent = "  ".repeat(row?.depth ?? 0);
				const branch = `${last ? " " : "│"}    ${indent}${j === children.length - 1 ? "└" : "├"} `;
				// A run waiting for a reply stands out; idle and running rows stay dim. The tree stays dim.
				const childLine =
					runState(r) === "waiting"
						? theme.fg("dim", branch) + theme.fg("warning", runLine(r, now))
						: theme.fg("dim", branch + runLine(r, now));
				const whole = visibleWidth(childLine) <= width;
				ticking = true;
				// Only a row shown in full is claimed; a truncated one carries no marker.
				if (whole && evidence === "screen") {
					const line = childLine + this.marker(r.id);
					marked.set(r.id, line);
					lines.push(line);
				} else {
					lines.push(truncate(childLine));
					if (whole && evidence === "inline") drawn.push(r.id);
				}
			}
		}
		this.finishFrame(drawn, ticking, marked);
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
