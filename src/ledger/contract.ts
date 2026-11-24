/**
 * The public bookkeeping contract (CONTRACT.md, schema/todo-v1.schema.json).
 *
 * Other extensions depend on these names and shapes, never on this package's
 * code: they read `todo/v1` entries from the session branch, listen for
 * `todo:changed`, and register metadata validators with `todo:namespace`.
 * Changing anything here is a breaking change of the contract version.
 */

import type { TaskState } from "../state/state.ts";
import type { Task } from "../tool/types.ts";

export const CONTRACT_VERSION = 1;

/** `customType` of the session entry carrying a snapshot after every change. */
export const SNAPSHOT_ENTRY_TYPE = "todo/v1";

/** Emitted on `pi.events` after every change and when a session's list is restored. */
export const CHANGED_EVENT = "todo:changed";

/** Emitted by other extensions on `pi.events` to register a metadata namespace validator. */
export const NAMESPACE_EVENT = "todo:namespace";

/**
 * Emitted by this extension on `pi.events` when it loads, so namespace owners
 * that loaded first register again.
 */
export const READY_EVENT = "todo:ready";

/** Data of a `todo/v1` session entry. */
export interface TodoSnapshotV1 {
	v: 1;
	tasks: Task[];
	nextId: number;
}

/** Payload of `todo:changed`. */
export interface TodoChangedEventV1 {
	v: 1;
	sessionId: string;
	tasks: Task[];
}

/** Payload of `todo:ready`. */
export interface TodoReadyEventV1 {
	v: 1;
}

/** The kind of change a namespace validator is asked about. */
export type NamespaceOp = "create" | "update" | "delete";

/**
 * Returns a refusal reason, or `undefined` to accept. `value` is
 * `task.metadata[ns]` after the change (`undefined` when the change removes it);
 * `task` is a copy of the task as it would be committed.
 */
export type NamespaceValidator = (value: unknown, task: Task, op: NamespaceOp) => string | undefined;

/** Payload of `todo:namespace`. */
export interface TodoNamespaceEventV1 {
	v: 1;
	ns: string;
	validate: NamespaceValidator;
}

/** Deep copy so listeners and entries never alias the live store. */
export function copyTasks(tasks: readonly Task[]): Task[] {
	return structuredClone(tasks) as Task[];
}

export function toSnapshot(state: TaskState): TodoSnapshotV1 {
	return { v: CONTRACT_VERSION, tasks: copyTasks(state.tasks), nextId: state.nextId };
}

export function toChangedEvent(sessionId: string, state: TaskState): TodoChangedEventV1 {
	return { v: CONTRACT_VERSION, sessionId, tasks: copyTasks(state.tasks) };
}
