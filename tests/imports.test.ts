import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

// Pi reloads extension TypeScript on /reload, but Node caches native .js/.mjs modules for the
// life of the process. A relative JavaScript import would keep an old version after an upgrade.
test("extension code imports relative modules only as .ts", () => {
	const files = readdirSync(join(root, "src"), { recursive: true, encoding: "utf8" }).filter((file) =>
		file.endsWith(".ts"),
	);
	assert.ok(files.length > 0);
	for (const name of files) {
		const source = readFileSync(join(root, "src", name), "utf8");
		for (const [, specifier] of source.matchAll(/(?:from|import\()\s*["'](\.[^"']*)["']/g)) {
			assert.match(specifier ?? "", /\.ts$/, `src/${name} imports ${specifier}`);
		}
	}
});
