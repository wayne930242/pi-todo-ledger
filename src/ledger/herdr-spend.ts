import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withSessionLock } from "../state/session-lock.ts";
import { applyTaskMutation } from "../state/state-reducer.ts";
import { getState, sid } from "../state/store.ts";
import { sanitizeTerminalText } from "../tool/sanitize.ts";
import type { Task } from "../tool/types.ts";
import type { FinishCall } from "./finish-call.ts";
import { runningGuard } from "./guards.ts";
import { history } from "./herdr-runs.ts";
import { addRun, fileSpend, nonblank, record } from "./spend.ts";

// A run's spend on its todo (CONTRACT.md "Run spend"). When a bound subagent's run ends, the host hands the launching session a `subagent_result` message (or `subagent_ping` when the
// run stopped to ask); its details name the run's `item` and `sessionFile`, and a result its `elapsed` seconds. The ledger reads that session file, sums the usage of its assistant
// turns, and records it on the todo in `metadata.herdr.spend` through a normal guarded update. A resume continues the same file, so a session's figures are replaced by its newest
// total (never added twice); wall time adds each result's `elapsed`. The figures are what pi wrote in the child's transcript: bookkeeping, not a bill.

const ENDS = new Set(["subagent_result", "subagent_ping"]);
const uid = /^t_[a-z2-7]{10}$/;
const local = /^([a-f0-9]{8})#([1-9]\d*)$/i;
/** The open todo an ended run is for: the one whose bound runs hold its session file, else its `item` (a uid, or `<session8>#<id>` of this session). */
function taskOf(tasks: readonly Task[], session: string, item: unknown, file: string | undefined): Task | undefined {
	const open = tasks.filter((t) => t.status !== "deleted");
	if (file) {
		const bound = open.filter((t) => history(t.metadata?.herdr).runs.some((r) => r.session === file));
		if (bound.length === 1) return bound[0];
		if (bound.length > 1) return undefined;
	}
	if (typeof item !== "string") return undefined;
	if (uid.test(item)) return open.find((t) => t.uid === item);
	const m = local.exec(item);
	return m && session.slice(0, 8).toLowerCase() === m[1].toLowerCase() ? open.find((t) => t.id === Number(m[2])) : undefined;
}

/** Per-load observer of ended runs. */
export function registerHerdrSpend(pi: ExtensionAPI, finish: FinishCall) {
	pi.on("message_end", async (event, ctx) => {
		const message = event.message as { role?: string; customType?: string; content?: unknown; details?: unknown };
		if (message.role !== "custom" || !ENDS.has(message.customType ?? "") || !record(message.details)) return;
		const d = message.details, file = nonblank(d.sessionFile) ? d.sessionFile : undefined;
		const session = sid(ctx);
		if (!taskOf(getState(session).tasks, session, d.item, file)) return;
		const say = (why: string) => {
			const note = `Todo spend: ${sanitizeTerminalText(why)}`;
			const content = typeof message.content === "string" ? `${message.content}\n\n${note}` : Array.isArray(message.content) ? [...message.content, { type: "text", text: note }] : note;
			return { message: { ...message, content } as typeof event.message };
		};
		if (runningGuard(session)) return say("cannot update the list from its own change guard");
		const spent = file ? await fileSpend(file) : undefined; // read before the lock: a large file must not hold the session's todo calls
		try {
			return await withSessionLock(session, async () => {
				const before = getState(session), task = taskOf(before.tasks, session, d.item, file);
				if (!task) return undefined;
				const herdr = record(task.metadata?.herdr) ? task.metadata.herdr : {};
				const spend = addRun(herdr.spend, file, spent, typeof d.elapsed === "number" && Number.isFinite(d.elapsed) && d.elapsed >= 0 ? d.elapsed : undefined);
				const params = { action: "update" as const, id: task.id, metadata: { herdr: { ...herdr, spend } } };
				const result = await finish(session, ctx.cwd, "update", params, before, applyTaskMutation(before, "update", params));
				return result.details.error ? say(result.details.error) : undefined;
			});
		} catch (error) {
			return say(error instanceof Error ? error.message : String(error));
		}
	});
}
