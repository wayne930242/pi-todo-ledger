import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { setActiveRenderSession } from "../src/todo.ts";
import { TodoOverlay } from "../src/todo-overlay.ts";
import type { RunRow } from "../src/view/live-runs.ts";
import { load } from "./harness.ts";

const theme = { fg: (_c: string, s: string) => s, strikethrough: (s: string) => s } as Theme;
const NOW = 1_000_000;

function env(ctx: TestContext, config?: object, locale = "C") {
	const dir = mkdtempSync(join(tmpdir(), "todo-others-"));
	const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, LC_ALL: process.env.LC_ALL };
	ctx.after(() => {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		rmSync(dir, { recursive: true, force: true });
	});
	process.env.HOME = dir;
	process.env.XDG_CONFIG_HOME = join(dir, "xdg");
	process.env.LC_ALL = locale;
	if (config) {
		mkdirSync(join(dir, "xdg", "pi-todo-ledger"), { recursive: true });
		writeFileSync(join(dir, "xdg", "pi-todo-ledger", "config.json"), JSON.stringify(config));
	}
	ctx.mock.timers.enable({ apis: ["Date"], now: NOW });
}

type Spec = { id: number; subject: string; status: string; metadata?: object };
const task = (id: number, status = "pending", extra: Partial<Spec> = {}): Spec => ({ id, subject: `t${id}`, status, ...extra });
const bound = (...runs: string[]) => ({ metadata: { herdr: { runs: runs.map((id) => ({ id, name: id })) } } });
const run = (id: string, secs = 5, extra: Partial<RunRow> = {}): RunRow => ({
	id, name: id, model: "gpt-6.2-astra", agent: "worker", startedAt: NOW - secs * 1000, phase: { kind: "active" }, ...extra,
});
const idle = (id: string) => run(id, 600, { model: "gpt-6.2-sol", phase: { kind: "waiting", since: NOW - 60_000 } });

async function mount(tasks: Spec[], rows: () => RunRow[], opts: { width?: number; sessionId?: string; look?: Theme } = {}) {
	const claims: string[][] = [];
	let probes = 0;
	const overlay = new TodoOverlay((p) => {
		probes++;
		if (p.claim) claims.push([...p.claim.ids]);
		p.rows = { version: 1, rows: rows() };
	});
	const h = load({
		...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
		branch: [{ type: "custom", customType: "todo/v1", data: { v: 1, tasks, nextId: tasks.length + 1 } }],
	});
	await h.fire("session_start");
	setActiveRenderSession(h.sessionId);
	let widget: Component | undefined;
	const look = opts.look ?? theme;
	overlay.setUICtx({
		theme: look,
		setWidget: (_k: string, f?: (tui: object, t: Theme) => Component) => {
			widget = f ? f({ mode: "regular", requestRender() {} }, look) : undefined;
		},
		getToolsExpanded: () => false,
	} as unknown as ExtensionUIContext);
	overlay.update();
	return {
		h, overlay, claims,
		probes: () => probes,
		registered: () => widget !== undefined,
		render: (width = opts.width ?? 120) => widget!.render(width),
	};
}

// Two todos in progress, each with its bound run, a pending one, and two runs bound to none.
const EXAMPLE = () => [task(1, "in_progress", bound("api-worker")), task(2, "in_progress", bound("ui-worker")), task(3)];
const EXAMPLE_ROWS = () => [run("api-worker"), run("ui-worker", 42), run("scout-x", 3), idle("scout-y")];

test("unbound runs form an Other workers group after the task rows, in zh-TW", async (ctx) => {
	env(ctx, undefined, "zh_TW.UTF-8");
	const colors: string[] = [];
	const look = { fg: (c: string, s: string) => { if (/其他|scout/.test(s)) colors.push(c); return s; }, strikethrough: (s: string) => s } as Theme;
	const m = await mount(EXAMPLE(), EXAMPLE_ROWS, { look });
	assert.deepEqual(m.render(), [
		"● Todos (0/3)",
		"├─ ◐ #1 t1",
		"│    └ api-worker · astra · 執行中 5s",
		"├─ ◐ #2 t2",
		"│    └ ui-worker · astra · 執行中 42s",
		"├─ ○ #3 t3",
		"├─ 其他 worker",
		"│    ├ scout-x · astra · 執行中 3s",
		"│    └ ◇ scout-y · sol · 閒置 1m",
		"└─ ctrl+shift+t 完整",
		"",
	]);
	assert.deepEqual(colors, ["muted", "mdLink", "mdLink"], "a muted heading and blue names");
	m.overlay.dispose();
});

