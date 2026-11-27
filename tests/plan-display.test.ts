import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { registerTodosCommand, setActiveRenderSession } from "../src/todo.ts";
import { TodoOverlay } from "../src/todo-overlay.ts";
import { renderTodoResult } from "../src/view/format.ts";
import { load, snapshots, text, type Harness, type ToolResult } from "./harness.ts";

const theme = { fg: (_color: string, s: string) => s, strikethrough: (s: string) => s } as Theme;
const card = (r: ToolResult) => renderTodoResult(r, theme).render(180).join("\n");

async function surfaces(h: Harness, width = 120, overlay = new TodoOverlay(), expanded = true) {
	let render!: (width: number) => string[];
	let command!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
	let notification = "";
	const muted: string[] = [];
	const ui = {
		theme: { ...theme, fg: (color: string, s: string) => { if (color === "muted") muted.push(s); return s; } },
		notify: (s: string) => { notification = s; },
		setWidget: (_key: string, factory?: (tui: object, t: Theme) => { render: typeof render }) => {
			if (factory) render = factory({ mode: "regular", requestRender() {} }, theme).render;
		},
		getToolsExpanded: () => expanded,
	} as unknown as ExtensionUIContext;
	registerTodosCommand({ registerCommand: (_: string, c: { handler: typeof command }) => { command = c.handler; } } as unknown as ExtensionAPI);
	await command("", { ...h.ctx, hasUI: true, ui } as ExtensionCommandContext);
	const commandMuted = [...muted];
	muted.length = 0;
	setActiveRenderSession(h.sessionId);

	overlay.setUICtx(ui);
	overlay.update();
	const rows = render(width);
	render(width);
	overlay.toggleCollapse();
	const collapsed = render(width);
	overlay.dispose();
	return { rows, collapsed, notification, commandMuted, overlayMuted: muted };
}

/** These tests pin the whole tree, so they run the panel with `"view": "full"`. */
function fullView(ctx: { after: (fn: () => void) => void }, config: object = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'todo-full-'));
	const xdg = process.env.XDG_CONFIG_HOME;
	ctx.after(() => { if (xdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = xdg; rmSync(dir, { recursive: true, force: true }); });
	mkdirSync(join(dir, 'pi-todo-ledger'));
	const write = (extra: object) => writeFileSync(join(dir, 'pi-todo-ledger', 'config.json'), JSON.stringify({ view: "full", ...config, ...extra }));
	write({});
	process.env.XDG_CONFIG_HOME = dir;
	return write;
}

test("live projection draws only bound runs, then releases the claim on collapse", async (ctx) => {
	const config = fullView(ctx);
	ctx.mock.timers.enable({apis:['Date'],now:1_000_000});
	const old = process.env.LC_ALL;
	process.env.LC_ALL = 'zh_Hant_TW.UTF-8';
	ctx.after(()=>{if(old===undefined) delete process.env.LC_ALL; else process.env.LC_ALL=old;});
	const rows = [ ["todograph-build", "gpt-6.2-astra", "active", 240], ["todograph-ui", "claude-opus-4-5", "waiting", 42], ["todograph-review", "gpt-6.2-sol", "active", 60] ] as const;
	const claims: string[][] = [];
	const overlay = new TodoOverlay(p => { if (p.claim) claims.push(p.claim.ids); p.rows = { version: 1, rows: rows.map(([name,model,kind,time],i) => ({ id:name,name,model,agent:i===2?"reviewer":"worker",phase:{kind,label:i===1?"thread_wait":undefined},startedAt:Date.now()-time*1000 })) }; });
	const tasks = ["sb 插單規則", "ledger 0.6.0", "sb 計畫圖", "maestro 研究"].map((subject,i) => ({id:61+i,subject,graph:"fan-out/fan-in",status:["completed","in_progress","in_progress","pending"][i],metadata:i===3?{waitsOn:"boss"}:{herdr:{runs:(i===1?rows.slice(0,1):i===2?rows.slice(1):[]).map(([name])=>({id:name,name}))}}}));
	const h = load({branch:[{type:"custom",customType:"todo/v1",data:{v:1,tasks,nextId:65}}]});
	await h.fire("session_start");
	const view = await surfaces(h,120,overlay);
	assert.deepEqual(view.rows,["● Todos (1/4) · fan-out", "├─ ✓ #61 sb 插單規則", "├─ ◐ #62 ledger 0.6.0", "│    └ todograph-build · astra · 執行中 4m", "├─ ◐ #63 sb 計畫圖", "│    ├ todograph-ui · opus · 等 thread 42s", "│    └ todograph-review · sol · 審查中 1m", "└─ ⏸ #64 maestro 研究 等 boss", ""]);
	assert.deepEqual(claims,[rows.map(([name])=>name),[]]);
	config({maxWidgetLines:5});
	claims.length=0;
	const limited = await surfaces(h,120,overlay,false);
	assert.ok(limited.rows.includes('├─ ◐ #63 sb 計畫圖 · 2 個工作階段'));
	assert.ok(claims.every(ids=>!ids.length));
});

