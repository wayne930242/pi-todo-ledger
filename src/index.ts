/**
 * pi-todo-ledger — Pi extension, forked from rpiv-todo 2.15.0. Registers the
 * `todo` tool, `/todos` slash command, and the persistent TodoOverlay widget,
 * and serves the bookkeeping contract in CONTRACT.md: `todo/v1` snapshot
 * entries, the `todo:changed` event, and `todo:namespace` validators.
 *
 * TUI chrome strings localize at render time via the i18n bridge. Strings are
 * registered with rpiv-i18n here, once, at module init — but only when the
 * SDK is actually installed. If `@juicesharp/rpiv-i18n` is missing (standalone
 * install of just this package), the dynamic-load shim no-ops and the bridge's
 * `t(key, fallback)` returns the inline English literal at every call site.
 * The extension stays online either way.
 *
 * Adding a locale: drop `locales/<code>.json` next to en.json (mirroring the
 * key set). No edit needed here — `registerLocalesFromDir` iterates
 * `SUPPORTED_LOCALES` from the SDK. See `@juicesharp/rpiv-i18n` README →
 * "Contributing translations" for the full convention.
 *
 * Tool name "todo" and widget key "rpiv-todos" are kept from rpiv-todo, and
 * replay reads rpiv-todo's records, so sessions started under rpiv-todo keep
 * their list.
 */

import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { conflictWarning } from './conflicts.ts';
import { COLLAPSE_KEY_OFF, resolveCollapseKey } from "./config.ts";
import {
	CHANGED_EVENT,
	CONTRACT_VERSION,
	GUARD_EVENT,
	GUARD_TIMEOUT_MS,
	NAMESPACE_EVENT,
	READY_EVENT,
	toChangedEvent,
} from "./ledger/contract.ts";
import { makeFinishCall } from "./ledger/finish-call.ts";
import { GuardRegistry } from "./ledger/guards.ts";
import { registerHerdrOwner } from "./ledger/herdr-owner.ts";
import { NamespaceRegistry } from "./ledger/namespaces.ts";
import { I18N_NAMESPACE } from "./state/i18n-bridge.ts";
import { replayFromBranch } from "./state/replay.ts";
import {
	clearActiveRenderSession,
	evictSession,
	getActiveRenderSession,
	getRenderState,
	getState,
	replaceState,
	setActiveRenderSession,
	sid,
} from "./state/store.ts";
import { registerTodosCommand, registerTodoTool, TOOL_NAME } from "./todo.ts";
import type { TodoOverlay } from "./todo-overlay.ts";
import { RUN_ROWS_EVENT } from "./view/live-runs.ts";
import { askRows, carRows, type SbQuery, sbSignature } from "./view/sb-rows.ts";

// Held in a variable so the type checker does not require the optional peer.
const I18N_LOADER: string = "@juicesharp/rpiv-i18n/loader";

type I18nLoader = {
	registerLocalesFromDir: (namespace: string, packageUrl: string, options?: { label?: string }) => void;
};

/** Delay the overlay graph pre-warm until Pi's startup work has settled. */
export const PREWARM_DELAY_MS = 2000;

/** How often the foreground looks whether sb's car or ask rows changed: sb reads them every 15 s, between turns too (an ask waits in a dialog). */
export const SB_LOOK_MS = 5000;

type TodoOverlayModule = typeof import("./todo-overlay.ts");
type TodoOverlayImporter = () => Promise<TodoOverlayModule>;

/**
 * Marker shared by the loader's poisoned-namespace error and the
 * `isStaleOverlayModuleError` predicate that lets handlers re-throw it while
 * swallowing transient load failures.
 */
const STALE_OVERLAY_MESSAGE = "Todo overlay module cache is stale; restart Pi";

/** True for the loader's latched poisoned-namespace error (see below). */
export function isStaleOverlayModuleError(e: unknown): boolean {
	return String(e).includes(STALE_OVERLAY_MESSAGE);
}

/**
 * Memoize the overlay graph after a successful load, but drop a rejected
 * promise so a failed pre-warm does not permanently replay the same rejection.
 * The export guard turns jiti's poisoned-namespace failure into a useful restart
 * error instead of a bare "TodoOverlay is not a constructor" TypeError.
 */
