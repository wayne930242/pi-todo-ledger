import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { SNAPSHOT_ENTRY_TYPE } from "./contract.ts";
import { isSnapshotV1 } from "./schema.ts";

/** Pi's session directories: `PI_CODING_AGENT_SESSION_DIR` when set, and `<agent dir>/sessions`. */
async function sessionRoots(): Promise<string[]> {
	const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
	const custom = process.env.PI_CODING_AGENT_SESSION_DIR;
	const roots = [...(custom ? [custom.replace(/^~(?=$|[\\/])/, homedir())] : []), join(getAgentDir(), "sessions")];
	return [...new Set(roots.map((root) => resolve(root)))];
}

/** Session files (`<time>_<id>.jsonl`) directly in a root or one directory below it, by session id. */
async function sessionFiles(roots: string[], signal?: AbortSignal): Promise<Map<string, string>> {
	const files = new Map<string, string>();
	const add = (dir: string, name: string) => {
		const match = /_([^_]+)\.jsonl$/.exec(name);
		if (match && !files.has(match[1]!)) files.set(match[1]!, join(dir, name));
	};
	const list = (dir: string) => readdir(dir, { withFileTypes: true }).catch(() => []);
	for (const root of roots) {
		for (const entry of await list(root)) {
			signal?.throwIfAborted();
			if (entry.isFile()) add(root, entry.name);
			else if (entry.isDirectory()) {
				const dir = join(root, entry.name);
				for (const child of await list(dir)) if (child.isFile()) add(dir, child.name);
			}
		}
	}
	return files;
}

/** The session file a `session` import names: a `.jsonl` path, or a full or unique-prefix session id. */
async function resolveSessionFile(session: string, cwd: string, self: string, signal?: AbortSignal): Promise<string> {
	if (session.endsWith(".jsonl") || session.includes("/") || session.includes(sep)) return resolve(cwd, session);
	const roots = await sessionRoots();
	const files = await sessionFiles(roots, signal);
	files.delete(self);
	const exact = files.get(session);
	if (exact) return exact;
	const matches = [...files.keys()].filter((id) => id.startsWith(session)).sort();
	if (matches.length === 0) throw new Error(`no session ${session} in ${roots.join(", ")}`);
	if (matches.length > 1) throw new Error(`session ${session} is ambiguous: ${matches.join(", ")}`);
	return files.get(matches[0]!)!;
}

type Entry = { type?: string; id?: string; parentId?: string | null; customType?: string; data?: unknown };

/**
 * The newest valid `todo/v1` snapshot on the current branch of a session file
 * (the branch ending at its last entry), stamped with the source session's id
 * when the snapshot does not carry one. Unvalidated beyond the schema; the
 * caller checks it as it checks a snapshot file.
 */
export async function readSessionSnapshot(session: string, cwd: string, self: string, signal?: AbortSignal): Promise<unknown> {
	const file = await resolveSessionFile(session, cwd, self, signal);
	const entries: Entry[] = [];
	for (const line of (await readFile(file, { encoding: "utf8", signal })).split("\n")) {
		if (!line.trim()) continue;
		try {
			entries.push(JSON.parse(line) as Entry);
		} catch {
			// Pi skips a malformed line too.
		}
	}
	const header = entries.find((entry) => entry.type === "session");
	const id = header?.id ?? /_([^_]+)\.jsonl$/.exec(file)?.[1] ?? session;
	const byId = new Map(entries.filter((entry) => entry.id && entry.type !== "session").map((entry) => [entry.id!, entry]));
	let cursor = [...byId.values()].at(-1);
	const seen = new Set<string>();
	while (cursor && !seen.has(cursor.id!)) {
		seen.add(cursor.id!);
		if (cursor.type === "custom" && cursor.customType === SNAPSHOT_ENTRY_TYPE && isSnapshotV1(cursor.data)) {
			return cursor.data.sessionId ? cursor.data : { ...cursor.data, sessionId: id };
		}
		cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
	}
	throw new Error(`session ${id} has no todo/v1 snapshot`);
}
