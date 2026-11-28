import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { load, snapshots, text, type Harness } from "./harness.ts";

// A run's spend on its todo (CONTRACT.md "Run spend"): when a bound subagent's run ends (`subagent_result`, or `subagent_ping` when it stops to ask), the ledger reads that run's
// session file and records on the todo its tokens, cost, wall time and models in `metadata.herdr.spend`, summed over every run of the todo. A resume continues the same file, so a
// session's tokens are replaced by its newest total, never added twice; wall time adds each run's `elapsed`.

const dir = mkdtempSync(join(tmpdir(), "ledger-spend-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const usage = (input: number, output: number, cost: number, cacheRead = 0) => ({ input, output, cacheRead, cacheWrite: 0, totalTokens: input + output + cacheRead, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } });
const SEEDED = "2026-11-28T10:00:00.000Z", LATER = "2026-11-28T10:05:00.000Z", BEFORE = "2026-11-28T09:00:00.000Z";
const turn = (model: string, u: ReturnType<typeof usage>, at = LATER, id = Math.random().toString(36).slice(2)) => JSON.stringify({ type: "message", id, timestamp: at, message: { role: "assistant", provider: "anthropic", model, usage: u, content: [] } });
/** A child session file with these assistant turns, after its header and a user turn that names a usage of its own (never counted). */
function child(name: string, turns: string[]): string {
	const file = join(dir, `${name}.jsonl`);
	writeFileSync(file, [JSON.stringify({ type: "session", version: 3, id: name, timestamp: SEEDED }), JSON.stringify({ type: "message", message: { role: "user", content: "\"usage\" in a prompt", usage: usage(9, 9, 9) } }), ...turns].join("\n") + "\n");
	return file;
}
const task = (h: Harness, id = 1) => snapshots(h.branch).at(-1)!.tasks.find((t) => t.id === id)!;
const spendOf = (h: Harness, id = 1) => ((task(h, id).metadata as { herdr?: { spend?: Record<string, unknown> } } | undefined)?.herdr?.spend);
/** A confirmed launch of `name` (run id `run`) for `item`, its session file `file`. */
async function launch(h: Harness, item: string, run: string, file: string, name = "api-worker") {
	await h.fire("tool_call", { toolName: "subagent", toolCallId: run, input: { item } });
	await h.fire("tool_result", { toolName: "subagent", toolCallId: run, input: { item }, details: { status: "started", id: run, name, item, sessionFile: file }, content: [], isError: false });
}
/** Waits for the event's own write, which the event bus does not await: until `done` holds (the file read runs on libuv's pool). */
const until = async (done: () => boolean) => { for (let i = 0; i < 4000 && !done(); i++) await new Promise((r) => setTimeout(r, 5)); assert.ok(done(), "the event's write landed"); };
const ended = (h: Harness, details: Record<string, unknown>, customType = "subagent_result") => h.fire("message_end", { message: { role: "custom", customType, content: "done", display: true, details } });

test("a bound run's end records its tokens, cost, wall time and model on the todo; get shows them", async () => {
	const h = load({ sessionId: "aaaa1111-parent" });
	await h.call({ action: "create", subject: "API", anchor: "npm test" });
	const file = child("w1", [turn("claude-opus-5-5", usage(1000, 200, 0.5, 3000)), turn("claude-opus-5-5", usage(500, 100, 0.25))]);
	await launch(h, "aaaa1111#1", "run-1", file);
	await ended(h, { name: "api-worker", item: "aaaa1111#1", sessionFile: file, exitCode: 0, elapsed: 125 });
	assert.deepEqual(spendOf(h), {
		input: 1500, output: 300, cacheRead: 3000, cacheWrite: 0, tokens: 4800, cost: 0.75, ms: 125_000, runs: 1, models: ["anthropic/claude-opus-5-5"],
		sessions: [{ session: file, input: 1500, output: 300, cacheRead: 3000, cacheWrite: 0, tokens: 4800, cost: 0.75, models: ["anthropic/claude-opus-5-5"] }],
	});
	assert.equal(task(h).owner, "api-worker", "the binding stays as the launch left it");
	const get = text(await h.call({ action: "get", id: 1 }));
	assert.match(get, /\n {2}spend: 4,800 tokens · \$0\.75 · 2m 5s · 1 run · anthropic\/claude-opus-5-5/);
});

test("spend sums across the todo's runs: a reviewer's run adds; a resume of the same session replaces its tokens and adds its time", async () => {
	const h = load({ sessionId: "bbbb2222-parent" });
	await h.call({ action: "create", subject: "Pair" });
	const uid = task(h).uid as string;
	const worker = child("w2", [turn("claude-sonnet-5-5", usage(100, 10, 0.1))]), reviewer = child("r2", [turn("gpt-6.2-astra", usage(50, 5, 0.05))]);
	await launch(h, uid, "w-run", worker, "worker");
	await launch(h, uid, "r-run", reviewer, "reviewer");
	await ended(h, { name: "worker", item: uid, sessionFile: worker, exitCode: 0, elapsed: 60 });
	await ended(h, { name: "reviewer", item: uid, sessionFile: reviewer, exitCode: 0, elapsed: 30 });
	assert.equal(spendOf(h)!.tokens, 165);
	// The worker stops to ask, then is resumed: its file grows, and each end re-reads it whole.
	appendFileSync(worker, `${turn("claude-sonnet-5-5", usage(200, 20, 0.2))}\n`);
	await ended(h, { name: "worker", item: uid, message: "help", sessionFile: worker }, "subagent_ping");
	await h.fire("tool_result", { toolName: "subagent_resume", toolCallId: "resume", input: { sessionPath: worker }, details: { status: "started", id: "w-run-2", name: "worker", sessionPath: worker }, content: [] });
	appendFileSync(worker, `${turn("claude-sonnet-5-5", usage(300, 30, 0.3))}\n`);
	await ended(h, { name: "worker", sessionFile: worker, exitCode: 0, elapsed: 90 }); // a resumed run's result names no item: its session finds the todo
	const s = spendOf(h)!;
	assert.equal(s.tokens, 110 + 220 + 330 + 55);
	assert.equal(Math.round((s.cost as number) * 100) / 100, 0.65);
	assert.equal(s.ms, 180_000);
	assert.equal(s.runs, 4);
	assert.deepEqual(s.models, ["anthropic/claude-sonnet-5-5", "anthropic/gpt-6.2-astra"]);
	// A later launch on the same todo keeps what was spent.
	await launch(h, uid, "w-run-3", child("w3", []), "worker");
	assert.equal(spendOf(h)!.tokens, 715);
	assert.equal(snapshots(h.branch).length >= 2, true);
});

test("an end the ledger cannot tie to one open todo changes nothing: no item, a foreign session, a deleted todo, an unrelated message", async () => {
	const h = load({ sessionId: "cccc3333-parent" });
	await h.call({ action: "create", subject: "A" });
	await h.call({ action: "create", subject: "B" });
	const file = child("w4", [turn("m", usage(1, 1, 0.01))]);
	const before = snapshots(h.branch).length;
	await ended(h, { name: "x", sessionFile: file, exitCode: 0, elapsed: 1 });
	await ended(h, { name: "x", item: "dddd4444#1", sessionFile: file, exitCode: 0, elapsed: 1 });
	await ended(h, { name: "x", item: "t_aaaaaaaaaa", sessionFile: file, exitCode: 0, elapsed: 1 });
	await h.fire("message_end", { message: { role: "custom", customType: "intercom_message", content: "x", details: { item: "cccc3333#1", sessionFile: file } } });
	await h.fire("message_end", { message: { role: "assistant", content: [], usage: usage(5, 5, 5) } });
	await h.call({ action: "delete", id: 2 });
	const afterDelete = snapshots(h.branch).length;
	await ended(h, { name: "x", item: "cccc3333#2", sessionFile: file, exitCode: 0, elapsed: 1 });
	assert.equal(snapshots(h.branch).length, afterDelete);
	assert.equal(afterDelete, before + 1, "only the delete wrote");
});

test("a run whose session file is gone still counts its time; a namespace validator's refusal is said on the result, and nothing commits", async () => {
	const h = load({ sessionId: "eeee5555-parent" });
	await h.call({ action: "create", subject: "A", metadata: { train: { step: 1 } } });
	await launch(h, "eeee5555#1", "run-gone", join(dir, "missing.jsonl"), "x");
	await ended(h, { name: "x", item: "eeee5555#1", sessionFile: join(dir, "missing.jsonl"), exitCode: 0, elapsed: 7 });
	assert.deepEqual(spendOf(h), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, cost: 0, ms: 7000, runs: 1, models: [], sessions: [] });
	h.emit("todo:namespace", { v: 1, ns: "train", validate: () => "frozen" });
	const n = snapshots(h.branch).length;
	const out = await ended(h, { name: "x", item: "eeee5555#1", sessionFile: join(dir, "missing.jsonl"), exitCode: 0, elapsed: 7 }) as { message: { content: unknown } } | undefined;
	assert.equal(snapshots(h.branch).length, n);
	assert.match(JSON.stringify(out?.message.content), /Todo spend: metadata\.train refused #1: frozen/);
});

test("a change guard is not asked about a spend: the write is bookkeeping of a run that already happened, and it never waits", async () => {
	const h = load({ sessionId: "9a9a0001-parent" });
	await h.fire("session_start");
	await h.call({ action: "create", subject: "A" });
	const uid = task(h).uid as string, file = child("unguarded", [turn("m", usage(10, 10, 0.02))]);
	await launch(h, uid, "run-g", file);
	let asked = 0;
	h.emit("todo:guard", { v: 1, id: "no", check: () => (asked++, "frozen") });
	h.emit("subagent:run-end", { v: 1, id: "run-g", kind: "result", item: uid, sessionFile: file, elapsed: 5 });
	assert.equal(spendOf(h)?.tokens, 20, "written in the event's own tick");
	assert.equal(asked, 0);
});

test("a fork-seeded child counts only its own turns: the parent's copied ones (older than the seed, or ids of the parent's) are not its spend", async () => {
	const parentTurn = turn("parent-model", usage(100_000, 0, 4), BEFORE, "parent-1");
	const h = load({ sessionId: "f0f01111-parent", branch: [JSON.parse(parentTurn)] });
	await h.fire("session_start");
	await h.call({ action: "create", subject: "Forked" });
	const file = child("fork1", [parentTurn, turn("parent-model", usage(5, 0, 1), LATER, "parent-1"), turn("child-model", usage(150, 50, 0.01))]);
	await launch(h, "f0f01111#1", "fork-run", file);
	await ended(h, { name: "api-worker", item: "f0f01111#1", sessionFile: file, exitCode: 0, elapsed: 3 });
	const s = spendOf(h)!;
	assert.equal(s.tokens, 200);
	assert.equal(s.cost, 0.01);
	assert.deepEqual(s.models, ["anthropic/child-model"]);
});

test("a run's end is tied to the todo its launch bound, never to a todo that reuses the number after a clear", async () => {
	const h = load({ sessionId: "c1ea0001-parent" });
	await h.call({ action: "create", subject: "A" });
	const file = child("cleared", [turn("m", usage(1, 1, 0.01))]);
	await launch(h, "c1ea0001#1", "run-a", file);
	await h.call({ action: "clear" });
	await h.call({ action: "create", subject: "B, unrelated" });
	const n = snapshots(h.branch).length;
	await ended(h, { name: "api-worker", item: "c1ea0001#1", sessionFile: file, exitCode: 0, elapsed: 61 });
	assert.equal(snapshots(h.branch).length, n, "B is not charged");
	assert.equal(spendOf(h), undefined);
});

test("the host's run-end event records the run once, by its run id; the message that follows, or a ping's own elapsed, adds nothing twice", async () => {
	const h = load({ sessionId: "e7e70001-parent" });
	await h.fire("session_start");
	await h.call({ action: "create", subject: "A" });
	const uid = task(h).uid as string, file = child("evented", [turn("m", usage(10, 10, 0.02))]);
	await launch(h, uid, "run-1", file);
	h.emit("subagent:run-end", { v: 1, id: "run-1", kind: "ping", name: "api-worker", item: uid, sessionFile: file, elapsed: 600 });
	await until(() => spendOf(h) !== undefined);
	assert.equal(spendOf(h)?.ms, 600_000, "a ping's first segment counts its time");
	await ended(h, { name: "api-worker", item: uid, message: "help", sessionFile: file, id: "run-1", elapsed: 600 }, "subagent_ping");
	assert.equal(spendOf(h)?.runs, 1, "the message of an end the event recorded adds nothing");
	await h.fire("tool_result", { toolName: "subagent_resume", toolCallId: "resume", input: { sessionPath: file }, details: { status: "started", id: "run-2", name: "api-worker", sessionPath: file }, content: [] });
	// A steer the boss cleared before the model read it: only the event comes.
	h.emit("subagent:run-end", { v: 1, id: "run-2", kind: "result", name: "api-worker", sessionFile: file, elapsed: 120 });
	await until(() => spendOf(h)?.runs === 2);
	assert.equal(spendOf(h)?.ms, 720_000);
	assert.equal(spendOf(h)?.runs, 2);
	const n = snapshots(h.branch).length;
	h.emit("subagent:run-end", { v: 1, id: "run-2", kind: "result", name: "api-worker", sessionFile: file, elapsed: 120 }); // refused at once, before any read: its id is counted
	assert.equal(snapshots(h.branch).length, n, "the same run id twice records once");
	for (const bad of [{ v: 2, id: "x" }, { v: 1 }, null, "x"]) h.emit("subagent:run-end", bad);
});

test("the spend write keeps the todo's other metadata, a wait mark included", async () => {
	const h = load({ sessionId: "aa110001-parent" });
	await h.call({ action: "create", subject: "A", metadata: { waitsOn: "boss", until: "2099-01-01", train: { step: 1 } } });
	const file = child("keep", [turn("m", usage(1, 1, 0.01))]);
	await launch(h, "aa110001#1", "run-k", file);
	await ended(h, { name: "api-worker", sessionFile: file, exitCode: 0, elapsed: 1 });
	const md = task(h).metadata as Record<string, unknown>;
	assert.equal(md.waitsOn, "boss"); assert.equal(md.until, "2099-01-01"); assert.deepEqual(md.train, { step: 1 });
	assert.equal((md.herdr as { spend: { runs: number } }).spend.runs, 1);
});

/** A guard that holds the next `todo` call until `release()`; `entered` once a call reaches it. */
function holdingGuard(h: Harness) {
	let entered = false, release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	h.emit("todo:guard", { v: 1, id: "hold", check: async () => { entered = true; await gate; return undefined; } });
	return { entered: () => entered, release };
}

test("an end after pi moved the session to another branch, before its session_tree replay ran, writes nothing there when that branch lacks the todo (F010)", async () => {
	const h = load({ sessionId: "b7a70001-parent" });
	await h.fire("session_start");
	await h.call({ action: "create", subject: "Only on B" });
	const other = [...h.branch]; // branch B: a list without the launch's todo
	await h.call({ action: "create", subject: "A" });
	const uid = task(h, 2).uid as string, file = child("branched", [turn("m", usage(10, 10, 0.02))]);
	await launch(h, uid, "run-b", file);
	// Pi moves the leaf first, then awaits its session_tree handlers in turn: the ledger's replay has not run yet.
	h.branch.splice(0, h.branch.length, ...other);
	const n = snapshots(h.branch).length;
	h.emit("subagent:run-end", { v: 1, id: "run-b", kind: "result", item: uid, sessionFile: file, elapsed: 5 });
	await ended(h, { id: "run-b", name: "api-worker", item: uid, sessionFile: file, exitCode: 0, elapsed: 5 });
	assert.equal(snapshots(h.branch).length, n, "nothing is appended to branch B");
	await h.fire("session_tree");
	assert.deepEqual(snapshots(h.branch).at(-1)!.tasks.map((t) => t.subject), ["Only on B"]);
	assert.doesNotMatch(text(await h.call({ action: "list" })), /\bA\b/, "the live list is B's");
});

test("an end after pi moved the session to another branch that holds the todo too records onto that branch's list, keeping its own tasks (F010)", async () => {
	const h = load({ sessionId: "b7a70002-parent" });
	await h.fire("session_start");
	await h.call({ action: "create", subject: "Shared" });
	const uid = task(h).uid as string, file = child("shared", [turn("m", usage(10, 10, 0.02))]);
	await launch(h, uid, "run-s", file);
	const fork = [...h.branch]; // the branch point: the todo is bound on both branches
	await h.call({ action: "create", subject: "Only on A" });
	const onA = [...h.branch];
	h.branch.splice(0, h.branch.length, ...fork);
	await h.fire("session_tree");
	await h.call({ action: "create", subject: "Only on B" }); // the live slot holds B's list
	// Back to A, as pi does it: the leaf moves first, and the ledger's session_tree replay is still to come.
	h.branch.splice(0, h.branch.length, ...onA);
	h.emit("subagent:run-end", { v: 1, id: "run-s", kind: "result", item: uid, sessionFile: file, elapsed: 5 });
	assert.deepEqual(snapshots(h.branch).at(-1)!.tasks.map((t) => t.subject), ["Shared", "Only on A"], "A's list with the spend, never B's");
	assert.equal(spendOf(h)?.tokens, 20);
	await h.fire("session_tree");
	assert.match(text(await h.call({ action: "list" })), /Only on A/);
});

test("a spend behind a todo call that waits on its guard lands after the call: both changes stay (no lost update)", async () => {
	const h = load({ sessionId: "10c10001-parent" });
	await h.fire("session_start");
	await h.call({ action: "create", subject: "A" });
	const uid = task(h).uid as string, file = child("queued", [turn("m", usage(10, 10, 0.02))]);
	await launch(h, uid, "run-q", file);
	const hold = holdingGuard(h);
	const call = h.call({ action: "update", id: 1, status: "in_progress" });
	await until(hold.entered);
	h.emit("subagent:run-end", { v: 1, id: "run-q", kind: "result", item: uid, sessionFile: file, elapsed: 5 });
	assert.equal(spendOf(h), undefined, "it waits its turn");
	hold.release();
	await call;
	await until(() => spendOf(h)?.runs === 1);
	assert.equal(task(h).status, "in_progress", "the call's change stays");
	assert.equal(spendOf(h)?.tokens, 20);
});

test("a spend queued behind a call while the session shuts down writes nothing", async () => {
	const h = load({ sessionId: "5d5d0001-parent" });
	await h.fire("session_start");
	await h.call({ action: "create", subject: "A" });
	const uid = task(h).uid as string, file = child("shut", [turn("m", usage(10, 10, 0.02))]);
	await launch(h, uid, "run-s", file);
	const hold = holdingGuard(h);
	const call = h.call({ action: "update", id: 1, status: "in_progress" });
	await until(hold.entered);
	h.emit("subagent:run-end", { v: 1, id: "run-s", kind: "result", item: uid, sessionFile: file, elapsed: 5 });
	await h.fire("session_shutdown");
	hold.release();
	await call;
	for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 2));
	const spent = (x: { tasks: Array<Record<string, unknown>> }) => x.tasks.some((t) => (t.metadata as { herdr?: { spend?: unknown } } | undefined)?.herdr?.spend !== undefined);
	assert.equal(snapshots(h.branch).filter(spent).length, 0, "no spend entry after shutdown");
	assert.equal(h.events("todo:changed").filter((e) => spent(e as never)).length, 0, "no spend announced");
});

