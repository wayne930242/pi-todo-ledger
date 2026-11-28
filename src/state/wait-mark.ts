import type { Task, TaskMutationParams } from "../tool/types.ts";

/**
 * A wait mark: `metadata.waitsOn` names what an open task waits on (a person, CI, a train), and
 * `metadata.until` an ISO time it waits until. The `waitsOn` and `until` tool fields write these keys,
 * the ones the panel, sb's board, and anchorloop's close guard already read, so a snapshot keeps its
 * v1 shape. Completing or deleting the task ends the wait and removes both keys.
 */
export const WAIT_KEYS = ["waitsOn", "until"] as const;

/** An ISO 8601 date or date-time, the forms `metadata.until` takes. */
export const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/i;

/** The refusal for a call's wait fields, or `undefined`; only an update (`clearable`) takes `null`. */
export function validateWaitFields(spec: TaskMutationParams, now: string, clearable: boolean): string | undefined {
	const { waitsOn, until } = spec;
	if (waitsOn !== undefined && !(clearable && waitsOn === null) && (typeof waitsOn !== "string" || !waitsOn.trim())) {
		return clearable ? "waitsOn must be a non-empty string (null clears)" : "waitsOn must be a non-empty string";
	}
	if (until === undefined || (clearable && until === null)) return undefined;
	if (typeof until !== "string" || !ISO_DATE_TIME.test(until) || Number.isNaN(Date.parse(until))) {
		return clearable ? "until must be an ISO 8601 date or time (null clears)" : "until must be an ISO 8601 date or time";
	}
	if (Date.parse(until) <= Date.parse(now)) return "until must be in the future";
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
	const raw = task.metadata?.until;
	const time = typeof raw === "string" && ISO_DATE_TIME.test(raw) ? Date.parse(raw) : Number.NaN;
	return { ...(on ? { on } : {}), ...(time > Date.now() ? { until: time } : {}) };
}
