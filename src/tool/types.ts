import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

// ---------------------------------------------------------------------------
// Tool / command identity — verbatim string boundaries.
// Tool name "todo" is the persistence key for branch replay (filtering
// `toolResult.toolName === "todo"`) and the name agents and prompts call.
// DO NOT rename.
// ---------------------------------------------------------------------------

export const TOOL_NAME = "todo";
export const TOOL_LABEL = "Todo";
export const COMMAND_NAME = "todos";

/**
 * Custom session-entry type rpiv-todo wrote for every state-changing call,
 * carrying the call's `details`. This package writes `todo/v1` entries instead
 * (src/ledger/contract.ts) and reads these only to replay sessions started
 * under rpiv-todo.
 */
export const LEGACY_STATE_ENTRY_TYPE = "rpiv-todo-state";

// ---------------------------------------------------------------------------
// User-facing strings (kept stable for /todos UX parity).
// ---------------------------------------------------------------------------

export const ERR_REQUIRES_INTERACTIVE = "/todos requires interactive mode";
export const MSG_NO_TODOS = "No todos yet. Ask the agent to add some!";

// ---------------------------------------------------------------------------
// Public domain types
// ---------------------------------------------------------------------------

export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export type TaskAction = "create" | "update" | "list" | "get" | "delete" | "clear" | "import";

export type EvidenceResult = "pass" | "fail";

/** One recorded run of a check: what ran, on which revision, how it ended, and when. */
export interface Evidence {
	ref?: string;
	command: string;
	sha?: string;
	result: EvidenceResult;
	/** ISO 8601 timestamp. */
	at: string;
}

/** Evidence as a caller supplies it: `at` defaults to the time of the call. */
export interface EvidenceInput {
	ref?: string;
	command: string;
	sha?: string;
	result: EvidenceResult;
	at?: string;
}

/** The work graphs a plan can name (pi-straw-boss prompts/planning.md §1). */
export const GRAPHS = ["single-loop", "fan-out/fan-in", "orchestrator-worker"] as const;
export type Graph = (typeof GRAPHS)[number];
export const isGraph = (value: unknown): value is Graph =>
	typeof value === "string" && (GRAPHS as readonly string[]).includes(value);

/** Inclusive bounds of `Task.points`. */
export const POINTS_MIN = 0;
export const POINTS_MAX = 10;

export interface Task {
	uid?: string;
	origin?: { session: string };
	id: number;
	subject: string;
	description?: string;
	activeForm?: string;
	status: TaskStatus;
	blockedBy?: number[];
	owner?: string;
	metadata?: Record<string, unknown>;
	/** Effort estimate, a number from 0 to 10. */
	points?: number;
	/** The check that shows this task is done, e.g. a test command. */
	anchor?: string;
	/** The work graph of the plan this task belongs to. */
	graph?: Graph;
	/** Runs of checks, oldest first. Append-only. */
	evidence?: Evidence[];
}

/**
 * Persistence + replay snapshot. Every successful `todo` tool call returns this
 * shape under `details`; `state/replay.ts` reads the latest one from the branch
 * to reconstruct module state. Field order and field names are pinned by
 * cross-version replay compatibility.
 */
export interface TaskDetails {
	action: TaskAction;
	params: Record<string, unknown>;
	tasks: Task[];
	nextId: number;
	error?: string;
}

/**
 * Open-shape input bag the reducer accepts. Stays an interface so the index
 * signature (`[key: string]: unknown`) lets the runtime pass through TypeBox
 * `Static<typeof TodoParamsSchema>` without `as` casts.
 */
/** One item in a batch `create` `tasks[]` payload. Same create-shaped fields as a single create, minus nested `tasks`. */
export interface CreateTaskInput {
	subject: string;
	description?: string;
	activeForm?: string;
	blockedBy?: number[];
	owner?: string;
	metadata?: Record<string, unknown>;
	points?: number;
	anchor?: string;
	graph?: string;
	evidence?: EvidenceInput[];
}

export interface TaskMutationParams {
	[key: string]: unknown;
	subject?: string;
	description?: string;
	activeForm?: string;
	status?: TaskStatus;
	blockedBy?: number[];
	addBlockedBy?: number[];
	removeBlockedBy?: number[];
	owner?: string;
	metadata?: Record<string, unknown>;
	points?: number;
	anchor?: string;
	/** A graph name; `null` clears it on update. */
	graph?: string | null;
	evidence?: EvidenceInput[];
	id?: number;
	path?: string;
	includeDeleted?: boolean;
	/** Batch create items. One-of with `subject` on `create`. */
	tasks?: CreateTaskInput[];
}

// ---------------------------------------------------------------------------
// TypeBox parameter schema — every `description` doubles as LLM-facing prompt
// copy. Field order and wording are pinned by registration tests.
// ---------------------------------------------------------------------------

