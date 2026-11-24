# Bookkeeping contract, version 1

Other pi extensions read and check the todo list through three things: a snapshot entry on the session branch, a change event, and namespace validators.
They depend on this document and on [`schema/todo-v1.schema.json`](schema/todo-v1.schema.json), never on this package's code, so they need no import from it and keep working when its internals change.

Every payload carries `v: 1`.
Within version 1, later releases may add optional properties; readers ignore properties they do not know.
Any other change to a name or shape below raises the version.

## Task

A task in a snapshot or an event has these properties.
The schema's `$defs/task` is the exact definition.

| Property | Type | Meaning |
| --- | --- | --- |
| `id` | integer ≥ 1 | Unique within the session; ids are never reused, except after `clear` restarts them at 1. |
| `subject` | string | Short imperative line. |
| `status` | `pending`, `in_progress`, `completed`, `deleted` | `deleted` is a tombstone that stays in the list. |
| `description` | string, optional | Long-form detail. |
| `activeForm` | string, optional | Present-continuous label shown while in progress. |
| `blockedBy` | integer[], optional | Ids of tasks this task waits on. |
| `owner` | string, optional | Who works on the task. |
| `metadata` | object, optional | Free-form fields; each top-level key is a namespace (see [Namespaces](#3-namespaces)). |
| `points` | number from 0 to 10, optional | Effort estimate. |
| `anchor` | non-empty string, optional | The check that shows the task is done, such as a test command. |
| `evidence` | Evidence[], optional | Runs of checks, oldest first. |

An evidence entry is `{ command, sha?, result, at }`:

| Property | Type | Meaning |
| --- | --- | --- |
| `command` | non-empty string | The check that ran. |
| `sha` | string, optional | Revision the check ran on, such as a git commit SHA. |
| `result` | `pass` or `fail` | How the run ended. |
| `at` | string | ISO 8601 time of the run in UTC, as `Date.prototype.toISOString` writes it. The tool converts the caller's time to that form, fills in the call time when the caller leaves it out, and rejects a time more than five minutes after the call. |

`evidence` is append-only.
A `todo` `update` call adds its `evidence` items after the existing ones, and no call removes or rewrites an entry; only `clear`, which empties the whole list, drops them.
`points` and `anchor` are replaced by an update that sets them, and cannot be removed.

> [!IMPORTANT]
> Evidence is self-reported bookkeeping, not proof.
> The agent writes each entry through the `todo` tool; the extension checks its shape and that `at` is not in the future, but runs nothing and cannot tell whether the command ran or how it ended.
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

Calls that change nothing write no entry: `list`, `get`, an `update` whose values equal the current ones, a call the tool rejects, and a call a namespace validator refuses.

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

## Coexistence

This package registers the tool name `todo`, as rpiv-todo does.
Install one of the two: with both installed, the tool names clash.
