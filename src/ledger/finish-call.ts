import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyTaskMutation, changesState, type ApplyResult } from "../state/state-reducer.ts";
import type { TaskState } from "../state/state.ts";
import { commitState, replaceState } from "../state/store.ts";
import { buildToolResult } from "../tool/response-envelope.ts";
import type { TaskAction, TaskMutationParams } from "../tool/types.ts";
import { CHANGED_EVENT, type GuardOp, SNAPSHOT_ENTRY_TYPE, toChangedEvent, toSnapshot } from "./contract.ts";
import type { GuardRegistry } from "./guards.ts";
import { changedTasks, type NamespaceRegistry } from "./namespaces.ts";

export const ABORTED = "call aborted; nothing changed";

export function refuse(action: TaskAction, input: TaskMutationParams, state: TaskState, message: string) {
	return { ...buildToolResult(action, input, state, { kind: "error", message }), isError: true };
}

/** Shared commit boundary for tool calls and acknowledged Herdr launches. Caller holds the session lock. */
export function makeFinishCall(pi: ExtensionAPI, namespaces: NamespaceRegistry, guards: GuardRegistry) {
	return async (sessionId: string, cwd: string, action: TaskAction, input: TaskMutationParams, before: TaskState, result: ApplyResult, signal?: AbortSignal) => {
		const guardChange = {
			op: action === "import" ? "create" as const : action as GuardOp,
			params: input, before: before.tasks, after: result.state.tasks, sessionId, cwd,
		};
		if (!changesState(result.op)) {
			// A valid no-op update reaches guards, but writes no entry and emits no event.
			if (result.op.kind === "update") {
				const refusal = await guards.check({ ...guardChange, noop: true });
				if (refusal) return refuse(action, input, before, refusal);
				if (signal?.aborted) return refuse(action, input, before, ABORTED);
			}
			commitState(sessionId, result.state);
			return buildToolResult(action, input, result.state, result.op);
		}
		const refusal = namespaces.check(changedTasks(result.op, input, result.state, before)) ?? (await guards.check(guardChange));
		if (refusal) return refuse(action, input, before, refusal);
		if (signal?.aborted) return refuse(action, input, before, ABORTED);
		// Append before committing the live slot; even nested tool calls survive replay, and a failed append changes nothing.
		pi.appendEntry(SNAPSHOT_ENTRY_TYPE, toSnapshot(result.state, sessionId));
		if (action === "clear") replaceState(sessionId, result.state);
		else commitState(sessionId, result.state);
		pi.events.emit(CHANGED_EVENT, toChangedEvent(sessionId, result.state));
		return buildToolResult(action, input, result.state, result.op);
	};
}

export type FinishCall = ReturnType<typeof makeFinishCall>;

/**
 * The ledger's own bookkeeping of something that already happened (a run's spend, herdr-spend.ts), committed in the same tick its caller read `before` from the
 * session's live branch: an `update` judged by the namespace validators, appended to the branch, then published. Change guards are not asked: they are awaited, and
 * a write that awaits can land on a branch the session switched to meanwhile (pi moves the leaf before its `session_tree` handlers run). Returns the refusal, if any.
 */
export function makeCommitNow(pi: ExtensionAPI, namespaces: NamespaceRegistry) {
	return (sessionId: string, input: TaskMutationParams, before: TaskState): string | undefined => {
		const result = applyTaskMutation(before, "update", input);
		if (result.op.kind === "error") return result.op.message;
		if (!changesState(result.op)) return undefined;
		const refusal = namespaces.check(changedTasks(result.op, input, result.state, before));
		if (refusal) return refusal;
		pi.appendEntry(SNAPSHOT_ENTRY_TYPE, toSnapshot(result.state, sessionId));
		commitState(sessionId, result.state);
		pi.events.emit(CHANGED_EVENT, toChangedEvent(sessionId, result.state));
		return undefined;
	};
}

export type CommitNow = ReturnType<typeof makeCommitNow>;
