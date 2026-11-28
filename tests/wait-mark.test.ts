import assert from "node:assert/strict";
import { test } from "node:test";
import { isSnapshotV1 } from "../src/ledger/schema.ts";
import { load, snapshots, text } from "./harness.ts";

const FUTURE = "2099-12-01T18:47:00+08:00";
const metadataOf = (h: ReturnType<typeof load>, id = 1) =>
	snapshots(h.branch).at(-1)!.tasks.find((t) => t.id === id)!.metadata as Record<string, unknown> | undefined;

test("update marks a task waiting with waitsOn and until, stored under the metadata keys readers already know", async () => {
	const h = load();
	await h.call({ action: "create", subject: "Install the release" });
	const marked = await h.call({ action: "update", id: 1, waitsOn: "  trains to end ", until: FUTURE });
	assert.notEqual(marked.isError, true, text(marked));
	assert.deepEqual(metadataOf(h), { waitsOn: "trains to end", until: FUTURE });
	assert.ok(isSnapshotV1(snapshots(h.branch).at(-1)), "the snapshot still matches the v1 schema");
	for (const result of [marked, await h.call({ action: "get", id: 1 }), await h.call({ action: "list" })]) {
		assert.match(text(result), /⏸ waits trains to end · until /);
	}
	const again = await h.call({ action: "update", id: 1, waitsOn: "trains to end" });
	assert.match(text(again), /No change/i, "re-sending the same mark changes nothing");
});

test("null clears each mark, and other metadata stays", async () => {
	const h = load();
	await h.call({ action: "create", subject: "Install", metadata: { ticket: "MP-1" }, waitsOn: "boss", until: FUTURE });
	assert.deepEqual(metadataOf(h), { ticket: "MP-1", waitsOn: "boss", until: FUTURE });
	await h.call({ action: "update", id: 1, until: null });
	assert.deepEqual(metadataOf(h), { ticket: "MP-1", waitsOn: "boss" });
	const cleared = await h.call({ action: "update", id: 1, waitsOn: null });
	assert.deepEqual(metadataOf(h), { ticket: "MP-1" });
	assert.ok(!text(cleared).includes("⏸"), text(cleared));
});

test("completing or deleting a task clears its wait, including a legacy metadata mark", async () => {
	const h = load();
	await h.call({ action: "create", tasks: [{ subject: "A", waitsOn: "CI", until: FUTURE }, { subject: "B", metadata: { waitsOn: "QA", keep: 1 } }] });
	await h.call({ action: "update", id: 1, status: "in_progress" });
	assert.deepEqual(metadataOf(h, 1), { waitsOn: "CI", until: FUTURE }, "starting the task keeps the wait");
	await h.call({ action: "update", id: 1, status: "completed" });
	assert.equal(metadataOf(h, 1), undefined);
	await h.call({ action: "delete", id: 2 });
	assert.deepEqual(metadataOf(h, 2), { keep: 1 });
});

test("a wait mark is refused when it is empty, not an ISO time, in the past, or on a batch's top level", async () => {
	const h = load();
	await h.call({ action: "create", subject: "A" });
	for (const [params, reason] of [
		[{ waitsOn: "  " }, "waitsOn must be a non-empty string"],
		[{ until: "Dec 1 2099" }, "until must be an ISO 8601 date or time"],
		[{ until: "2001-01-01T00:00:00Z" }, "until must be in the future"],
	] as const) {
		const refused = await h.call({ action: "update", id: 1, ...params });
		assert.ok(text(refused).startsWith(`Error: ${reason}`), text(refused));
	}
	const batch = await h.call({ action: "create", waitsOn: "CI", tasks: [{ subject: "B" }] });
	assert.match(text(batch), /^Error: create with tasks\[\] takes waitsOn on each item/);
	const nulled = await h.call({ action: "create", subject: "C", waitsOn: null });
	assert.match(text(nulled), /^Error: waitsOn must be a non-empty string$/, "only update clears a mark");
	assert.equal(snapshots(h.branch).at(-1)!.tasks.length, 1);
});

test("an update that sets only a wait mark is a mutation", async () => {
	const h = load();
	await h.call({ action: "create", subject: "A" });
	const result = await h.call({ action: "update", id: 1, until: FUTURE });
	assert.notEqual(result.isError, true, text(result));
	assert.equal(metadataOf(h)!.until, FUTURE);
});
