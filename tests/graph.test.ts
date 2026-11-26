import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isSnapshotV1 } from "../src/ledger/schema.ts";
import { replayFromBranch } from "../src/state/replay.ts";
import { load, snapshots, text } from "./harness.ts";

const NAMES = /single-loop, fan-out\/fan-in, or orchestrator-worker/;
const last = (h: ReturnType<typeof load>) => snapshots(h.branch).at(-1)!.tasks;
const branchOf = (entries: unknown[]) => ({ sessionManager: { getBranch: () => entries } });

test("graph is set on create, single and batch, and shown by get", async () => {
	const h = load();
	await h.call({ action: "create", subject: "Plan A", graph: "single-loop" });
	await h.call({ action: "create", tasks: [{ subject: "B1", graph: "fan-out/fan-in" }, { subject: "B2" }] });
	assert.deepEqual(last(h).map((t) => t.graph), ["single-loop", "fan-out/fan-in", undefined]);
	assert.ok(isSnapshotV1(snapshots(h.branch).at(-1)));
	assert.match(text(await h.call({ action: "get", id: 2 })), /^ {2}graph: fan-out\/fan-in$/m);
	assert.doesNotMatch(text(await h.call({ action: "get", id: 3 })), /graph/);
});

test("a graph outside the three names is refused with the names, and nothing commits", async () => {
	const h = load();
	await h.call({ action: "create", subject: "Plan" });
	const calls = [
		{ action: "create", subject: "X", graph: "pipeline" },
		{ action: "create", tasks: [{ subject: "Y", graph: "fan-out" }] },
		{ action: "update", id: 1, graph: "single" },
		{ action: "update", id: 1, graph: 3 },
		{ action: "create", subject: "Z", graph: null },
	];
	for (const params of calls) {
		const result = await h.call(params);
		assert.ok(result.isError, JSON.stringify(params));
		assert.match(text(result), NAMES);
	}
	assert.equal(snapshots(h.branch).length, 1);
});

test("graph on a batch create belongs to each item, not the top level", async () => {
	const h = load();
	const result = await h.call({ action: "create", graph: "single-loop", tasks: [{ subject: "A" }] });
	assert.ok(result.isError);
	assert.match(text(result), /graph on each item/);
});

test("update replaces graph, null clears it, and the same value is no change", async () => {
	const h = load();
	await h.call({ action: "create", subject: "Plan", graph: "single-loop" });
	assert.equal(text(await h.call({ action: "update", id: 1, graph: "orchestrator-worker" })), "Updated #1");
	assert.equal(last(h)[0]!.graph, "orchestrator-worker");
	assert.match(text(await h.call({ action: "update", id: 1, graph: "orchestrator-worker" })), /^No change/);
	assert.equal(text(await h.call({ action: "update", id: 1, graph: null })), "Updated #1");
	assert.equal("graph" in last(h)[0]!, false);
	assert.match(text(await h.call({ action: "update", id: 1, graph: null })), /^No change/);
});

test("list groups open tasks by graph, ungrouped then closed last; without graphs it is unchanged", async () => {
	const h = load();
	await h.call({ action: "create", tasks: [{ subject: "A" }, { subject: "B" }] });
	assert.equal(text(await h.call({ action: "list" })), "[pending] #1 A\n[pending] #2 B");
	await h.call({
		action: "create",
		tasks: [
			{ subject: "C", graph: "fan-out/fan-in" },
			{ subject: "D", graph: "single-loop" },
			{ subject: "E", graph: "fan-out/fan-in" },
			{ subject: "F", graph: "single-loop" },
		],
	});
	await h.call({ action: "update", id: 6, status: "in_progress" });
	await h.call({ action: "update", id: 6, status: "completed" });
	assert.equal(
		text(await h.call({ action: "list" })),
		[
			"fan-out/fan-in:",
			"[pending] #3 C",
			"[pending] #5 E",
			"single-loop:",
			"[pending] #4 D",
			"no graph:",
			"[pending] #1 A",
			"[pending] #2 B",
			"closed:",
			"[completed] #6 F",
		].join("\n"),
	);
	assert.equal(text(await h.call({ action: "list", status: "completed" })), "[completed] #6 F");
});

test("old states without graph load unchanged; a valid legacy metadata.graph is read as graph", () => {
	const plain = { id: 1, subject: "Old", status: "pending", metadata: { train: 1 } };
	const legacy = { id: 2, subject: "Legacy", status: "pending", metadata: { graph: "orchestrator-worker" } };
	const invalid = { id: 3, subject: "Alias", status: "pending", metadata: { graph: "fan-out" } };
	const explicit = { id: 4, subject: "Both", status: "pending", graph: "single-loop", metadata: { graph: "fan-out/fan-in" } };
	const data = { v: 1, tasks: [plain, legacy, invalid, explicit], nextId: 5 };
	const entry = { type: "custom", customType: "todo/v1", data };
	const before = structuredClone(data);
	const state = replayFromBranch(branchOf([entry]));
	assert.deepEqual(state.tasks, [plain, { ...legacy, graph: "orchestrator-worker" }, invalid, explicit]);
	// History is not rewritten.
	assert.deepEqual(data, before);
	// Rpiv-era records migrate the same way.
	const rpiv = replayFromBranch(
		branchOf([{ type: "custom", customType: "rpiv-todo-state", data: { action: "create", params: {}, tasks: [legacy], nextId: 3 } }]),
	);
	assert.equal(rpiv.tasks[0]!.graph, "orchestrator-worker");
});

test("a snapshot with an invalid graph does not match the schema", () => {
	assert.equal(isSnapshotV1({ v: 1, tasks: [{ id: 1, subject: "x", status: "pending", graph: "pipeline" }], nextId: 2 }), false);
});

test("graph survives replay in a new session and handover import, and import migrates legacy metadata.graph", async (t) => {
	const source = load();
	await source.call({ action: "create", subject: "Plan", graph: "fan-out/fan-in" });
	const restarted = load({ branch: [...source.branch] });
	await restarted.fire("session_start");
	assert.match(text(await restarted.call({ action: "get", id: 1 })), /graph: fan-out\/fan-in/);

	const cwd = mkdtempSync(join(tmpdir(), "todo-graph-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const saved = snapshots(source.branch).at(-1)!;
	saved.tasks.push({ id: 2, subject: "Legacy", status: "pending", metadata: { graph: "single-loop" } });
	saved.nextId = 3;
	writeFileSync(join(cwd, "handover.json"), JSON.stringify(saved));
	const dest = load({ cwd });
	assert.equal(text(await dest.call({ action: "import", path: "handover.json" })), "Imported 2 tasks");
	assert.deepEqual(last(dest).map((task) => task.graph), ["fan-out/fan-in", "single-loop"]);
	assert.deepEqual(last(dest)[1]!.metadata, { graph: "single-loop" });
});
