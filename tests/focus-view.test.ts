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

/** An isolated config directory (optionally with a config file), a locale, and a fixed clock. */
function env(ctx: TestContext, config?: object, locale = "C") {
	const dir = mkdtempSync(join(tmpdir(), "todo-focus-"));
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

type Spec = { id: number; subject: string; status: string; blockedBy?: number[]; metadata?: object };
const task = (id: number, status = "pending", extra: Partial<Spec> = {}): Spec => ({ id, subject: `t${id}`, status, ...extra });
const bound = (...runs: string[]) => ({ metadata: { herdr: { runs: runs.map((id) => ({ id, name: id })) } } });
const run = (id: string, secs = 5): RunRow => ({
	id, name: id, model: "gpt-6.2-astra", agent: "worker", startedAt: NOW - secs * 1000, phase: { kind: "active" },
});

async function mount(tasks: Spec[], rows: RunRow[] = [], mode = "regular") {
	const claims: string[][] = [];
	const overlay = new TodoOverlay((p) => {
		if (p.claim) claims.push([...p.claim.ids]);
		p.rows = { version: 1, rows };
	});
	const h = load({ branch: [{ type: "custom", customType: "todo/v1", data: { v: 1, tasks, nextId: tasks.length + 1 } }] });
	await h.fire("session_start");
	setActiveRenderSession(h.sessionId);
	let widget!: Component;
	overlay.setUICtx({
		theme,
		setWidget: (_k: string, f?: (tui: object, t: Theme) => Component) => {
			if (f) widget = f({ mode, requestRender() {} }, theme);
		},
		getToolsExpanded: () => false,
	} as unknown as ExtensionUIContext);
	overlay.update();
	return { overlay, claims, render: () => widget.render(120) };
}

// The boss's list: eight todos, #8 in progress with one bound run.
const BOSS = ["檢查畫面", "確認版面", "整理文件", "補測試", "更新說明", "檢查翻譯", "發布前檢查", "執行等待"];
const bossTasks = () =>
	BOSS.map((subject, i) => ({ ...task(i + 1, i === 7 ? "in_progress" : "pending", i === 7 ? bound("fixture-test") : {}), subject }));

test("focus view (default): the boss's example, in zh-TW", async (ctx) => {
	env(ctx, undefined, "zh_TW.UTF-8");
	const m = await mount(bossTasks(), [run("fixture-test", 6)]);
	assert.deepEqual(m.render(), [
		"● Todos (0/8)",
		"├─ ◐ #8 執行等待",
		"│    └ fixture-test · astra · 執行中 6s",
		"├─ ○ #1 檢查畫面",
		"├─ ○ #2 確認版面",
		"└─ +5 待處理",
		"",
	]);
	m.overlay.dispose();
});

test("focus view without an in-progress task lists the next three open tasks", async (ctx) => {
	env(ctx);
	const six = await mount([1, 2, 3, 4, 5, 6].map((id) => task(id)));
	assert.deepEqual(six.render(), ["● Todos (0/6)", "├─ ○ t1", "├─ ○ t2", "├─ ○ t3", "└─ +3 pending", ""]);
	six.overlay.dispose();
	const three = await mount([1, 2, 3].map((id) => task(id)));
	assert.deepEqual(three.render(), ["● Todos (0/3)", "├─ ○ t1", "├─ ○ t2", "└─ ○ t3", ""], "nothing hidden, no summary");
	three.overlay.dispose();
});

test("focus view keeps waiting and blocker marks on flat rows", async (ctx) => {
	env(ctx);
	const m = await mount([
		{ ...task(1, "in_progress"), subject: "Scope" },
		{ ...task(2, "pending", { blockedBy: [1], metadata: { waitsOn: "Pat" } }), subject: "Approve" },
		{ ...task(3, "pending", { blockedBy: [1, 2] }), subject: "Ship" },
		{ ...task(4), subject: "Docs" },
	]);
	assert.deepEqual(m.render(), [
		"● Todos (0/4)",
		"├─ ◐ #1 Scope",
		"├─ ⏸ #2 Approve waits Pat ⛓ #1",
		"├─ ○ #3 Ship ⛓ #1,#2",
		"└─ +1 pending",
		"",
	]);
	m.overlay.dispose();
});

test("maxWidgetLines=3 with four in-progress tasks: the rest go into the summary", async (ctx) => {
	env(ctx, { maxWidgetLines: 3 });
	const m = await mount([1, 2, 3, 4].map((id) => task(id, "in_progress")));
	assert.deepEqual(m.render(), ["● Todos (0/4)", "├─ ◐ t1", "└─ +3 in progress", ""]);
	m.overlay.dispose();
});

test("several in-progress tasks with runs over the budget fold runs and summarize the rest", async (ctx) => {
	env(ctx, { maxWidgetLines: 7 });
	const tasks = [task(1, "in_progress", bound("w1")), task(2, "in_progress", bound("w2a", "w2b")), task(3), task(4), task(5)];
	const m = await mount(tasks, [run("w1"), run("w2a"), run("w2b")]);
	const rows = m.render();
	assert.deepEqual(rows, [
		"● Todos (0/5)",
		"├─ ◐ #1 t1",
		"│    └ w1 · astra · running 5s",
		"├─ ◐ #2 t2 · 2 runs",
		"├─ ○ #3 t3",
		"├─ ○ #4 t4",
		"└─ +1 pending",
		"",
	]);
	assert.equal(rows.length - 1, 7, "the cap holds");
	m.overlay.dispose();
});

test("the summary counts hidden in-progress, pending and completed tasks, in zh-TW", async (ctx) => {
	env(ctx, { maxWidgetLines: 4 }, "zh_TW.UTF-8");
	const tasks = [
		task(1, "in_progress", bound("a")), task(2, "in_progress", bound("b")), task(3, "in_progress"),
		task(4, "completed"), task(5, "completed"), ...[6, 7, 8, 9, 10].map((id) => task(id)),
	];
	const m = await mount(tasks, [run("a"), run("b")]);
	assert.deepEqual(m.render(), [
		"● Todos (2/10)",
		"├─ ◐ #1 t1 · 1 個工作階段",
		"├─ ◐ #2 t2 · 1 個工作階段",
		"└─ +1 進行中、5 待處理、2 已完成",
		"",
	]);
	m.overlay.dispose();
});

test("a completed row from this turn shows only when the budget allows, and leaves the count once faded", async (ctx) => {
	env(ctx);
	const tasks = [task(1, "completed"), task(2, "in_progress"), task(3)];
	const roomy = await mount(tasks);
	assert.deepEqual(roomy.render(), ["● Todos (1/3)", "├─ ◐ t2", "├─ ○ t3", "└─ ✓ t1", ""]);
	roomy.overlay.dispose();
	const dir = process.env.XDG_CONFIG_HOME!;
	mkdirSync(join(dir, "pi-todo-ledger"), { recursive: true });
	writeFileSync(join(dir, "pi-todo-ledger", "config.json"), JSON.stringify({ maxWidgetLines: 3 }));
	const tight = await mount(tasks);
	assert.deepEqual(tight.render(), ["● Todos (1/3)", "├─ ◐ t2", "└─ +1 pending, 1 completed", ""]);
	tight.overlay.hideCompletedTasksFromPreviousTurn();
	assert.deepEqual(tight.render(), ["● Todos (0/2)", "├─ ◐ t2", "└─ ○ t3", ""], "a faded row leaves the heading too, as in the full view");
	tight.overlay.dispose();
});

test('"view": "full" renders today\'s tree unchanged; an unknown value means focus', async (ctx) => {
	env(ctx, { view: "full" }, "zh_TW.UTF-8");
	const m = await mount(bossTasks(), [run("fixture-test", 6)]);
	assert.deepEqual(m.render(), [
		"● Todos (0/8)",
		...BOSS.slice(0, 7).map((s, i) => `├─ ○ #${i + 1} ${s}`),
		"└─ ◐ #8 執行等待",
		"     └ fixture-test · astra · 執行中 6s",
		"",
	]);
	m.overlay.dispose();
	writeFileSync(join(process.env.XDG_CONFIG_HOME!, "pi-todo-ledger", "config.json"), JSON.stringify({ view: "tree" }));
	const unknown = await mount(bossTasks(), [run("fixture-test", 6)]);
	assert.equal(unknown.render().at(-2), "└─ +5 待處理");
	unknown.overlay.dispose();
});

test("focus view claims a run drawn on two frames, and never one folded into the summary", async (ctx) => {
	env(ctx);
	const shown = await mount(bossTasks(), [run("fixture-test", 6)]);
	shown.render();
	shown.render();
	assert.deepEqual(shown.claims, [["fixture-test"]]);
	shown.overlay.dispose();
	assert.deepEqual(shown.claims.at(-1), [], "dispose releases");

	const dir = process.env.XDG_CONFIG_HOME!;
	mkdirSync(join(dir, "pi-todo-ledger"), { recursive: true });
	writeFileSync(join(dir, "pi-todo-ledger", "config.json"), JSON.stringify({ maxWidgetLines: 3 }));
	const tasks = [1, 2, 3].map((id) => task(id, "in_progress")).concat(task(4, "in_progress", bound("hidden")));
	const folded = await mount(tasks, [run("hidden")]);
	const rows = folded.render();
	folded.render();
	assert.ok(!rows.some((l) => l.includes("hidden")), "the task with the run is in the summary");
	assert.deepEqual(folded.claims, []);
	folded.overlay.dispose();
});
