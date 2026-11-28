/**
 * Per-session call queue. A `todo` call reads the list, awaits guards, then
 * commits; two calls of one session running at once (pi runs a turn's tool
 * calls in parallel) would both read the same list and the second commit would
 * drop the first one's change. Each session's calls therefore run one at a
 * time, in arrival order; different sessions do not wait for each other.
 */

const tails = new Map<string, Promise<void>>();

export function withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
	const previous = tails.get(sessionId) ?? Promise.resolve();
	const run = previous.then(fn);
	const tail = run.then(
		() => undefined,
		() => undefined,
	);
	tails.set(sessionId, tail);
	void tail.then(() => {
		if (tails.get(sessionId) === tail) tails.delete(sessionId);
	});
	return run;
}

/** Whether a call of the session is running or queued: a synchronous writer must queue behind it, else the call commits a list read before the write. */
export function sessionBusy(sessionId: string): boolean {
	return tails.has(sessionId);
}
