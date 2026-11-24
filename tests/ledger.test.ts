import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { compile } from "@earendil-works/pi-schema";
import { replayFromBranch } from "../src/state/replay.ts";
import { load, snapshots, text } from "./harness.ts";

const schema = JSON.parse(readFileSync(new URL("../schema/todo-v1.schema.json", import.meta.url), "utf8"));
const snapshotSchema = compile(schema);
const changedSchema = compile({ $ref: "#/$defs/changedEvent", $defs: schema.$defs });

function assertValid(validator: ReturnType<typeof compile>, value: unknown): void {
	assert.deepEqual(validator.errors(value), [], JSON.stringify(value));
}

const branchOf = (entries: unknown[]) => ({ sessionManager: { getBranch: () => entries } });
const legacyTask = { id: 1, subject: "Legacy task", status: "in_progress", activeForm: "porting", owner: "w1" };

// ---------------------------------------------------------------------------
// Replay and migration
// ---------------------------------------------------------------------------

test("replay reads rpiv-todo-state entries when the branch has no todo/v1 entry", () => {
	const state = replayFromBranch(
		branchOf([
			{ type: "custom", customType: "rpiv-todo-state", data: { action: "create", params: {}, tasks: [], nextId: 1 } },
			{
				type: "custom",
				customType: "rpiv-todo-state",
				data: { action: "create", params: {}, tasks: [legacyTask], nextId: 2 },
			},
			// A later rpiv toolResult never outranks a state entry.
			{
				type: "message",
				message: { role: "toolResult", toolName: "todo", details: { action: "clear", params: {}, tasks: [], nextId: 1 } },
			},
		]),
	);
	assert.deepEqual(state, { tasks: [legacyTask], nextId: 2 });
});

test("replay falls back to todo toolResult details in sessions older than state entries", () => {
	const state = replayFromBranch(
		branchOf([
			{
				type: "message",
				message: { role: "toolResult", toolName: "todo", details: { action: "create", params: {}, tasks: [legacyTask], nextId: 2 } },
			},
			{ type: "message", message: { role: "toolResult", toolName: "other", details: { tasks: [], nextId: 1 } } },
		]),
	);
	assert.deepEqual(state, { tasks: [legacyTask], nextId: 2 });
});

test("replay prefers the newest valid todo/v1 entry over rpiv records and skips invalid snapshots", () => {
	const v1Task = { id: 1, subject: "V1 task", status: "pending", points: 2 };
	const state = replayFromBranch(
		branchOf([
			{ type: "custom", customType: "todo/v1", data: { v: 1, tasks: [v1Task], nextId: 2 } },
			{ type: "custom", customType: "rpiv-todo-state", data: { action: "create", params: {}, tasks: [legacyTask], nextId: 5 } },
			// Out-of-range points: the whole snapshot is skipped.
			{ type: "custom", customType: "todo/v1", data: { v: 1, tasks: [{ ...v1Task, points: 11 }], nextId: 2 } },
			// Wrong version: skipped.
			{ type: "custom", customType: "todo/v1", data: { v: 2, tasks: [], nextId: 1 } },
		]),
	);
	assert.deepEqual(state, { tasks: [v1Task], nextId: 2 });
});

test("replay skips every todo/v1 snapshot the JSON schema rejects", () => {
	const good = { v: 1, tasks: [{ id: 1, subject: "Good", status: "pending" }], nextId: 2 };
	const task = good.tasks[0];
	const bad = [
		{ ...good, tasks: [{ ...task, id: 0 }] },
		{ ...good, nextId: 0 },
		{ ...good, tasks: [{ ...task, metadata: [] }] },
		{ ...good, tasks: [{ ...task, anchor: "" }] },
		{ ...good, tasks: [{ ...task, evidence: [{ command: "", result: "pass", at: "2026-11-24T00:00:00.000Z" }] }] },
		{ ...good, tasks: [{ ...task, blockedBy: [0] }] },
	];
	for (const snapshot of bad) {
		assert.notDeepEqual(snapshotSchema.errors(snapshot), [], `schema rejects ${JSON.stringify(snapshot)}`);
		const state = replayFromBranch(
			branchOf([
				{ type: "custom", customType: "todo/v1", data: good },
				{ type: "custom", customType: "todo/v1", data: snapshot },
			]),
		);
		assert.deepEqual(state, { tasks: good.tasks, nextId: 2 }, JSON.stringify(snapshot));
	}
});

