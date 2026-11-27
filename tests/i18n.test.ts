import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { t } from "../src/state/i18n-bridge.ts";

const SDK_STATE = Symbol.for("rpiv-i18n");
const g = globalThis as { [k: symbol]: unknown };
const word = () => t("run.kind.active", "running");

function sandbox(ctx: { after: (fn: () => void) => void }) {
	const dir = mkdtempSync(join(tmpdir(), "todo-i18n-"));
	const saved = { env: { ...process.env }, argv: [...process.argv], state: g[SDK_STATE] };
	ctx.after(() => {
		process.env = saved.env;
		process.argv = saved.argv;
		g[SDK_STATE] = saved.state;
		rmSync(dir, { recursive: true, force: true });
	});
	process.env.HOME = dir;
	process.env.XDG_CONFIG_HOME = join(dir, "xdg");
	delete process.env.LC_MESSAGES;
	delete process.env.LANG;
	const pick = (locale: string | undefined) => {
		mkdirSync(join(dir, "xdg", "rpiv-i18n"), { recursive: true });
		writeFileSync(join(dir, "xdg", "rpiv-i18n", "locale.json"), JSON.stringify(locale ? { locale } : {}));
	};
	// The SDK publishes a fresh frozen snapshot on every applyLocale().
	const apply = (locale: string | undefined) => { g[SDK_STATE] = Object.freeze({ locale, namespaces: {} }); };
	return { pick, apply };
}

test("without the SDK, a Traditional system locale renders zh-TW and others fall back to English", (ctx) => {
	sandbox(ctx);
	delete g[SDK_STATE];
	process.env.LC_ALL = "zh_TW.UTF-8";
	assert.equal(word(), "執行中");
	process.env.LC_ALL = "zh_Hant_TW.UTF-8";
	assert.equal(word(), "執行中");
	process.env.LC_ALL = "zh_CN.UTF-8";
	assert.equal(word(), "running");
});

test("system default: the SDK's region-less zh from a zh_TW system renders Traditional", (ctx) => {
	const { apply } = sandbox(ctx);
	process.env.LC_ALL = "zh_TW.UTF-8";
	apply("zh");
	assert.equal(word(), "執行中");
});

test("an explicit zh pick or --locale zh stays Simplified on a zh_TW system", (ctx) => {
	const { pick, apply } = sandbox(ctx);
	process.env.LC_ALL = "zh_TW.UTF-8";
	apply("zh");
	assert.equal(word(), "執行中");
	pick("zh"); // /languages saves first, then applies the same code again
	apply("zh");
	assert.equal(word(), "running", "explicit zh goes to the SDK's zh strings, not zh-TW");
	pick(undefined); // System default
	apply("zh");
	assert.equal(word(), "執行中");
	process.argv = [...process.argv, "--locale", "zh"];
	apply("zh");
	assert.equal(word(), "running");
});

test("explicit zh-TW wins over any system locale; explicit en wins over zh_TW", (ctx) => {
	const { pick, apply } = sandbox(ctx);
	process.env.LC_ALL = "en_US.UTF-8";
	process.argv = [...process.argv, "--locale=zh-TW"];
	apply("zh-TW");
	assert.equal(word(), "執行中");
	process.argv = process.argv.filter((a) => a !== "--locale=zh-TW");
	process.env.LC_ALL = "zh_TW.UTF-8";
	pick("en");
	apply("en");
	assert.equal(word(), "running");
});

test("system default follows LC_ALL > LC_MESSAGES > LANG for Traditional, though the SDK reads LANG first", (ctx) => {
	const { apply } = sandbox(ctx);
	process.env.LANG = "en_US.UTF-8";
	process.env.LC_ALL = "zh_TW.UTF-8";
	apply("en"); // the SDK derived `en` from LANG
	assert.equal(word(), "執行中");
	delete process.env.LC_ALL;
	process.env.LC_MESSAGES = "zh_Hant_TW.UTF-8";
	apply("en");
	assert.equal(word(), "執行中");
	process.env.LC_MESSAGES = "en_US.UTF-8";
	process.env.LANG = "zh_TW.UTF-8";
	apply("zh");
	assert.equal(word(), "running", "LC_MESSAGES outranks LANG");
});