test('a worker of a folded todo is drawn with its todo id and claimed', async ctx => {
 env(ctx);
 const m = await mount([task(1),task(2),task(3),task(4,'pending',bound('worker-four'))],()=>[run('worker-four')]);
 try { assert.match(m.render().join('\n'),/#4 worker-four/); m.render(); assert.deepEqual(m.claims.at(-1),['worker-four']); } finally { m.overlay.dispose(); }
});

test("the group in English", async (ctx) => {
	env(ctx);
	const m = await mount(EXAMPLE(), EXAMPLE_ROWS);
	assert.deepEqual(m.render().slice(6, 9), [
		"├─ Other workers",
		"│    ├ scout-x · astra · running 3s",
		"│    └ ◇ scout-y · sol · idle 1m",
	]);
	m.overlay.dispose();
});

test("a waiting run in the group keeps the bound row's mark and colour", async (ctx) => {
	env(ctx);
	const colors: string[] = [];
	const look = { fg: (c: string, s: string) => { if (["? ", "asker", " · astra · ", "waiting 42s"].includes(s)) colors.push(c); return s; }, strikethrough: (s: string) => s } as Theme;
	const m = await mount([task(1)], () => [run("asker", 600, { phase: { kind: "blocked", since: NOW - 42_000 } })], { look });
	assert.deepEqual(m.render(), ["● Todos (0/1)", "├─ ○ t1", "├─ Other workers", "│    └ ? asker · astra · waiting 42s", "└─ ctrl+shift+t full", ""]);
	assert.deepEqual(colors, ["warning", "mdLink", "dim", "warning"]);
	m.overlay.dispose();
});

test("no todos, only runs: the panel shows the heading and the group, and hides once the runs end", async (ctx) => {
	env(ctx, undefined, "zh_TW.UTF-8");
	let rows = [run("scout-x", 3), idle("scout-y")];
	const m = await mount([], () => rows);
	assert.ok(m.registered(), "runs alone register the panel");
	assert.deepEqual(m.render(), [
		"○ Todos (0/0)",
		"├─ 其他 worker",
		"│    ├ scout-x · astra · 執行中 3s",
		"│    └ ◇ scout-y · sol · 閒置 1m",
		"└─ ctrl+shift+t 完整",
		"",
	]);
	rows = [];
	assert.deepEqual(m.render(), [], "no runs left: nothing to draw");
	m.overlay.update();
	assert.ok(!m.registered(), "the next update unregisters the empty panel");
	m.overlay.dispose();
});

test("no todos and no runs: the panel stays unregistered", async (ctx) => {
	env(ctx);
	const m = await mount([], () => []);
	assert.ok(!m.registered());
	m.overlay.dispose();
});

test("focus budget, compact: each run shares its todo's row, the group takes one row, in zh-TW", async (ctx) => {
	env(ctx, { maxWidgetLines: 6 }, "zh_TW.UTF-8");
	const BOSS = ["檢查畫面", "確認版面", "整理文件", "補測試", "更新說明", "檢查翻譯", "發布前檢查", "執行等待"];
	const tasks = BOSS.map((subject, i) => ({ ...task(i + 1, i === 7 ? "in_progress" : "pending", i === 7 ? bound("fixture-test") : {}), subject }));
	const m = await mount(tasks, () => [run("fixture-test", 6), run("scout-x"), run("scout-y")]);
	assert.deepEqual(m.render(), [
		"● Todos (0/8)",
		"├─ ◐ #8 執行等待 ⟶ fixture-test · astra · 執行中 6s",
		"├─ ○ #1 檢查畫面",
		"├─ ○ #2 確認版面",
		"├─ 其他 worker ⟶ scout-x · astra · 執行中 5s +1",
		"└─ +5 待處理 · ctrl+shift+t 完整",
		"",
	]);
	m.overlay.dispose();
});

test("focus budget: a group that does not fit switches to compact, and its one row claims every run", async (ctx) => {
	env(ctx, { maxWidgetLines: 7 });
	const m = await mount([task(1, "in_progress", bound("a")), task(2), task(3)], () => ["a", "w", "x", "y", "z"].map((id) => run(id)));
	const rows = m.render();
	assert.deepEqual(rows, [
		"● Todos (0/3)",
		"├─ ◐ #1 t1 ⟶ a · astra · running 5s",
		"├─ ○ #2 t2",
		"├─ ○ #3 t3",
		"├─ Other workers ⟶ w · astra · running 5s +3",
		"└─ ctrl+shift+t full",
		"",
	]);
	assert.ok(rows.length - 1 <= 7, "the cap holds");
	m.render();
	assert.deepEqual(m.claims.at(-1), ["a", "w", "x", "y", "z"], "a painted compact row claims the runs it counts");
	m.overlay.dispose();
});

test("focus budget: one hidden worker reads singular", async (ctx) => {
	env(ctx, { maxWidgetLines: 3 });
	const m = await mount([task(1, "in_progress"), task(2, "in_progress")], () => [run("w")]);
	assert.deepEqual(m.render(), ["● Todos (0/2)", "├─ ◐ t1", "└─ +1 in progress, 1 worker · ctrl+shift+t full", ""]);
	m.overlay.dispose();
});

test("claims: group rows drawn on two frames are claimed and released when they leave", async (ctx) => {
	env(ctx);
	let rows = EXAMPLE_ROWS();
	const m = await mount(EXAMPLE(), () => rows);
	m.render();
	m.render();
	assert.deepEqual(m.claims.at(-1), ["api-worker", "ui-worker", "scout-x", "scout-y"]);
	rows = rows.filter((r) => r.id !== "scout-x");
	m.render();
	assert.deepEqual(m.claims.at(-1), ["api-worker", "ui-worker", "scout-y"]);
	m.overlay.dispose();
	assert.deepEqual(m.claims.at(-1), [], "dispose releases");
});

test("claims: a group row cut by the width stays unclaimed", async (ctx) => {
	env(ctx);
	const long = run("scout-with-a-very-long-name-that-does-not-fit");
	const m = await mount([task(1)], () => [run("x"), long], { width: 40 });
	const rows = m.render();
	m.render();
	assert.ok(rows.some((l) => l.includes("scout-with") && l.includes("…")), "the long row is truncated");
	assert.deepEqual(m.claims.at(-1), ["x"]);
	m.overlay.dispose();
});

test("a run that gets bound moves under its todo, with no duplicate row", async (ctx) => {
	env(ctx);
	const sessionId = "abcd1234-parent";
	const m = await mount([task(1, "in_progress"), task(2)], () => [run("scout-x")], { sessionId });
	assert.deepEqual(m.render(), ["● Todos (0/2)", "├─ ◐ t1", "├─ ○ t2", "├─ Other workers", "│    └ scout-x · astra · running 5s", "└─ ctrl+shift+t full", ""]);
	m.render();
	assert.deepEqual(m.claims.at(-1), ["scout-x"]);
	const item = `${sessionId.slice(0, 8)}#1`;
	await m.h.fire("tool_call", { toolName: "subagent", toolCallId: "launch", input: { item } });
	await m.h.fire("tool_result", {
		toolName: "subagent", toolCallId: "launch", input: { item }, isError: false,
		details: { id: "scout-x", name: "scout-x", status: "started", item }, content: [{ type: "text", text: "started" }],
	});
	const rows = m.render();
	assert.deepEqual(rows, ["● Todos (0/2)", "├─ ◐ #1 t1", "│    └ scout-x · astra · running 5s", "├─ ○ #2 t2", "└─ ctrl+shift+t full", ""]);
	assert.equal(rows.filter((l) => l.includes("scout-x")).length, 1);
	m.render();
	assert.deepEqual(m.claims.at(-1), ["scout-x"], "the claim carries over to the bound row");
	m.overlay.dispose();
});

test('"view": "full" lists the group after the tree, and counts what the budget cuts', async (ctx) => {
	env(ctx, { view: "full" });
	const m = await mount(EXAMPLE(), EXAMPLE_ROWS);
	assert.deepEqual(m.render(), [
		"● Todos (0/3)",
		"├─ ◐ #1 t1",
		"│    └ api-worker · astra · running 5s",
		"├─ ◐ #2 t2",
		"│    └ ui-worker · astra · running 42s",
		"├─ ○ #3 t3",
		"├─ Other workers",
		"│    ├ scout-x · astra · running 3s",
		"│    └ ◇ scout-y · sol · idle 1m",
		"└─ ctrl+shift+t collapse",
		"",
	]);
	m.overlay.dispose();
	writeFileSync(join(process.env.XDG_CONFIG_HOME!, "pi-todo-ledger", "config.json"), JSON.stringify({ view: "full", maxWidgetLines: 8 }));
	const tight = await mount(EXAMPLE(), EXAMPLE_ROWS);
	assert.deepEqual(tight.render(), [
		"● Todos (0/3)",
		"├─ ◐ #1 t1 ⟶ api-worker · astra · running 5s",
		"├─ ◐ #2 t2 ⟶ ui-worker · astra · running 42s",
		"├─ ○ #3 t3",
		"├─ Other workers ⟶ scout-x · astra · running 3s +1",
		"└─ ctrl+shift+t collapse",
		"",
	]);
	tight.overlay.dispose();
});

test("full view: hidden tasks and hidden workers share the summary", async (ctx) => {
	env(ctx, { view: "full", maxWidgetLines: 3 });
	const m = await mount([task(1, "in_progress"), task(2, "in_progress"), task(3), task(4), task(5)], () => [run("w")]);
	assert.deepEqual(m.render(), ["● Todos (0/5)", "├─ ◐ t1", "└─ +4 more (1 in progress, 3 pending), 1 worker · ctrl+shift+t collapse", ""]);
	m.overlay.dispose();
});

test("collapsed: the line counts the other workers and claims none", async (ctx) => {
	env(ctx, undefined, "zh_TW.UTF-8");
	const m = await mount(EXAMPLE(), EXAMPLE_ROWS);
	m.render();
	m.render();
	m.overlay.cycleView();
	m.overlay.cycleView();
	assert.deepEqual(m.claims.at(-1), [], "collapsing releases");
	const sent = m.claims.length;
	assert.deepEqual(m.render(), ["● Todos (0/3)", "└─ +2 worker · ctrl+shift+t 焦點", ""]);
	assert.equal(m.claims.length, sent, "a collapsed frame claims nothing");
	m.overlay.dispose();
});

test("collapsed with no todos keeps the panel for the runs", async (ctx) => {
	env(ctx, { view: "full" });
	const m = await mount([], () => [run("w")]);
	m.overlay.cycleView();
	assert.deepEqual(m.render(), ["○ Todos (0/0)", "└─ +1 worker · ctrl+shift+t focus", ""]);
	m.overlay.dispose();
});

test("a subagent launch with an empty list loads the panel for the run", async (ctx) => {
	env(ctx);
	let widget = undefined as Component | undefined;
	const ui = {
		theme,
		notify() {},
		getToolsExpanded: () => false,
		setWidget: (_k: string, f?: (tui: object, t: Theme) => Component) => {
			widget = f ? f({ mode: "regular", requestRender() {} }, theme) : undefined;
		},
	};
	const rows: RunRow[] = [];
	const h = load({
		ui,
		before: (hh) => hh.bus.on("pi-herdr-agents:run-rows:v1", (p: { rows?: unknown }) => { p.rows = { version: 1, rows }; }),
	});
	setActiveRenderSession(h.sessionId); // earlier tests in this process took the foreground
	await h.fire("session_start");
	assert.equal(widget, undefined, "nothing to show yet");
	rows.push(run("scout-x"));
	await h.fire("tool_execution_end", { toolName: "subagent", isError: false });
	assert.deepEqual((widget as Component | undefined)?.render(120), ["○ Todos (0/0)", "├─ Other workers", "│    └ scout-x · astra · running 5s", "└─ ctrl+shift+t full", ""]);
	await h.fire("session_shutdown");
});