test("a fallback run counts every spawned attempt: the failed first model's file and time too (F004)", async () => {
	const h = load({ sessionId: "fb000001-parent" });
	await h.fire("session_start");
	await h.call({ action: "create", subject: "A" });
	const uid = task(h).uid as string;
	const first = child("attempt-1", [turn("model-one", usage(100, 10, 0.1))]), second = child("attempt-2", [turn("model-two", usage(20, 2, 0.02))]);
	await launch(h, uid, "run-fb", first);
	const attempts = [{ model: "anthropic/model-one", sessionFile: first, elapsed: 40 }, { model: "anthropic/model-two", sessionFile: second, elapsed: 20 }];
	h.emit("subagent:run-end", { v: 1, id: "run-fb", kind: "result", item: uid, sessionFile: second, elapsed: 20, attempts });
	await ended(h, { id: "run-fb", name: "api-worker", item: uid, sessionFile: second, exitCode: 0, elapsed: 20, attempts });
	const s = spendOf(h)!;
	assert.equal(s.tokens, 132);
	assert.equal(s.ms, 60_000, "both attempts' wall time");
	assert.equal(s.runs, 1, "one run, counted once");
	assert.deepEqual(s.models, ["anthropic/model-one", "anthropic/model-two"]);
	assert.deepEqual((s.sessions as { session: string }[]).map((x) => x.session), [first, second]);
});

test("a run-end event with only v, id and kind (a failed run without a session file) counts the run and its time on the todo its run id names", async () => {
	const h = load({ sessionId: "fa110001-parent" });
	await h.fire("session_start");
	await h.call({ action: "create", subject: "A" });
	await launch(h, task(h).uid as string, "run-f", join(dir, "never-written.jsonl"));
	h.emit("subagent:run-end", { v: 1, id: "run-f", kind: "result", elapsed: 63 });
	assert.equal(spendOf(h)?.runs, 1, "in the event's own tick");
	assert.equal(spendOf(h)?.ms, 63_000);
	assert.equal(spendOf(h)?.tokens, 0);
});
