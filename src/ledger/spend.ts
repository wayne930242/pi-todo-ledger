import { readFile } from "node:fs/promises";
import { sanitizeTerminalText } from "../tool/sanitize.ts";

// A run's spend as `metadata.herdr.spend` keeps it (CONTRACT.md "Run spend"): pure parts, so `todo get` formats it without the observer (herdr-spend.ts).

export const record = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
export const nonblank = (x: unknown): x is string => typeof x === "string" && x.trim().length > 0;
/** Sessions kept for the replace-not-add rule, newest last; an older one folds into the totals and is no longer told apart. Models kept, first seen first. */
export const SPEND_SESSIONS = 12, SPEND_MODELS = 8;
const COUNTS = ["input", "output", "cacheRead", "cacheWrite", "tokens", "cost"] as const;
type Counts = Record<(typeof COUNTS)[number], number>;
export interface SessionSpend extends Counts { session: string; models: string[] }
export interface Spend extends Counts { ms: number; runs: number; models: string[]; sessions: SessionSpend[] }

const count = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : 0);
const zero = (): Counts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, cost: 0 });
const names = (x: unknown) => (Array.isArray(x) ? x.filter(nonblank) : []);

/** A stored spend read back defensively: a hand-edited or partial one counts from what it holds. */
export function spendOf(value: unknown): Spend {
	const v = record(value) ? value : {};
	const sessions = (Array.isArray(v.sessions) ? v.sessions : []).flatMap((s): SessionSpend[] => (record(s) && nonblank(s.session) ? [{ session: s.session, ...Object.fromEntries(COUNTS.map((k) => [k, count(s[k])])) as Counts, models: names(s.models) }] : []));
	return { ...Object.fromEntries(COUNTS.map((k) => [k, count(v[k])])) as Counts, ms: count(v.ms), runs: count(v.runs), models: names(v.models), sessions };
}

/** The usage pi recorded on the assistant turns of a session file, every branch of it (all of it was spent), and the models they ran on; undefined when the file cannot be read. */
export async function fileSpend(file: string): Promise<{ counts: Counts; models: string[] } | undefined> {
	let raw: string;
	try { raw = await readFile(file, "utf8"); } catch { return undefined; }
	const counts = zero(), models: string[] = [];
	for (const line of raw.split("\n")) {
		if (!line.includes('"assistant"') || !line.includes('"usage"')) continue;
		let entry: unknown;
		try { entry = JSON.parse(line); } catch { continue; } // a torn last line
		const m = record(entry) && record(entry.message) ? entry.message : undefined, u = m && m.role === "assistant" && record(m.usage) ? m.usage : undefined;
		if (!m || !u) continue;
		counts.input += count(u.input), counts.output += count(u.output), counts.cacheRead += count(u.cacheRead), counts.cacheWrite += count(u.cacheWrite);
		counts.tokens += count(u.totalTokens) || count(u.input) + count(u.output) + count(u.cacheRead) + count(u.cacheWrite);
		counts.cost += record(u.cost) ? count(u.cost.total) : 0;
		const model = nonblank(m.model) ? (nonblank(m.provider) ? `${m.provider}/${m.model}` : m.model) : undefined;
		if (model && !models.includes(model)) models.push(model);
	}
	return { counts, models };
}

/** `previous` with one ended run added: the session's figures replaced by `file`'s total, `seconds` of wall time added. */
export function addRun(previous: unknown, session: string | undefined, file: { counts: Counts; models: string[] } | undefined, seconds: number | undefined): Spend {
	const s = spendOf(previous), out: Spend = { ...s, ms: s.ms + (seconds === undefined ? 0 : Math.round(seconds * 1000)), runs: s.runs + 1, models: [...s.models], sessions: [...s.sessions] };
	if (session && file) {
		const at = out.sessions.findIndex((x) => x.session === session), before = at < 0 ? zero() : out.sessions[at]!;
		for (const k of COUNTS) out[k] = Math.max(0, out[k] + file.counts[k] - before[k]);
		if (at >= 0) out.sessions.splice(at, 1);
		out.sessions.push({ session, ...file.counts, models: file.models });
		out.sessions = out.sessions.slice(-SPEND_SESSIONS);
		for (const m of file.models) if (!out.models.includes(m)) out.models.push(m);
		out.models = out.models.slice(0, SPEND_MODELS);
	}
	out.cost = Math.round(out.cost * 1e6) / 1e6;
	return out;
}

/** A spend in one line, for `todo get`: tokens, cost, wall time, runs, models. */
export function spendLine(value: unknown): string | undefined {
	const s = spendOf(value);
	if (!s.runs) return undefined;
	const seconds = Math.round(s.ms / 1000), time = seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
	return [`${s.tokens.toLocaleString("en-US")} tokens`, `$${s.cost < 10 ? s.cost.toFixed(2) : s.cost.toFixed(1)}`, time, `${s.runs} run${s.runs === 1 ? "" : "s"}`, ...s.models.map(sanitizeTerminalText)].join(" · ");
}

