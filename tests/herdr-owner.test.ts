import assert from "node:assert/strict";
import { test } from "node:test";
import { load, snapshots, type Harness } from "./harness.ts";

const name = "API worker: keep the full name";
const id = "0accb6d1-4380-4d51-a6d7-81dd0408d82f";
const base = { id, name, status: "started" };
const last = (h: Harness) => snapshots(h.branch).at(-1)!.tasks[0];
const start = (h: Harness, item: unknown) => h.fire("tool_call", { toolName: "subagent", toolCallId: "launch", input: { item } });
const ack = (h: Harness, item: unknown, extra = {}, event = {}) => h.fire("tool_result", {
	toolName: "subagent", toolCallId: "launch", input: { item }, details: { ...base, item, ...extra },
	content: [{ type: "text", text: "started" }], isError: false, ...event,
});

for (const mode of ["uid", "session#id"] as const) {
	test(`a confirmed launch binds its ${mode} to the returned child, preserving unrelated metadata`, async () => {
		const h = load({ sessionId: mode === "uid" ? "abcd1234-parent" : "01a2130c-parent" });
		await h.call({ action: "create", subject: "API", owner: "self", metadata: { train: 2 } });
		const item = mode === "uid" ? last(h).uid : `${h.sessionId.slice(0, 8)}#1`;
		await start(h, item);
		const extra = mode === "uid" ? { worktree: { paneId: "w1:p4" } } : {};
		await ack(h, item, extra);
		const herdr = { name, id, ...(mode === "uid" ? { pane: "w1:p4" } : {}) };
		assert.equal(last(h).owner, name);
		assert.deepEqual(last(h).metadata, { train: 2, herdr: { ...herdr, runs: [herdr] } });
		assert.deepEqual((h.events("todo:changed").at(-1) as { tasks: unknown[] }).tasks[0], last(h));
		const replay = load({ branch: [...h.branch] });
		await replay.fire("session_start");
		const get = await replay.call({ action: "get", id: 1 });
		assert.deepEqual((get.details as { tasks: unknown[] }).tasks[0], last(h));
		await start(h, item);
		await ack(h, item, extra);
		assert.equal(snapshots(h.branch).length, 2, "duplicate ack writes no snapshot");
		await h.call({ action: "update", id: 1, owner: "self" });
		assert.equal(last(h).owner, "self");
	});
}

test("missing, unknown, foreign, uncertain, errored or unrelated acknowledgements don't alter the list", async () => {
	const h = load({ sessionId: "aaaa0000-parent" });
	await h.call({ action: "create", subject: "Keep", owner: "self" });
	for (const item of [undefined, "t_aaaaaaaaaa", "aaaa0000#2", "bbbb1111#1"]) {
		await start(h, item); await ack(h, item);
	}
	const item = last(h).uid;
	for (const [extra, event] of [[{ status: "uncertain" }, {}], [{}, { isError: true }], [{}, { toolName: "subagent_send" }],
		[{ name: null }, {}], [{ id: "" }, {}], [{ item: undefined }, {}]]) {
		await start(h, item); await ack(h, item, extra, event);
	}
	assert.equal(last(h).owner, "self");
	assert.equal(snapshots(h.branch).length, 1);
});

test("a legacy uid-less task binds by local id; reassignment without a pane drops the old pane", async () => {
	const task = { id: 3, subject: "Legacy", status: "pending" };
	const h = load({ sessionId: "0123abcd-parent", branch: [{ type: "custom", customType: "todo/v1", data: { v: 1, tasks: [task], nextId: 4 } }] });
	await h.fire("session_start");
	const item = "0123abcd#3";
	await start(h, item); await ack(h, item, { worktree: { paneId: "w1:p3" } });
	assert.deepEqual(last(h).metadata, { herdr: { name, id, pane: "w1:p3", runs: [{ name, id, pane: "w1:p3" }] } });
	await start(h, item); await ack(h, item, { name: "Second", id: "another-child" });
	assert.deepEqual(last(h).metadata, { herdr: { name: "Second", id: "another-child", runs: [{ name, id, pane: "w1:p3" }, { name: "Second", id: "another-child" }] } });
	assert.equal(last(h).owner, "Second");
	assert.equal(last(h).uid, undefined);
});

test("resume follows session path; history keeps six unique runs", async () => {
	const h = load();
	await h.call({ action: "create", subject: "Pair" });
	const item = last(h).uid;
	await ack(h, item, { sessionFile: "/worker" });
	await ack(h, item, { id: "review", name: "Reviewer" });
	for (let i = 0; i < 5; i++) await h.fire("tool_result", { toolName: "subagent_resume", toolCallId: `resume${i}`, input: { sessionPath: "/worker" }, details: { ...base, id: `r${i}`, sessionPath: "/worker" }, content: [] });
	const history = (last(h).metadata as { herdr: { runs: { id: string; session?: string }[]; older: number } }).herdr;
	assert.deepEqual(history.runs.map(r => r.id), ["review", "r0", "r1", "r2", "r3", "r4"]);
	assert.equal(history.runs.at(-1)?.session, "/worker");
	assert.equal(history.older, 1);
});

for (const intervening of ["update", "clear", "session_tree"] as const) {
	test(`legacy numeric dispatch retains identity across an update only: ${intervening}`, async () => {
		const original = { id: 1, subject: "Legacy", status: "pending" };
		const entry = { type: "custom", customType: "todo/v1", data: { v: 1, tasks: [original], nextId: 2 } };
		const h = load({ sessionId: `0abc0001-${intervening}`, branch: [entry] });
		await h.fire("session_start");
		const item = "0abc0001#1";
		await start(h, item);
		if (intervening === "update") {
			await h.call({ action: "update", id: 1, subject: "Renamed", metadata: { note: 1 } });
		} else if (intervening === "clear") {
			await h.call({ action: "clear" });
			await h.call({ action: "create", subject: "Replacement" });
		} else {
			await h.fire("session_tree");
		}
		const before = snapshots(h.branch).length;
		await ack(h, item);
		if (intervening === "update") {
			assert.equal(last(h).owner, name);
			assert.equal(last(h).subject, "Renamed");
			assert.equal(last(h).uid, undefined);
			assert.deepEqual(last(h).metadata, { note: 1, herdr: { name, id, runs: [{ name, id }] } });
		} else {
			assert.equal(last(h).owner, undefined);
			assert.equal(snapshots(h.branch).length, before);
		}
	});
}

test("clear and reuse of a numeric id during launch cannot bind its replacement", async () => {
	const h = load({ sessionId: "fee10000-parent" });
	await h.call({ action: "create", subject: "Original" });
	const item = "fee10000#1";
	await start(h, item);
	await h.call({ action: "clear" });
	await h.call({ action: "create", subject: "Replacement" });
	await ack(h, item);
	assert.equal(last(h).owner, undefined);
});

test("a refused binding doesn't undo the launch, bypass a guard or emit a spurious snapshot", async () => {
	const h = load();
	await h.call({ action: "create", subject: "Keep" });
	h.emit("todo:guard", { v: 1, id: "policy", check: () => "locked" });
	const item = last(h).uid;
	await start(h, item);
	const warning = await ack(h, item) as { content?: { text: string }[]; isError?: boolean } | undefined;
	assert.match(warning?.content?.at(-1)?.text ?? "", /guard policy refused: locked/);
	assert.ok(!warning?.isError);
	assert.equal(snapshots(h.branch).length, 1);
});
