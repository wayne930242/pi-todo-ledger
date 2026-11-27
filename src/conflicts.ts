import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { t } from "./state/i18n-bridge.ts";

const self = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
const predecessors = ["@juicesharp/rpiv-todo", "rpiv-todo"];
function real(path: string) {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}
function json(path: string) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}
function owner(path: string) {
	for (let dir = dirname(path); ; dir = dirname(dir)) {
		const name: unknown = json(join(dir, "package.json"))?.name;
		if (typeof name === "string" && name) return { root: dir, name };
		if (dirname(dir) === dir) return { root: path, name: basename(path) };
	}
}
const quote = (s: string) =>
	/^[\w@.:/+~-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`;
interface Rival {
	name: string;
	path: string;
	commands: Set<string>;
}
export function conflictWarning(pi: ExtensionAPI, ctx: ExtensionContext) {
	const found = new Map<string, Rival>();
	function add(path: string, name: string, root: string) {
		let item = found.get(root);
		if (!item) {
			item = { name, path, commands: new Set() };
			found.set(root, item);
		}
		return item;
	}
	const tool = pi.getAllTools().find((x) => x.name === "todo");
	const toolPath = tool?.sourceInfo?.path;
	const active = toolPath ? owner(real(toolPath)).name : "—";
	const registrations = new Map<string, Set<string>>();
	for (const info of [
		tool?.sourceInfo,
		...pi
			.getCommands()
			.filter(
				(c) => c.source === "extension" && /^todos?(?::\d+)?$/.test(c.name),
			)
			.map((c) => c.sourceInfo),
	]) {
		const path = info?.path;
		if (!path || !isAbsolute(path)) continue;
		const p = real(path),
			pkg = owner(p);
		if (pkg.root === self) continue;
		add(p, pkg.name, pkg.root);
		const sources = registrations.get(pkg.root) ?? new Set<string>();
		sources.add(`${info.scope}:${info.source}`);
		registrations.set(pkg.root, sources);
	}
	const globalDir = resolve(
		(
			process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent")
		).replace(/^~(?=\/)/, homedir()),
	);
	for (const [dir, local] of [
		[globalDir, false],
		[join(ctx.cwd, ".pi"), true],
	] as const) {
		const npmRoot = join(dir, "npm", "node_modules");
		const gitRoot = join(dir, "git");
		for (const root of [
			...predecessors.map((n) => join(npmRoot, n)),
			join(
				gitRoot,
				"github.com",
				"juicesharp",
				"rpiv-mono",
				"packages",
				"rpiv-todo",
			),
			join(gitRoot, "github.com", "juicesharp", "rpiv-todo"),
		]) {
			const name = json(join(root, "package.json"))?.name;
			if (predecessors.includes(name)) add(real(root), name, real(root));
		}
		const packages: unknown = json(join(dir, "settings.json"))?.packages;
		if (!Array.isArray(packages)) continue;
		for (const entry of packages) {
			const source = typeof entry === "string" ? entry : entry?.source;
			if (typeof source !== "string" || /[\x00-\x1f\x7f]/.test(source))
				continue;
			const npm = /^npm:((?:@[^/@]+\/)?[^/@]+)(?:@.*)?$/.exec(source)?.[1];
			const git =
				/^(?:git:|https?:\/\/|ssh:\/\/)(?:https?:\/\/)?(?:git@)?([\w.-]+)[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:@[^\s]+)?$/.exec(
					source,
				);
			const root = real(
				npm
					? join(npmRoot, npm)
					: git
						? join(gitRoot, git[1], git[2], git[3])
						: resolve(dir, source.replace(/^~(?=\/)/, homedir())),
			);
			const name = npm ?? json(join(root, "package.json"))?.name;
			if (predecessors.includes(name)) add(root, name, root);
			for (const [key, item] of found)
				if (
					key === root ||
					(git && key.startsWith(root + sep)) ||
					registrations.get(key)?.has(`${local ? "project" : "user"}:${source}`)
				)
					item.commands.add(
						`pi remove ${local ? "--local " : ""}${quote(source)}`,
					);
		}
	}
	if (!found.size) return;
	const rivals = [...found.values()]
		.map((x) => `${x.name} (${x.path})`)
		.join("; ");
	const commands = [
		...new Set([...found.values()].flatMap((x) => [...x.commands])),
	];
	return (
		t(
			"conflict.warning",
			"Todo conflict: {rivals}. Active todo tool: {active}.",
		)
			.replace("{rivals}", () => rivals)
			.replace("{active}", () => active) +
		" " +
		[...commands, "/reload"].join(" → ")
	);
}
