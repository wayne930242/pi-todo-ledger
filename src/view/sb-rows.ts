/**
 * What pi-straw-boss (sb) knows of a session beyond its runs, read from its two probes on `pi.events`, as the run rows are read:
 * the reader emits a plain object and sb's synchronous handler sets `rows` on it. With no sb loaded both are absent, and the panel
 * draws nothing of them. sb writes every word of a car row; the ledger adds only the time.
 * - `straw-boss:car-rows:v1`: the merge-train cars this session sent, or the trains it integrates (sb docs/specs/2026-11-28-car-rows.md).
 * - `straw-boss:ask-rows:v1`: the open questions that wait on the boss (sb docs/specs/2026-11-28-boss-asks.md).
 */
import { truncateToWidth } from "@earendil-works/pi-tui";
import { t } from "../state/i18n-bridge.ts";
import { sanitizeTerminalText } from "../tool/sanitize.ts";

export const CAR_ROWS_EVENT = "straw-boss:car-rows:v1";
export const ASK_ROWS_EVENT = "straw-boss:ask-rows:v1";

export type CarTone = "ok" | "wait" | "warn" | "bad";
export interface CarRow {
	id: string;
	/** The todo it goes under: its uid, else `<session8>#<id>`; absent exactly when `group` is set. */
	item?: string;
	group?: string;
	tickets: string[];
	phase: string;
	tone: CarTone;
	line: string;
	wait?: string;
	since: number;
}
export interface AskRow {
	id: string;
	subject: string;
	asker: string;
	where: string;
	kind: string;
	since: number;
	/** The asker is this session or one of its subagents. */
	mine: boolean;
	/**
	 * The todo it blocks: the session whose list holds it (as `AskRows.session` names this one), its id there, and its uid when sb bound
	 * it with one. The ledger reuses ids after `clear`, so only the uid tells that todo from a new one.
	 */
	item?: { session: string; id: number; uid?: string };
}
export interface CarRows {
	/** This session's id: an item `<session8>#<id>` must start with its first eight characters. An older sb leaves it out. */
	session?: string;
	rows: CarRow[];
}
export interface AskRows {
	/** This session's id as `item.session` names it; an older sb leaves it out, and then no ask is put under a todo. */
	session?: string;
	rows: AskRow[];
}

/** Emits a probe on sb's event and returns nothing; the handler fills the probe. */
export type SbQuery = (event: string, probe: object) => void;

function probe(query: SbQuery | undefined, event: string): { version?: unknown; session?: unknown; rows?: unknown } | undefined {
	const p: { rows?: { version?: unknown; session?: unknown; rows?: unknown } } = {};
	try {
		query?.(event, p);
	} catch {
		return undefined;
	}
	const rows = p.rows;
	return rows && rows.version === 1 && Array.isArray(rows.rows) ? rows : undefined;
}

const TONES = new Set<string>(["ok", "wait", "warn", "bad"]);
const str = (v: unknown): v is string => typeof v === "string";

/** The car rows of this session, a row the contract does not allow left out; none without sb. */
export function carRows(query?: SbQuery): CarRows {
	const answer = probe(query, CAR_ROWS_EVENT);
	const rows = ((answer?.rows ?? []) as unknown[]).filter((r): r is CarRow => {
		const c = r as Partial<CarRow> | null;
		return !!c && str(c.id) && str(c.line) && str(c.phase) && Number.isFinite(c.since) &&
			(c.item === undefined || str(c.item)) && (c.group === undefined || str(c.group)) && (c.wait === undefined || str(c.wait));
	}).map((c) => ({ ...c, tone: TONES.has(c.tone) ? c.tone : "ok", tickets: Array.isArray(c.tickets) ? c.tickets.filter(str) : [] }));
	return { ...(str(answer?.session) && answer.session ? { session: answer.session } : {}), rows };
}

/** The open asks of this session and its subagents (`mine`); another session's are on `/boss asks` and sb's GUI, not here. */
export function askRows(query?: SbQuery): AskRows {
	const answer = probe(query, ASK_ROWS_EVENT);
	const rows = ((answer?.rows ?? []) as unknown[]).filter((r): r is AskRow => {
		const a = r as Partial<AskRow> | null;
		return !!a && str(a.id) && str(a.subject) && str(a.kind) && Number.isFinite(a.since) && a.mine === true;
	});
	return { ...(str(answer?.session) && answer.session ? { session: answer.session } : {}), rows };
}

/**
 * Whether an ask blocks this todo of this session: its item names this session, the todo's id, and the uid the todo has
 * (carrows-review-F001). An item with no uid, or a todo with none, cannot be told from a todo that took the id later: neither matches.
 */
export function askNames(ask: AskRow, task: { id: number; uid?: string }, session: string | undefined): boolean {
	const item = ask.item;
	return !!session && !!item && item.session === session && item.id === task.id && typeof item.uid === "string" && item.uid === task.uid;
}

/**
 * Whether a car row's `item` names this todo: its uid, or `<session8>#<id>` with this session's own eight characters
 * (carrows-review-F003). With no session from sb, only a uid places a car.
 */
export function carNames(car: CarRow, task: { id: number; uid?: string }, session: string | undefined): boolean {
	if (!car.item) return false;
	if (task.uid && car.item === task.uid) return true;
	return !!session && car.item === `${session.slice(0, 8)}#${task.id}`;
}

/** `42s`, `12m`, `1h05m`, as the run rows have it. */
export function duration(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h${String(Math.floor(s / 60) % 60).padStart(2, "0")}m`;
}

type Color = "dim" | "warning" | "error";
type Fg = (color: Color, text: string) => string;
const plain: Fg = (_, text) => text;
const TONE_COLOR: Record<CarTone, Color> = { ok: "dim", wait: "dim", warn: "warning", bad: "error" };

/** A car row as sb's contract draws it: `${line} ${duration}${wait ? " · " + wait : ""}`, coloured by its tone. */
export function carLine(car: CarRow, now: number, fg: Fg = plain): string {
	const text = `${car.line} ${duration(now - car.since)}${car.wait ? ` · ${car.wait}` : ""}`;
	return fg(TONE_COLOR[car.tone], sanitizeTerminalText(text));
}

/** The longest question an ask row shows; the rest is on `/boss asks`. */
export const ASK_SUBJECT_WIDTH = 48;
/**
 * An ask row: `⏸ waits on you: <question> 5m` under its todo; in the group, whose heading already says so, `⏸ <question> 5m`.
 */
export function askLine(ask: AskRow, now: number, fg: Fg = plain, grouped = false): string {
	const subject = truncateToWidth(sanitizeTerminalText(ask.subject).replace(/\s+/g, " ").trim(), ASK_SUBJECT_WIDTH, "…");
	const lead = grouped ? "" : t("ask.waits", "waits on you: ");
	return fg("warning", `⏸ ${lead}${subject} ${duration(now - ask.since)}`);
}

/** What changed for the panel, to redraw it when sb's rows do (sb refreshes them every 15 s, between turns too). */
export function sbSignature(query?: SbQuery): string {
	const cars = carRows(query);
	const asks = askRows(query);
	return JSON.stringify([cars.session, cars.rows.map((c) => [c.id, c.item, c.group, c.phase, c.tone, c.line, c.wait, c.since]), asks.session, asks.rows.map((a) => [a.id, a.subject, a.item?.session, a.item?.id, a.item?.uid])]);
}
