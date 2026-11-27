import { sanitizeTerminalText } from "../tool/sanitize.ts";
import type { Task } from "../tool/types.ts";

export function isOpen(task: Task): boolean {
	return task.status === "pending" || task.status === "in_progress";
}

// A legacy task can lack a uid. A made-up one would not identify it to other extensions.
export function uidSuffix(task: Task): string {
	return typeof task.uid === "string" ? ` ${sanitizeTerminalText(task.uid)}` : "";
}

const isoDateTime = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/i;
const localTime = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" });

/** A hint for this render, never a status transition or a stored field. */
export function waitingLabel(task: Task): string {
	if (!isOpen(task)) return "";
	const who = task.metadata?.waitsOn;
	const party = typeof who === "string" ? sanitizeTerminalText(who).trim() : "";
	const until = task.metadata?.until;
	const time = typeof until === "string" && isoDateTime.test(until) ? Date.parse(until) : NaN;
	return [party && `waits ${party}`, time > Date.now() && `until ${localTime.format(time)}`].filter(Boolean).join(" · ");
}

export function resultSuffix(task: Task): string {
	const wait = waitingLabel(task);
	return `${uidSuffix(task)}${wait ? ` ⏸ ${wait}` : ""}`;
}