test("a session started under rpiv-todo keeps its list and continues in todo/v1", async () => {
	const h = load({
		branch: [
			{ type: "custom", customType: "rpiv-todo-state", data: { action: "create", params: {}, tasks: [legacyTask], nextId: 2 } },
		],
	});
	await h.fire("session_start");
	await h.call({ action: "update", id: 1, status: "completed" });
	const [snapshot] = snapshots(h.branch);
	assert.deepEqual(snapshot, { v: 1, tasks: [{ ...legacyTask, status: "completed" }], nextId: 2 });
	assert.equal(
		h.branch.filter((e) => (e as { customType?: string }).customType === "rpiv-todo-state").length,
		1,
		"no new rpiv-todo-state entries are written",
	);
});

// ---------------------------------------------------------------------------
// todo/v1 round trip
// ---------------------------------------------------------------------------

test("todo/v1 snapshots match the schema and replay to the same list in a new session", async () => {
	const h = load();
	await h.fire("session_start");
	await h.call({
		action: "create",
		subject: "Write replay tests",
		points: 1.5,
		anchor: "npm test",
		blockedBy: undefined,
		metadata: { team: { lane: "a" } },
		evidence: [{ command: "npm test", result: "fail", at: "2026-11-23T08:00:00.000Z" }],
	});
	await h.call({ action: "create", tasks: [{ subject: "Second", owner: "w2", points: 0 }, { subject: "Third" }] });
	await h.call({ action: "update", id: 3, addBlockedBy: [1], status: "in_progress", activeForm: "waiting" });
	await h.call({ action: "delete", id: 2 });
	await h.call({ action: "list" });

	const all = snapshots(h.branch);
	assert.equal(all.length, 4, "one entry per state-changing call; list writes none");
	for (const s of all) assertValid(snapshotSchema, s);

	const last = all.at(-1);
	assert.deepEqual(last, {
		v: 1,
		nextId: 4,
		tasks: [
			{
				id: 1,
				subject: "Write replay tests",
				status: "pending",
				metadata: { team: { lane: "a" } },
				points: 1.5,
				anchor: "npm test",
				evidence: [{ command: "npm test", result: "fail", at: "2026-11-23T08:00:00.000Z" }],
			},
			{ id: 2, subject: "Second", status: "deleted", owner: "w2", points: 0 },
			{ id: 3, subject: "Third", status: "in_progress", activeForm: "waiting", blockedBy: [1] },
		],
	});

	// A new session on the same branch restores exactly that list.
	const next = load({ branch: [...h.branch] });
	await next.fire("session_start");
	const [restored] = next.events("todo:changed") as Array<{ tasks: unknown }>;
	assert.deepEqual(restored?.tasks, last?.tasks);
	const got = await next.call({ action: "get", id: 1 });
	assert.match(text(got), /points: 1\.5/);
	assert.match(text(got), /anchor: npm test/);
	assert.match(text(got), /evidence: fail npm test \(2026-11-23T08:00:00\.000Z\)/);
});

test("tool result details do not alias live state", async () => {
	const h = load();
	const created = await h.call({ action: "create", subject: "Original", metadata: { k: 1 } });
	const details = created.details as { tasks: Array<{ subject: string; metadata: { k: number } }> };
	details.tasks[0]!.subject = "mutated";
	details.tasks[0]!.metadata.k = 2;
	const got = await h.call({ action: "get", id: 1 });
	assert.match(text(got), /Original/);
	assert.deepEqual((got.details as { tasks: Array<{ metadata: unknown }> }).tasks[0]?.metadata, { k: 1 });
});

