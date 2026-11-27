import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Spacer, Text, TuiAltScreen } from "@earendil-works/pi-tui";
import { setActiveRenderSession } from "../src/todo.ts";
import { TodoOverlay } from "../src/todo-overlay.ts";
import { type Probe, type RunRow, runLine } from "../src/view/live-runs.ts";
import { load } from "./harness.ts";

// Pi's fullscreen chat layout is internal (not in the package exports); load it by path like Pi does.
const { createChatViewport } = (await import(
	new URL("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/chat-viewport.js", import.meta.url).href
)) as { createChatViewport: (o: Record<string, Component>) => { root: Component } };

const theme = { fg: (_c: string, s: string) => s, strikethrough: (s: string) => s } as Theme;
const worker = (extra: Partial<RunRow> = {}): RunRow => ({
	id: "w1", name: "deep-worker", model: "gpt-6.2-astra", agent: "worker", startedAt: Date.now() - 5000, phase: { kind: "active" }, ...extra,
});

async function mount(opts: { mode?: string; tui?: object; bound?: boolean; tasks?: number; expanded?: boolean; rows?: () => RunRow[] }) {
	const probes: Probe[] = [];
	const overlay = new TodoOverlay((p) => {
		probes.push(p.claim ? { claim: { ...p.claim, ids: [...p.claim.ids] } } : {});
		p.rows = { version: 1, rows: (opts.rows ?? (() => [worker()]))() };
	});
	const n = opts.tasks ?? 3;
	const tasks = Array.from({ length: n }, (_, i) => ({
		id: i + 1, subject: `task ${i + 1}`, status: "in_progress",
		...(opts.bound !== false && i === n - 1 ? { metadata: { herdr: { runs: [{ id: "w1", name: "deep-worker" }] } } } : {}),
	}));
	const h = load({ branch: [{ type: "custom", customType: "todo/v1", data: { v: 1, tasks, nextId: n + 1 } }] });
	await h.fire("session_start");
	setActiveRenderSession(h.sessionId);
	let widget!: Component;
	const redraws: boolean[] = [];
	const tui = opts.tui ?? { ...(opts.mode ? { mode: opts.mode } : {}), requestRender: (force?: boolean) => redraws.push(!!force) };
	overlay.setUICtx({
		theme,
		setWidget: (_k: string, f?: (tui: object, t: Theme) => Component) => { if (f) widget = f(tui, theme); },
		getToolsExpanded: () => opts.expanded ?? true,
	} as unknown as ExtensionUIContext);
	overlay.update();
	const claims = () => probes.filter((p) => p.claim).map((p) => p.claim!.ids);
	return { overlay, widget, probes, claims, redraws };
}

