import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { TaskState } from "../state/state.ts";
import { isSnapshotV1 } from "./schema.ts";

/** Prepare the imported state without writing it; the caller holds the session lock. */
export async function readImport(before: TaskState, cwd: string, path?: string, signal?: AbortSignal): Promise<TaskState> {
	if (before.tasks.length) throw new Error(`import needs an empty list; this list has ${before.tasks.length} tasks`);
	if (!path) throw new Error("path required for import");
	const raw = await readFile(resolve(cwd, path), { encoding: "utf8", signal });
	let snapshot: unknown;
	try {
		snapshot = JSON.parse(raw);
	} catch {
		throw new Error("import file is not valid JSON");
	}
	if (!isSnapshotV1(snapshot)) throw new Error("import file does not match the todo/v1 snapshot schema");
	const ids = new Set<number>();
	for (const { id } of snapshot.tasks) {
		if (ids.has(id)) throw new Error(`duplicate task id #${id}`);
		if (snapshot.nextId <= id) throw new Error(`nextId must be greater than task id #${id}`);
		ids.add(id);
	}
	for (const task of snapshot.tasks) {
		for (const dep of task.blockedBy ?? []) {
			if (!ids.has(dep)) throw new Error(`#${task.id} blockedBy: #${dep} not found`);
		}
	}
	const session = snapshot.sessionId;
	const tasks = session ? snapshot.tasks.map(task => ({ ...task, origin: { session } })) : snapshot.tasks;
	return { tasks, nextId: snapshot.nextId };
}