test("a failed snapshot append leaves the list unchanged and emits nothing", async () => {
	let fail = false;
	const h = load({ failAppend: () => fail });
	await h.call({ action: "create", subject: "A" });
	fail = true;
	const failed = await h.call({ action: "update", id: 1, status: "completed" });
	assert.equal(failed.isError, true);
	assert.equal(text(failed), "disk full");
	assert.equal(h.events("todo:changed").length, 1, "only the first change was announced");
	fail = false;
	assert.match(text(await h.call({ action: "get", id: 1 })), /#1 \[pending\]/);
});

test("snapshot entries do not alias live state", async () => {
	const h = load();
	await h.call({ action: "create", subject: "A", metadata: { k: 1 } });
	const [first] = snapshots(h.branch);
	await h.call({ action: "update", id: 1, metadata: { k: 2 } });
	assert.deepEqual(first?.tasks[0]?.metadata, { k: 1 });
});

// ---------------------------------------------------------------------------
// todo:changed
// ---------------------------------------------------------------------------

test("todo:changed fires after every change with the full list, and not for reads or errors", async () => {
	const h = load();
	await h.call({ action: "create", subject: "A" });
	await h.call({ action: "update", id: 1, status: "in_progress" });
	await h.call({ action: "update", id: 1, status: "in_progress" }); // no change
	await h.call({ action: "get", id: 1 });
	await h.call({ action: "list" });
	await h.call({ action: "update", id: 99, status: "completed" }); // error
	await h.call({ action: "delete", id: 1 });
	await h.call({ action: "clear" });

	const changed = h.events("todo:changed") as Array<{ v: number; sessionId: string; tasks: Array<{ status: string }> }>;
	assert.deepEqual(
		changed.map((e) => e.tasks.map((t) => t.status)),
		[["pending"], ["in_progress"], ["deleted"], []],
	);
	for (const e of changed) {
		assertValid(changedSchema, e);
		assert.equal(e.sessionId, h.sessionId);
	}
});

test("todo:changed fires on session restore events with the replayed list", async () => {
	const h = load({
		branch: [{ type: "custom", customType: "todo/v1", data: { v: 1, tasks: [{ id: 1, subject: "Kept", status: "pending" }], nextId: 2 } }],
	});
	await h.fire("session_start");
	await h.fire("session_compact");
	await h.fire("session_tree");
	const changed = h.events("todo:changed") as Array<{ sessionId: string; tasks: Array<{ subject: string }> }>;
	assert.equal(changed.length, 3);
	for (const e of changed) assert.deepEqual(e, { v: 1, sessionId: h.sessionId, tasks: [{ id: 1, subject: "Kept", status: "pending" }] });
});

test("a listener mutating a todo:changed payload does not change the list", async () => {
	const h = load();
	h.bus.on("todo:changed", (e: { tasks: Array<{ subject: string }> }) => {
		for (const t of e.tasks) t.subject = "mutated";
	});
	await h.call({ action: "create", subject: "Original" });
	assert.match(text(await h.call({ action: "get", id: 1 })), /Original/);
});

// ---------------------------------------------------------------------------
// Namespaces
// ---------------------------------------------------------------------------

test("a namespace validator's refusal is a tool error and nothing commits", async () => {
	const h = load();
	await h.call({ action: "create", subject: "Train car", metadata: { train: { step: "build" } } });
	const seen: unknown[][] = [];
	h.emit("todo:namespace", {
		v: 1,
		ns: "train",
		validate: (value: unknown, task: { status: string }, op: string) => {
			seen.push([value, task.status, op]);
			const step = (value as { step?: string } | undefined)?.step;
			if (task.status === "completed" && step !== "merged") return "complete only after the merge step";
			return undefined;
		},
	});
	const entriesBefore = snapshots(h.branch).length;
	const changedBefore = h.events("todo:changed").length;

	const refused = await h.call({ action: "update", id: 1, status: "completed" });
	assert.equal(refused.isError, true);
	assert.equal(text(refused), "Error: metadata.train refused #1: complete only after the merge step");
	assert.deepEqual(seen.at(-1), [{ step: "build" }, "completed", "update"]);
	assert.equal(snapshots(h.branch).length, entriesBefore, "no snapshot written");
	assert.equal(h.events("todo:changed").length, changedBefore, "no change event");
	assert.match(text(await h.call({ action: "get", id: 1 })), /#1 \[pending\]/);

	const accepted = await h.call({ action: "update", id: 1, status: "completed", metadata: { train: { step: "merged" } } });
	assert.notEqual(accepted.isError, true);
	assert.equal(text(accepted), "Updated #1 (pending → completed)");
});

test("validators see creates, removals, and deletes; unknown namespaces pass", async () => {
	const h = load();
	const calls: Array<[unknown, string]> = [];
	h.emit("todo:namespace", {
		v: 1,
		ns: "owned",
		validate: (value: unknown, _task: unknown, op: string) => {
			calls.push([value, op]);
			return value === "bad" ? "bad value" : undefined;
		},
	});
	const batch = await h.call({
		action: "create",
		tasks: [{ subject: "ok", metadata: { owned: "fine" } }, { subject: "no", metadata: { owned: "bad" } }],
	});
	assert.equal(batch.isError, true);
	assert.equal(text(batch), "Error: metadata.owned refused #2: bad value");
	assert.equal(snapshots(h.branch).length, 0, "the whole batch is refused");

	const free = await h.call({ action: "create", subject: "free", metadata: { unregistered: "anything" } });
	assert.notEqual(free.isError, true);

	await h.call({ action: "create", subject: "owned", metadata: { owned: "fine" } });
	await h.call({ action: "update", id: 2, metadata: { owned: null } });
	await h.call({ action: "create", subject: "to delete", metadata: { owned: "x" } });
	await h.call({ action: "delete", id: 3 });
	assert.deepEqual(calls.slice(2), [
		["fine", "create"],
		[undefined, "update"],
		["x", "create"],
		["x", "delete"],
	]);
});

test("a throwing validator refuses the change", async () => {
	const h = load();
	h.emit("todo:namespace", {
		v: 1,
		ns: "strict",
		validate: () => {
			throw new Error("boom");
		},
	});
	const result = await h.call({ action: "create", subject: "x", metadata: { strict: 1 } });
	assert.equal(result.isError, true);
	assert.equal(text(result), "Error: metadata.strict refused #1: validator threw: boom");
});

test("owners that loaded first register on todo:ready; malformed registrations are ignored", async () => {
	const h = load({
		before: (early) => {
			early.bus.on("todo:ready", (ready: unknown) => {
				assert.deepEqual(ready, { v: 1 });
				early.emit("todo:namespace", { v: 1, ns: "early", validate: () => "refused by early owner" });
			});
		},
	});
	const warn = console.warn;
	console.warn = () => {};
	try {
		h.emit("todo:namespace", { v: 2, ns: "late", validate: () => "never" });
		h.emit("todo:namespace", { v: 1, ns: "", validate: () => "never" });
		h.emit("todo:namespace", { v: 1, ns: "late", validate: "not a function" });
	} finally {
		console.warn = warn;
	}
	assert.equal(text(await h.call({ action: "create", subject: "a", metadata: { early: true } })), "Error: metadata.early refused #1: refused by early owner");
	assert.notEqual((await h.call({ action: "create", subject: "b", metadata: { late: true } })).isError, true);
});

// ---------------------------------------------------------------------------
// Fields: points, anchor, evidence
// ---------------------------------------------------------------------------

test("evidence appends on update, oldest first, and at defaults to the call time", async () => {
	const h = load();
	await h.call({ action: "create", subject: "Fix bug", anchor: "npm test -- bug" });
	const before = Date.now();
	const first = await h.call({ action: "update", id: 1, evidence: [{ command: "npm test -- bug", result: "fail" }] });
	assert.equal(text(first), "Updated #1");
	await h.call({
		action: "update",
		id: 1,
		points: 2,
		evidence: [{ command: "npm test -- bug", sha: "abc1234", result: "pass", at: "2026-11-23T17:00:00+08:00" }],
	});
	const task = snapshots(h.branch).at(-1)?.tasks[0] as { evidence: Array<Record<string, string>>; points: number };
	assert.equal(task.points, 2);
	assert.equal(task.evidence.length, 2);
	assert.deepEqual(Object.keys(task.evidence[0] ?? {}), ["command", "result", "at"]);
	assert.ok(Date.parse(task.evidence[0]?.at ?? "") >= before - 1000, "at defaults to now");
	assert.deepEqual(
		task.evidence[1],
		{ command: "npm test -- bug", sha: "abc1234", result: "pass", at: "2026-11-23T09:00:00.000Z" },
		"at is normalized to UTC",
	);

	const changed = h.events("todo:changed") as Array<{ tasks: Array<{ evidence?: unknown[] }> }>;
	assert.deepEqual(
		changed.map((e) => e.tasks[0]?.evidence?.length ?? 0),
		[0, 1, 2],
	);
});

test("invalid ledger fields are rejected before anything changes", async () => {
	const h = load();
	await h.call({ action: "create", subject: "A" });
	const cases: Array<[Record<string, unknown>, string]> = [
		[{ action: "update", id: 1, points: 11 }, "Error: points must be a number from 0 to 10"],
		[{ action: "update", id: 1, anchor: "  " }, "Error: anchor must be a non-empty string"],
		[
			{ action: "update", id: 1, evidence: [{ command: "npm test", result: "ok" }] },
			'Error: evidence[0]: result must be "pass" or "fail"',
		],
		[
			{ action: "update", id: 1, evidence: [{ command: "npm test", result: "pass", at: "yesterday" }] },
			"Error: evidence[0]: at must be an ISO 8601 time",
		],
		[{ action: "create", tasks: [{ subject: "B", points: -1 }] }, "Error: tasks[0]: points must be a number from 0 to 10"],
		[
			{
				action: "update",
				id: 1,
				evidence: [{ command: "npm test", result: "pass", at: new Date(Date.now() + 6 * 60_000).toISOString() }],
			},
			"Error: evidence[0]: at must not be in the future",
		],
		[{ action: "create", tasks: [{ subject: "B" }], anchor: "x" }, "Error: create with tasks[] takes anchor on each item, not at the top level"],
	];
	for (const [params, expected] of cases) assert.equal(text(await h.call(params)), expected);
	assert.equal(snapshots(h.branch).length, 1);
	assert.equal(text(await h.call({ action: "update", id: 1, points: 0 })), "Updated #1");
	assert.match(text(await h.call({ action: "update", id: 1, points: 0 })), /^No change/);
	// Clock skew up to five minutes is accepted.
	const soon = new Date(Date.now() + 4 * 60_000).toISOString();
	assert.equal(text(await h.call({ action: "update", id: 1, evidence: [{ command: "x", result: "pass", at: soon }] })), "Updated #1");
});
