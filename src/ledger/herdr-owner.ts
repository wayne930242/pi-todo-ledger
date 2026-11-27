import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withSessionLock } from "../state/session-lock.ts";
import { applyTaskMutation } from "../state/state-reducer.ts";
import { getState, sid } from "../state/store.ts";
import { sanitizeTerminalText } from "../tool/sanitize.ts";
import type { Task } from "../tool/types.ts";
import type { FinishCall } from "./finish-call.ts";
import { runningGuard } from "./guards.ts";

const uid = /^t_[a-z2-7]{10}$/;
const local = /^([a-f0-9]{8})#([1-9]\d*)$/i;
const record = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const nonblank = (x: unknown): x is string => typeof x === "string" && x.trim().length > 0;

interface LaunchTarget { item: string; task: Task }

/** Per-load observer. A returned name is data, not a shell argument or a pane lookup. */
export function registerHerdrOwner(pi: ExtensionAPI, finish: FinishCall) {
	// A numeric id can be reused by clear or a branch switch before Herdr acknowledges the launch.
	// Capture its identity at dispatch. A legacy task without a uid must still be the same record.
	const pending = new Map<string, Map<string, LaunchTarget>>();
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "subagent" || typeof event.input.item !== "string") return;
		const item = event.input.item;
		const match = local.exec(item);
		if (!match) return;
		const session = sid(ctx);
		if (session.slice(0, 8).toLowerCase() !== match[1].toLowerCase()) return;
		const task = getState(session).tasks.find(t => t.id === Number(match[2]) && t.status !== "deleted");
		if (!task) return;
		const calls = pending.get(session) ?? new Map<string, LaunchTarget>();
		calls.set(event.toolCallId, { item, task });
		pending.set(session, calls);
	});
	// A blocked call need not produce a result. Drop any leftover captures at the turn boundary.
	pi.on("agent_end", (_event, ctx) => { pending.delete(sid(ctx)); });
	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "subagent") return;
		const session = sid(ctx);
		const calls = pending.get(session);
		const capture = calls?.get(event.toolCallId);
		calls?.delete(event.toolCallId);
		if (!calls?.size) pending.delete(session);
		const d = event.details;
		if (event.isError || !record(d) || d.status !== "started" || !nonblank(d.name) || !nonblank(d.id)) return;
		const item = d.item;
		if (typeof item !== "string" || item !== event.input.item) return;
		const pinned = capture?.item === item ? capture.task : undefined;
		if (!pinned && !uid.test(item)) return;
		const pane = record(d.worktree) ? d.worktree.paneId : undefined;
		const herdr = { name: d.name, id: d.id, ...(nonblank(pane) ? { pane } : {}) };
		const warn = (why: string) => ({
			content: [...event.content, { type: "text" as const, text: `Todo owner binding: ${sanitizeTerminalText(why)}` }],
			structuredContent: event.structuredContent,
		});
		if (runningGuard(session)) return warn("cannot update the list from its own change guard");
		try {
			return await withSessionLock(session, async () => {
				const before = getState(session);
				const task = pinned && !pinned.uid
					? before.tasks.find(t => t === pinned)
					: before.tasks.find(t => t.uid === (pinned?.uid ?? item));
				if (!task || task.status === "deleted") return;
				const params = { action: "update", id: task.id, owner: herdr.name, metadata: { herdr } };
				const result = await finish(session, ctx.cwd, "update", params, before, applyTaskMutation(before, "update", params));
				if (result.details.error) return warn(result.details.error);
			});
		} catch (error) {
			// Herdr already launched the child. Don't turn a persistence error into a failed launch/retry.
			return warn(error instanceof Error ? error.message : String(error));
		}
	});
}
