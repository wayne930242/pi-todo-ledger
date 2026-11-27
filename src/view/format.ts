import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { formatStatusLabel } from "../state/i18n-bridge.ts";
import { selectTaskSubjectById } from "../state/selectors.ts";
import type { TaskState } from "../state/state.ts";
import { sanitizeTerminalText } from "../tool/sanitize.ts";
import type { Task, TaskAction, TaskDetails, TaskMutationParams, TaskStatus } from "../tool/types.ts";
import type { PlanRow } from "./plan.ts";
import { uidSuffix, waitingLabel } from "./task-labels.ts";

// Re-export so legacy import paths (todo.ts, tests) continue to resolve;
// the canonical definition lives in the i18n bridge.
export { formatStatusLabel };

// ---------------------------------------------------------------------------
// Status presentation tables — the single source of truth for glyph/color.
// ---------------------------------------------------------------------------

export const STATUS_GLYPH: Record<TaskStatus, string> = {
	pending: "○",
	in_progress: "◐",
	completed: "●",
	deleted: "⊘",
};

/**
 * Color palette for the renderResult status echo. `deleted` uses `muted` so a
 * successful delete is visually distinct from the error branch (which uses
 * `error` + `✗`).
 */
export const STATUS_COLOR: Record<TaskStatus, "dim" | "warning" | "success" | "muted"> = {
	pending: "dim",
	in_progress: "warning",
	completed: "success",
	deleted: "muted",
};

/**
 * Per-action prefix glyph for renderCall. `+` create, `→` update, `×` delete,
 * `›` get, `☰` list, `∅` clear.
 */
export const ACTION_GLYPH: Record<TaskAction, string> = {
	create: "+",
	update: "→",
	delete: "×",
	get: "›",
	list: "☰",
	clear: "∅",
	import: "↓",
};

/**
 * Glyph for the persistent overlay's per-task row. Differs from `STATUS_GLYPH`
 * for `completed` (`✓` vs `●`) and `deleted` (`✗` vs `⊘`) because the
 * overlay caller never renders a `deleted` row but uses `✗` in its
 * error-toned palette.
 */
export function overlayStatusGlyph(status: TaskStatus, theme: Theme): string {
	switch (status) {
		case "pending":
			return theme.fg("dim", "○");
		case "in_progress":
			return theme.fg("warning", "◐");
		case "completed":
			return theme.fg("success", "✓");
		case "deleted":
			return theme.fg("error", "✗");
	}
}

/**
 * Format a task row for the overlay or /todos. The subject color
 * reflects task state while IDs and supporting metadata stay visually quiet.
 */
export function formatPlanTaskLine(t: Task, theme: Theme, showId: boolean, row?: PlanRow): string {
	const wait = waitingLabel(t);
	const glyph = wait ? theme.fg("warning", "⏸") : overlayStatusGlyph(t.status, theme);
	const subjectColor =
		t.status === "in_progress" ? "accent" : t.status === "completed" || t.status === "deleted" ? "muted" : "text";
	let subject = theme.fg(subjectColor, sanitizeTerminalText(t.subject));
	if (t.status === "completed" || t.status === "deleted") {
		subject = theme.strikethrough(subject);
	}
	let line = `${"  ".repeat(row?.depth ?? 0)}${glyph}`;
	if (showId) line += ` ${theme.fg("dim", `#${t.id}`)}`;
	line += ` ${subject}`;
	if (t.owner) line += ` ${theme.fg("muted", `@${sanitizeTerminalText(t.owner)}`)}`;
	if (wait) line += ` ${theme.fg("muted", wait)}`;
	if (t.status === "in_progress" && t.activeForm) {
		line += ` ${theme.fg("muted", `(${sanitizeTerminalText(t.activeForm)})`)}`;
	}
	if (row?.graph) line += ` ${theme.fg("dim", row.graph)}`;
	if (row?.resumeParent !== undefined) line += ` ${theme.fg("dim", `↳ #${row.resumeParent}`)}`;
	const blockers = row?.otherBlockers ?? t.blockedBy;
	if (blockers?.length) line += ` ${theme.fg("muted", `⛓ ${blockers.map(id => `#${id}`).join(",")}`)}`;
	return line;
}

