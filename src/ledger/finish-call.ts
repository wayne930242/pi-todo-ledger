import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { changesState, type ApplyResult } from "../state/state-reducer.ts";
import type { TaskState } from "../state/state.ts";
import { commitState } from "../state/store.ts";
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
		const refusal = namespaces.check(changedTasks(result.op, input, result.state)) ?? (await guards.check(guardChange));
		if (refusal) return refuse(action, input, before, refusal);
		if (signal?.aborted) return refuse(action, input, before, ABORTED);
		// Append before committing the live slot; even nested tool calls survive replay, and a failed append changes nothing.
		pi.appendEntry(SNAPSHOT_ENTRY_TYPE, toSnapshot(result.state, sessionId));
		commitState(sessionId, result.state);
		pi.events.emit(CHANGED_EVENT, toChangedEvent(sessionId, result.state));
		return buildToolResult(action, input, result.state, result.op);
	};
}

export type FinishCall = ReturnType<typeof makeFinishCall>;
