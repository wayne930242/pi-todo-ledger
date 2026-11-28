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

export const DEFAULT_PROMPT_SNIPPET = "Track multi-step work in a task list";
export const DEFAULT_PROMPT_GUIDELINES: string[] = [
	"Use todo for work with 3+ steps, a user task list, or immediately on new instructions to capture requirements. Skip single trivial tasks and conversation.",
	"Mark one task in_progress before starting (with activeForm); mark it completed immediately when done, never in batches. With failing tests, partial work or unresolved errors, keep it in_progress and create a blocker task.",
	"Set status with update and id: pending → in_progress → completed; deleted is a tombstone. update needs a mutable field.",
	"For dependencies, create prerequisites first, then dependents with blockedBy. Update via addBlockedBy/removeBlockedBy, not a full set; cycles are rejected.",
	"On external waits (person, CI, train, release window), set waitsOn and, if known, until. End a wait early with waitsOn: null and until: null for the fields you set; a future until still holds the wait.",
];

export function registerTodoTool(pi: ExtensionAPI, finish: FinishCall): void {
	const guidance = validateGuidanceFields(loadConfig().guidance);
	pi.registerTool({
		name: TOOL_NAME,
		label: TOOL_LABEL,
		description: "Track a plan and its progress: create, update, list, get, delete (tombstone), clear (reset all), or import a handoff into an empty list.",
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
