import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { TodoChangeV1 } from "../src/ledger/contract.ts";
import { load, snapshots, text } from "./harness.ts";

const tasks = [
	{ id: 3, subject: "First", status: "deleted", metadata: { train: 1 } },
	{ id: 8, subject: "Second", status: "in_progress", blockedBy: [3], owner: "worker", description: "Details",
		activeForm: "testing", metadata: { train: 2 }, points: 0, anchor: "npm test",
		evidence: [{ command: "npm test", sha: "abc", result: "pass", at: "2025-11-25T20:00:00+08:00" }] },
];
const snapshot = { v: 1, nextId: 15, tasks };
const params = { action: "import", path: "handover.json" };

function setup(t: TestContext) {
	const cwd = mkdtempSync(join(tmpdir(), "todo-import-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const file = join(cwd, params.path);
	writeFileSync(file, JSON.stringify(snapshot));
	return { h: load({ cwd }), file };
}

test("import commits one verbatim snapshot and replay restores its tasks and nextId", async (t) => {
	const { h, file } = setup(t);
	const validations: unknown[] = [];
	h.emit("todo:namespace", { v: 1, ns: "train", validate: (value: unknown, task: { id: number }, op: string) => {
		validations.push([value, task.id, op]);
	} });
	assert.equal(text(await h.call(params)), "Imported 2 tasks");
	assert.deepEqual(validations, [[1, 3, "create"], [2, 8, "create"]]);
	assert.deepEqual(snapshots(h.branch), [snapshot]);
	assert.deepEqual(h.events("todo:changed"), [{ v: 1, sessionId: h.sessionId, tasks }]);
	rmSync(file);
	const restarted = load({ branch: [{ type: "custom", customType: "todo/v1", data: snapshots(h.branch)[0] }] });
	await restarted.fire("session_start");
	assert.deepEqual(restarted.events("todo:changed"), [{ v: 1, sessionId: restarted.sessionId, tasks }]);
	assert.match(text(await restarted.call({ action: "create", subject: "Next" })), /Created #15:/);
});

test("import refuses even a list containing only a tombstone", async (t) => {
	const { h } = setup(t);
	await h.call({ action: "create", subject: "Existing" });
	await h.call({ action: "delete", id: 1 });
	const before = snapshots(h.branch);
	const result = await h.call(params);
	assert.ok(result.isError);
	assert.match(text(result), /empty list; this list has 1 tasks/);
	assert.deepEqual(snapshots(h.branch), before);
	assert.equal(h.events("todo:changed").length, 2);
});

test("missing, malformed or inconsistent snapshots leave the list untouched", async (t) => {
	const { h, file } = setup(t);
	const cases: [string | undefined, RegExp][] = [
		[undefined, /ENOENT/], ["{", /JSON/], [JSON.stringify({ ...snapshot, v: 2 }), /schema/],
		[JSON.stringify({ ...snapshot, tasks: [tasks[1]] }), /blockedBy: #3 not found/],
		[JSON.stringify({ ...snapshot, tasks: [tasks[0], tasks[0]] }), /duplicate/],
		[JSON.stringify({ ...snapshot, nextId: 8 }), /nextId/],
	];
	for (const [contents, reason] of cases) {
		if (contents === undefined) rmSync(file);
		else writeFileSync(file, contents);
		const result = await h.call(params);
		assert.ok(result.isError);
		assert.match(text(result), reason);
	}
	assert.deepEqual(snapshots(h.branch), []);
	assert.deepEqual(h.events("todo:changed"), []);
	assert.equal(text(await h.call({ action: "list", includeDeleted: true })), "No tasks");
});

test("guard can refuse the whole import as one create without committing", async (t) => {
	const { h } = setup(t);
	const changes: TodoChangeV1[] = [];
	h.emit("todo:guard", { v: 1, id: "policy", check: (change: TodoChangeV1) => {
		changes.push(change);
		return "not allowed";
	} });
	const result = await h.call(params);
	assert.ok(result.isError);
	assert.match(text(result), /guard policy refused: not allowed/);
	assert.deepEqual(changes, [{ op: "create", params, before: [], after: tasks, sessionId: h.sessionId, cwd: h.ctx.cwd }]);
	assert.deepEqual(snapshots(h.branch), []);
	assert.deepEqual(h.events("todo:changed"), []);
	assert.equal(text(await h.call({ action: "list" })), "No tasks");
});
