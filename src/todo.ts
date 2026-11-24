/**
 * todo tool + /todos command — thin registration shell (forked from rpiv-todo).
 *
 * Tool/command identity, schema, types, reducer, store, replay, response
 * envelope, selectors, and view formatters live in the layered modules under
 * `tool/`, `state/`, and `view/`. This file is the package-root registration
 * surface — it mirrors `packages/rpiv-ask-user-question/ask-user-question.ts`
 * which keeps the tool registration at the package root.
 *
 * Public re-exports below preserve the package-root import surface so that
 * `index.ts`, `todo-overlay.ts`, and the global `test/setup.ts` `beforeEach`
 * continue to import from `./todo.js`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, validateGuidanceFields } from "./config.ts";
import { CHANGED_EVENT, type GuardOp, SNAPSHOT_ENTRY_TYPE, toChangedEvent, toSnapshot } from "./ledger/contract.ts";
import { type GuardRegistry, runningGuard } from "./ledger/guards.ts";
import { changedTasks, type NamespaceRegistry } from "./ledger/namespaces.ts";
import { formatStatusLabel, t } from "./state/i18n-bridge.ts";
import { selectTasksByStatus, selectTodoCounts, selectVisibleTasks } from "./state/selectors.ts";
import { applyTaskMutation, changesState } from "./state/state-reducer.ts";
import { withSessionLock } from "./state/session-lock.ts";
import type { TaskState } from "./state/state.ts";
import { commitState, getRenderState, getState, sid } from "./state/store.ts";
import { prepareTodoArguments } from "./tool/normalize-params.ts";
import { buildToolResult } from "./tool/response-envelope.ts";
import {
	COMMAND_NAME,
	ERR_REQUIRES_INTERACTIVE,
	MSG_NO_TODOS,
	type TaskAction,
	type TaskMutationParams,
	TOOL_LABEL,
	TOOL_NAME,
	TodoParamsSchema,
} from "./tool/types.ts";
import { formatCommandTaskLine, renderTodoCall, renderTodoResult } from "./view/format.ts";

// English fallbacks for localized /todos section headers — the box-drawing
// decoration is part of the localized string so translators can adjust spacing.
const SECTION_PENDING = "── Pending ──";
const SECTION_IN_PROGRESS = "── In Progress ──";
const SECTION_COMPLETED = "── Completed ──";

// ---------------------------------------------------------------------------
// Public re-exports — existing consumers (overlay, tests, index.ts) keep
// importing from `./todo.js`. New code may opt into deeper imports.
// ---------------------------------------------------------------------------

export { isTransitionValid } from "./state/invariants.ts";
export { applyTaskMutation } from "./state/state-reducer.ts";
export { __resetState, getNextId, getTodos, setActiveRenderSession, sid } from "./state/store.ts";
export { deriveBlocks, detectCycle } from "./state/task-graph.ts";
export type { Task, TaskAction, TaskDetails, TaskStatus } from "./tool/types.ts";
export { TOOL_NAME } from "./tool/types.ts";

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export const DEFAULT_PROMPT_SNIPPET = "Manage a task list to track multi-step progress";
export const DEFAULT_PROMPT_GUIDELINES: string[] = [
	"Use `todo` for complex work with 3+ steps, when the user gives you a list of tasks, or immediately after receiving new instructions to capture requirements. Skip it for single trivial tasks and purely conversational requests.",
	"When starting a task from the todo list, mark it in_progress BEFORE beginning work. Mark it completed IMMEDIATELY when done — never batch completions. Exactly one task in_progress at a time.",
	"Never mark a task completed if tests are failing, the implementation is partial, or you hit unresolved errors — keep it in_progress and create a new task for the blocker instead.",
	"Task status is a 4-state machine: pending → in_progress → completed, plus deleted as a tombstone. Pass activeForm (present-continuous label, e.g. 'researching existing tool') when marking in_progress.",
	'To change a task\'s status, call update with the task id and the target status, e.g. {"action":"update","id":3,"status":"completed"} or {"action":"update","id":3,"status":"in_progress","activeForm":"writing tests"}. status is the field that changes the task; an update without a mutable field (status or another) is rejected.',
	"Use blockedBy to express dependencies (A is blocked by B). On create, pass blockedBy as the initial set. On update, use addBlockedBy / removeBlockedBy (additive merge — do not resend the full array). Cycles are rejected.",
	"To create several independent tasks at once, pass create with tasks: [{subject}, ...]. Do not also pass subject. tasks[] cannot blockedBy each other (ids do not exist until the call commits); create the prerequisite first, then the dependent with blockedBy. Dependency chains stay single-create.",
	"list hides tombstoned (deleted) tasks by default; pass includeDeleted:true to see them. Pass status to filter by a single status.",
	"Subject must be short and imperative (e.g. 'Research existing tool'); description is for long-form detail. activeForm is a present-continuous label shown while in_progress.",
	"Optional bookkeeping fields: points (effort, 0 to 10), anchor (the check that shows the task is done, e.g. a test command), and evidence (runs of checks, each {command, sha?, result: pass|fail, at?}). On update, points and anchor replace; evidence is appended, never replaced.",
];

const ABORTED = "call aborted; nothing changed";

/** An `isError` result for a refused call; the list is reported as it was. */
function refuse(action: TaskAction, input: TaskMutationParams, state: TaskState, message: string) {
	return { ...buildToolResult(action, input, state, { kind: "error", message }), isError: true };
}

