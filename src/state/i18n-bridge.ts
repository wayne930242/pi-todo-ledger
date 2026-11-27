/**
 * i18n bridge for pi-todo-ledger (inherited from rpiv-todo) — single thin import surface so every call site
 * routes through one module. Backed by `@juicesharp/rpiv-i18n`'s SDK when
 * available; degrades to canonical-English fallbacks when not.
 *
 * - `t(key, fallback)` is `scope("pi-todo-ledger")` if the SDK is
 *   installed (live `/languages` updates propagate). If the SDK is missing
 *   (standalone install without rpiv-i18n), `t` returns the inline English
 *   fallback at every call site, so the extension stays online with English UI.
 * - Traditional Chinese (`locales/zh-TW.json`) is served here, not by the SDK,
 *   whose picker lists only `zh`: see `renderLocale()` for when it applies.
 * - `formatStatusLabel(status)` resolves a TaskStatus to its locale-aware
 *   label via the canonical `status.*` namespace, with the English literal
 *   as fallback so nothing renders blank if the namespace isn't registered.
 *   This is the SINGLE point of localization for status words — overlay,
 *   /todos header, /todos render-call all route through here.
 *
 * Strings are registered ONCE at extension load (see ../index.ts). Call sites
 * MUST use this module at render time — never bake the result into a top-level
 * `const X = formatStatusLabel(...)`.
 */

import { readFileSync } from 'node:fs';
import { savedLocale } from "../config.ts";
import type { TaskStatus } from "../tool/types.ts";

export const I18N_NAMESPACE = "pi-todo-ledger";

// Held in a variable so the type checker does not require the optional peer.
const I18N_SDK: string = "@juicesharp/rpiv-i18n";

type ScopeFn = (key: string, fallback: string) => string;
type I18nSDK = { scope: (namespace: string) => ScopeFn };

// Prefer the live SDK if installed: closures it returns track the active
// locale, so /languages picker propagates to our render call sites. If the
// SDK isn't installed (standalone install of this extension without
// rpiv-i18n), the dynamic import fails, every t(key, fallback) returns the
// canonical English literal, and the extension stays online.
//
// Top-level await is required so a synchronous `t(...)` call from any
// downstream module sees the resolved scope; ESM module loading awaits this
// before evaluating any importer.
const traditional: Record<string,string> = JSON.parse(readFileSync(new URL('../locales/zh-TW.json', import.meta.url), 'utf8'));
let scopeImpl: ScopeFn;
try {
	const sdk = (await import(I18N_SDK)) as I18nSDK;
	scopeImpl = sdk.scope(I18N_NAMESPACE);
} catch {
	scopeImpl = (_key, fallback) => fallback;
}

const TRADITIONAL = /^zh[-_](?:TW|Hant)(?:[-_.@]|$)/i;

// The SDK republishes this plain-data snapshot on every locale change, a /languages pick included.
const SDK_STATE = Symbol.for("rpiv-i18n");
type SdkState = { readonly locale?: string } | undefined;

/** The `--locale` value Pi was started with (`--locale x` or `--locale=x`). */
function flagLocale(argv = process.argv): string | undefined {
	for (const [i, arg] of argv.entries()) {
		if (arg.startsWith("--locale=")) return arg.slice(9) || undefined;
		if (arg === "--locale" && argv[i + 1] && !argv[i + 1].startsWith("-")) return argv[i + 1];
	}
	return undefined;
}

let seenState: SdkState | null = null;
let chosen: string | undefined;
/** The user's explicit choice (`--locale`, then the saved /languages pick), re-read when the SDK applies a locale. */
function explicitLocale(state: SdkState): string | undefined {
	if (state !== seenState) {
		seenState = state;
		chosen = flagLocale() ?? savedLocale();
	}
	return chosen;
}

/**
 * The locale to render in. An explicit choice wins as given: `zh` stays Simplified and `zh-TW`
 * is Traditional. Without one, the system locale is the default, read in POSIX order
 * (`LC_ALL`, then `LC_MESSAGES`, then `LANG`). The SDK reads `LANG` first and drops the
 * region, so a Traditional system locale decides here; any other keeps the SDK's code.
 */
export function renderLocale(): string {
	const sys = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '';
	const state = (globalThis as { [k: symbol]: SdkState })[SDK_STATE];
	const locale = state?.locale;
	if (!locale) return sys;
	if (explicitLocale(state) !== undefined) return locale;
	return TRADITIONAL.test(sys) ? sys : locale;
}

export const t: ScopeFn = (key, fallback) => {
	if (TRADITIONAL.test(renderLocale())) return traditional[key] ?? fallback;
	return scopeImpl(key, fallback);
};

const STATUS_LABEL_PENDING = "pending";
const STATUS_LABEL_IN_PROGRESS = "in progress";
const STATUS_LABEL_COMPLETED = "completed";
const STATUS_LABEL_DELETED = "deleted";

export function formatStatusLabel(status: TaskStatus): string {
	switch (status) {
		case "pending":
			return t("status.pending", STATUS_LABEL_PENDING);
		case "in_progress":
			return t("status.in_progress", STATUS_LABEL_IN_PROGRESS);
		case "completed":
			return t("status.completed", STATUS_LABEL_COMPLETED);
		case "deleted":
			return t("status.deleted", STATUS_LABEL_DELETED);
	}
}
