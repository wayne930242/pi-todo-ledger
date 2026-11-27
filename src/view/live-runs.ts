import { t } from "../state/i18n-bridge.ts";
import { sanitizeTerminalText } from "../tool/sanitize.ts";
export interface RunRow {
	id: string;
	name: string;
	agent?: string;
	model?: string;
	startedAt: number;
	phase: { kind: string; label?: string; since?: number };
	cancel?: string;
}
/** The host's run-rows event (pi-herdr-agents, and pi-straw-boss after the move): the probe and the claim. */
export const RUN_ROWS_EVENT = "pi-herdr-agents:run-rows:v1";
export interface Probe {
	claim?: { by: string; ids: string[] };
	rows?: { version: 1; rows: RunRow[] };
}
export type Query = (probe: Probe) => void;
export function liveRows(query?: Query) {
	const p: Probe = {};
	try {
		query?.(p);
	} catch {
		return undefined;
	}
	if (p.rows?.version !== 1 || !Array.isArray(p.rows.rows)) return undefined;
	return new Map(
		p.rows.rows
			.filter(
				(r) =>
					r &&
					typeof r.id === "string" &&
					typeof r.name === "string" &&
					typeof r.phase?.kind === "string" &&
					Number.isFinite(r.startedAt),
			)
			.map((r) => [r.id, r]),
	);
}
export function shortModel(model: string) {
	const base = model.split("/").at(-1) ?? model;
	return (
		base
			.split(/[-_:]/)
			.filter(
				(x) => x && !/^(?:claude|gpt|openai|anthropic|\d[\d.]*)$/i.test(x),
			)
			.join("-") || base
	);
}
/**
 * What a run row says about its subagent, from Maestro's `projectLifecycle` kind:
 * Herdr `working` is `active`; Herdr `done` or `idle` after work (the turn ended, or a
 * persistent specialist sits between tasks) is `waiting`, shown as idle; Herdr `blocked`
 * (a dialog, approval or question in the pane) is `blocked`, shown as waiting for a reply.
 * Other kinds (interrupted, stalled, finalizing, ...) and unknown ones keep the plain row.
 */
export type RunState = "running" | "idle" | "waiting";
const STATES: Record<string, RunState> = {
	starting: "running",
	running: "running",
	active: "running",
	waiting: "idle",
	blocked: "waiting",
};
/** Single-cell marks distinct from the task glyphs (○ ◐ ✓ ✗ ⏸); running rows carry none. */
const MARKS: Partial<Record<RunState, string>> = { idle: "◇", waiting: "?" };
function pendingCancel(row: RunRow) {
	return row.cancel === "requested" || row.cancel === "unconfirmed"
		? `cancel.${row.cancel}`
		: undefined;
}
/** The row's state, or undefined when a pending cancel leads or the kind is not mapped. */
export function runState(row: RunRow): RunState | undefined {
	if (pendingCancel(row)) return undefined;
	return Object.hasOwn(STATES, row.phase.kind) ? STATES[row.phase.kind] : undefined;
}
const words: Record<string, string> = {
	"cancel.requested": "cancelling",
	"cancel.unconfirmed": "cancel unconfirmed",
	"tool.thread_wait": "waiting for thread",
	"active.reviewer": "reviewing",
	"kind.active": "running",
	"state.idle": "idle",
	"state.waiting": "waiting",
};
export function runLine(row: RunRow, now: number) {
	const { kind, label, since } = row.phase;
	// A pending cancel outranks the lifecycle: the host hides its own warning for claimed rows.
	const cancel = pendingCancel(row);
	const state = runState(row);
	const keys = [
		cancel,
		state && state !== "running" && `state.${state}`,
		label && `tool.${label}`,
		kind === "active" && row.agent && `active.${row.agent}`,
		`kind.${kind}`,
	];
	const word =
		keys
			.filter(Boolean)
			.map((k) => t(`run.${k}`, words[String(k)] ?? ""))
			.find(Boolean) || kind;
	const s = Math.max(
		0,
		Math.floor(
			(now - (Number.isFinite(since) ? since! : row.startedAt)) / 1000,
		),
	);
	const time =
		s < 60
			? `${s}s`
			: s < 3600
				? `${Math.floor(s / 60)}m`
				: `${Math.floor(s / 3600)}h${String(Math.floor(s / 60) % 60).padStart(2, "0")}m`;
	return sanitizeTerminalText(
		(state && MARKS[state] ? `${MARKS[state]} ` : "") +
			[row.name, row.model && shortModel(row.model), `${word} ${time}`]
				.filter(Boolean)
				.join(" · "),
	);
}