export function registerTodoTool(pi: ExtensionAPI, namespaces: NamespaceRegistry, guards: GuardRegistry): void {
	const guidance = validateGuidanceFields(loadConfig().guidance);
	pi.registerTool({
		name: TOOL_NAME,
		label: TOOL_LABEL,
		description:
			"Manage a task list for tracking multi-step progress. Actions: create (new task, or several independent tasks at once via tasks[]), update (change status/fields/dependencies), list (all tasks, optionally filtered by status), get (single task details), delete (tombstone), clear (reset all). Status: pending → in_progress → completed, plus deleted tombstone. Use this to plan and track multi-step work like research, design, and implementation.",
		promptSnippet: guidance.promptSnippet ?? DEFAULT_PROMPT_SNIPPET,
		promptGuidelines: guidance.promptGuidelines ?? DEFAULT_PROMPT_GUIDELINES,
		parameters: TodoParamsSchema,
		// Undo a double-encoded tasks[] before Pi validates it (#244 shape).
		prepareArguments: prepareTodoArguments,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const sessionId = sid(ctx);
			// A guard reads `change.before` / `change.after`; calling `todo` for its own session would
			// wait on the queue its own call holds. Refuse at once, before queueing.
			const guardId = runningGuard(sessionId);
			if (guardId !== undefined) {
				const action = params.action as TaskAction;
				return refuse(action, params as TaskMutationParams, getState(sessionId), `todo called from inside guard ${guardId}`);
			}
			return withSessionLock(sessionId, async () => {
				const action = params.action as TaskAction;
				const input = params as TaskMutationParams;
				const before = getState(sessionId);
				// A call aborted while it waited in the queue, or while its guards ran, commits nothing.
				if (signal?.aborted) return refuse(action, input, before, ABORTED);
				const result = applyTaskMutation(before, action, input);
				const guardChange = {
					op: action as GuardOp,
					params: input as Record<string, unknown>,
					before: before.tasks,
					after: result.state.tasks,
					sessionId,
					cwd: ctx.cwd,
				};
				if (!changesState(result.op)) {
					// A valid update that changes nothing still reaches the guards (flagged `noop`):
					// re-asserting a status is how an agent reports it after a reload, and guards may
					// track it. It writes no snapshot and emits no event.
					if (result.op.kind === "update") {
						const refusal = await guards.check({ ...guardChange, noop: true });
						if (refusal) return refuse(action, input, before, refusal);
						if (signal?.aborted) return refuse(action, input, before, ABORTED);
					}
					commitState(sessionId, result.state);
					return buildToolResult(action, input, result.state, result.op);
				}
				// Namespace owners, then change guards, see the change before it commits; a refusal
				// leaves state untouched.
				const refusal =
					namespaces.check(changedTasks(result.op, input, result.state)) ?? (await guards.check(guardChange));
				if (refusal) return refuse(action, input, before, refusal);
				if (signal?.aborted) return refuse(action, input, before, ABORTED);
				// Persist the snapshot as a custom entry on the calling session's branch, however the
				// tool was reached: a call made through another tool (`ctx.executeTool`, e.g. codemode)
				// never lands as a standalone `toolResult`, so its `details` alone would not survive
				// replay. Pi's own codemode persists its `store()` the same way.
				// The entry is written before the live state commits: if appending throws, the call
				// fails with the list unchanged, so live state never runs ahead of the branch.
				pi.appendEntry(SNAPSHOT_ENTRY_TYPE, toSnapshot(result.state));
				commitState(sessionId, result.state);
				pi.events.emit(CHANGED_EVENT, toChangedEvent(sessionId, result.state));
				return buildToolResult(action, input, result.state, result.op);
			});
		},

		// renderCall reflects the FOREGROUND slot, not the calling session's. Pi's
		// `ToolRenderContext` carries no session identity (no sessionManager/sessionId),
		// so this ctx-less hook cannot re-key by caller. For the foreground session's
		// own transcript that is exactly right. A detached/child call rendered in the
		// lane-transcript viewer whose task lives only in the child's slot misses the
		// foreground lookup and falls back to `#<id>` (see renderTodoCall). That is the
		// safe outcome: per-session ids restart at 1, so searching sibling slots could
		// surface the WRONG subject — the `#<id>` fallback is intentional, not a gap.
		renderCall(args, theme, _context) {
			return renderTodoCall(args as never, theme, getRenderState());
		},

		renderResult(result, _opts, theme, context) {
			return renderTodoResult(result, theme, context?.isError);
		},
	});
}

