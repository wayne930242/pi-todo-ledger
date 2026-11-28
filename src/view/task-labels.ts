import { t } from '../state/i18n-bridge.ts';
import { sanitizeTerminalText } from "../tool/sanitize.ts";
import { waitParts } from "../state/wait-mark.ts";
import type { Task } from "../tool/types.ts";

export function isOpen(task: Task): boolean {
	return task.status === "pending" || task.status === "in_progress";
}

// A legacy task can lack a uid. A made-up one would not identify it to other extensions.
export function uidSuffix(task: Task): string {
	return typeof task.uid === "string" ? ` ${sanitizeTerminalText(task.uid)}` : "";
}

const localTime = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" });

/** A hint for this render, never a status transition or a stored field. */
export function waitingLabel(task: Task): string {
	const { on, until } = waitParts(task);
	const party = on ? sanitizeTerminalText(on).trim() : "";
	return [party && `${t('wait.party','waits')} ${party}`, until !== undefined && `${t('wait.until','until')} ${localTime.format(until)}`].filter(Boolean).join(" · ");
}

export function resultSuffix(task: Task): string {
	const wait = waitingLabel(task);
	return `${uidSuffix(task)}${wait ? ` ⏸ ${wait}` : ""}`;
}
