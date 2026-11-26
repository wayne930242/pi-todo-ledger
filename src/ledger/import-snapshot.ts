import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { TaskState } from "../state/state.ts";
import { withLegacyGraph } from "../state/state-reducer.ts";
import { isSnapshotV1 } from "./schema.ts";
import { readSessionSnapshot } from "./session-source.ts";

/** Where an import reads from: a snapshot file, or another session's latest snapshot entry. */
export interface ImportSource {
	path?: string;
	/** A full or unique-prefix session id, or a session `.jsonl` path. */
	session?: string;
	/** The importing session's id, never matched by `session`. */
	self: string;
}

/** Prepare the imported state without writing it; the caller holds the session lock. */
export async function readImport(before: TaskState, cwd: string, source: ImportSource, signal?: AbortSignal): Promise<TaskState> {
	if (before.tasks.length) throw new Error(`import needs an empty list; this list has ${before.tasks.length} tasks`);
	const { path, session } = source;
	if (path && session) throw new Error("import takes path or session, not both");
	let snapshot: unknown;
	if (session) snapshot = await readSessionSnapshot(session, cwd, source.self, signal);
	else if (!path) throw new Error("path or session required for import");
	else {
		const raw = await readFile(resolve(cwd, path), { encoding: "utf8", signal });
		try {
			snapshot = JSON.parse(raw);
		} catch {
			throw new Error("import file is not valid JSON");
		}
	}
	if (!isSnapshotV1(snapshot)) throw new Error("import file does not match the todo/v1 snapshot schema");
	const ids = new Set<number>();
	const uids = new Set<string>();
	for (const { id, uid } of snapshot.tasks) {
		if (ids.has(id)) throw new Error(`duplicate task id #${id}`);
		if (uid !== undefined) {
			if (uids.has(uid)) throw new Error(`duplicate task uid ${uid} (#${id})`);
			uids.add(uid);
		}
		if (snapshot.nextId <= id) throw new Error(`nextId must be greater than task id #${id}`);
		ids.add(id);
	}
	for (const task of snapshot.tasks) {
		for (const dep of task.blockedBy ?? []) {
			if (!ids.has(dep)) throw new Error(`#${task.id} blockedBy: #${dep} not found`);
		}
	}
	const origin = snapshot.sessionId;
	const tasks = snapshot.tasks.map(task => withLegacyGraph(origin ? { ...task, origin: { session: origin } } : task));
	return { tasks, nextId: snapshot.nextId };
}
