import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { registerTodosCommand, setActiveRenderSession } from "../src/todo.ts";
import { TodoOverlay } from "../src/todo-overlay.ts";
import { renderTodoResult } from "../src/view/format.ts";
import { load, snapshots, text, type Harness, type ToolResult } from "./harness.ts";

const theme = { fg: (_color: string, s: string) => s, strikethrough: (s: string) => s } as Theme;
const card = (r: ToolResult) => renderTodoResult(r, theme).render(180).join("\n");

async function surfaces(h: Harness, width = 120) {
	let render!: (width: number) => string[];
	let command!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
	let notification = "";
	const muted: string[] = [];
	const ui = {
		theme: { ...theme, fg: (color: string, s: string) => { if (color === "muted") muted.push(s); return s; } },
		notify: (s: string) => { notification = s; },
		setWidget: (_key: string, factory?: (tui: object, t: Theme) => { render: typeof render }) => {
			if (factory) render = factory({ requestRender() {} }, theme).render;
		},
		getToolsExpanded: () => true,
	} as unknown as ExtensionUIContext;
	registerTodosCommand({ registerCommand: (_: string, c: { handler: typeof command }) => { command = c.handler; } } as unknown as ExtensionAPI);
	await command("", { ...h.ctx, hasUI: true, ui } as ExtensionCommandContext);
	const commandMuted = [...muted];
	muted.length = 0;
	setActiveRenderSession(h.sessionId);
	const overlay = new TodoOverlay();
	overlay.setUICtx(ui);
	overlay.update();
	const rows = render(width);
	overlay.toggleCollapse();
	const collapsed = render(width);
	overlay.dispose();
	return { rows, collapsed, notification, commandMuted, overlayMuted: muted };
}

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

test("overlay and /todos nest a chain and a fan-out, show muted owners and share one graph heading", async () => {
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
