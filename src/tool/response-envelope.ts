import type { TaskState } from "../state/state.ts";
import type { Op } from "../state/state-reducer.ts";
import { deriveBlocks } from "../state/task-graph.ts";
import { isOpen, resultSuffix } from "../view/task-labels.ts";
import { spendLine } from "../ledger/spend.ts";
import { sanitizeTerminalText } from "./sanitize.ts";
import type { Task, TaskAction, TaskDetails, TaskMutationParams } from "./types.ts";

/**
 * Compact `list` row for the caller. The widget and /todos use the tree layout instead.
 */
function formatListLine(t: Task): string {
	const block = t.blockedBy?.length ? ` ⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}` : "";
	const form = t.status === "in_progress" && t.activeForm ? ` (${sanitizeTerminalText(t.activeForm)})` : "";
	return `[${t.status}] #${t.id} ${sanitizeTerminalText(t.subject)}${form}${block}${resultSuffix(t)}`;
}

/**
 * `list` body. When an open task names a graph, open tasks are grouped under
 * `<graph>:` headers in first-seen order, then `no graph:`, then `closed:` for
 * the rest; otherwise one line per task in id order.
 */
function formatList(view: readonly Task[]): string {
	if (!view.some((t) => isOpen(t) && t.graph)) return view.map(formatListLine).join("\n");
	const groups = new Map<string, Task[]>();
	const closed: Task[] = [];
	for (const t of view) {
		if (!isOpen(t)) closed.push(t);
		else {
			const key = t.graph ?? "";
			groups.set(key, [...(groups.get(key) ?? []), t]);
		}
	}
	const ungrouped = groups.get("");
	groups.delete("");
	const lines: string[] = [];
	const section = (header: string, tasks: Task[] | undefined) => {
		if (tasks?.length) lines.push(`${header}:`, ...tasks.map(formatListLine));
	};
	for (const [graph, tasks] of groups) section(graph, tasks);
	section("no graph", ungrouped);
	section("closed", closed);
	return lines.join("\n");
}

/**
 * `get` shows the local id and stable uid on the first line, followed by the set fields.
 */
function formatGetLines(task: Task, state: TaskState): string {
	const blocks = deriveBlocks(state.tasks).get(task.id) ?? [];
	const lines = [`#${task.id} [${task.status}] ${sanitizeTerminalText(task.subject)}${resultSuffix(task)}`];
	if (task.description) lines.push(`  description: ${sanitizeTerminalText(task.description)}`);
	if (task.activeForm) lines.push(`  activeForm: ${sanitizeTerminalText(task.activeForm)}`);
	if (task.blockedBy?.length) {
		lines.push(`  blockedBy: ${task.blockedBy.map((id) => `#${id}`).join(", ")}`);
	}
	if (blocks.length) {
		lines.push(`  blocks: ${blocks.map((id) => `#${id}`).join(", ")}`);
	}
	if (task.owner) lines.push(`  owner: ${sanitizeTerminalText(task.owner)}`);
	if (task.points !== undefined) lines.push(`  points: ${task.points}`);
	if (task.anchor) lines.push(`  anchor: ${sanitizeTerminalText(task.anchor)}`);
	if (task.graph) lines.push(`  graph: ${task.graph}`);
	const spend = spendLine((task.metadata?.herdr as { spend?: unknown } | undefined)?.spend);
	if (spend) lines.push(`  spend: ${spend}`);
	for (const e of task.evidence ?? []) {
		const sha = e.sha ? ` @${sanitizeTerminalText(e.sha)}` : "";
		lines.push(`  evidence: ${e.result} ${sanitizeTerminalText(e.command)}${sha} (${sanitizeTerminalText(e.at)})`);
	}
	return lines.join("\n");
}

/**
 * Pure formatter: `(op, state) → string`. Closed switch on `op.kind` —
 * adding a new `Op` variant fails to compile here until a branch is added.
 */
export function formatContent(op: Op, state: TaskState): string {
	switch (op.kind) {
		case "create": {
			// Defensive — each `op.taskIds` entry resolves on the success path.
			return op.taskIds
				.map((id) => {
					const created = state.tasks.find((x) => x.id === id);
					if (!created) return `Created #${id}`;
					return `Created #${created.id}: ${sanitizeTerminalText(created.subject)} (pending)${resultSuffix(created)}`;
				})
				.join("\n");
		}
		case "update": {
			const suffix = resultSuffix(state.tasks.find(t => t.id === op.id)!);
			if (!op.changed) {
				return `No change: #${op.id} already matches the requested values (status: ${op.toStatus})${suffix}`;
			}
			const transition = op.fromStatus !== op.toStatus ? ` (${op.fromStatus} → ${op.toStatus})` : "";
			return `Updated #${op.id}${transition}${suffix}`;
		}
		case "delete":
			return `Deleted #${op.id}: ${sanitizeTerminalText(op.subject)}`;
		case "import":
			return `Imported ${state.tasks.length} tasks`;
		case "clear":
			return `Cleared ${op.count} tasks`;
		case "list": {
			let view = state.tasks;
			if (!op.includeDeleted) view = view.filter((t) => t.status !== "deleted");
			if (op.statusFilter) view = view.filter((t) => t.status === op.statusFilter);
			return view.length === 0 ? "No tasks" : formatList(view);
		}
		case "get":
			return formatGetLines(op.task, state);
		case "error":
			return `Error: ${op.message}`;
	}
}

/**
 * Build the LLM-facing tool envelope after the store has committed the
 * reducer's new state. `details` is the persistence + replay snapshot —
 * `state/replay.ts` consumes this exact shape on session lifecycle events.
 *
 * Mirrors `packages/rpiv-ask-user-question/tool/response-envelope.ts:13-47`.
 */
export function buildToolResult(
	action: TaskAction,
	params: TaskMutationParams,
	state: TaskState,
	op: Op,
): { content: Array<{ type: "text"; text: string }>; details: TaskDetails } {
	const text = formatContent(op, state);
	const details: TaskDetails = {
		action,
		params: structuredClone(params) as Record<string, unknown>,
		// An independent copy: callers (renderers, scripts, other extensions) may hold or
		// change `details`, and must not reach the live store through it.
		tasks: structuredClone(state.tasks),
		nextId: state.nextId,
		...(op.kind === "error" ? { error: op.message } : {}),
	};
	return { content: [{ type: "text", text }], details };
}