test("each get/list/create/update task exposes its stable uid to the caller and in the result card", async () => {
	const h = load();
	const created = await h.call({ action: "create", tasks: [{ subject: "API" }, { subject: "UI" }] });
	const [a, b] = snapshots(h.branch).at(-1)!.tasks.map(t => String(t.uid));
	const check = (r: ToolResult, uids: string[]) => {
		for (const body of [text(r), card(r)]) for (const uid of uids) assert.ok(body.includes(uid), body);
	};
	check(created, [a, b]);
	check(await h.call({ action: "get", id: 2 }), [b]);
	check(await h.call({ action: "list" }), [a, b]);
	for (let i = 0; i < 2; i++) check(await h.call({ action: "update", id: 1, owner: "me" }), [a]);
	await h.call({ action: "update", id: 1, status: "completed" });
	const filtered = await h.call({ action: "list", status: "pending" });
	check(filtered, [b]);
	assert.ok(!card(filtered).includes(a));
});

for (const [label, status, metadata, expected] of [
	["party", "in_progress", { waitsOn: "QA\nteam" }, "waits QA team"],
	["future", "pending", { until: "2099-12-01T18:47:00Z" }, "until "],
	["past", "pending", { until: "2001-01-01T00:00:00Z" }, ""],
	["non-ISO", "pending", { until: "Dec 1 2099" }, ""],
	["finished", "completed", { waitsOn: "QA" }, ""],
] as const) {
	test(`${label}: waiting is a display mark across lookup, card, widget and /todos`, async () => {
		const h = load();
		await h.call({ action: "create", subject: "Approve" });
		const updated = await h.call({ action: "update", id: 1, status, metadata });
		const get = await h.call({ action: "get", id: 1 });
		const list = await h.call({ action: "list" });
		const { rows, notification } = await surfaces(h);
		for (const body of [rows.join("\n"), notification, ...[updated, get, list].flatMap(r => [card(r), text(r)])]) {
			assert.equal(body.includes("⏸"), Boolean(expected), body);
			if (expected) assert.ok(body.includes(expected), body);
			if (label === "future") {
				const local = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" });
				assert.ok(body.includes(local.format(new Date(metadata.until))), body);
			}
		}
		assert.equal(snapshots(h.branch).at(-1)!.tasks[0].status, status);
	});
}

test("overlay and /todos nest a chain and a fan-out, show muted owners and share one graph heading", async (ctx) => {
	fullView(ctx);
	const h = load();
	const graph = "fan-out/fan-in";
	for (const spec of [{ subject: "Scope", owner: "Ari" }, { subject: "Approve", metadata: { waitsOn: "Pat" } },
		{ subject: "API", blockedBy: [1] }, { subject: "Check API", blockedBy: [3] }, { subject: "UI", blockedBy: [1] }]) {
		await h.call({ action: "create", graph, ...spec });
	}
	await h.call({ action: "update", id: 1, status: "in_progress" });
	const view = await surfaces(h);
	assert.deepEqual(view.rows, ["● Todos (0/5) · fan-out/fan-in", "├─ ◐ #1 Scope @Ari", "├─   ○ #3 API",
		"├─     ○ #4 Check API", "├─   ○ #5 UI", "└─ ⏸ #2 Approve waits Pat", ""]);
	assert.equal(view.notification, ["1 in progress · 4 pending · fan-out/fan-in", "  ◐ #1 Scope @Ari", "    ○ #3 API",
		"      ○ #4 Check API", "    ○ #5 UI", "  ⏸ #2 Approve waits Pat"].join("\n"));
	for (const calls of [view.commandMuted, view.overlayMuted]) assert.ok(calls.some(s => s.includes("@Ari")));
	assert.equal(view.collapsed.length, 3);
	assert.match(view.collapsed[0], /fan-out\/fan-in/);
	const narrow = await surfaces(h, 13);
	assert.ok(narrow.rows.every(l => visibleWidth(l) <= 13));
	assert.ok(narrow.rows.some(l => l.includes("…")));
	await h.call({ action: "update", id: 2, graph: "single-loop" });
	await h.call({ action: "update", id: 4, addBlockedBy: [5] });
	const mixed = await surfaces(h);
	for (const body of [mixed.rows.join("\n"), mixed.notification]) {
		const lines = body.split("\n");
		assert.ok(!lines[0].includes(graph));
		assert.match(lines.find(l => l.includes("Scope"))!, /fan-out\/fan-in/);
		assert.match(lines.find(l => l.includes("Approve"))!, /single-loop/);
		assert.match(lines.find(l => l.includes("Check API"))!, /⛓ #5/);
		assert.match(lines.find(l => l.includes("Check API"))!, /↳ #3/);
		assert.ok(lines.findIndex(l => l.includes("Check API")) > lines.findIndex(l => l.includes("#5 UI")));
	}
});
