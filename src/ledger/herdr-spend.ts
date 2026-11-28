import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { listOnBranch } from "../state/replay.ts";
import { sessionBusy, withSessionLock } from "../state/session-lock.ts";
import { listGeneration, sid } from "../state/store.ts";
import { sanitizeTerminalText } from "../tool/sanitize.ts";
import type { Task } from "../tool/types.ts";
import type { CommitNow } from "./finish-call.ts";
import { runningGuard } from "./guards.ts";
import { history } from "./herdr-runs.ts";
import { addRun, fileSpend, nonblank, record, spendOf } from "./spend.ts";

// A run's spend on its todo (CONTRACT.md "Run spend"). A run's end comes two ways: the host's `subagent:run-end` event, sent as the host delivers the end whether or not the model
// ever reads it, and the `subagent_result` or `subagent_ping` message the launching session's model receives. Both name the run's id, by which it counts once, and its session files:
// one per spawned attempt (`attempts`, a fallback's failed ones included), else the end's `sessionFile`. The ledger reads those files, sums the usage of the child's own assistant
// turns, and records it on the todo in `metadata.herdr.spend`. A resume continues the same file, so a session's figures are replaced by its newest total (never added twice); wall time
// adds each attempt's `elapsed`. The figures are what pi wrote in the child's transcript: bookkeeping, not a bill.
//
// The write is synchronous: it reads the list from the branch pi is on at that moment (pi's leaf, not the live slot, which a pending `session_tree` replay may still hold from the
// branch before), reads the files, and appends in the same tick, so no branch switch, replay or shutdown can come between the read and the append. A `todo` call of the session that
// is running or queued holds the list while its guards run: the write then waits its turn in the session's queue and does the same there.

export const RUN_END_EVENT = "subagent:run-end";
const ENDS = new Set(["subagent_result", "subagent_ping"]);
const uid = /^t_[a-z2-7]{10}$/;
const seconds = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0;

/** One spawned attempt of a run: its session file, when it has one, and its wall time. */
interface Attempt { file?: string; elapsed?: number }
/** One ended run, from the host's event or its message's details. */
interface End { run?: string; item?: unknown; file?: string; elapsed?: number; attempts?: Attempt[] }
const endOf = (d: Record<string, unknown>): End => {
	const attempts = Array.isArray(d.attempts)
		? d.attempts.flatMap((a): Attempt[] => (record(a) ? [{ ...(nonblank(a.sessionFile) ? { file: a.sessionFile } : {}), ...(seconds(a.elapsed) ? { elapsed: a.elapsed } : {}) }] : []))
		: [];
	return {
		...(nonblank(d.id) ? { run: d.id } : {}),
		item: d.item,
		...(nonblank(d.sessionFile) ? { file: d.sessionFile } : {}),
		...(seconds(d.elapsed) ? { elapsed: d.elapsed } : {}),
		...(attempts.length ? { attempts } : {}),
	};
};
/** The session files an end names: each attempt's, else the end's own. */
const filesOf = (end: End): string[] => [...new Set(end.attempts ? end.attempts.flatMap((a) => (a.file ? [a.file] : [])) : end.file ? [end.file] : [])];
/** An end's wall time: its attempts' sum (a fallback's failed attempts ran too), else its own. */
const timeOf = (end: End): number | undefined => (end.attempts?.some((a) => a.elapsed !== undefined) ? end.attempts.reduce((sum, a) => sum + (a.elapsed ?? 0), 0) : end.elapsed);

/**
 * The open todo an ended run is for, as its launch bound it: the one whose bound runs hold its run id, else one of its session files, else the todo its `item` names by uid. A bare
 * `<session8>#<id>` is never looked up as the todo of that number now: after a clear or a branch switch it names another todo (the launch's binding is what proves the identity).
 */
function taskOf(tasks: readonly Task[], end: End): Task | undefined {
	const open = tasks.filter((t) => t.status !== "deleted"), files = new Set([...(end.file ? [end.file] : []), ...filesOf(end)]);
	for (const match of [end.run && ((r: { id: string }) => r.id === end.run), files.size > 0 && ((r: { session?: string }) => r.session !== undefined && files.has(r.session))]) {
		if (!match) continue;
		const bound = open.filter((t) => history(t.metadata?.herdr).runs.some(match));
		if (bound.length === 1) return bound[0];
		if (bound.length > 1) return undefined;
	}
	return typeof end.item === "string" && uid.test(end.item) ? open.find((t) => t.uid === end.item) : undefined;
}