export function makeTodoOverlayLoader(
	importOverlay: TodoOverlayImporter = () => import("./todo-overlay.ts"),
): TodoOverlayImporter {
	let memo: Promise<TodoOverlayModule> | undefined;

	return async (): Promise<TodoOverlayModule> => {
		memo ??= importOverlay();
		const current = memo;
		let mod: TodoOverlayModule;
		try {
			mod = await current;
		} catch (error) {
			// Clear only OUR rejected promise: a late catch from a concurrent
			// awaiter must never clobber a fresh retry another caller installed.
			if (memo === current) memo = undefined;
			throw error;
		}
		if (typeof mod.TodoOverlay !== "function") {
			// Deliberately latched: the memo keeps this resolved-but-poisoned
			// namespace, so every subsequent load re-throws instead of retrying.
			// Re-importing would hand back the same cached jiti namespace — a
			// retry can never heal this; only the restart the error asks for can.
			const keys = JSON.stringify(Object.keys(mod));
			throw new Error(`${STALE_OVERLAY_MESSAGE} (resolved namespace keys: ${keys})`);
		}
		return mod;
	};
}

// Dynamic import keeps `@juicesharp/rpiv-i18n` a soft optional peer: when the
// SDK is installed alongside this package the strings register and
// `/languages` flips them live; when it isn't, the import rejects here, we
// no-op, and the bridge's English-fallback shim keeps the extension online.
//
// The `/loader` subpath is used instead of the SDK entry so the i18n-ui +
// pi-tui modules are not pulled into our load graph just to register strings.
try {
	const sdk = (await import(I18N_LOADER)) as I18nLoader;
	sdk.registerLocalesFromDir(I18N_NAMESPACE, import.meta.url, { label: "pi-todo-ledger" });
} catch {
	// SDK absent — extension still loads with English-only UI.
}

// pi-core's ExtensionRunner throws this exact phrase from an invalidated ctx
// proxy after session replacement/reload. Match the stable substring so genuine
// replay bugs still propagate instead of being silently swallowed.
function isStaleCtxError(e: unknown): boolean {
	return /stale after session replacement/.test(String(e));
}

/**
 * Render a caught `unknown` as a human-readable message — the `instanceof Error`
 * dance collapsed to one place. Local copy of the `formatError` in
 * packages/rpiv-workflow/internal-utils.ts:56-58 (that module disclaims its
 * public surface, so the cross-package import is not available). M2 boundary
 * duplication: tracked as a documented-constant seam.
 */