/** Pi's fullscreen TUI on a fake terminal, laid out by Pi's own chat viewport. */
function fullscreen() {
	const size = { columns: 80, rows: 40 };
	const terminal = {
		start() {}, stop() {}, async drainInput() {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {},
		clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
		get columns() { return size.columns; }, get rows() { return size.rows; }, get kittyProtocolActive() { return false; },
	};
	const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
	const above = new Container();
	const lines = (k: number, s: string) => new Text(Array.from({ length: k }, (_, i) => `${s} ${i}`).join("\n"), 0, 0);
	const mountWidget = (widget: Component) => {
		above.addChild(new Spacer(1));
		above.addChild(widget);
		const { root } = createChatViewport({
			document: lines(60, "transcript"), pendingMessages: new Container(), status: new Container(),
			widgetsAbove: above, editor: lines(3, "editor"), widgetsBelow: new Container(), footer: lines(2, "footer"),
		});
		tui.setLayoutRoot(root);
		tui.start();
	};
	// One painted frame, then the microtask that reads it.
	const frame = async (rows: number) => {
		size.rows = rows;
		tui.renderNow();
		await new Promise((r) => setImmediate(r));
		return tui.getScreenLines();
	};
	return { tui, mountWidget, frame };
}

test("fullscreen: a run row clipped by the layout is never claimed", async (ctx) => {
	const pi = fullscreen();
	ctx.after(() => pi.tui.stop());
	const m = await mount({ tui: pi.tui, tasks: 18 });
	pi.mountWidget(m.widget);
	for (let i = 0; i < 3; i++) {
		const short = await pi.frame(20);
		assert.ok(!short.some((l) => l.includes("deep-worker")), "short window clips the run row");
	}
	assert.deepEqual(m.claims().filter((ids) => ids.length), []);
	m.overlay.dispose();
});

test("fullscreen: a run row on the painted screen is claimed, and released once the layout clips it", async (ctx) => {
	const pi = fullscreen();
	ctx.after(() => pi.tui.stop());
	const m = await mount({ tui: pi.tui, tasks: 18 });
	pi.mountWidget(m.widget);
	const tall = await pi.frame(40);
	assert.ok(tall.some((l) => l.includes("deep-worker")), "tall window shows the run");
	assert.deepEqual(m.claims().at(-1), ["w1"]);
	await pi.frame(40);
	assert.deepEqual(m.claims().at(-1), ["w1"], "each painted frame renews the claim");
	const short = await pi.frame(20);
	assert.ok(!short.some((l) => l.includes("deep-worker")));
	assert.deepEqual(m.claims().at(-1), [], "the frame that clipped the row releases it");
	await pi.frame(40);
	assert.deepEqual(m.claims().at(-1), ["w1"]);
	m.overlay.dispose();
	assert.deepEqual(m.claims().at(-1), []);
});

test("fullscreen without getScreenLines gives no evidence, so nothing is claimed", async () => {
	const m = await mount({ mode: "fullscreen" });
	m.widget.render(80);
	await new Promise((r) => setImmediate(r));
	m.widget.render(80);
	await new Promise((r) => setImmediate(r));
	assert.deepEqual(m.claims(), []);
	m.overlay.dispose();
});

test("inline (regular) mode claims a run drawn on two frames", async () => {
	const m = await mount({ mode: "regular" });
	m.widget.render(80);
	m.widget.render(80);
	assert.deepEqual(m.claims(), [["w1"]]);
	m.overlay.dispose();
});

test("a host without a mode gives no visibility evidence, so nothing is claimed", async () => {
	const m = await mount({});
	m.widget.render(80);
	m.widget.render(80);
	assert.deepEqual(m.claims(), []);
	m.overlay.dispose();
});

test("collapse releases the claim before it asks for the redraw", async () => {
	const m = await mount({ mode: "regular" });
	m.widget.render(80);
	m.widget.render(80);
	const before = m.claims().length;
	m.redraws.length = 0;
	let releasedFirst = false;
	const orig = m.redraws.push.bind(m.redraws);
	m.redraws.push = (...v: boolean[]) => { releasedFirst = m.claims().length > before && m.claims().at(-1)!.length === 0; return orig(...v); };
	m.overlay.toggleCollapse();
	assert.ok(releasedFirst, "release sent before requestRender(true)");
	const sent = m.probes.length;
	m.widget.render(80);
	assert.equal(m.probes.length, sent, "collapsed frame neither probes nor re-sends a release");
	m.overlay.dispose();
});

test("no bound runs: the widget never probes the host and never sends a release", async () => {
	const m = await mount({ mode: "regular", bound: false });
	m.widget.render(80);
	m.widget.render(80);
	m.overlay.dispose();
	assert.equal(m.probes.length, 0);
});

test("a release goes out only when an old claim exists", async () => {
	let rows = [worker()];
	const m = await mount({ mode: "regular", rows: () => rows });
	m.widget.render(80);
	m.widget.render(80);
	rows = [];
	m.widget.render(80);
	m.widget.render(80);
	m.widget.render(80);
	assert.deepEqual(m.claims(), [["w1"], []]);
	m.overlay.dispose();
	assert.deepEqual(m.claims(), [["w1"], []], "dispose after a release sends nothing");
});

for (const [cancel, en, zh] of [["requested", "cancelling", "取消中"], ["unconfirmed", "cancel unconfirmed", "取消未確認"]] as const) {
	test(`cancel ${cancel} leads the run line in en and zh-TW`, (ctx) => {
		const old = process.env.LC_ALL;
		ctx.after(() => { if (old === undefined) delete process.env.LC_ALL; else process.env.LC_ALL = old; });
		const row = worker({ cancel, phase: { kind: "active", label: "thread_wait" }, startedAt: 0 });
		process.env.LC_ALL = "C";
		assert.equal(runLine(row, 42_000), `deep-worker · astra · ${en} 42s`);
		process.env.LC_ALL = "zh_TW.UTF-8";
		assert.equal(runLine(row, 42_000), `deep-worker · astra · ${zh} 42s`);
	});
}
