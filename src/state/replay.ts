import { SNAPSHOT_ENTRY_TYPE } from "../ledger/contract.ts";
import { isSnapshotV1 } from "../ledger/schema.ts";
import { LEGACY_STATE_ENTRY_TYPE, type Task, type TaskDetails, type TaskStatus, TOOL_NAME } from "../tool/types.ts";
import { EMPTY_STATE, type TaskState } from "./state.ts";
import { withLegacyGraph } from "./state-reducer.ts";

const TASK_STATUSES: ReadonlySet<unknown> = new Set<TaskStatus>(["pending", "in_progress", "completed", "deleted"]);

const optional = (value: unknown, valid: (v: unknown) => boolean): boolean => value === undefined || valid(value);
const isString = (v: unknown): boolean => typeof v === "string";

function isTask(value: unknown): value is Task {
	if (!value || typeof value !== "object") return false;
	const t = value as Record<string, unknown>;
	return (
		Number.isSafeInteger(t.id) &&
		typeof t.subject === "string" &&
		TASK_STATUSES.has(t.status) &&
		optional(t.description, isString) &&
		optional(t.activeForm, isString) &&
		optional(t.owner, isString) &&
		optional(t.blockedBy, (v) => Array.isArray(v) && v.every((id) => Number.isSafeInteger(id))) &&
		optional(t.metadata, (v) => typeof v === "object" && v !== null)
	);
}

/**
 * Legacy records only (`rpiv-todo-state` entries and `todo` tool results), with
 * rpiv-todo's own rules; `todo/v1` data is checked against the published schema
 * by `isSnapshotV1`. Discriminator for `details` envelopes that match the
 * persisted `TaskDetails` shape, down to every task. Defensive — a snapshot from an older or corrupt
 * session (e.g. a `tasks[]` another extension truncated with a marker string)
 * is skipped whole, so replay keeps the last valid one.
 */
export function isTaskDetails(value: unknown): value is TaskDetails {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return Array.isArray(v.tasks) && v.tasks.every(isTask) && Number.isSafeInteger(v.nextId);
}

/** Fresh `TaskState` from a persisted snapshot — deep-copies the tasks so replay never aliases branch data. */
function stateOf(details: { tasks: Task[]; nextId: number }): TaskState {
	return { tasks: structuredClone(details.tasks).map(withLegacyGraph), nextId: details.nextId };
}

/**
 * Walk the current branch in chronological order and return the last persisted
 * snapshot (last-write-wins within a source). Sources, in order of authority:
 *
 * 1. `custom` entries of type `"todo/v1"` — the public snapshot this package
 *    writes for every state-changing call (CONTRACT.md).
 * 2. `custom` entries of type `"rpiv-todo-state"` — written by rpiv-todo before
 *    this fork; read so a session started under rpiv-todo keeps its list.
 * 3. `toolResult` messages with `toolName === "todo"` — the `details` envelope,
 *    the only record in sessions older than either entry type.
 *
 * A higher source, once present, wins even when a lower one appears later on
 * the branch: entries are appended at commit time for every change, so a lower
 * source can only repeat or predate them. Invalid snapshots are skipped whole.
 * When no source exists, returns `EMPTY_STATE`.
 *
 * Pure of module state — `index.ts` writes the returned snapshot into the
 * store after this returns.
 */
export function replayFromBranch(ctx: { sessionManager: { getBranch(): Iterable<unknown> } }): TaskState {
	let fromV1: TaskState | undefined;
	let fromLegacyEntries: TaskState | undefined;
	let fromToolResults: TaskState | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		const e = entry as {
			type?: string;
			customType?: string;
			data?: unknown;
			message?: { role?: string; toolName?: string; details?: unknown };
		};
		if (e.type === "custom") {
			if (e.customType === SNAPSHOT_ENTRY_TYPE && isSnapshotV1(e.data)) fromV1 = stateOf(e.data);
			else if (e.customType === LEGACY_STATE_ENTRY_TYPE && isTaskDetails(e.data)) {
				fromLegacyEntries = stateOf(e.data);
			}
			continue;
		}
		if (e.type !== "message") continue;
		const msg = e.message;
		if (msg?.role !== "toolResult" || msg.toolName !== TOOL_NAME) continue;
		if (!isTaskDetails(msg.details)) continue;
		fromToolResults = stateOf(msg.details);
	}
	return (
		fromV1 ?? fromLegacyEntries ?? fromToolResults ?? { tasks: [...EMPTY_STATE.tasks], nextId: EMPTY_STATE.nextId }
	);
}

/**
 * The list the session's live branch holds now, as `replayFromBranch` reads it, from its newest valid `todo/v1` snapshot when there is one (a walk back from the
 * leaf, which validates that one snapshot only). A writer that must commit onto the branch pi is on at this moment reads this, not the live slot: pi moves the leaf
 * before its `session_tree` handlers replay the slot.
 */
export function listOnBranch(ctx: { sessionManager: { getBranch(): Iterable<unknown> } }): TaskState {
	const branch = Array.from(ctx.sessionManager.getBranch());
	for (let i = branch.length - 1; i >= 0; i--) {
		const e = branch[i] as { type?: string; customType?: string; data?: unknown };
		if (e?.type === "custom" && e.customType === SNAPSHOT_ENTRY_TYPE && isSnapshotV1(e.data)) return stateOf(e.data);
	}
	return replayFromBranch({ sessionManager: { getBranch: () => branch } });
}