function formatError(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

export interface LedgerOptions {
	/** How long a change guard may take; tests shorten it. */
	guardTimeoutMs?: number;
}

export default function (
	pi: ExtensionAPI,
	importOverlay: TodoOverlayImporter = () => import("./todo-overlay.ts"),
	options: LedgerOptions = {},
) {
	let todoOverlay: TodoOverlay | undefined;
	const loadTodoOverlay = makeTodoOverlayLoader(importOverlay);
	let uiCtx: ExtensionUIContext | undefined;
	let lifecycleGeneration = 0;

	// The host's run-rows probe. Without a claim it only reads this session's runs.
	const queryRuns = (p: object) => pi.events.emit(RUN_ROWS_EVENT, p);
	// sb's car-rows and ask-rows probes (src/view/sb-rows.ts); with no sb loaded they stay unanswered.
	const querySb: SbQuery = (event, p) => pi.events.emit(event, p);
	/** Whether the host lists any run of this session, or sb any car or ask of it: such rows show on the panel even with no task. */
	const hostHasRows = (): boolean => {
		const p: { rows?: { rows?: unknown } } = {};
		try {
			queryRuns(p);
		} catch {
			return false;
		}
		return (Array.isArray(p.rows?.rows) && p.rows.rows.length > 0) || carRows(querySb).rows.length > 0 || askRows(querySb).rows.length > 0;
	};

	async function updateTodoOverlay(
		resetCompletedDisplayState = false,
		generation = lifecycleGeneration,
	): Promise<void> {
		const hasVisibleTasks = getRenderState().tasks.some((task) => task.status !== "deleted");
		if (!uiCtx || (!todoOverlay && !hasVisibleTasks && !hostHasRows())) return;

		const { TodoOverlay } = await loadTodoOverlay();
		if (generation !== lifecycleGeneration || !uiCtx) return;

		todoOverlay ??= new TodoOverlay(queryRuns, querySb);
		todoOverlay.setUICtx(uiCtx);
		if (resetCompletedDisplayState) todoOverlay.resetCompletedDisplayState();
		todoOverlay.update();
	}

	// Namespace and guard owners register on `todo:namespace` and `todo:guard`;
	// `todo:ready` asks the ones that loaded before this extension to register again.
	const namespaces = new NamespaceRegistry();
	const guards = new GuardRegistry(options.guardTimeoutMs ?? GUARD_TIMEOUT_MS);
	pi.events.on(NAMESPACE_EVENT, (payload) => {
		const ignored = namespaces.register(payload);
		if (ignored) console.warn(`[pi-todo-ledger] ignored ${ignored}`);
	});
	pi.events.on(GUARD_EVENT, (payload) => {
		const ignored = guards.register(payload);
		if (ignored) console.warn(`[pi-todo-ledger] ignored ${ignored}`);
	});

	const finish = makeFinishCall(pi, namespaces, guards);
	registerTodoTool(pi, finish);
	registerHerdrOwner(pi, finish);
	registerTodosCommand(pi);
	pi.events.emit(READY_EVENT, { v: CONTRACT_VERSION });

	// Replay a session's list from its branch into its slot and announce it.
	const restore = (id: string, ctx: Parameters<typeof replayFromBranch>[0]): void => {
		replaceState(id, replayFromBranch(ctx));
		pi.events.emit(CHANGED_EVENT, toChangedEvent(id, getState(id)));
	};

	// Cycle hotkey for the todo overlay (focus → full → collapsed). The key is resolved once at
	// factory scope from config (register-once contract: a config change needs
	// `/reload` to re-bind, same as lane-switcher's env hotkey) and the binding is
	// skipped entirely when collapseKey is "off". The handler closes over the
	// closure-local `todoOverlay` by reference and re-reads it at fire time, so an
	// overlay loaded after shortcut registration is picked up. No-op in headless
	// mode, before the overlay has loaded, or when the widget isn't currently
	// registered (auto-hidden on an empty list).
	const collapseKey = resolveCollapseKey();
	if (collapseKey !== COLLAPSE_KEY_OFF) {
		pi.registerShortcut(collapseKey as KeyId, {
			description: "Cycle the todo overlay: focus, full, collapsed",
			handler: (ctx) => {
				if (!ctx.hasUI || !todoOverlay?.isRegistered()) return;
				todoOverlay.cycleView();
			},
		});
	}

	// Re-key a session's slot from its branch, then refresh the overlay only when
	// the refreshed session IS the foreground. Shared by session_compact and
	// session_tree (verbatim-identical pre-extraction). A stale ctx (auto-compaction
	// races session disposal: pi-core invalidates the runner while still emitting the
	// event, so `ctx` may be a dead proxy whose getters throw) keeps current state —
	// the replacement session's session_start replays it. Other errors are real replay
	// bugs and must propagate. The render is sid-gated so a child never refreshes the
	// foreground overlay.
	const replayAndRefresh = async (
		ctx: Parameters<typeof sid>[0] & Parameters<typeof replayFromBranch>[0],
	): Promise<void> => {
		let isForeground = false;
		try {
			const id = sid(ctx);
			restore(id, ctx);
			isForeground = id === getActiveRenderSession();
		} catch (e) {
			if (!isStaleCtxError(e)) throw e;
		}
		if (isForeground) await updateTodoOverlay(true);
	};

	// sb's rows change with no event of this session (a car moves, an ask opens while a dialog waits): while a foreground
	// session has a UI, look every SB_LOOK_MS and redraw when they changed. Stopped with that session.
	let sbLook: ReturnType<typeof setInterval> | undefined;
	const stopSbLook = () => {
		if (sbLook) clearInterval(sbLook);
		sbLook = undefined;
	};
	const startSbLook = () => {
		stopSbLook();
		let seen = sbSignature(querySb);
		sbLook = setInterval(() => {
			const now = sbSignature(querySb);
			if (now === seen) return;
			seen = now;
			void refresh().catch(() => undefined);
		}, SB_LOOK_MS);
		sbLook.unref?.();
	};

	const warned = new Set<string>();
	pi.on("session_start", async (_event, ctx) => {
		let id: string;
		try {
			id = sid(ctx);
			// Every session replays into its OWN data slot (Phase 1 isolation).
			restore(id, ctx);
		} catch (e) {
			// Parity with compact/tree/shutdown: session_start is the fresh-ctx event
			// so the stale risk is low, but a stale/throwing ctx has nothing to bind —
			// swallow the known stale error and bail; let real replay bugs propagate.
			if (!isStaleCtxError(e)) throw e;
			return;
		}
		if (!warned.has(id)) {
			const message = conflictWarning(pi, ctx);
			if (message) {
				warned.add(id);
				if (ctx.hasUI) ctx.ui.notify(message, 'warning');
				else console.error(message.replace(/[\r\n]+/g, ' '));
			}
		}
		if (!ctx.hasUI) return;
		// First UI-bearing session_start claims the foreground (the interactive
		// launcher, by spawn-ordering) without eagerly loading the overlay.
		if (getActiveRenderSession() === "") setActiveRenderSession(id);
		// Only the foreground re-binds/refreshes the shared overlay. A child
		// (distinct sid) is skipped — does not rebind to a relay/stale ui.
		if (id !== getActiveRenderSession()) return;
		const generation = ++lifecycleGeneration;
		uiCtx = ctx.ui;
		startSbLook();
		await updateTodoOverlay(true, generation);
	});

	pi.on("session_compact", async (_event, ctx) => {
		await replayAndRefresh(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		await replayAndRefresh(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		// Best-effort sid: disposal can race a stale ctx (like compact). An
		// unknown/stale sid resolves to "" and is treated as foreground — the
		// safe pre-isolation default that disposes as before.
		let s: string;
		try {
			s = sid(ctx);
		} catch (e) {
			if (!isStaleCtxError(e)) throw e;
			s = "";
		}
		// The shutting-down session's own data slot is always evicted.
		evictSession(s);
		// Overlay teardown is sid-gated: a child shutdown (distinct sid) must not
		// dispose the foreground's overlay. Only the foreground's own shutdown
		// (or an unknown/stale sid) tears it down and clears the pointer.
		if (s === "" || s === getActiveRenderSession()) {
			// Invalidate pending imports before clearing the foreground binding so a
			// replaced session cannot inherit the stale overlay or UI context.
			lifecycleGeneration++;
			uiCtx = undefined;
			stopSbLook();
			// `dispose()`'s first act is setWidget(KEY, undefined) on a possibly-stale
			// ui proxy, which can throw. evictSession(s) above already deleted this
			// slot, so leaving `activeRenderSession` pointing at it would resolve
			// getRenderState() to a fresh EMPTY_STATE (overlay silently renders empty).
			// try/finally guarantees the pointer-clear + overlay-drop run regardless.
			try {
				todoOverlay?.dispose();
			} finally {
				todoOverlay = undefined;
				clearActiveRenderSession();
			}
		}
	});

	// A refresh after something that may change the list or this session's runs.
	const refresh = async (): Promise<void> => {
		try {
			await updateTodoOverlay();
		} catch (e) {
			// The tool or turn itself succeeded — a transient overlay-load failure only
			// costs this one refresh, and the loader's cleared memo lets the next
			// update retry. Don't surface that as an extension error. The latched
			// stale-namespace error still propagates: it never self-heals, and the
			// user needs its restart guidance.
			if (isStaleOverlayModuleError(e)) throw e;
			console.warn(`[pi-todo-ledger] overlay refresh failed (will retry on next update): ${formatError(e)}`);
		}
	};

	// Reads getTodos() at render time; do NOT call replayFromBranch here
	// (branch is stale — message_end runs after tool_execution_end). A launch or
	// resume may start a run bound to no task, which the panel shows too.
	pi.on("tool_execution_end", async (event) => {
		if (event.isError || ![TOOL_NAME, "subagent", "subagent_resume"].includes(event.toolName)) return;
		await refresh();
	});

	// Runs can also start without a tool call of this session; the end of a turn picks them up.
	pi.on("agent_end", refresh);

	// Evaluate the lazy graph after startup while Pi's boot-time dependency paths
	// are still stable. This loads no widget and constructs no overlay; those stay
	// deferred until a foreground session has visible tasks. A rejected pre-warm
	// is intentionally swallowed after loadTodoOverlay clears its memo, allowing
	// the first real update to retry. unref avoids holding an embedder open.
	const prewarmTimer = setTimeout(() => void loadTodoOverlay().catch(() => undefined), PREWARM_DELAY_MS);
	prewarmTimer.unref?.();

	pi.on("agent_start", async () => {
		todoOverlay?.hideCompletedTasksFromPreviousTurn();
	});
}
