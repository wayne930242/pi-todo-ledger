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
	waitsOn?: string;
	until?: string;
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
	/** What the task waits on, stored as `metadata.waitsOn`; `null` clears it on update. */
	waitsOn?: string | null;
	/** An ISO time the task waits until, stored as `metadata.until`; `null` clears it on update. */
	until?: string | null;
	id?: number;
	path?: string;
	session?: string;
	includeDeleted?: boolean;
	/** Batch create items. One-of with `subject` on `create`. */
	tasks?: CreateTaskInput[];
}

// ---------------------------------------------------------------------------
// TypeBox parameter schema. Descriptions are prompt text: document shared
// fields once, on the top-level property rather than in each batch item.
// ---------------------------------------------------------------------------

const PointsSchema = Type.Number({ minimum: POINTS_MIN, maximum: POINTS_MAX });
const AnchorSchema = Type.String({ minLength: 1 });
const EvidenceSchema = Type.Array(Type.Object({
	ref: Type.Optional(Type.String({ minLength: 1, maxLength: 64, pattern: "^\\S*$" })),
	command: Type.String({ minLength: 1 }),
	sha: Type.Optional(Type.String()),
	result: StringEnum(["pass", "fail"] as const),
	at: Type.Optional(Type.String()),
}));

const CreateTaskInputSchema = Type.Object({
	subject: Type.String(),
	description: Type.Optional(Type.String()),
	activeForm: Type.Optional(Type.String()),
	blockedBy: Type.Optional(Type.Array(Type.Number())),
	owner: Type.Optional(Type.String()),
	metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	points: Type.Optional(PointsSchema),
	anchor: Type.Optional(AnchorSchema),
	graph: Type.Optional(Type.String()),
	evidence: Type.Optional(EvidenceSchema),
	waitsOn: Type.Optional(Type.String({ minLength: 1 })),
	until: Type.Optional(Type.String()),
});

export const TodoParamsSchema = Type.Object({
	action: StringEnum(["create", "update", "list", "get", "delete", "clear", "import"] as const),
	path: Type.Optional(Type.String({ description: "Import snapshot, cwd-relative." })),
	session: Type.Optional(Type.String({ description: "Import alternative: session ID, unique prefix or .jsonl." })),
	subject: Type.Optional(Type.String({ description: "Short imperative title (create, unless tasks is set)." })),
	description: Type.Optional(Type.String({ description: "Long-form detail." })),
	activeForm: Type.Optional(Type.String({ description: "Present-continuous in_progress label, e.g. 'writing tests'." })),
	status: Type.Optional(StringEnum(["pending", "in_progress", "completed", "deleted"] as const, { description: "Set on update; filter on list." })),
	blockedBy: Type.Optional(Type.Array(Type.Number(), { description: "Existing prerequisite IDs (create)." })),
	addBlockedBy: Type.Optional(Type.Array(Type.Number(), { description: "Update: add prerequisite IDs." })),
	removeBlockedBy: Type.Optional(Type.Array(Type.Number(), { description: "Update: drop prerequisite IDs." })),
	owner: Type.Optional(Type.String()),
	metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Update: null drops that key." })),
	points: Type.Optional({ ...PointsSchema, description: "Effort; update replaces." }),
	anchor: Type.Optional({ ...AnchorSchema, description: "Completion check, e.g. test command; update replaces." }),
	graph: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "single-loop, fan-out/fan-in or orchestrator-worker; null clears." })),
	evidence: Type.Optional({ ...EvidenceSchema, description: "Check runs: update only appends. ref: run or child:<id>; sha: tested revision; at: ISO 8601 (default now)." }),
	waitsOn: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()], { description: "What is pending. Wait shows ⏸, suppresses close/stale reminders; complete/delete clears it. null clears on update." })),
	until: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "ISO 8601 deadline; an until-only wait ends then. null clears on update." })),
	id: Type.Optional(Type.Number({ description: "Required for update/get/delete." })),
	includeDeleted: Type.Optional(Type.Boolean({ description: "list: include tombstones (default false)." })),
	tasks: Type.Optional(Type.Array(CreateTaskInputSchema, { description: "Atomic batch create instead of subject; same fields, no dependencies within the batch." })),
});

export type TodoParams = Static<typeof TodoParamsSchema>;
