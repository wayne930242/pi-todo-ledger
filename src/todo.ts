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
import { ABORTED, type FinishCall, refuse } from "./ledger/finish-call.ts";
import { runningGuard } from "./ledger/guards.ts";
import { readImport } from "./ledger/import-snapshot.ts";
import { formatStatusLabel, t } from "./state/i18n-bridge.ts";
import { selectTasksByStatus, selectTodoCounts, selectVisibleTasks } from "./state/selectors.ts";
import { applyTaskMutation, type ApplyResult } from "./state/state-reducer.ts";
import { withSessionLock } from "./state/session-lock.ts";
import { getRenderState, getState, sid } from "./state/store.ts";
import { prepareTodoArguments } from "./tool/normalize-params.ts";
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
import { formatPlanTaskLine, renderTodoCall, renderTodoResult } from "./view/format.ts";
import { planView } from "./view/plan.ts";

// English fallbacks for localized /todos section headers — the box-drawing
// decoration is part of the localized string so translators can adjust spacing.
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
	"Use import with a snapshot file path, or session (an earlier session's id), to restore a handed-over list into an empty session list.",
	"list hides tombstoned (deleted) tasks by default; pass includeDeleted:true to see them. Pass status to filter by a single status.",
	"Subject must be short and imperative (e.g. 'Research existing tool'); description is for long-form detail. activeForm is a present-continuous label shown while in_progress.",
	"Optional bookkeeping fields: points (effort, 0 to 10), anchor (the check that shows the task is done, e.g. a test command), and evidence (runs of checks, each {command, sha?, result: pass|fail, at?}). On update, points and anchor replace; evidence is appended, never replaced.",
	"When a task waits on something outside your control (a person, CI, a train, a release window), mark it with waitsOn (what it waits on) and, if known, until (ISO time); it shows ⏸ and reminders leave it alone while it waits. Clear it with waitsOn: null when the wait ends; completing the task clears it too.",
];

export function registerTodoTool(pi: ExtensionAPI, finish: FinishCall): void {
	const guidance = validateGuidanceFields(loadConfig().guidance);
	pi.registerTool({
		name: TOOL_NAME,
		label: TOOL_LABEL,
		description:
			"Manage a task list for tracking multi-step progress. Actions: create (new task, or several independent tasks at once via tasks[]), update (change status/fields/dependencies), list (all tasks, optionally filtered by status), get (single task details), delete (tombstone), clear (reset all), import (restore a snapshot file into an empty list). Status: pending → in_progress → completed, plus deleted tombstone. Use this to plan and track multi-step work like research, design, and implementation.",
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
				let result: ApplyResult;
				if (action === "import") {
					try {
						result = { state: await readImport(before, ctx.cwd, { path: input.path, session: input.session, self: sessionId }, signal), op: { kind: "import" } };
					} catch (error) {
						return refuse(action, input, before, signal?.aborted ? ABORTED : String(error instanceof Error ? error.message : error));
					}
				} else {
					result = applyTaskMutation(before, action, input);
				}
				return finish(sessionId, ctx.cwd, action, input, before, result, signal);
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
		description: "Show the current branch's plan by dependency, then its completed todos",
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
			const { completed } = selectTasksByStatus(state);
			const plan = planView(visible);
			const counts = selectTodoCounts(state);

			const header: string[] = [];
			if (counts.completed > 0) header.push(`${counts.completed}/${counts.total} ${formatStatusLabel("completed")}`);
			if (counts.inProgress > 0) header.push(`${counts.inProgress} ${formatStatusLabel("in_progress")}`);
			if (counts.pending > 0) header.push(`${counts.pending} ${formatStatusLabel("pending")}`);

			if (plan.sharedGraph) header.push(plan.sharedGraph);
			const lines = [header.join(" · ")];
			for (const task of plan.ordered) lines.push(`  ${formatPlanTaskLine(task, ctx.ui.theme, true, plan.rows.get(task.id))}`);
			if (completed.length) {
				lines.push(t("command.section.completed", SECTION_COMPLETED));
				for (const task of completed) lines.push(`  ${formatPlanTaskLine(task, ctx.ui.theme, true)}`);
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
