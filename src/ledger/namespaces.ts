/**
 * Metadata namespace validators. Another extension owns `metadata.<ns>` by
 * emitting `todo:namespace` with a validator; the `todo` tool runs every
 * relevant validator before it commits a change and refuses the whole call on
 * the first refusal. Namespaces nobody registered pass unchecked.
 */

import type { Op } from "../state/state-reducer.ts";
import { WAIT_KEYS } from "../state/wait-mark.ts";
import type { TaskState } from "../state/state.ts";
import type { Task, TaskMutationParams } from "../tool/types.ts";
import { CONTRACT_VERSION, type NamespaceOp, type NamespaceValidator, NAMESPACE_EVENT } from "./contract.ts";

/** One task a call changes, with the metadata keys the call itself sets or removes. */
interface TaskChange {
	task: Task;
	op: NamespaceOp;
	touched: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function metadataKeys(value: unknown): string[] {
	return isRecord(value) ? Object.keys(value) : [];
}

/** The wait keys a call writes through its `waitsOn` and `until` fields, or all of them when it ends the task's wait. */
function waitKeys(spec: unknown, ends = false): string[] {
	return WAIT_KEYS.filter((key) => ends || (isRecord(spec) && spec[key] !== undefined));
}

/**
 * The tasks a committed `op` would create, update, or delete, read from the
 * reducer's proposed state. Reads, `clear`, errors, and no-effect updates
 * change no task and run no validator.
 */
export function changedTasks(op: Op, params: TaskMutationParams, next: TaskState): TaskChange[] {
	const find = (id: number) => next.tasks.find((t) => t.id === id);
	switch (op.kind) {
		case "import":
			return next.tasks.map((task) => ({ task, op: "create", touched: [] }));
		case "create": {
			const items = Array.isArray(params.tasks) ? params.tasks : undefined;
			return op.taskIds.flatMap((id, i) => {
				const task = find(id);
				const spec = items ? items[i] : params;
				return task ? [{ task, op: "create" as const, touched: [...metadataKeys(spec?.metadata), ...waitKeys(spec)] }] : [];
			});
		}
		case "update": {
			const task = op.changed ? find(op.id) : undefined;
			const ends = op.toStatus === "completed" || op.toStatus === "deleted";
			return task ? [{ task, op: "update", touched: [...metadataKeys(params.metadata), ...waitKeys(params, ends)] }] : [];
		}
		case "delete": {
			const task = find(op.id);
			return task ? [{ task, op: "delete", touched: waitKeys(params, true) }] : [];
		}
		case "list":
		case "get":
		case "clear":
		case "error":
			return [];
	}
}

export class NamespaceRegistry {
	private readonly validators = new Map<string, NamespaceValidator>();

	/**
	 * Handle a `todo:namespace` payload. A later registration of the same
	 * namespace replaces the earlier one. Returns the reason a malformed payload
	 * was ignored, or `undefined` when it registered.
	 */
	register(payload: unknown): string | undefined {
		if (!isRecord(payload)) return `${NAMESPACE_EVENT}: payload must be an object`;
		if (payload.v !== CONTRACT_VERSION) {
			return `${NAMESPACE_EVENT}: unsupported contract version ${String(payload.v)} (expected ${CONTRACT_VERSION})`;
		}
		if (typeof payload.ns !== "string" || !payload.ns.trim()) {
			return `${NAMESPACE_EVENT}: ns must be a non-empty string`;
		}
		if (typeof payload.validate !== "function") {
			return `${NAMESPACE_EVENT}: validate must be a function (ns "${payload.ns}")`;
		}
		this.validators.set(payload.ns, payload.validate as NamespaceValidator);
		return undefined;
	}

	has(ns: string): boolean {
		return this.validators.has(ns);
	}

	/**
	 * Run the validators for each changed task: every registered namespace the
	 * task carries after the change, or that the call sets or removes. Returns
	 * the first refusal as `metadata.<ns> refused #<id>: <reason>`.
	 */
	check(changes: readonly TaskChange[]): string | undefined {
		if (this.validators.size === 0) return undefined;
		for (const { task, op, touched } of changes) {
			const namespaces = new Set([...metadataKeys(task.metadata), ...touched]);
			for (const ns of namespaces) {
				const validate = this.validators.get(ns);
				if (!validate) continue;
				const copy = structuredClone(task);
				let reason: unknown;
				try {
					reason = validate(copy.metadata?.[ns], copy, op);
				} catch (error) {
					reason = `validator threw: ${error instanceof Error ? error.message : String(error)}`;
				}
				if (typeof reason === "string" && reason.length > 0) {
					return `metadata.${ns} refused #${task.id}: ${reason}`;
				}
			}
		}
		return undefined;
	}
}
