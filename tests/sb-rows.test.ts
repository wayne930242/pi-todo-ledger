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
import { ASK_ROWS_EVENT, type AskRow, CAR_ROWS_EVENT, type CarRow } from "../src/view/sb-rows.ts";
import { SB_LOOK_MS } from "../src/index.ts";
import { load } from "./harness.ts";

// sb's car rows (`straw-boss:car-rows:v1`) and ask rows (`straw-boss:ask-rows:v1`) on the panel: each under the todo it names, else in a
// group, ranked with the run rows; in compact mode on the todo's row. With no sb, nothing of them shows.

const theme = { fg: (_c: string, s: string) => s, strikethrough: (s: string) => s } as Theme;
const NOW = 10_000_000;
const ME = "intercom-me-1";

function env(ctx: TestContext, config?: object, locale = "C", apis: Array<"Date" | "setInterval"> = ["Date"]) {
	const dir = mkdtempSync(join(tmpdir(), "todo-sb-rows-"));
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
	ctx.mock.timers.enable({ apis, now: NOW });
}

type Spec = { id: number; uid?: string; subject: string; status: string; metadata?: object };
const task = (id: number, status = "pending", extra: Partial<Spec> = {}): Spec => ({ id, subject: `t${id}`, status, ...extra });
const bound = (...runs: string[]) => ({ metadata: { herdr: { runs: runs.map((id) => ({ id, name: id })) } } });
const run = (id: string, secs = 5): RunRow => ({ id, name: id, model: "gpt-6.2-astra", agent: "worker", startedAt: NOW - secs * 1000, phase: { kind: "active" } });
const car = (id: string, extra: Partial<CarRow> = {}): CarRow => ({
	id, tickets: ["MP-1"], phase: "riding", tone: "ok", line: "🚂 1128a ▰▰▰▱▱▱▱ merge", since: NOW - 12 * 60_000, ...extra,
});
const ask = (id: string, extra: Partial<AskRow> = {}): AskRow => ({
	id, subject: "Deploy MP-1 now?", asker: "main", where: "Alpha › main", kind: "boss", since: NOW - 5 * 60_000, mine: true, ...extra,
});

interface Sb { cars?: () => unknown; asks?: () => unknown; session?: string | null }
async function mount(tasks: Spec[], runs: () => RunRow[], sb: Sb | undefined, opts: { width?: number } = {}) {
	const claims: string[][] = [];
	const overlay = new TodoOverlay(
		(p) => {
			if (p.claim) claims.push([...p.claim.ids]);
			p.rows = { version: 1, rows: runs() };
		},
		sb &&
			((event, p) => {
				const probe = p as { rows?: unknown };
				if (event === CAR_ROWS_EVENT && sb.cars)
					probe.rows = { ...(sb.cars() as object), ...(sb.session === null ? {} : { session: sb.session ?? ME }) };
				if (event === ASK_ROWS_EVENT && sb.asks)
					probe.rows = { ...(sb.asks() as object), ...(sb.session === null ? {} : { session: sb.session ?? ME }) };
			}),
	);
	const h = load({ branch: [{ type: "custom", customType: "todo/v1", data: { v: 1, tasks, nextId: tasks.length + 1 } }] });
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
	return { overlay, claims, registered: () => widget !== undefined, render: (width = opts.width ?? 110) => widget!.render(width) };
}
const v1 = (rows: unknown[]) => ({ version: 1, rows });

// A coordinator main: #1 sends a car and has a worker, #2 waits on the boss, #3 is next.
const TASKS = () => [
	task(1, "in_progress", { uid: "t_aaaaaaaaaa", subject: "MP-1 ship the order list", ...bound("list-worker") }),
	task(2, "in_progress", { uid: "t_bbbbbbbbbb", subject: "MP-2 pick the deploy window" }),
	task(3),
];
const SB: Sb = {
	cars: () => v1([car("p/fe2-abc#1", { item: "t_aaaaaaaaaa", wait: "waits 1127j", tone: "wait" }), car("sent:v3-def", { tickets: ["MP-9"], phase: "sent", tone: "wait", line: "📮 sent", group: "Other cars", wait: "not received yet · MP-9", since: NOW - 3 * 60_000 })]),
	asks: () => v1([ask("Q3", { item: { session: ME, id: 2, uid: "t_bbbbbbbbbb" } }), ask("Q4", { subject: "Approve the key", mine: false, asker: "box-2" })]),
};

