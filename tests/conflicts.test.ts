import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "./harness.ts";

test("known predecessor without registrations: project settings or installed manifest", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "ledger-known-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const cfg = join(dir, ".pi");
	mkdirSync(cfg);
	const lines: string[] = [];
	t.mock.method(console, "error", (s: string) => lines.push(s));
	writeFileSync(
		join(cfg, "settings.json"),
		JSON.stringify({ packages: ["npm:@juicesharp/rpiv-todo@2"] }),
	);
	await load({ cwd: dir }).fire("session_start");
	assert.match(lines.pop()!, /pi remove --local npm:@juicesharp\/rpiv-todo@2/);
	rmSync(join(cfg, "settings.json"));
	const root = join(
		cfg,
		"git/github.com/juicesharp/rpiv-mono/packages/rpiv-todo",
	);
	mkdirSync(root, { recursive: true });
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({ name: "@juicesharp/rpiv-todo" }),
	);
	await load({ cwd: dir }).fire("session_start");
	assert.ok(lines.pop()!.includes("rpiv-mono/packages/rpiv-todo"));
});

test("foreign winning tool triggers a visible warning", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "ledger-winner-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const path = join(cwd, "main.ts");
	writeFileSync(path, "");
	writeFileSync(join(cwd, "package.json"), '{"name":"winning-rival"}');
	const calls: string[][] = [];
	const h = load({
		cwd,
		ui: {
			notify: (...args: string[]) => calls.push(args),
			setWidget: () => {},
		},
		tools: [{ name: "todo", sourceInfo: { path } }],
	});
	await h.fire("session_start");
	assert.equal(calls.length, 1);
	assert.match(calls[0][0], /Active todo tool: winning-rival/);
	assert.equal(calls[0][1], "warning");
	await h.fire("session_shutdown");
});

test("duplicate command warns once and names the winning tool and exact removal source", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "ledger-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const root = join(cwd, ".pi", "npm", "node_modules", "rival");
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "index.ts"), "");
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "rival" }));
	writeFileSync(
		join(cwd, ".pi", "settings.json"),
		JSON.stringify({ packages: [{ source: "npm:rival@1" }] }),
	);
	const lines: string[] = [];
	t.mock.method(console, "error", (s: string) => lines.push(s));
	const h = load({
		cwd,
		commands: [
			{
				name: "todos:2",
				source: "extension",
				sourceInfo: { path: join(root, "index.ts") },
			},
		],
		tools: [
			{
				name: "todo",
				sourceInfo: {
					path: new URL("../src/index.ts", import.meta.url).pathname,
				},
			},
		],
	});
	await h.fire("session_start");
	await h.fire("session_start");
	assert.equal(lines.length, 1);
	assert.ok(lines[0].includes("node_modules/rival/index.ts"));
	assert.match(lines[0], /pi-todo-ledger/);
	assert.match(lines[0], /pi remove --local npm:rival@1/);
});
