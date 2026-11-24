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

/** Emitted by other extensions on `pi.events` to register a change guard. */
export const GUARD_EVENT = "todo:guard";

/**
 * Emitted by this extension on `pi.events` when it loads, so namespace and
 * guard owners that loaded first register again.
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

/** The `todo` actions that change the list, i.e. the calls a guard sees. */
export type GuardOp = "create" | "update" | "delete" | "clear";

/** What a guard is asked to judge: one call that would change the list. */
export interface TodoChangeV1 {
	op: GuardOp;
	/** The call's arguments, as the tool received them. */
	params: Record<string, unknown>;
	/** The whole list before the call. */
	before: Task[];
	/** The whole list as the call would commit it. */
	after: Task[];
	sessionId: string;
	cwd: string;
	/** Present on a valid `update` that changes nothing; `before` equals `after`. */
	noop?: true;
}

/** Returns, or resolves to, a refusal reason, or `undefined` to accept. */
export type GuardCheck = (change: TodoChangeV1) => string | undefined | Promise<string | undefined>;

/** Payload of `todo:guard`. */
export interface TodoGuardEventV1 {
	v: 1;
	id: string;
	check: GuardCheck;
}

/** How long a guard may take before its call is refused. */
export const GUARD_TIMEOUT_MS = 10_000;

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