// ---------------------------------------------------------------------------
// /todos slash command
// ---------------------------------------------------------------------------

export function registerTodosCommand(pi: ExtensionAPI): void {
	pi.registerCommand(COMMAND_NAME, {
		description: "Show all todos on the current branch, grouped by status",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify(t("command.requires_interactive", ERR_REQUIRES_INTERACTIVE), "error");
				return;
			}
			const state = getState(sid(ctx));
			const visible = selectVisibleTasks(state);
			if (visible.length === 0) {
				ctx.ui.notify(t("command.no_todos", MSG_NO_TODOS), "info");
				return;
			}
			const groups = selectTasksByStatus(state);
			const counts = selectTodoCounts(state);

			const header: string[] = [];
			if (counts.completed > 0) header.push(`${counts.completed}/${counts.total} ${formatStatusLabel("completed")}`);
			if (counts.inProgress > 0) header.push(`${counts.inProgress} ${formatStatusLabel("in_progress")}`);
			if (counts.pending > 0) header.push(`${counts.pending} ${formatStatusLabel("pending")}`);

			const lines: string[] = [header.join(" · ")];
			if (groups.pending.length > 0) {
				lines.push(t("command.section.pending", SECTION_PENDING));
				for (const task of groups.pending) lines.push(formatCommandTaskLine(task, "○"));
			}
			if (groups.inProgress.length > 0) {
				lines.push(t("command.section.in_progress", SECTION_IN_PROGRESS));
				for (const task of groups.inProgress) lines.push(formatCommandTaskLine(task, "◐"));
			}
			if (groups.completed.length > 0) {
				lines.push(t("command.section.completed", SECTION_COMPLETED));
				for (const task of groups.completed) lines.push(formatCommandTaskLine(task, "✓"));
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