const PointsSchema = (description: string) =>
	Type.Number({ minimum: POINTS_MIN, maximum: POINTS_MAX, description });

const AnchorSchema = (description: string) => Type.String({ minLength: 1, description });

const EvidenceInputSchema = Type.Object({
	ref: Type.Optional(Type.String({ minLength: 1, maxLength: 64, pattern: "^\\S*$", description: "Run or child:<id>" })),
	command: Type.String({ minLength: 1, description: "The check that ran, e.g. 'npm test -- replay'" }),
	sha: Type.Optional(Type.String({ description: "Revision the check ran on, e.g. a git commit SHA" })),
	result: StringEnum(["pass", "fail"] as const, { description: "How the run ended" }),
	at: Type.Optional(Type.String({ description: "ISO 8601 time of the run. Default: now" })),
});

const EvidenceSchema = (description: string) => Type.Array(EvidenceInputSchema, { description });

const CreateTaskInputSchema = Type.Object({
	subject: Type.String({ description: "Task subject line" }),
	description: Type.Optional(Type.String({ description: "Long-form task description" })),
	activeForm: Type.Optional(
		Type.String({
			description: "Present-continuous spinner label shown while status is in_progress (e.g. 'writing tests')",
		}),
	),
	blockedBy: Type.Optional(
		Type.Array(Type.Number(), {
			description:
				"Existing task ids this item waits on. Cannot name another item in this same batch; create the prerequisite first, then the dependent with blockedBy.",
		}),
	),
	owner: Type.Optional(Type.String({ description: "Agent/owner assigned to this task" })),
	metadata: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), {
			description: "Arbitrary metadata",
		}),
	),
	points: Type.Optional(PointsSchema("Effort points, 0 to 10")),
	anchor: Type.Optional(AnchorSchema("The check that shows this task is done, e.g. a test command")),
	graph: Type.Optional(Type.String()),
	evidence: Type.Optional(EvidenceSchema("Check runs already recorded for this task")),
});

export const TodoParamsSchema = Type.Object({
	action: StringEnum(["create", "update", "list", "get", "delete", "clear", "import"] as const),
	path: Type.Optional(Type.String({ description: "Snapshot file (import only); relative to the session cwd" })),
	subject: Type.Optional(
		Type.String({
			description: "Task subject line (required for create unless tasks[] is set)",
		}),
	),
	description: Type.Optional(Type.String({ description: "Long-form task description" })),
	activeForm: Type.Optional(
		Type.String({
			description: "Present-continuous spinner label shown while status is in_progress (e.g. 'writing tests')",
		}),
	),
	status: Type.Optional(
		StringEnum(["pending", "in_progress", "completed", "deleted"] as const, {
			description:
				"Set this task's status (update): one of pending, in_progress, completed, deleted. When action is list, filters returned tasks by this status.",
		}),
	),
	blockedBy: Type.Optional(
		Type.Array(Type.Number(), {
			description: "Initial blockedBy ids (create only)",
		}),
	),
	addBlockedBy: Type.Optional(
		Type.Array(Type.Number(), {
			description: "Task ids to add to blockedBy (update only, additive merge)",
		}),
	),
	removeBlockedBy: Type.Optional(
		Type.Array(Type.Number(), {
			description: "Task ids to remove from blockedBy (update only, additive merge)",
		}),
	),
	owner: Type.Optional(Type.String({ description: "Agent/owner assigned to this task" })),
	metadata: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), {
			description: "Arbitrary metadata; pass null value for a key to delete that key on update",
		}),
	),
	points: Type.Optional(PointsSchema("Effort points, 0 to 10 (create or update; update replaces)")),
	anchor: Type.Optional(
		AnchorSchema(
			"The check that shows this task is done, e.g. a test command (create or update; update replaces)",
		),
	),
	graph: Type.Optional(
		Type.Union([Type.String(), Type.Null()], {
			description: "single-loop, fan-out/fan-in, or orchestrator-worker; null clears",
		}),
	),
	evidence: Type.Optional(
		EvidenceSchema(
			"Check runs to record: the initial list on create; on update, appended to the task's evidence (never replaced or removed)",
		),
	),
	id: Type.Optional(
		Type.Number({
			description: "Task id (required for update, get, delete)",
		}),
	),
	includeDeleted: Type.Optional(
		Type.Boolean({
			description: "If true, list action returns deleted (tombstoned) tasks as well. Default: false.",
		}),
	),
	tasks: Type.Optional(
		Type.Array(CreateTaskInputSchema, {
			description:
				"Batch create: independent tasks in one call, one-of with subject. The whole list is validated then committed together. Items cannot blockedBy each other; create the prerequisite first, then the dependent with blockedBy.",
		}),
	),
});

export type TodoParams = Static<typeof TodoParamsSchema>;
