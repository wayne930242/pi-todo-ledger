import { isGraph, type Task } from "../tool/types.ts";
import { isOpen } from "./task-labels.ts";

export interface PlanRow {
	depth: number;
	graph?: Task["graph"];
	otherBlockers: number[];
	/** A cross-edge interrupted the displayed branch; identify the parent explicitly. */
	resumeParent?: number;
}

/** Read-only projection shared by the widget and /todos. Edges to finished work don't indent a row. */
export function planView(tasks: readonly Task[]) {
	const open = tasks.filter(isOpen).sort((a, b) => a.id - b.id);
	const graph = open[0]?.graph;
	const sharedGraph = isGraph(graph) && open.every(task => task.graph === graph) ? graph : undefined;
	const byId = new Map(open.map(task => [task.id, task]));
	const rows = new Map<number, PlanRow>();
	// Only the mutation and import paths enforce unique ids; don't traverse ambiguous legacy edges.
	if (byId.size !== open.length) return { ordered: open, sharedGraph, rows };
	const blockers = new Map<number, number[]>();
	const children = new Map<number, Task[]>();
	const roots: Task[] = [];
	for (const task of open) {
		const deps = (task.blockedBy ?? []).filter(id => byId.has(id));
		blockers.set(task.id, deps);
		if (!deps.length) roots.push(task);
		else {
			const siblings = children.get(deps[0]) ?? [];
			siblings.push(task);
			children.set(deps[0], siblings);
		}
	}

	// Visit first-parent subtrees in id order. For a join, emit any remaining prerequisites
	// before the joined row. Iterative even for a long chain restored from a snapshot.
	const ordered: Task[] = [];
	const reached = new Set<number>();
	const ancestry: number[] = [];
	const branches = roots.slice().reverse();
	while (branches.length) {
		const branch = branches.pop()!;
		const siblings = children.get(branch.id) ?? [];
		for (let i = siblings.length - 1; i >= 0; i--) branches.push(siblings[i]);
		const stack = [{ task: branch, emit: false }];
		while (stack.length) {
			const { task, emit } = stack.pop()!;
			const deps = blockers.get(task.id)!;
			if (!emit) {
				if (reached.has(task.id)) continue;
				reached.add(task.id);
				stack.push({ task, emit: true });
				for (let i = deps.length - 1; i >= 0; i--) {
					if (!reached.has(deps[i])) stack.push({ task: byId.get(deps[i])!, emit: false });
				}
				continue;
			}
			const parent = rows.get(deps[0]);
			const depth = parent ? parent.depth + 1 : 0;
			const resumeParent = parent && ancestry[depth - 1] !== deps[0] ? deps[0] : undefined;
			rows.set(task.id, {
				depth, otherBlockers: deps.slice(1), resumeParent,
				graph: !depth && !sharedGraph && isGraph(task.graph) ? task.graph : undefined,
			});
			if (resumeParent !== undefined) ancestry.length = 0;
			ancestry.length = depth;
			ancestry[depth] = task.id;
			ordered.push(task);
		}
	}
	// Replay predates cycle checks. Never hide a historical row we couldn't place in a tree.
	for (const task of open) if (!rows.has(task.id)) ordered.push(task);
	return { ordered, rows, sharedGraph };
}
