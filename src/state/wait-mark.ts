import type { Task, TaskMutationParams } from "../tool/types.ts";

/**
 * A wait mark: `metadata.waitsOn` names what an open task waits on (a person, CI, a train), and
 * `metadata.until` an ISO time it waits until. The `waitsOn` and `until` tool fields write these keys,
 * the ones the panel, sb's board, and anchorloop's close guard already read, so a snapshot keeps its
 * v1 shape. Completing or deleting the task ends the wait and removes both keys.
 */
export const WAIT_KEYS = ["waitsOn", "until"] as const;

/** An ISO 8601 date or date-time, the forms `metadata.until` takes; pi-straw-boss (src/todoledger.ts) reads the same. */
const ISO_DATE_TIME = /^\d{4}-\d\d-\d\d(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)?)?$/;

/** The epoch time of an `until` value, or NaN unless it is an ISO date or date-time on a real calendar day (not 2099-02-30). */
export function untilTime(value: unknown): number {
	if (typeof value !== "string" || !ISO_DATE_TIME.test(value)) return Number.NaN;
	const day = value.slice(0, 10), midnight = Date.parse(day);
	return Number.isFinite(midnight) && new Date(midnight).toISOString().startsWith(day) ? Date.parse(value) : Number.NaN;
}

/** The refusal for a call's wait fields, or `undefined`; only an update (`clearable`) takes `null`. */
export function validateWaitFields(spec: TaskMutationParams, now: string, clearable: boolean): string | undefined {
	const { waitsOn, until } = spec;
	if (waitsOn !== undefined && !(clearable && waitsOn === null) && (typeof waitsOn !== "string" || !waitsOn.trim())) {
		return clearable ? "waitsOn must be a non-empty string (null clears)" : "waitsOn must be a non-empty string";
	}
	if (until === undefined || (clearable && until === null)) return undefined;
	if (Number.isNaN(untilTime(until))) {
		return clearable ? "until must be an ISO 8601 date or time (null clears)" : "until must be an ISO 8601 date or time";
	}
	if (untilTime(until) <= Date.parse(now)) return "until must be in the future";
	return undefined;
}

/** Metadata with the call's wait fields applied: a string sets its key, `null` removes it. */
export function withWaitFields(metadata: Record<string, unknown> | undefined, spec: TaskMutationParams): Record<string, unknown> | undefined {
	if (spec.waitsOn === undefined && spec.until === undefined) return metadata;
	const next: Record<string, unknown> = { ...(metadata ?? {}) };
	if (typeof spec.waitsOn === "string") next.waitsOn = spec.waitsOn.trim();
	else if (spec.waitsOn === null) delete next.waitsOn;
	if (typeof spec.until === "string") next.until = spec.until;
	else if (spec.until === null) delete next.until;
	return Object.keys(next).length ? next : undefined;
}

/** Metadata without a wait mark, for a task that is completed or deleted. */
export function withoutWait(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
	if (!metadata || !WAIT_KEYS.some((key) => key in metadata)) return metadata;
	const { waitsOn: _on, until: _until, ...rest } = metadata;
	return Object.keys(rest).length ? rest : undefined;
}

/** What an open task waits on and until when, as display text parts; empty when it does not wait. */
export function waitParts(task: Task): { on?: string; until?: number } {
	if (task.status !== "pending" && task.status !== "in_progress") return {};
	const who = task.metadata?.waitsOn;
	const on = typeof who === "string" && who.trim() ? who : undefined;
	const time = untilTime(task.metadata?.until);
	return { ...(on ? { on } : {}), ...(time > Date.now() ? { until: time } : {}) };
}