test("full view: a car under the todo it names, an ask under the todo it blocks, a car with no todo in its group; another session's ask is not drawn", async (ctx) => {
	env(ctx, { view: "full" });
	const m = await mount(TASKS(), () => [run("list-worker")], SB);
	try {
		assert.deepEqual(m.render(), [
			"● Todos (0/3)",
			"├─ ◐ #1 MP-1 ship the order list",
			"│    ├ list-worker · astra · running 5s",
			"│    └ 🚂 1128a ▰▰▰▱▱▱▱ merge 12m · waits 1127j",
			"├─ ◐ #2 MP-2 pick the deploy window",
			"│    └ ⏸ waits on you: Deploy MP-1 now? 5m",
			"├─ ○ #3 t3",
			"├─ Other cars",
			"│    └ 📮 sent 3m · not received yet · MP-9",
			"└─ ctrl+shift+t collapse",
			"",
		]);
	} finally {
		m.overlay.dispose();
	}
});

test("zh-TW: the ask reads 等你, and an ask of this session with no todo goes in the 等你 group", async (ctx) => {
	env(ctx, { view: "full" }, "zh_TW.UTF-8");
	const m = await mount([task(1, "in_progress", { uid: "t_cccccccccc" }), task(2)], () => [], {
		asks: () => v1([ask("Q3", { item: { session: ME, id: 1, uid: "t_cccccccccc" }, subject: "要現在部署嗎？" }), ask("Q5", { subject: "選哪個方案？" })]),
	});
	try {
		assert.deepEqual(m.render(), [
			"● Todos (0/2)",
			"├─ ◐ #1 t1",
			"│    └ ⏸ 等你：要現在部署嗎？ 5m",
			"├─ ○ #2 t2",
			"├─ 等你",
			"│    └ ⏸ 選哪個方案？ 5m",
			"└─ ctrl+shift+t 收合",
			"",
		]);
	} finally {
		m.overlay.dispose();
	}
});

test("an ask whose todo is another session's (a subagent's own), or from an sb that names no session, is not put under this session's todo of that id", async (ctx) => {
	env(ctx, { view: "full" });
	for (const sb of [
		{ asks: () => v1([ask("Q3", { item: { session: "subagent-7", id: 1 } })]) },
		{ asks: () => v1([ask("Q3", { item: { session: ME, id: 1 } })]), session: null },
	] satisfies Sb[]) {
		const m = await mount([task(1, "in_progress")], () => [], sb);
		try {
			assert.deepEqual(m.render().slice(1, 4), ["├─ ◐ t1", "├─ Waiting on you", "│    └ ⏸ Deploy MP-1 now? 5m"]);
		} finally {
			m.overlay.dispose();
		}
	}
});

test("compact mode: car and ask rows go on their todo's row, the ask leads, and the rows rank with run rows", async (ctx) => {
	env(ctx, { view: "full", maxWidgetLines: 5 });
	const m = await mount(TASKS(), () => [run("list-worker")], SB);
	try {
		const lines = m.render();
		assert.equal(lines.length, 6, `the budget holds:\n${lines.join("\n")}`);
		assert.deepEqual(lines.slice(1, 5), [
			"├─ ◐ #1 MP-1 ship the order list ⟶ list-worker · astra · running 5s +1",
			"├─ ◐ #2 MP-2 pick the deploy window ⟶ ⏸ waits on you: Deploy MP-1 now? 5m",
			"├─ ○ #3 t3",
			"└─ Other cars ⟶ 📮 sent 3m · not received yet · MP-9",
		]);
		m.render();
		assert.deepEqual(m.claims.at(-1), ["list-worker"], "a compact row still claims the run it stands for");
	} finally {
		m.overlay.dispose();
	}
});

test("a todo with only a car shows the car on its compact row, a returned car before a running worker", async (ctx) => {
	env(ctx, { view: "full", maxWidgetLines: 3 });
	const m = await mount([task(1, "in_progress", { uid: "t_aaaaaaaaaa", ...bound("w") }), task(2, "in_progress", { uid: "t_bbbbbbbbbb" })], () => [run("w")], {
		cars: () => v1([car("c1", { item: "t_aaaaaaaaaa", phase: "returned", tone: "bad", line: "↩ returned", wait: "red unit gate" }), car("c2", { item: `${ME.slice(0, 8)}#2` })]),
	});
	try {
		assert.deepEqual(m.render().slice(1, 3), [
			"├─ ◐ #1 t1 ⟶ ↩ returned 12m · red unit gate +1",
			"└─ ◐ #2 t2 ⟶ 🚂 1128a ▰▰▰▱▱▱▱ merge 12m",
		]);
	} finally {
		m.overlay.dispose();
	}
});

