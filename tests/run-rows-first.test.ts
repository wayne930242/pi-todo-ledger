import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Spacer, Text, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { setActiveRenderSession } from "../src/todo.ts";
import { TodoOverlay } from "../src/todo-overlay.ts";
import type { RunRow } from "../src/view/live-runs.ts";
import { load } from "./harness.ts";
// Pi's fullscreen chat layout is internal (not in the package exports); load it by path like Pi does.
const { createChatViewport } = (await import(
	new URL("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/chat-viewport.js", import.meta.url).href
)) as { createChatViewport: (o: Record<string, Component>) => { root: Component } };
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

/** Compact rows: the run named after ` ⟶ ` mapped to its row's todo (or `Other workers`) and the `+N` it counts. */
function compactRows(lines: readonly string[]) {
	const rows = new Map<string, { under: string; more: number }>();
	for (const line of lines) {
		const m = /^[├└]─ (?:\S+ )?(#\d+|Other workers).* ⟶ (?:#\d+ )?(?:[◇?] )?(\S+) · .*?(?: \+(\d+))?$/.exec(line);
		if (m) rows.set(m[2], { under: m[1], more: Number(m[3] ?? 0) });
	}
	return rows;
}

for (const [view, config] of [["full", { view: "full" }], ["focus", {}]] as const)
	test(`skald main, ${view} view at the default 12 lines: compact rows put every run on its todo's row, and all are claimed`, async (ctx) => {
		env(ctx, config);
		const m = await mount(skaldTasks(), () => skaldRows(NOW));
		const lines = m.render();
		const text = lines.join("\n");
		assert.equal(lines.length - 1, 12, `the cap holds:\n${text}`);
		for (const id of [35, 55, 56, 65, 66, 67, 68, 70]) assert.ok(lines.some((l) => l.includes(`◐ #${id} `)), `in-progress #${id} drawn:\n${text}`);
		const rows = compactRows(lines);
		assert.deepEqual(
			Object.fromEntries(rows),
			{
				"coremaptab-ui": { under: "#55", more: 0 },
				"factionsdb-build": { under: "#56", more: 0 },
				"selectsweep-ui": { under: "#66", more: 0 },
				"epbooks-build": { under: "#67", more: 0 },
				"epscen-review": { under: "#68", more: 2 },
				"skald-scout": { under: "Other workers", more: 1 },
			},
			`one row per todo, led by the most active run:\n${text}`,
		);
		assert.ok(!lines.some((l) => /^[│ ] {4}/.test(l)), "no run takes a row of its own");
		m.render();
		assert.deepEqual([...(m.claims.at(-1) ?? [])].sort(), [...BOUND_RUNS, ...UNBOUND].sort(), "every run on a painted row is claimed");
		m.overlay.dispose();
	});

test("skald main, compact at 80 columns: the subject is cut before the run, and the rows are still claimed", async (ctx) => {
	env(ctx, { view: "full" });
	const m = await mount(skaldTasks(), () => skaldRows(NOW));
	const lines = m.render(80).map((l) => stripVTControlCharacters(l));
	const text = lines.join("\n");
	assert.ok(lines.every((l) => visibleWidth(l) <= 80), text);
	const row = lines.find((l) => l.includes("#67 "))!;
	assert.match(row, /^├─ ◐ #67 EP rules book: .*… ⟶ epbooks-build · opus · running 30m$/, text);
	assert.equal(compactRows(lines).size, 6, text);
	m.render(80);
	assert.deepEqual([...(m.claims.at(-1) ?? [])].sort(), [...BOUND_RUNS, ...UNBOUND].sort());
	m.overlay.dispose();
});

test("skald main, compact in Pi's fullscreen layout: the screen check finds each compact row and claims every run it stands for", async (ctx) => {
	env(ctx, { view: "full" });
	const size = { columns: 110, rows: 40 };
	const terminal = {
		start() {}, stop() {}, async drainInput() {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {},
		clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
		get columns() { return size.columns; }, get rows() { return size.rows; }, get kittyProtocolActive() { return false; },
	};
	const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
	const claims: string[][] = [];
	const overlay = new TodoOverlay((p) => {
		if (p.claim) claims.push([...p.claim.ids]);
		p.rows = { version: 1, rows: skaldRows(NOW) };
	});
	const h = load({ branch: [{ type: "custom", customType: "todo/v1", data: { v: 1, tasks: skaldTasks(), nextId: 73 } }] });
	await h.fire("session_start");
	setActiveRenderSession(h.sessionId);
	const above = new Container();
	overlay.setUICtx({
		theme,
		setWidget: (_k: string, f?: (tui: object, t: Theme) => Component) => {
			if (!f) return;
			above.addChild(new Spacer(1));
			above.addChild(f(tui, theme));
		},
		getToolsExpanded: () => false,
	} as unknown as ExtensionUIContext);
	overlay.update();
	const lines = (k: number, s: string) => new Text(Array.from({ length: k }, (_, i) => `${s} ${i}`).join("\n"), 0, 0);
	const { root } = createChatViewport({
		document: lines(60, "transcript"), pendingMessages: new Container(), status: new Container(),
		widgetsAbove: above, editor: lines(3, "editor"), widgetsBelow: new Container(), footer: lines(2, "footer"),
	});
	tui.setLayoutRoot(root);
	tui.start();
	ctx.after(() => { overlay.dispose(); tui.stop(); });
	tui.renderNow();
	await new Promise((r) => setImmediate(r));
	assert.ok(tui.getScreenLines().some((l) => stripVTControlCharacters(l).includes("#68 EP scenarios") && l.includes("⟶")));
	assert.deepEqual([...(claims.at(-1) ?? [])].sort(), [...BOUND_RUNS, ...UNBOUND].sort());
});

test("skald main, too few rows even for compact: the rows drawn are claimed, the rest are counted as before", async (ctx) => {
	env(ctx, { view: "full", maxWidgetLines: 4 });
	const m = await mount(skaldTasks(), () => skaldRows(NOW));
	const lines = m.render();
	assert.deepEqual(lines, [
		"● Todos (54/71)",
		"├─ ◐ #35 Final BitD UAT round for the boss",
		"├─ ◐ #55 S3 地圖 tab on core Table Maps, BitD map retired ⟶ coremaptab-ui · opus · running 4m",
		"└─ +69 more (54 completed, 6 in progress, 9 pending), 8 workers · ctrl+shift+t collapse",
		"",
	]);
	m.render();
	assert.deepEqual(m.claims.at(-1), ["coremaptab-ui"]);
	m.overlay.dispose();
});
