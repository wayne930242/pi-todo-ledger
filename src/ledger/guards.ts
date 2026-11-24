/**
 * Change guards. Another extension that must approve changes to the list as a
 * whole (not one metadata namespace) registers a guard by emitting
 * `todo:guard`. The `todo` tool awaits every guard, in registration order,
 * after the namespace validators and before it commits; the first refusal
 * refuses the whole call.
 */

import { CONTRACT_VERSION, GUARD_EVENT, type GuardCheck, type TodoChangeV1 } from "./contract.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class GuardRegistry {
	private readonly guards = new Map<string, GuardCheck>();
	private readonly timeoutMs: number;

	constructor(timeoutMs: number) {
		this.timeoutMs = timeoutMs;
	}

	/**
	 * Handle a `todo:guard` payload. A later registration of the same id
	 * replaces the earlier one. Returns the reason a malformed payload was
	 * ignored, or `undefined` when it registered.
	 */
	register(payload: unknown): string | undefined {
		if (!isRecord(payload)) return `${GUARD_EVENT}: payload must be an object`;
		if (payload.v !== CONTRACT_VERSION) {
			return `${GUARD_EVENT}: unsupported contract version ${String(payload.v)} (expected ${CONTRACT_VERSION})`;
		}
		if (typeof payload.id !== "string" || !payload.id.trim()) return `${GUARD_EVENT}: id must be a non-empty string`;
		if (typeof payload.check !== "function") {
			return `${GUARD_EVENT}: check must be a function (id "${payload.id}")`;
		}
		this.guards.set(payload.id, payload.check as GuardCheck);
		return undefined;
	}

	/**
	 * Run every guard on `change`, one at a time, each with its own copy.
	 * Returns the first refusal as the tool's error message, or `undefined`.
	 */
	async check(change: TodoChangeV1): Promise<string | undefined> {
		for (const [id, check] of this.guards) {
			const reason = await this.runOne(id, check, change);
			if (reason !== undefined) return reason;
		}
		return undefined;
	}

	private async runOne(id: string, check: GuardCheck, change: TodoChangeV1): Promise<string | undefined> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timedOut = new Promise<"timeout">((resolve) => {
			timer = setTimeout(() => resolve("timeout"), this.timeoutMs);
		});
		try {
			const reason = await Promise.race([Promise.resolve().then(() => check(structuredClone(change))), timedOut]);
			if (reason === "timeout") return `guard ${id} timed out after ${this.timeoutMs} ms`;
			return typeof reason === "string" && reason.length > 0 ? `guard ${id} refused: ${reason}` : undefined;
		} catch (error) {
			return `guard ${id} refused: guard threw: ${error instanceof Error ? error.message : String(error)}`;
		} finally {
			clearTimeout(timer);
		}
	}
}
