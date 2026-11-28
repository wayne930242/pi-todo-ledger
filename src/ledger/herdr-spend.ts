import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { withSessionLock } from "../state/session-lock.ts";
import { applyTaskMutation } from "../state/state-reducer.ts";
import { getState, sid } from "../state/store.ts";
import { sanitizeTerminalText } from "../tool/sanitize.ts";
import type { Task } from "../tool/types.ts";
import { type FinishCall, MOVED } from "./finish-call.ts";
import { runningGuard } from "./guards.ts";
import { history } from "./herdr-runs.ts";
import { addRun, fileSpend, nonblank, record, spendOf } from "./spend.ts";

// A run's spend on its todo (CONTRACT.md "Run spend"). A run's end comes two ways: the host's `subagent:run-end` event, sent as the host delivers the end whether or not the model
// ever reads it, and the `subagent_result` or `subagent_ping` message the launching session's model receives. Either names the run's session file, and the host's both name its run
// id, by which it counts once. The ledger reads that session file, sums the usage of the child's own assistant turns, and records it on the todo in `metadata.herdr.spend` through a
// normal guarded update. A resume continues the same file, so a session's figures are replaced by its newest total (never added twice); wall time adds each end's `elapsed`.
// The figures are what pi wrote in the child's transcript: bookkeeping, not a bill.

export const RUN_END_EVENT = "subagent:run-end";
const ENDS = new Set(["subagent_result", "subagent_ping"]);
const uid = /^t_[a-z2-7]{10}$/;

/** One ended run, from the host's event or its message's details. */
interface End { run?: string; item?: unknown; file?: string; elapsed?: number }
const endOf = (d: Record<string, unknown>): End => ({
	...(nonblank(d.id) ? { run: d.id } : {}),
	item: d.item,
	...(nonblank(d.sessionFile) ? { file: d.sessionFile } : {}),
	...(typeof d.elapsed === "number" && Number.isFinite(d.elapsed) && d.elapsed >= 0 ? { elapsed: d.elapsed } : {}),
});

/**
 * The open todo an ended run is for, as its launch bound it: the one whose bound runs hold its run id, else its session file, else the todo its `item` names by uid. A bare
 * `<session8>#<id>` is never looked up as the todo of that number now: after a clear or a branch switch it names another todo (the launch's binding is what proves the identity).
 */
function taskOf(tasks: readonly Task[], end: End): Task | undefined {
	const open = tasks.filter((t) => t.status !== "deleted");
	for (const match of [end.run && ((r: { id: string }) => r.id === end.run), end.file && ((r: { session?: string }) => r.session === end.file)]) {
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
export function registerHerdrSpend(pi: ExtensionAPI, finish: FinishCall) {
	/** The session the host's event belongs to: this process's current one, as its last event showed it. */
	let current: ExtensionContext | undefined;
	const seen = (_event: unknown, ctx: ExtensionContext) => void (current = ctx);
	pi.on("session_start", seen); pi.on("session_tree", seen); pi.on("agent_start", seen);

	/** Records one end; a reason when it could not, undefined when it did or when the end is not this list's. */
	const recordEnd = async (ctx: ExtensionContext, end: End): Promise<string | undefined> => {
		const session = sid(ctx), found = taskOf(getState(session).tasks, end);
		if (!found || (end.run && spendOf(record(found.metadata?.herdr) ? found.metadata.herdr.spend : undefined).ended?.includes(end.run))) return undefined;
		if (runningGuard(session)) return "cannot update the list from its own change guard";
		const spent = end.file ? await fileSpend(end.file, parentIds(ctx)) : undefined; // read before the lock: a large file must not hold the session's todo calls
		// A list replaced while the write waited on its guards refuses it (MOVED): look again in the list that is live now. The same branch's replay
		// still holds the todo, another branch's list or a shut-down session's (empty) does not, and the end is dropped there.
		for (let attempt = 0; ; attempt++) {
			const why = await withSessionLock(session, async () => {
				const before = getState(session), task = taskOf(before.tasks, end);
				if (!task) return undefined;
				const herdr = record(task.metadata?.herdr) ? task.metadata.herdr : {};
				if (end.run && spendOf(herdr.spend).ended?.includes(end.run)) return undefined;
				const spend = addRun(herdr.spend, end.file, spent, end.elapsed, end.run);
				const params = { action: "update" as const, id: task.id, metadata: { herdr: { ...herdr, spend } } };
				const result = await finish(session, ctx.cwd, "update", params, before, applyTaskMutation(before, "update", params));
				return result.details.error;
			});
			if (why !== MOVED || attempt === 2) return why;
		}
	};

	// The host's event: an end the model may never read (a steer cleared before its turn) is still spent. A refusal here is said again by the message, when it comes.
	pi.events.on(RUN_END_EVENT, (raw) => {
		const ctx = current;
		if (!ctx || !record(raw) || raw.v !== 1 || !nonblank(raw.id) || (raw.kind !== "result" && raw.kind !== "ping")) return;
		void recordEnd(ctx, endOf(raw)).catch(() => undefined); // a stale context (the session was replaced): its next session replays its own list
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
