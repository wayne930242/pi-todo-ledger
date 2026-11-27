import { EventEmitter } from "node:events";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";

export interface ToolResult {
	content: Array<{ type: string; text?: string }>;
	details?: unknown;
	isError?: boolean;
}

export interface Harness {
	/** Session branch: entries appended by the extension land here, after any seeded ones. */
	branch: unknown[];
	/** Every `pi.events` emission, in order, from any emitter. */
	emitted: Array<{ channel: string; data: unknown }>;
	bus: EventEmitter;
	sessionId: string;
	ctx: ExtensionContext;
	/** Call the `todo` tool the way pi does after argument validation. */
	call(params: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>;
	/** Fire a pi lifecycle event at the extension. */
	fire(event: string, fields?: Record<string, unknown>): Promise<unknown>;
	/** Emit on the shared event bus, as another extension would. */
	emit(channel: string, data: unknown): void;
	/** Events emitted on one channel. */
	events(channel: string): unknown[];
	/** Keys the extension bound with `registerShortcut`, in order. */
	shortcuts: string[];
}

let sessionCounter = 0;

/**
 * Load the extension against a minimal pi: a real event bus, a branch that
 * `appendEntry` writes to, and a headless session context. `before` runs on the
 * bus before the extension loads (an extension that loaded first).
 */
export function load(
	options: {
		commands?: unknown[];
		tools?: unknown[];
		branch?: unknown[];
		sessionId?: string;
		cwd?: string;
		before?: (h: Harness) => void;
		/** Throw from `appendEntry` while this returns true. */
		failAppend?: () => boolean;
		guardTimeoutMs?: number;
		/** An interactive session: `ctx.hasUI` is true, and the real overlay loads into this UI. */
		ui?: Record<string, unknown>;
	} = {},
): Harness {
	const bus = new EventEmitter();
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	let tool: ToolDefinition | undefined;
	const sessionId = options.sessionId ?? `test-session-${++sessionCounter}`;
	const branch = options.branch ?? [];
	const emitted: Harness["emitted"] = [];
	const shortcuts: string[] = [];

	const ctx = {
		hasUI: options.ui !== undefined,
		cwd: options.cwd ?? "/work/project",
		ui: options.ui ?? { notify: () => {} },
		sessionManager: { getSessionId: () => sessionId, getBranch: () => branch },
	} as unknown as ExtensionContext;

	const pi = {
		registerTool: (definition: ToolDefinition) => {
			tool = definition;
		},
		registerCommand: () => {},
		getCommands: () => options.commands ?? [],
		getAllTools: () => options.tools ?? [],
		registerShortcut: (key: string) => {
			shortcuts.push(key);
		},
		appendEntry: (customType: string, data: unknown) => {
			if (options.failAppend?.()) throw new Error("disk full");
			branch.push({ type: "custom", customType, data });
		},
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		events: {
			emit: (channel: string, data: unknown) => {
				emitted.push({ channel, data });
				bus.emit(channel, data);
			},
			on: (channel: string, handler: (data: unknown) => void) => {
				bus.on(channel, handler);
				return () => bus.off(channel, handler);
			},
		},
	} as unknown as ExtensionAPI;

	const harness: Harness = {
		branch,
		emitted,
		shortcuts,
		bus,
		sessionId,
		ctx,
		async call(params, signal) {
			if (!tool) throw new Error("todo tool not registered");
			const prepared = tool.prepareArguments ? tool.prepareArguments(params) : params;
			let result: ToolResult;
			try {
				result = (await tool.execute("call-1", prepared as never, signal, undefined, ctx as never)) as ToolResult;
			} catch (error) {
				// Pi turns a thrown error into an error result.
				result = { content: [{ type: "text", text: (error as Error).message }], details: {}, isError: true };
			}
			// Pi records each tool result on the branch as a message.
			branch.push({
				type: "message",
				message: { role: "toolResult", toolName: "todo", details: result.details, isError: result.isError === true },
			});
			return result;
		},
		async fire(event, fields) {
			let result: unknown;
			for (const handler of handlers.get(event) ?? []) result = await handler({ type: event, ...fields }, ctx);
			return result;
		},
		emit(channel, data) {
			pi.events.emit(channel, data);
		},
		events(channel) {
			return emitted.filter((e) => e.channel === channel).map((e) => e.data);
		},
	};

	options.before?.(harness);
	extension(
		pi,
		options.ui
			? () => import("../src/todo-overlay.ts")
			: async () => {
					throw new Error("overlay not loaded in tests");
				},
		options.guardTimeoutMs === undefined ? {} : { guardTimeoutMs: options.guardTimeoutMs },
	);
	return harness;
}

export function text(result: ToolResult): string {
	return result.content.map((c) => c.text ?? "").join("\n");
}

/** Keep exact output assertions readable without predicting random task identifiers. */
export function stableText(result: ToolResult): string {
	return text(result).replace(/\bt_[a-z2-7]{10}\b/g, "<uid>");
}

/** `data` of every `todo/v1` entry on the branch. */
export function snapshots(branch: unknown[]): Array<{ v: number; tasks: Array<Record<string, unknown>>; nextId: number }> {
	return branch
		.filter((e) => (e as { customType?: string }).customType === "todo/v1")
		.map((e) => (e as { data: never }).data);
}