// ---------------------------------------------------------------------------
// Tool render hooks — wrapped so `todo.ts` becomes a thin call-site.
// ---------------------------------------------------------------------------

/**
 * `renderCall` body. Receives the call's args, the theme, and the live
 * `TaskState` (resolved by the caller via `getRenderState()`). The args may
 * still be streaming or may fail validation, so `action` can be absent.
 */
export function renderTodoCall(
	args: TaskMutationParams & { action?: TaskAction },
	theme: Theme,
	state: TaskState,
): Text {
	let text = theme.fg("toolTitle", theme.bold("todo "));
	if (args.action) text += theme.fg("muted", ACTION_GLYPH[args.action] ?? args.action);

	if (args.action === "import" && args.path) {
		text += ` ${theme.fg("dim", sanitizeTerminalText(args.path))}`;
	} else if (args.action === "create" && args.subject) {
		text += ` ${theme.fg("dim", sanitizeTerminalText(args.subject))}`;
	} else if (args.action === "create" && Array.isArray(args.tasks)) {
		text += ` ${theme.fg("dim", `${args.tasks.length} tasks`)}`;
	} else if (
		(args.action === "update" || args.action === "get" || args.action === "delete") &&
		args.id !== undefined
	) {
		const subject = selectTaskSubjectById(state, args.id);
		text += ` ${theme.fg("accent", subject ? sanitizeTerminalText(subject) : `#${args.id}`)}`;
	} else if (args.action === "list" && args.status) {
		text += ` ${theme.fg("muted", formatStatusLabel(args.status))}`;
	}
	return new Text(text, 0, 0);
}

/**
 * A refusal renders its reason. Task results show only the affected or requested
 * rows; operations with no rows keep the short success mark.
 */
export function renderTodoResult(result: ToolResultView, theme: Theme, isError = false): Text {
	const failure = failureReason(result, isError);
	if (failure !== undefined) return new Text(theme.fg("error", failure ? `✗ ${failure}` : "✗"), 0, 0);

	const details = result.details as TaskDetails | undefined;
	const tasks = echoedTasks(details);
	if (tasks.length) {
		const rows = tasks.map(task => {
			const wait = waitingLabel(task);
			const label = wait ? `⏸ ${wait}` : `${STATUS_GLYPH[task.status]} ${formatStatusLabel(task.status)}`;
			const subject = details?.action === "list" || tasks.length > 1 ? ` ${sanitizeTerminalText(task.subject)}` : "";
			return `${theme.fg(wait ? "warning" : STATUS_COLOR[task.status], label)} #${task.id}${subject}${theme.fg("dim", uidSuffix(task))}`;
		});
		return new Text(rows.join("\n"), 0, 0);
	}
	return new Text(theme.fg("success", "✓"), 0, 0);
}

type ToolResultView = { content?: Array<{ type: string; text?: string }>; details?: unknown };

/**
 * First line of the failure message, or `undefined` when the call succeeded.
 * The reducer reports through `details.error`; Pi rejects a call before execute
 * with `isError` and the message as text content.
 */
function failureReason(result: ToolResultView, isError: boolean): string | undefined {
	const reducerError = (result.details as TaskDetails | undefined)?.error;
	if (!isError && !reducerError) return undefined;
	const message = reducerError ?? result.content?.find((c) => c.type === "text")?.text ?? "";
	return sanitizeTerminalText(message.split("\n")[0]);
}

/** Use the result's snapshot, not the live slot: a historic card belongs to its own call. */
function echoedTasks(details?: TaskDetails): Task[] {
	if (!details?.tasks || !details.params) return [];
	const params = details.params as TaskMutationParams;
	switch (details.action) {
		case "create": return details.tasks.slice(-(params.tasks?.length ?? 1));
		case "get":
		case "update":
		case "delete": return details.tasks.filter(t => t.id === params.id);
		case "list": return details.tasks.filter(t => (params.includeDeleted || t.status !== "deleted") && (!params.status || t.status === params.status));
		default: return [];
	}
}
