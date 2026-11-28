# Bookkeeping contract, version 1

Other pi extensions read and check the todo list through four things: a snapshot entry on the session branch, a change event, namespace validators, and change guards.
They depend on this document and on [`schema/todo-v1.schema.json`](schema/todo-v1.schema.json), never on this package's code, so they need no import from it and keep working when its internals change.

Every payload carries `v: 1`.
Within version 1, later releases may add optional properties; readers ignore properties they do not know.
Any other change to a name or shape below raises the version.

## Task

A task in a snapshot or an event has these properties.
The schema's `$defs/task` is the exact definition.

| Property | Type | Meaning |
| --- | --- | --- |
| `id` | integer ≥ 1 | Unique within one list, that is one branch of one session. Ids are not stable identities: `clear` restarts them at 1, and two branches of a session (after `/tree`) can give the same id to different tasks. |
| `uid` | string, optional | A random `t_` plus ten lowercase base32 characters. Create assigns it once; update, replay, and import retain it. Older tasks keep no uid. |
| `origin` | object, optional | On import from a known session, `{ session }` identifies the session that wrote the imported snapshot. |
| `subject` | string | Short imperative line. |
| `status` | `pending`, `in_progress`, `completed`, `deleted` | `deleted` is a tombstone that stays in the list. |
| `description` | string, optional | Long-form detail. |
| `activeForm` | string, optional | Present-continuous label shown while in progress. |
| `blockedBy` | integer[], optional | Ids of tasks this task waits on. |
| `owner` | string, optional | Who works on the task. |
| `metadata` | object, optional | Free-form fields; each top-level key is a namespace (see [Namespaces](#3-namespaces)). |
| `points` | number from 0 to 10, optional | Effort estimate. |
| `anchor` | non-empty string, optional | The check that shows the task is done, such as a test command. |
| `graph` | `single-loop`, `fan-out/fan-in`, `orchestrator-worker`, optional | Since 0.4.0: the work graph of the plan the task belongs to. Update replaces it; `null` on update clears it. A reader that finds no `graph` but a `metadata.graph` holding one of these names may treat it as the graph, as this extension does on replay and import. |
| `evidence` | Evidence[], optional | Runs of checks, oldest first. |

An evidence entry is `{ command, sha?, ref?, result, at }`:

| Property | Type | Meaning |
| --- | --- | --- |
| `command` | non-empty string | The check that ran. |
| `ref` | string, optional | Tool call id of the run, or `child:<id>`; up to 64 characters without whitespace. |
| `sha` | string, optional | Revision the check ran on, such as a git commit SHA. |
| `result` | `pass` or `fail` | How the run ended. |
| `at` | string | ISO 8601 time of the run in UTC, as `Date.prototype.toISOString` writes it. The tool converts the caller's time to that form, fills in the call time when the caller leaves it out, and rejects a time more than five minutes after the call. |

`evidence` is append-only.
A `todo` `update` call adds its `evidence` items after the existing ones, and no call removes or rewrites an entry; only `clear`, which empties the whole list, drops them.
`points` and `anchor` are replaced by an update that sets them, and cannot be removed.

> [!IMPORTANT]
> Evidence is self-reported bookkeeping, not proof.
> When recording new evidence, the extension checks its shape and time; when importing or replaying a snapshot, it preserves the recorded time.
> It runs nothing and cannot tell whether the command ran or how it ended.
> Use it to find which checks were run and on which revision, so the next round can reuse a green run.
> A consumer that judges whether a check passed after the last change, such as a guard that blocks closing a task, keeps the session's real tool results (the command's own output on the branch) as the source of truth and treats evidence only as a pointer to them.

The agent sets these fields through the `todo` tool's `points`, `anchor`, and `evidence` parameters on `create` (also on each `tasks[]` item) and `update`.

## 1. Snapshot entry `todo/v1`

After every call that changes the list, the extension appends a custom session entry:

```json
{ "type": "custom", "customType": "todo/v1", "data": { "v": 1, "tasks": [], "nextId": 1 } }
```

`data` matches the schema's root: `v`, every task in id order including tombstones, and `nextId`, the id the next created task receives.
Each entry holds the whole list, so a reader needs only the newest one.

To read the current list, walk `ctx.sessionManager.getBranch()` and keep the newest entry whose `customType` is `todo/v1` and whose `data` matches the schema.
Read the branch, not every session entry: entries on abandoned branches describe another history.

Calls that change nothing write no entry: `list`, `get`, an `update` whose values equal the current ones, a call the tool rejects, and a call a namespace validator or guard refuses.

### Import into an empty list

Since 0.2.0, `todo` accepts `{ "action": "import", "path": "handover.json" }` as an additive operation within v1.
Since 0.4.0, `{ "action": "import", "session": "<id, unique id prefix, or .jsonl path>" }` reads the snapshot from the newest `todo/v1` entry on another session's current branch instead, looking ids up in pi's session directories; a snapshot without `sessionId` takes the source session's id.
The file contains the snapshot `data` itself, not the surrounding session entry.
Import requires an empty list (even a tombstone counts as a task), unique task ids, a task for every `blockedBy` id, and a `nextId` greater than every task id.
New snapshots carry the writer's `sessionId`. Import uses it to set each task's `origin.session`, replacing any previous source. If the snapshot lacks `sessionId`, import leaves `origin` untouched. All other task fields, including historical evidence timestamps, and the supplied `nextId` are preserved.

### Migration from rpiv-todo

When a branch has no `todo/v1` entry, the extension restores the list from rpiv-todo's records, newest first by kind:

1. custom entries with `customType: "rpiv-todo-state"`, whose `data` holds `tasks` and `nextId`;
2. otherwise, `toolResult` messages of the `todo` tool, whose `details` hold `tasks` and `nextId`.

Once a `todo/v1` entry exists it wins over both, even when an rpiv record appears later on the branch.
The extension writes no rpiv records.

## 2. Event `todo:changed`

The extension emits on `pi.events`:

```ts
pi.events.on("todo:changed", (data) => {
  const { v, sessionId, tasks } = data as { v: 1; sessionId: string; tasks: Task[] };
});
```

It fires:

- after every call that writes a `todo/v1` entry, with the list that entry holds;
- after the extension restores a session's list on `session_start`, `session_compact`, and `session_tree`, including when the list is empty.

`sessionId` is the session whose list changed; a child session has its own list and its own events.
`tasks` is the full list, tombstones included, as a copy: changing it does not change the list.
The payload matches `$defs/changedEvent` in the schema.

## Reading the list

Each `todo:changed` payload and each `todo/v1` snapshot holds the session's whole current list.
A consumer replaces its copy of that session's list with it every time.
It never merges tasks by `sessionId` and `id`: after `clear` or a branch switch, the same id names a different task, and a merge would keep tasks that no longer exist or attach old fields to new tasks.

## 3. Namespaces

An extension that owns `metadata.<ns>` registers a validator by emitting `todo:namespace`:

```ts
const register = () =>
  pi.events.emit("todo:namespace", {
    v: 1,
    ns: "train",
    validate: (value, task, op) =>
      op === "update" && task.status === "completed" && (value as { step?: string } | undefined)?.step !== "merged"
        ? "complete the task only after the merge step"
        : undefined,
  });

register();                          // the todo extension loaded first
pi.events.on("todo:ready", register); // the todo extension loads later
```

The extension emits `todo:ready` with `{ v: 1 }` when it loads, because `pi.events` delivers an event only to listeners subscribed at that moment and extensions load in no fixed order.
Registering on both covers either order.
A later registration of the same `ns` replaces the earlier one.
The extension ignores, with a console warning, a payload whose `v` is not 1, whose `ns` is empty, or whose `validate` is not a function.

Before a call commits, the extension runs `validate(value, task, op)` for each task the call creates, changes, or deletes, once for every registered namespace that the task carries in `metadata` after the change or that the call sets or removes:

- `value` is `task.metadata[ns]` after the change, or `undefined` when the call removes it (`metadata: { ns: null }`);
- `task` is a copy of the task as it would be committed;
- `op` is `"create"`, `"update"`, or `"delete"`.

Returning a non-empty string refuses the change; returning `undefined` accepts it.
A validator that throws refuses with `validator threw: <message>`.
On the first refusal the whole call is refused: nothing commits, no entry is written, no event fires, and the tool returns an error result (`isError: true`) whose text is:

```text
Error: metadata.<ns> refused #<id>: <reason>
```

`clear`, `list`, and `get` run no validators.
Namespaces nobody registered pass unchecked.

### Wait marks (`metadata.waitsOn`, `metadata.until`)

Since 0.8.0 the `todo` tool's `waitsOn` and `until` fields write these two top-level metadata keys; earlier releases already read them, and an agent may still set them through `metadata`.

| Key | Type | Meaning |
| --- | --- | --- |
| `waitsOn` | non-empty string | What the task waits on: a person, CI, a train to end. |
| `until` | ISO 8601 date or date-time | When the task waits until: `YYYY-MM-DD`, optionally `THH:MM`, seconds, fraction, and `Z` or an offset, on a real calendar day. Another form marks no wait. |

A task waits while its `status` is `pending` or `in_progress` and either `waitsOn` is a non-blank string or `until` is a time after now.
A reader that judges open work, such as a close or stale reminder, treats a waiting task as held up rather than forgotten.
An `update` to `completed` or `deleted`, and `delete`, remove both keys; a namespace validator registered for a key the task had sees the removal. A validator for a wait key follows the general rule in [Namespaces](#3-namespaces): it runs when the task carries the key after the change, or when the call sets the key or removes one the task had; ending the wait of a task that never had a key does not run that key's validator.
The snapshot version stays 1.

### Optional Herdr launch identity (`metadata.herdr`)

When `pi-herdr-agents` acknowledges a `subagent` launch with `details.status: "started"` and echoes the call's `item`, the ledger looks up that task in the **calling session**.
`item` can be a stable task uid or `<session8>#<id>`, where `session8` is the first eight hex digits of the calling session id.
A numeric reference identifies the task present at dispatch: ordinary updates keep that identity even on a legacy task without a uid, while clearing or replaying the list invalidates a pending legacy binding.
Missing, unknown, foreign-session, or tombstoned items and failed or uncertain launches leave the list unchanged.

A match issues a normal guarded `update`: `owner` becomes the full `details.name`, and `metadata.herdr` records the launch:

```json
{ "name": "api-worker", "id": "0accb6d1-4380-4d51-a6d7-81dd0408d82f", "pane": "w1:p4" }
```

`name` is verbatim; `id` is the child **run id** (`details.id`), not the parent's session id or a path-derived id.
`pane` is the acknowledged `details.worktree.paneId` and is absent for ordinary launches.
The top-level fields always describe the latest assignment. An old pane id does not carry forward. For example, after a reviewer joins a worker on the same task, `owner` and `metadata.herdr.id` identify the reviewer.

New writers also store `metadata.herdr.runs`: up to six `{ name, id, pane?, session?, agent? }` records, unique by run id, newest last. `session` is the launch acknowledgement's `sessionFile`. Once the list exceeds six, `metadata.herdr.older` counts the discarded records. An earlier v1 record without `runs` counts as one binding. A reader that finds a repeated run id (in imported or hand-edited metadata) keeps that id's last record in its last position, then applies the cap of six, so the next write is unique again. The snapshot version remains 1.

A successful `subagent_resume` appends its new run id when its acknowledged `sessionPath` matches a retained session path on exactly one non-deleted task in the calling session. An unknown or ambiguous path binds nothing.
Other metadata stays intact; a refusal leaves the launch successful but adds the reason to its response.
Manual `owner` updates (including `self`) are still allowed; the optional `herdr` record describes the last bound launch, not proof of a live pane or of the current owner's identity.

Use `metadata.herdr.id` as the stable key when resolving or messaging the worker.
Use a name with `/boss send` only when it matches the name Straw Boss shows; on an unlabeled pane it may derive `api-worker` from the launch script for `API worker`.
For names longer than 24 UTF-16 units, Straw Boss displays just the first 23 units plus `…` in the `sb_name` pane token.
Resolve the live pane at read time rather than targeting that cosmetic label or a saved pane id.
This namespace needs no new status, schema field, or contract version.

### Run spend (`metadata.herdr.spend`)

Since 0.9.0, when a bound run ends, the ledger records what it spent on its task.
A run's end arrives two ways:

- the host's event `subagent:run-end` on `pi.events`, `{ v: 1, id, kind, name?, item?, sessionFile?, elapsed? }`: `id` is the run id the launch acknowledged (`details.id`), `kind` is `"result"` or `"ping"`, and `elapsed` the run's wall time in seconds. Only `v`, `id`, and `kind` are required: a run that failed before it wrote a session file ends without `sessionFile` and counts its time, and the ledger never reads `name`. The host sends it as it delivers the end, so an end still counts when its message never reaches the model (a steer cleared before the turn);
- the custom message in the calling session: `subagent_result` when the run finished or `subagent_ping` when it stopped to ask. Its `details` name `sessionFile` and `item`, and `elapsed` when the host supplies it (Straw Boss adds `id` and a ping's `elapsed`).

The ledger finds the task as the launch bound it: the non-deleted task whose `metadata.herdr.runs` hold the run id, else the end's `sessionFile`, else, by `item`, the task with that uid.
A bare `<session8>#<id>` is never looked up by its number at the end: after `clear` or a branch switch the number names another task, and the launch's binding is what proves the identity.
No match, several matches, or a deleted task leave the list unchanged.

It reads that session file and sums the `usage` of every assistant turn in it (every branch: all of it was spent), except the turns a fork copied from the launcher: a turn older than the file's `session` header, or one whose entry id the calling session holds.
Then it issues a normal guarded `update` of `metadata.herdr.spend`, keeping every other `metadata` key:

```json
{
  "input": 1500, "output": 300, "cacheRead": 3000, "cacheWrite": 0, "tokens": 4800, "cost": 0.75,
  "ms": 125000, "runs": 1, "models": ["anthropic/claude-opus-5-5"], "ended": ["0accb6d1-4380-4d51-a6d7-81dd0408d82f"],
  "sessions": [{ "session": "/path/child.jsonl", "input": 1500, "output": 300, "cacheRead": 3000, "cacheWrite": 0, "tokens": 4800, "cost": 0.75, "models": ["anthropic/claude-opus-5-5"] }]
}
```

The top-level figures are the task's totals over all its runs: `tokens` is pi's `totalTokens`, `cost` its `cost.total` in US dollars, `ms` the sum of the ends' `elapsed`, `runs` the number of ended runs (results and pings), and `models` the `provider/model` ids seen, first seen first, at most eight.
`ended` keeps the last 24 run ids counted, so the event and the message of one run count once.
A resume continues the same session file, so the ledger replaces that session's figures with the file's new total instead of adding them again; `sessions` keeps up to twelve, newest last, and an older one stays in the totals but is no longer told apart.
A file that cannot be read adds the run and its time, not tokens.
A later launch keeps `spend` when it rebinds `metadata.herdr`.
A refusal by a validator or guard leaves the list unchanged and appends `Todo spend: <reason>` to the message.
A write whose list was replaced while its guards ran (see [Change guards](#4-change-guards)) looks again in the list that is live now: a replay of the same branch still holds the task and records there, another branch's list or a shut-down session's does not, and the end is dropped.
The figures are an estimate from what pi wrote in the child's transcript, bookkeeping rather than a bill. `get` shows them on a `spend:` line.
A host that launches fallback models in one run delivers only the last attempt's file: the last attempt is always counted, earlier attempts are not.

## 4. Change guards

A namespace validator judges one task's value.
An extension that must judge a call as a whole registers a guard instead: for example, one that refuses a task created without its namespace, compares a change with the list before it, or reads state outside the list.
It registers by emitting `todo:guard`, and registers again on `todo:ready` as in [Namespaces](#3-namespaces):

```ts
const register = () =>
  pi.events.emit("todo:guard", {
    v: 1,
    id: "train",
    check: async (change) =>
      change.op === "clear" && change.before.some((t) => t.status === "in_progress")
        ? "steps are in progress; complete or void them first"
        : undefined,
  });
```

A later registration of the same `id` replaces the earlier one; the extension ignores, with a console warning, a payload whose `v` is not 1, whose `id` is empty, or whose `check` is not a function.

The extension calls `check(change)` for every call that would change the list: `create` (a single task or a `tasks[]` batch, with or without metadata), `import`, `update`, `delete`, and `clear`.
On import, namespace validators see each relevant task as a `create`.
Guard registration accepts an optional `imports: true` field within v1.
If any registered guard has not opted in, the tool returns `Error: guard <id> refused: guard does not accept imports` without calling the guards or committing the list.
Otherwise each guard sees one `op: "create"` with `params.action: "import"`, the original `path` or `session`, an empty `before`, and the full imported list in `after`.
A guard that accepts imports must judge the tasks in `change.after`, not `change.params`: the arguments name the snapshot file but do not contain its tasks.
A valid `update` that changes nothing, such as setting `in_progress` on a task already in progress after `/reload`, reaches the guards too, flagged `noop: true`: it is how an agent restates a task's state, and a guard may track it.
`change` matches `$defs/change` in the schema and is a copy:

| Property | Meaning |
| --- | --- |
| `op` | `"create"`, `"update"`, `"delete"`, or `"clear"`. |
| `params` | The call's arguments as the tool received them. |
| `before` | The whole list before the call, tombstones included. |
| `after` | The whole list as the call would commit it. |
| `sessionId` | The session that made the call. It does not say which branch of the session is current; a guard that needs the branch keeps its own map from session id to the latest context it saw (for example from `session_start` and `session_tree`). |
| `cwd` | That session's working directory. |
| `noop` | `true` on an `update` that changes nothing, where `before` equals `after`; absent otherwise. |

Guards run after the namespace validators and before anything commits, one at a time in registration order, and the extension awaits each.
`check` returns, or resolves to, a non-empty string to refuse, or `undefined` to accept.
The first refusal refuses the whole call as in [Namespaces](#3-namespaces): nothing commits, no entry is written, no event fires, and the tool returns an error result (`isError: true`):

| Outcome | Tool result text |
| --- | --- |
| `check` returns or resolves to a reason | `Error: guard <id> refused: <reason>` |
| `check` throws or rejects | `Error: guard <id> refused: guard threw: <message>` |
| `check` takes longer than 10 seconds | `Error: guard <id> timed out after 10000 ms` |

The time limit stops waiting on an asynchronous guard at 10 seconds.
It cannot interrupt a synchronous guard, which holds the event loop until it returns; the extension measures how long it took and refuses the call with the same timeout error if it ran past the limit.

An accepted `noop` update writes no entry and emits no event; a refused one returns the refusal like any other call.
Reads (`list`, `get`) and calls the tool rejects run no guard.
One session's `todo` calls run one at a time, so a guard never sees a `before` that another call of the same session is about to change.
A guard reads the list from `change.before` and `change.after` and never calls the `todo` tool for the session it is judging: such a call is refused at once with `Error: todo called from inside guard <id>`, and changes nothing.
The same holds along a chain of guards: when session A's guard calls `todo` for session B, and B's guard calls `todo` for A, the call for A is refused the same way, naming A's guard.
Calling `todo` for a session whose guard is not running further up the chain is allowed.
A call aborted (through the tool's abort signal) while it waits for an earlier call or while its guards run commits nothing and returns `Error: call aborted; nothing changed`, a `noop` update included.
A call whose list stops being the session's live list while its guards run commits nothing and returns `Error: the list was replaced while the change waited (branch switch, replay, or shutdown); nothing changed`: a `session_tree` switch, a replay on `session_compact` or `session_start`, or `session_shutdown` does not wait for the session's queue, and a write computed from the old list would put it on the new branch or rebuild the evicted list.

## Coexistence

This package registers the tool name `todo`, as rpiv-todo does.
Install one of the two: with both installed, the tool names clash.
