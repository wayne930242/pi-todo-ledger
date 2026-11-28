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
import { BOUND_RUNS, type Spec, skaldRows, skaldTasks, UNBOUND } from "./skald-scenario.ts";

const theme = { fg: (_c: string, s: string) => s, strikethrough: (s: string) => s } as Theme;
const NOW = 1_000_000_000;

function env(ctx: TestContext, config: object) {
	const dir = mkdtempSync(join(tmpdir(), "todo-runs-first-"));
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
	process.env.LC_ALL = "C";
	mkdirSync(join(dir, "xdg", "pi-todo-ledger"), { recursive: true });
	writeFileSync(join(dir, "xdg", "pi-todo-ledger", "config.json"), JSON.stringify(config));
	ctx.mock.timers.enable({ apis: ["Date"], now: NOW });
}

async function mount(tasks: Spec[], rows: () => RunRow[]) {
	const claims: string[][] = [];
	const overlay = new TodoOverlay((p) => {
		if (p.claim) claims.push([...p.claim.ids]);
		p.rows = { version: 1, rows: rows() };
	});
	const h = load({ branch: [{ type: "custom", customType: "todo/v1", data: { v: 1, tasks, nextId: 73 } }] });
	await h.fire("session_start");
	setActiveRenderSession(h.sessionId);
	let widget: Component | undefined;
	overlay.setUICtx({
		theme,
		setWidget: (_k: string, f?: (tui: object, t: Theme) => Component) => {
			widget = f ? f({ mode: "regular", requestRender() {} }, theme) : undefined;
		},
		getToolsExpanded: () => false,
	} as unknown as ExtensionUIContext);
	overlay.update();
	return { overlay, claims, render: (width = 110) => widget!.render(width) };
}

/** The todo a run row is drawn under: the nearest task row above it, or the Other workers heading. */
function owners(lines: readonly string[]) {
	const under = new Map<string, string>();
	let parent = "";
	for (const line of lines) {
		const task = /^[├└]─ (?:\S+ )?(#\d+|Other workers)/.exec(line);
		if (task) parent = task[1];
		const run = /^[│ ] {4}(?: {2})*[├└] (?:#\d+ )?(?:[◇?] )?(\S+) ·/.exec(line);
		if (run) under.set(run[1], parent);
	}
	return under;
}

test("skald main, full view: every live run bound to an in-progress todo is drawn under it before pending todos, and claimed", async (ctx) => {
	env(ctx, { view: "full", maxWidgetLines: 20 });
	const m = await mount(skaldTasks(), () => skaldRows(NOW));
	const lines = m.render();
	assert.equal(lines.length - 1, 20, `the cap holds:\n${lines.join("\n")}`);
	const under = owners(lines);
	const expected: Record<string, string> = {
		"coremaptab-ui": "#55", "factionsdb-build": "#56", "selectsweep-ui": "#66", "epbooks-build": "#67",
		"epscen-build": "#68", "epscen-review": "#68", "epscen-fix": "#68",
	};
	for (const [run, todo] of Object.entries(expected)) assert.equal(under.get(run), todo, `${run} under ${todo}:\n${lines.join("\n")}`);
	for (const run of UNBOUND) assert.equal(under.get(run), "Other workers", `${run} in the group:\n${lines.join("\n")}`);
	for (const id of [35, 55, 56, 65, 66, 67, 68, 70]) assert.ok(lines.some((l) => l.includes(`◐ #${id} `)), `in-progress #${id} drawn`);
	assert.match(lines.at(-2)!, /^└─ \+\d+ more \(54 completed, 9 pending\) · ctrl\+shift\+t collapse$/, "the pending todos without a run fold into the summary");
	m.render();
	const claim = m.claims.at(-1) ?? [];
	for (const id of [...BOUND_RUNS, ...UNBOUND]) assert.ok(claim.includes(id), `${id} claimed: ${claim.join(", ")}`);
	m.overlay.dispose();
});

test("skald main, focus view: run rows of in-progress todos outrank the next pending todos", async (ctx) => {
	env(ctx, { maxWidgetLines: 20 });
	const m = await mount(skaldTasks(), () => skaldRows(NOW));
	const lines = m.render();
	assert.equal(lines.length - 1, 20);
	const under = owners(lines);
	for (const run of BOUND_RUNS) assert.match(under.get(run) ?? "", /^#(55|56|66|67|68)$/, `${run} under its todo:\n${lines.join("\n")}`);
	for (const run of UNBOUND) assert.equal(under.get(run), "Other workers");
	m.render();
	const claim = m.claims.at(-1) ?? [];
	for (const id of [...BOUND_RUNS, ...UNBOUND]) assert.ok(claim.includes(id), `${id} claimed`);
	m.overlay.dispose();
});

test("skald main at the default budget: in-progress todos keep their rows, the runs that fit come next, the rest are counted", async (ctx) => {
	env(ctx, { view: "full" });
	const m = await mount(skaldTasks(), () => skaldRows(NOW));
	const lines = m.render();
	assert.equal(lines.length - 1, 12);
	for (const id of [35, 55, 56, 65, 66, 67, 68, 70]) assert.ok(lines.some((l) => l.includes(`◐ #${id} `)), `in-progress #${id} drawn:\n${lines.join("\n")}`);
	assert.ok(!lines.some((l) => /○ #\d+/.test(l)), "no pending todo takes a row from a run");
	const drawn = [...owners(lines).keys()];
	assert.ok(drawn.length >= 2, `runs drawn:\n${lines.join("\n")}`);
	m.overlay.dispose();
});
