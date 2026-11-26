import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { load, snapshots, text } from "./harness.ts";

const A = "01a2aaaa-1111-7000-8000-000000000001";
const B = "01a2aaaa-2222-7000-8000-000000000002";
const EMPTY = "01a2cccc-3333-7000-8000-000000000003";
const kept = [{ id: 1, subject: "Plan", status: "in_progress", graph: "single-loop" }, { id: 2, subject: "Next", status: "pending" }];
const abandoned = [{ id: 1, subject: "Abandoned", status: "pending" }];

const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const header = (id: string) => line({ type: "session", version: 3, id, timestamp: "2026-11-25T10:00:00.000Z", cwd: "/old" });
const snapshotEntry = (id: string, parentId: string, tasks: unknown[], nextId: number, sessionId?: string) =>
	line({ type: "custom", id, parentId, timestamp: "2026-11-25T10:00:01.000Z", customType: "todo/v1",
		data: { v: 1, ...(sessionId ? { sessionId } : {}), tasks, nextId } });
const message = (id: string, parentId: string) =>
	line({ type: "message", id, parentId, timestamp: "2026-11-25T10:00:02.000Z", message: { role: "user", content: "hi" } });

/** Session A: its current branch ends on the first snapshot; a later snapshot sits on an abandoned branch. */
const sessionA =
	header(A) + message("e1", null as never) + snapshotEntry("e2", "e1", [{ id: 9, subject: "Old", status: "pending" }], 10, A) +
	snapshotEntry("e3", "e2", kept, 3, A) + snapshotEntry("e4", "e3", abandoned, 2, A) + message("e5", "e3");

function setup(t: TestContext, env: "agent" | "session-dir" = "agent") {
	const root = mkdtempSync(join(tmpdir(), "todo-session-import-"));
	const saved = { agent: process.env.PI_CODING_AGENT_DIR, sessions: process.env.PI_CODING_AGENT_SESSION_DIR };
	t.after(() => {
		for (const [key, value] of [["PI_CODING_AGENT_DIR", saved.agent], ["PI_CODING_AGENT_SESSION_DIR", saved.sessions]] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	});
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	let dir: string;
	if (env === "agent") {
		delete process.env.PI_CODING_AGENT_SESSION_DIR;
		dir = join(root, "agent", "sessions", "--old--");
	} else {
		dir = join(root, "custom-sessions");
		process.env.PI_CODING_AGENT_SESSION_DIR = dir;
	}
	mkdirSync(dir, { recursive: true });
	const fileA = join(dir, `2026-11-25T10-00-00-000Z_${A}.jsonl`);
	writeFileSync(fileA, sessionA);
	writeFileSync(join(dir, `2026-11-25T11-00-00-000Z_${B}.jsonl`), header(B) + message("f1", null as never) + snapshotEntry("f2", "f1", abandoned, 2));
	writeFileSync(join(dir, `2026-11-25T12-00-00-000Z_${EMPTY}.jsonl`), header(EMPTY) + message("g1", null as never));
	const cwd = join(root, "work");
	mkdirSync(cwd);
	return { h: load({ cwd }), fileA, root };
}

const expected = (session: string) => kept.map((task) => ({ ...task, origin: { session } }));

test("import by full session id restores that session's latest snapshot on its current branch", async (t) => {
	const { h } = setup(t);
	assert.equal(text(await h.call({ action: "import", session: A })), "Imported 2 tasks");
	assert.deepEqual(snapshots(h.branch), [{ v: 1, sessionId: h.sessionId, tasks: expected(A), nextId: 3 }]);
	assert.match(text(await h.call({ action: "create", subject: "More" })), /Created #3:/);
});

test("import by a unique id prefix, and from PI_CODING_AGENT_SESSION_DIR", async (t) => {
	const { h } = setup(t, "session-dir");
	assert.equal(text(await h.call({ action: "import", session: "01a2aaaa-1" })), "Imported 2 tasks");
	assert.deepEqual(snapshots(h.branch)[0]!.tasks, expected(A));
});

test("import by a session .jsonl path; a snapshot without sessionId takes the session's own id", async (t) => {
	const { h, fileA, root } = setup(t);
	assert.equal(text(await h.call({ action: "import", session: fileA })), "Imported 2 tasks");
	assert.deepEqual(snapshots(h.branch)[0]!.tasks, expected(A));
	const other = load({ cwd: root });
	assert.equal(text(await other.call({ action: "import", session: B })), "Imported 1 tasks");
	assert.deepEqual(snapshots(other.branch)[0]!.tasks, abandoned.map((task) => ({ ...task, origin: { session: B } })));
});

test("ambiguous, unknown, snapshot-less, and conflicting session imports are refused and change nothing", async (t) => {
	const { h } = setup(t);
	const cases: [Record<string, unknown>, RegExp][] = [
		[{ session: "01a2aaaa" }, new RegExp(`session 01a2aaaa is ambiguous: ${A}, ${B}`)],
		[{ session: "01a2ffff" }, /no session 01a2ffff/],
		[{ session: "missing.jsonl" }, /ENOENT/],
		[{ session: EMPTY }, new RegExp(`session ${EMPTY} has no todo/v1 snapshot`)],
		[{ session: A, path: "handover.json" }, /path or session, not both/],
		[{ session: "" }, /path or session required for import/],
	];
	for (const [params, reason] of cases) {
		const result = await h.call({ action: "import", ...params });
		assert.ok(result.isError, JSON.stringify(params));
		assert.match(text(result), reason);
	}
	assert.deepEqual(snapshots(h.branch), []);
});

test("session import needs an empty list", async (t) => {
	const { h } = setup(t);
	await h.call({ action: "create", subject: "Existing" });
	const result = await h.call({ action: "import", session: A });
	assert.ok(result.isError);
	assert.match(text(result), /empty list; this list has 1 tasks/);
	assert.equal(snapshots(h.branch).length, 1);
});
