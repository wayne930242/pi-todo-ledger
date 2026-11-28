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

test("until takes the date rule pi-straw-boss reads: ISO with a T, real hours, and a real calendar day", async () => {
	const h = load();
	await h.call({ action: "create", subject: "A" });
	for (const until of ["2099-02-30T09:00:00Z", "2099-02-30", "2099-12-01 09:00:00Z", "2099-12-01t09:00Z", "2099-12-01T24:00Z"]) {
		const refused = await h.call({ action: "update", id: 1, until });
		assert.ok(text(refused).startsWith("Error: until must be an ISO 8601 date or time"), `${until}: ${text(refused)}`);
	}
	for (const until of ["2099-12-01", "2099-12-01T09:00", "2099-12-01T09:00:00.5+08:00", "2099-12-01T09:00+0800"]) {
		const accepted = await h.call({ action: "update", id: 1, until });
		assert.ok(!text(accepted).startsWith("Error"), `${until}: ${text(accepted)}`);
	}
	// A legacy mark written straight into metadata follows the same rule on display.
	await h.call({ action: "create", tasks: [{ subject: "B", metadata: { until: "2099-02-30T09:00:00Z" } }, { subject: "C", metadata: { until: "2099-12-01 09:00:00Z" } }] });
	for (const id of [2, 3]) assert.ok(!text(await h.call({ action: "get", id })).includes("⏸"));
});

test("namespace validators for a wait key see only calls that set or actually remove it", async () => {
	const h = load();
	const seen: unknown[][] = [];
	h.emit("todo:namespace", { v: 1, ns: "until", validate: (value: unknown, task: { id: number }, op: string) => {
		seen.push([value, op, task.id]);
		return typeof value === "string" ? undefined : "until is a string here";
	} });
	await h.call({ action: "create", tasks: [{ subject: "A" }, { subject: "B" }, { subject: "C" }, { subject: "D" }] });
	for (const params of [{ id: 1, status: "completed" }, { id: 3, waitsOn: "CI" }, { id: 3, until: null }]) {
		assert.ok(!text(await h.call({ action: "update", ...params })).startsWith("Error"), JSON.stringify(params));
	}
	assert.ok(!text(await h.call({ action: "delete", id: 2 })).startsWith("Error"));
	assert.deepEqual(seen, [], "a task that never had until does not reach the until validator");
	await h.call({ action: "update", id: 4, until: FUTURE });
	assert.match(text(await h.call({ action: "update", id: 4, status: "completed" })), /^Error: metadata\.until refused #4/);
	assert.deepEqual(seen, [[FUTURE, "update", 4], [undefined, "update", 4]]);
});

test("the prompt says to clear both fields to end a wait early", async () => {
	const { DEFAULT_PROMPT_GUIDELINES } = await import("../src/todo.ts");
	assert.ok(DEFAULT_PROMPT_GUIDELINES.some((line) => line.includes("waitsOn: null") && line.includes("until: null")));
});
