/**
 * todo-overlay.ts — Persistent widget showing todo list above the editor.
 *
 * Lifecycle controller for Pi's `setWidget` contract: factory-form
 * registration in widgetContainerAbove, register-once + requestRender()
 * refresh, configurable collapse-not-scroll (default 12 content rows via
 * getMaxWidgetLines(); plus a trailing spacer row so the widget renders up
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
import { planView } from "./view/plan.ts";

import { history } from "./ledger/herdr-runs.ts";
import { liveRows, runLine, type Query } from "./view/live-runs.ts";

const WIDGET_KEY = "rpiv-todos";

// English fallbacks for localized overlay chrome strings.
const OVERLAY_HEADING = "Todos";
const OVERLAY_MORE = "more";
const OVERLAY_EXPAND_HINT = "{key} to expand";
const OVERLAY_COLLAPSED = "collapsed";

export class TodoOverlay {
	private uiCtx: ExtensionUIContext | undefined;
	private widgetRegistered = false;
	private tui: TUI | undefined;
	private completedTaskIdsPendingHide = new Set<number>();
	private hiddenCompletedTaskIds = new Set<number>();
	private lastNextId: number | undefined;
	private collapsed = false;

	private previous: string[] = [];
	private claimed = false;
	private tick?: ReturnType<typeof setInterval>;
	private query?: Query;
	constructor(query?: Query) {
		this.query = query;
	}

	private sendClaim(ids: string[]) {
		// An empty claim is a release; send it only to retract an earlier claim.
		if (!ids.length && !this.claimed) return;
		this.claimed = ids.length > 0;
		try {
			this.query?.({ claim: { by: "pi-todo-ledger", ids } });
		} catch {
			/* host lease expires */
		}
	}

	/**
	 * Whether a drawn line reaches the screen. Pi's regular (inline) renderer
	 * writes every widget line; the fullscreen layout may clip the widget after
	 * render() returns, which the widget cannot observe, so it gives no evidence.
	 */
	private linesReachScreen(): boolean {
		return (this.tui as { mode?: string } | undefined)?.mode === "regular";
	}

	private finishFrame(ids: string[], ticking = ids.length > 0) {
		// Only renew claims for children visible on both this and the preceding frame.
		this.sendClaim(this.previous.filter((id) => ids.includes(id)));
		this.previous = ids;
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

	toggleCollapse(): void {
		this.collapsed = !this.collapsed;
		// Release before the redraw: the host may draw its widget first in that frame.
		if (this.collapsed) this.finishFrame([]);
		// Forced full redraw on the collapsed↔expanded height step, mirroring the
		// lane-dock's requestRender(shapeChanged); distinct from the non-forced
		// requestRender() refresh paths in update()/hideCompletedTasksFromPreviousTurn().
		this.tui?.requestRender(true);
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
			hasRuns && !this.collapsed ? liveRows(this.query) : undefined;

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

		// Collapsed view: just the heading + a dim "└─" expand hint, then the
		// trailing spacer. Short-circuit before the budget math and the completed-
		// display tracking — nothing is shown to track, and skipping the tracking
		// when nothing is rendered is correctness, not optimization. The hint splices
		// the resolved key into the {key} placeholder (per-render, like the row
		// budget); a config edit needs /reload to re-bind the actual shortcut. The
		// "off" sentinel is reachable here mid-session (config edited after the
		// shortcut was bound and the overlay collapsed) — render a static collapsed
		// label instead of splicing the sentinel into the placeholder.
		if (this.collapsed) {
			this.finishFrame([]);
			const key = resolveCollapseKey();
			const hint =
				key === COLLAPSE_KEY_OFF
					? t("overlay.collapsed", OVERLAY_COLLAPSED)
					: t("overlay.expandHint", OVERLAY_EXPAND_HINT).replace("{key}", key);
			return this.withTrailingSpacer([
				heading,
				truncate(`${theme.fg("dim", "└─")} ${theme.fg("dim", hint)}`),
			]);
		}

		const lines: string[] = [heading];
		// Budget for content rows (heading + tasks/summary). The rendered widget is
		// one line taller — withTrailingSpacer() appends a blank row below the panel.
		// Pi's global tool-output expansion mode is read on every render so its
		// expand/collapse shortcut also expands this live widget. Optional chaining
		// preserves compatibility with hosts predating getToolsExpanded().
		const bodyBudget =
			this.uiCtx?.getToolsExpanded?.() === true
				? Infinity
				: getMaxWidgetLines() - 1;
		const layout = selectOverlayLayout(overlayState, bodyBudget);
		const overflow = layout.hiddenCompleted + layout.truncatedTail;
		let spare = bodyBudget - layout.visible.length - Number(overflow > 0);
		const drawn: string[] = [];
		let ticking = false;
		const now = Date.now();
		const evidence = this.linesReachScreen();
		for (const [i, task] of layout.visible.entries()) {
			const { runs, older } = bound.get(task.id) ?? history(undefined);
			const children = runs.flatMap((r) => live?.get(r.id) ?? []);
			const fits = children.length <= spare;
			const last = !overflow && i === layout.visible.length - 1;
			const row = plan.rows.get(task.id);
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
				const childLine = theme.fg(
					"dim",
					`${last ? " " : "│"}    ${indent}${j === children.length - 1 ? "└" : "├"} ${runLine(r, now)}`,
				);
				const visibleLine = truncate(childLine);
				lines.push(visibleLine);
				ticking = true;
				if (evidence && visibleWidth(childLine) <= width) drawn.push(r.id);
			}
		}
		this.finishFrame(drawn, ticking);

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

		if (layout.hiddenCompleted === 0 && layout.truncatedTail === 0) {
			return this.withTrailingSpacer(lines);
		}

		const totalHidden = layout.hiddenCompleted + layout.truncatedTail;
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
				? `+${totalHidden} ${more} (${overflowParts.join(", ")})`
				: `+${totalHidden} ${more}`;
		lines.push(
			truncate(`${theme.fg("dim", "└─")} ${theme.fg("dim", summary)}`),
		);
		return this.withTrailingSpacer(lines);
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
		this.collapsed = false;
		this.resetCompletedDisplayState();
	}
}
