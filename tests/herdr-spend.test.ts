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
const turn = (model: string, u: ReturnType<typeof usage>) => JSON.stringify({ type: "message", id: Math.random().toString(36).slice(2), message: { role: "assistant", provider: "anthropic", model, usage: u, content: [] } });
/** A child session file with these assistant turns, after its header and a user turn that names a usage of its own (never counted). */
function child(name: string, turns: string[]): string {
	const file = join(dir, `${name}.jsonl`);
	writeFileSync(file, [JSON.stringify({ type: "session", id: name }), JSON.stringify({ type: "message", message: { role: "user", content: "\"usage\" in a prompt", usage: usage(9, 9, 9) } }), ...turns].join("\n") + "\n");
	return file;
}
const task = (h: Harness, id = 1) => snapshots(h.branch).at(-1)!.tasks.find((t) => t.id === id)!;
const spendOf = (h: Harness, id = 1) => ((task(h, id).metadata as { herdr?: { spend?: Record<string, unknown> } } | undefined)?.herdr?.spend);
/** A confirmed launch of `name` (run id `run`) for `item`, its session file `file`. */
async function launch(h: Harness, item: string, run: string, file: string, name = "api-worker") {
	await h.fire("tool_call", { toolName: "subagent", toolCallId: run, input: { item } });
	await h.fire("tool_result", { toolName: "subagent", toolCallId: run, input: { item }, details: { status: "started", id: run, name, item, sessionFile: file }, content: [], isError: false });
}
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

test("a run whose session file is gone still counts its time; a guard's refusal is said on the result, and nothing commits", async () => {
	const h = load({ sessionId: "eeee5555-parent" });
	await h.call({ action: "create", subject: "A" });
	await ended(h, { name: "x", item: "eeee5555#1", sessionFile: join(dir, "missing.jsonl"), exitCode: 0, elapsed: 7 });
	assert.deepEqual(spendOf(h), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, cost: 0, ms: 7000, runs: 1, models: [], sessions: [] });
	h.emit("todo:guard", { v: 1, id: "no", check: () => "frozen" });
	const n = snapshots(h.branch).length;
	const out = await ended(h, { name: "x", item: "eeee5555#1", sessionFile: join(dir, "missing.jsonl"), exitCode: 0, elapsed: 7 }) as { message: { content: unknown } } | undefined;
	assert.equal(snapshots(h.branch).length, n);
	assert.match(JSON.stringify(out?.message.content), /Todo spend: guard no refused: frozen/);
});