/** The ids of the launcher's own entries: a forked child's file holds copies of them. */
function parentIds(ctx: ExtensionContext): Set<string> {
	const sm = ctx.sessionManager as { getEntries?(): readonly unknown[]; getBranch(): readonly unknown[] };
	const entries = typeof sm.getEntries === "function" ? sm.getEntries() : sm.getBranch();
	return new Set(entries.flatMap((e) => (record(e) && typeof e.id === "string" ? [e.id] : [])));
}

/** Per-load observer of ended runs. */
export function registerHerdrSpend(pi: ExtensionAPI, commit: CommitNow) {
	/** The session the host's event belongs to: this process's current one, as its last event showed it. */
	let current: ExtensionContext | undefined;
	const seen = (_event: unknown, ctx: ExtensionContext) => void (current = ctx);
	pi.on("session_start", seen); pi.on("session_tree", seen); pi.on("agent_start", seen);
	/** Shutdowns per session: a write queued before one is dropped, even when a call that finished after it rebuilt the list. */
	const shutdowns = new Map<string, number>();
	pi.on("session_shutdown", (_event, ctx) => {
		try { const s = sid(ctx); shutdowns.set(s, (shutdowns.get(s) ?? 0) + 1); } catch { /* a stale context: its session is gone with it */ }
	});

	/** Records one end in this tick; a reason when it could not, undefined when it did or when the end is not this list's. */
	const book = (ctx: ExtensionContext, end: End): string | undefined => {
		const session = sid(ctx);
		if (listGeneration(session) === undefined) return undefined; // shut down: its list is gone, and no write may rebuild it
		const before = listOnBranch(ctx), task = taskOf(before.tasks, end);
		if (!task) return undefined;
		const herdr = record(task.metadata?.herdr) ? task.metadata.herdr : {};
		if (end.run && spendOf(herdr.spend).ended?.includes(end.run)) return undefined;
		const parent = parentIds(ctx), files = filesOf(end).map((session) => ({ session, spend: fileSpend(session, parent) }));
		const spend = addRun(herdr.spend, files, timeOf(end), end.run);
		return commit(session, { action: "update", id: task.id, metadata: { herdr: { ...herdr, spend } } }, before);
	};
	/** `book` now, or, behind a running or queued call of the session, when its turn comes. */
	const recordEnd = (ctx: ExtensionContext, end: End): string | undefined | Promise<string | undefined> => {
		const session = sid(ctx);
		if (runningGuard(session)) return "cannot update the list from its own change guard";
		if (!sessionBusy(session)) return book(ctx, end);
		const epoch = shutdowns.get(session) ?? 0;
		return withSessionLock(session, async () => ((shutdowns.get(session) ?? 0) === epoch ? book(ctx, end) : undefined));
	};

	// The host's event: an end the model may never read (a steer cleared before its turn) is still spent. A refusal here is said again by the message, when it comes.
	pi.events.on(RUN_END_EVENT, (raw) => {
		const ctx = current;
		if (!ctx || !record(raw) || raw.v !== 1 || !nonblank(raw.id) || (raw.kind !== "result" && raw.kind !== "ping")) return;
		try {
			void Promise.resolve(recordEnd(ctx, endOf(raw))).catch(() => undefined); // a stale context (the session was replaced): its next session replays its own list
		} catch { /* the same, thrown in this tick */ }
	});

	pi.on("message_end", async (event, ctx) => {
		const message = event.message as { role?: string; customType?: string; content?: unknown; details?: unknown };
		if (message.role !== "custom" || !ENDS.has(message.customType ?? "") || !record(message.details)) return;
		const say = (why: string) => {
			const note = `Todo spend: ${sanitizeTerminalText(why)}`;
			const content = typeof message.content === "string" ? `${message.content}\n\n${note}` : Array.isArray(message.content) ? [...message.content, { type: "text", text: note }] : note;
			return { message: { ...message, content } as typeof event.message };
		};
		try {
			const why = await recordEnd(ctx, endOf(message.details));
			return why ? say(why) : undefined;
		} catch (error) {
			return say(error instanceof Error ? error.message : String(error));
		}
	});
}