test("with no sb, or an sb answering another version or malformed rows, the panel is as before", async (ctx) => {
	env(ctx, { view: "full" });
	const before = await mount(TASKS(), () => [run("list-worker")], undefined);
	const plain = before.render();
	before.overlay.dispose();
	assert.ok(!plain.some((l) => /🚂|⏸|Other cars|Waiting/.test(l)));
	const odd = await mount(TASKS(), () => [run("list-worker")], {
		cars: () => ({ version: 2, rows: [car("x", { item: "t_aaaaaaaaaa" })] }),
		asks: () => v1([{ id: "Q1", kind: "boss", since: NOW, mine: true }, ask("Q2", { since: Number.NaN })]),
	});
	try {
		assert.deepEqual(odd.render(), plain);
	} finally {
		odd.overlay.dispose();
	}
});

test("cars and asks alone keep the panel up, and the collapsed panel counts the asks waiting on you", async (ctx) => {
	env(ctx, { view: "full" });
	const m = await mount([], () => [], { cars: () => v1([car("c", { group: "Other cars" })]), asks: () => v1([ask("Q3")]) });
	try {
		assert.ok(m.registered());
		assert.deepEqual(m.render().slice(1, 5), ["├─ Waiting on you", "│    └ ⏸ Deploy MP-1 now? 5m", "├─ Other cars", "│    └ 🚂 1128a ▰▰▰▱▱▱▱ merge 12m"]);
		m.overlay.cycleView();
		assert.deepEqual(m.render(), ["○ Todos (0/0)", "└─ ⏸ 1 waiting on you · ctrl+shift+t focus", ""]);
	} finally {
		m.overlay.dispose();
	}
});

test("an ask that opens between turns, while a dialog waits, brings the panel up within SB_LOOK_MS; with no sb nothing loads", async (ctx) => {
	env(ctx, undefined, "C", ["Date", "setInterval"]);
	let widget = undefined as Component | undefined;
	const ui = {
		theme,
		notify() {},
		getToolsExpanded: () => false,
		setWidget: (_k: string, f?: (tui: object, t: Theme) => Component) => {
			widget = f ? f({ mode: "regular", requestRender() {} }, theme) : undefined;
		},
	};
	const rows: AskRow[] = [];
	const h = load({ ui, before: (hh) => hh.bus.on(ASK_ROWS_EVENT, (p: { rows?: unknown }) => { p.rows = { version: 1, session: ME, rows }; }) });
	setActiveRenderSession(h.sessionId);
	await h.fire("session_start");
	ctx.mock.timers.tick(SB_LOOK_MS);
	await new Promise((r) => setImmediate(r));
	assert.equal(widget, undefined, "nothing to show yet");
	rows.push(ask("Q3"));
	ctx.mock.timers.tick(SB_LOOK_MS);
	for (let i = 0; i < 5 && !widget; i++) await new Promise((r) => setImmediate(r));
	assert.deepEqual((widget as Component | undefined)?.render(120).slice(1, 3), ["├─ Waiting on you", "│    └ ⏸ Deploy MP-1 now? 5m"]);
	await h.fire("session_shutdown");
});

test("carrows-review-F001: an ask goes under its todo only when the uid it was bound with is that todo's; after clear a new #1 is not blocked by it", async (ctx) => {
	env(ctx, { view: "full" });
	for (const item of [{ session: ME, id: 1, uid: "t_oldoldoldo" }, { session: ME, id: 1 }]) {
		const m = await mount([task(1, "in_progress", { uid: "t_newnewnewn", subject: "a new todo after clear" })], () => [], { asks: () => v1([ask("Q3", { item })]) });
		try {
			assert.deepEqual(m.render().slice(1, 4), ["├─ ◐ a new todo after clear", "├─ Waiting on you", "│    └ ⏸ Deploy MP-1 now? 5m"], JSON.stringify(item));
		} finally {
			m.overlay.dispose();
		}
	}
});

test("carrows-review-F003: a car's `<session8>#id` must name this session; another session's prefix, or an sb that names no session, puts it in its group", async (ctx) => {
	env(ctx, { view: "full" });
	for (const [item, session] of [["abcdefgh#1", undefined], [`${ME.slice(0, 8)}#1`, null]] as const) {
		const m = await mount([task(1, "in_progress")], () => [], { cars: () => v1([car("c", { item })]), ...(session === null ? { session } : {}) });
		try {
			assert.deepEqual(m.render().slice(1, 4), ["├─ ◐ t1", "├─ Other cars", "│    └ 🚂 1128a ▰▰▰▱▱▱▱ merge 12m"], item);
		} finally {
			m.overlay.dispose();
		}
	}
});
