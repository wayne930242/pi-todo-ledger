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
	const dir = mkdtempSync(join(tmpdir(), "todo-cycle-"));
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

const run: RunRow = { id: "w1", name: "w1", model: "gpt-6.2-astra", agent: "worker", startedAt: NOW - 5000, phase: { kind: "active" } };

/** #1 in progress with run w1, then five pending tasks: focus shows three task rows, full shows all six. */
async function mount() {
	const claims: string[][] = [];
	const overlay = new TodoOverlay((p) => {
		if (p.claim) claims.push([...p.claim.ids]);
		p.rows = { version: 1, rows: [run] };
	});
	const tasks = [1, 2, 3, 4, 5, 6].map((id) => ({
		id, subject: `t${id}`, status: id === 1 ? "in_progress" : "pending",
		...(id === 1 ? { metadata: { herdr: { runs: [{ id: "w1", name: "w1" }] } } } : {}),
	}));
	const h = load({ branch: [{ type: "custom", customType: "todo/v1", data: { v: 1, tasks, nextId: 7 } }] });
	await h.fire("session_start");
	setActiveRenderSession(h.sessionId);
	let widget!: Component;
	const redraws: boolean[] = [];
	overlay.setUICtx({
		theme,
		setWidget: (_k: string, f?: (tui: object, t: Theme) => Component) => {
			if (f) widget = f({ mode: "regular", requestRender: (force?: boolean) => redraws.push(!!force) }, theme);
		},
		getToolsExpanded: () => false,
	} as unknown as ExtensionUIContext);
	overlay.update();
	return { overlay, claims, redraws, render: (width = 120) => widget.render(width) };
}

const FOCUS = ["● Todos (0/6)", "├─ ◐ #1 t1", "│    └ w1 · astra · running 5s", "├─ ○ #2 t2", "├─ ○ #3 t3", "└─ +3 pending · ctrl+shift+t full", ""];
const FULL = [
	"● Todos (0/6)", "├─ ◐ #1 t1", "│    └ w1 · astra · running 5s",
	"├─ ○ #2 t2", "├─ ○ #3 t3", "├─ ○ #4 t4", "├─ ○ #5 t5", "├─ ○ #6 t6", "└─ ctrl+shift+t collapse", "",
];
const COLLAPSED = ["● Todos (0/6)", "└─ ctrl+shift+t focus", ""];

test("the collapse key cycles focus → full → collapsed → focus", async (ctx) => {
	env(ctx);
	const m = await mount();
	assert.deepEqual(m.render(), FOCUS);
	m.overlay.cycleView();
	assert.deepEqual(m.render(), FULL);
	m.overlay.cycleView();
	assert.deepEqual(m.render(), COLLAPSED);
	m.overlay.cycleView();
	assert.deepEqual(m.render(), FOCUS);
	assert.deepEqual(m.redraws, [true, true, true], "each step forces a full redraw");
	m.overlay.dispose();
});

test("the state survives re-renders until the next press", async (ctx) => {
	env(ctx);
	const m = await mount();
	m.overlay.cycleView();
	m.render();
	m.overlay.update();
	assert.deepEqual(m.render(), FULL);
	m.overlay.dispose();
});

test("with view \"full\" the cycle starts at full: full → collapsed → focus → full", async (ctx) => {
	env(ctx, { view: "full" });
	const m = await mount();
	assert.deepEqual(m.render(), FULL);
	m.overlay.cycleView();
	assert.deepEqual(m.render(), COLLAPSED);
	m.overlay.cycleView();
	assert.deepEqual(m.render(), FOCUS);
	m.overlay.cycleView();
	assert.deepEqual(m.render(), FULL);
	m.overlay.dispose();
});

test("zh-TW: the hint names the key and the next state", async (ctx) => {
	env(ctx, undefined, "zh_TW.UTF-8");
	const m = await mount();
	assert.equal(m.render().at(-2), "└─ +3 待處理 · ctrl+shift+t 完整");
	m.overlay.cycleView();
	assert.equal(m.render().at(-2), "└─ ctrl+shift+t 收合");
	m.overlay.cycleView();
	assert.deepEqual(m.render(), ["● Todos (0/6)", "└─ ctrl+shift+t 焦點", ""]);
	m.overlay.dispose();
});

test("the hint names the configured key", async (ctx) => {
	env(ctx, { collapseKey: "alt+t" });
	const m = await mount();
	assert.equal(m.render().at(-2), "└─ +3 pending · alt+t full");
	m.overlay.dispose();
});

test("a narrow summary row drops the hint before cutting the counts", async (ctx) => {
	env(ctx);
	const m = await mount();
	assert.equal(m.render(20).at(-2), "└─ +3 pending");
	m.overlay.dispose();
});

test("no spare row: the hint gives way to the tasks", async (ctx) => {
	// Budget 8 = heading + 7 body rows: six tasks and the run fill them exactly.
	env(ctx, { view: "full", maxWidgetLines: 8 });
	const m = await mount();
	assert.deepEqual(m.render(), [
		"● Todos (0/6)", "├─ ◐ #1 t1", "│    └ w1 · astra · running 5s",
		"├─ ○ #2 t2", "├─ ○ #3 t3", "├─ ○ #4 t4", "├─ ○ #5 t5", "└─ ○ #6 t6", "",
	]);
	m.overlay.dispose();
});

test("collapseKey \"off\": no shortcut and no hint", async (ctx) => {
	env(ctx, { collapseKey: "off" });
	assert.deepEqual(load().shortcuts, []);
	const m = await mount();
	assert.equal(m.render().at(-2), "└─ +3 pending");
	m.overlay.cycleView();
	assert.equal(m.render().at(-2), "└─ ○ #6 t6");
	m.overlay.cycleView();
	assert.deepEqual(m.render(), ["● Todos (0/6)", "└─ collapsed", ""]);
	m.overlay.dispose();
});

test("the default key is registered once", async (ctx) => {
	env(ctx);
	assert.deepEqual(load().shortcuts, ["ctrl+shift+t"]);
});

test("claims follow the painted run row in each state", async (ctx) => {
	env(ctx);
	const m = await mount();
	m.render();
	m.render();
	assert.deepEqual(m.claims.at(-1), ["w1"], "focus claims the drawn run");
	m.overlay.cycleView();
	m.render();
	m.render();
	assert.deepEqual(m.claims.at(-1), ["w1"], "full claims the drawn run");
	m.overlay.cycleView();
	assert.deepEqual(m.claims.at(-1), [], "collapsing releases before the redraw");
	const sent = m.claims.length;
	m.render();
	assert.equal(m.claims.length, sent, "a collapsed frame claims nothing");
	m.overlay.cycleView();
	m.render();
	m.render();
	assert.deepEqual(m.claims.at(-1), ["w1"], "back in focus the run is claimed again");
	m.overlay.dispose();
});
