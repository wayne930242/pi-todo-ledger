# `todo` tool reference

Complete parameter schema, status machine, response envelope, and error strings
for the `todo` tool registered by pi-todo-ledger. The actions and parameters are
rpiv-todo's, plus the bookkeeping fields `points`, `anchor`, and `evidence`.

## Actions

| Action | Required params | What it does |
| --- | --- | --- |
| `create` | `subject` or `tasks[]` (one-of) | Adds one task, or several independent tasks, in `pending`. |
| `update` | `id` + at least one mutable field | Changes status, fields, or dependencies. |
| `list` | — | Returns all tasks, optionally filtered by `status`. |
| `get` | `id` | Returns one task with its `blockedBy` and reverse `blocks` edges. |
| `delete` | `id` | Tombstones the task (`status: "deleted"`); it is not removed. |
| `clear` | — | Drops every task and resets the id counter to `1`. |

## Parameters

```ts
todo({
  action: "create" | "update" | "list" | "get" | "delete" | "clear",

  // create-only (one-of: subject or tasks[])
  subject?: string,                   // required for single create
  blockedBy?: number[],               // initial dependency ids (single create)
  tasks?: Array<{                     // batch create; independent items only
    subject: string,
    description?: string,
    activeForm?: string,
    blockedBy?: number[],             // existing ids only; no sibling refs
    owner?: string,
    metadata?: Record<string, unknown>,
    points?: number,
    anchor?: string,
    evidence?: Evidence[],
  }>,

  // create + update
  description?: string,               // long-form detail
  activeForm?: string,                // present-continuous label shown while in_progress
  owner?: string,                     // agent/owner assigned to this task
  metadata?: Record<string, unknown>, // on update, a null value deletes that key
  points?: number,                    // effort, 0 to 10; update replaces
  anchor?: string,                    // the check that shows the task is done; update replaces
  evidence?: Array<{                  // check runs; update appends, never replaces
    command: string,
    sha?: string,                     // revision the check ran on
    result: "pass" | "fail",
    at?: string,                      // ISO 8601; stored in UTC; defaults to the time of the call
  }>,

  // update-only
  addBlockedBy?: number[],            // additive merge into blockedBy
  removeBlockedBy?: number[],         // additive removal from blockedBy

  // update / get / delete
  id?: number,

  // update (sets this task's status) or list (filters by status)
  status?: "pending" | "in_progress" | "completed" | "deleted",

  // list-only
  includeDeleted?: boolean,           // default false — hides tombstones
})
```

`create` takes either `subject` (one task) or `tasks[]` (several independent
tasks). Passing both is rejected, even with a blank `subject`. Each item carries
its own `description`, `activeForm`, `blockedBy`, `owner`, `metadata`, `points`,
`anchor` and `evidence`; the same
fields at the top level of a batch are rejected rather than dropped. The batch is validated first and committed
together: one bad item fails the whole call and leaves the list unchanged.
Items in `tasks[]` cannot `blockedBy` each other; those ids do not exist until
the call commits. Create the prerequisite first, then the dependent with
`blockedBy`. `blockedBy` on a batch item may name a task that already exists.

`update` merges `metadata` key by key into the existing record; passing `null`
for a key removes it, and emptying the record drops the field entirely.
`addBlockedBy` and `removeBlockedBy` are additive — do not resend the whole
array.

`update` replaces `points` and `anchor` and appends `evidence` items after the
existing ones. No call removes an evidence entry or a field once set; `points: 0`
is the lowest estimate. Pi drops a `null` passed for an optional parameter before
the tool sees it, so `points: null` changes nothing.

## Status transitions

| From | Allowed targets |
| --- | --- |
| `pending` | `in_progress`, `completed`, `deleted` |
| `in_progress` | `pending`, `completed`, `deleted` |
| `completed` | `deleted` |
| `deleted` | _(terminal)_ |

A transition to the current status is always accepted and reported as a no-op.
`delete` keeps the task as a tombstone so historic `blockedBy` references still
resolve; tombstones are hidden from `list` unless you pass `includeDeleted: true`.

## Dependencies

`blockedBy` holds the ids this task waits on. Validation runs before the state
is mutated, so a rejected call leaves the list untouched:

- a dependency id that does not exist is rejected;
- a dependency that is already tombstoned is rejected;
- blocking a task on itself is rejected;
- an `addBlockedBy` that would close a cycle in the graph is rejected.

`get` also reports the reverse edges as a `blocks:` line, derived from the other
tasks' `blockedBy` arrays.

## Return envelope

```ts
{
  content: [{ type: "text", text: string }], // human-readable summary of the op
  details: {                                 // full snapshot — replay reads this back
    action: TaskAction,
    params: Record<string, unknown>,
    tasks: Array<{
      id: number,
      subject: string,
      description?: string,
      activeForm?: string,
      status: "pending" | "in_progress" | "completed" | "deleted",
      blockedBy?: number[],
      owner?: string,
      metadata?: Record<string, unknown>,
      points?: number,
      anchor?: string,
      evidence?: Array<{ command: string, sha?: string, result: "pass" | "fail", at: string }>,
    }>,
    nextId: number,
    error?: string,                          // present only on a rejected call
  }
}
```

## Persistence

Every call that changes the list (`create`, `delete`, `clear`, or an `update`
that changed something) appends a `todo/v1` custom entry holding the whole list
to the session branch, and emits `todo:changed`. Both are part of the public
contract in [CONTRACT.md](../CONTRACT.md). Custom entries are never sent to the
model. The tool result's `details` still embeds the complete post-mutation
snapshot, as in rpiv-todo.

The custom entry matters when `todo` is called from another tool, such as a Pi
codemode script: Pi records that call only as a short summary on the outer
tool's result, so its own `details` never reach the branch.

The session-lifecycle handlers rebuild state by walking the branch and taking
the last `todo/v1` snapshot. Sessions started under rpiv-todo fall back to its
last `rpiv-todo-state` entry, then to the last `todo` tool result's `details`.
Either way, tasks survive `/reload`, `/resume`, `/tree` and compaction without
any disk writes.

## Content strings

| Situation | `content[0].text` |
| --- | --- |
| Created | `Created #3: Write the parser (pending)` |
| Created a batch | one `Created #N: … (pending)` line per task, joined by newlines |
| Updated with a status change | `Updated #3 (pending → in_progress)` |
| Updated without a status change | `Updated #3` |
| Update that changed nothing | `No change: #3 already matches the requested values (status: in_progress)` |
| Deleted | `Deleted #3: Write the parser` |
| Cleared | `Cleared 7 tasks` |
| `list` row | `[in_progress] #3 Write the parser (writing the parser) ⛓ #1,#2` |
| `list` with nothing to show | `No tasks` |
| `get` | `#3 [pending] Write the parser`, then one indented line per set field: `description`, `activeForm`, `blockedBy`, `blocks`, `owner`, `points`, `anchor`, and one `evidence: pass npm test @abc1234 (2026-11-24T09:00:00.000Z)` line per run |
| Any rejection | `Error: <message>` |

The `No change` reply exists so a model that re-issues an identical update sees
that it was a no-op instead of a fresh `Updated #N`.

## Error messages

| Message | Cause |
| --- | --- |
| `subject required for create` | `create` without a non-blank `subject` and without `tasks[]`. |
| `create requires subject or tasks[], not both` | `create` with both `subject` and `tasks[]`. |
| `tasks[] must be non-empty` | `create` with `tasks: []`. |
| `create with tasks[] takes <fields> on each item, not at the top level` | `create` with `tasks[]` and a top-level `description`, `activeForm`, `blockedBy`, `owner`, `metadata`, `points`, `anchor`, or `evidence`. |
| `tasks[N]: subject required for create` | A batch item with a blank or missing subject. |
| `blockedBy: #N not found` | `create` naming an unknown dependency. |
| `blockedBy: #N is deleted` | `create` naming a tombstoned dependency. |
| `blockedBy: #N is another item in this batch; create the prerequisite first, then the dependent with blockedBy` | A `tasks[]` item naming a sibling that this call would assign. |
| `id required for update` / `get` / `delete` | `id` omitted. |
| `#N not found` | No task with that id. |
| `update requires at least one mutable field: subject, description, activeForm, status, owner, metadata, points, anchor, evidence, addBlockedBy, or removeBlockedBy` | `update` with only an `id`. |
| `points must be a number from 0 to 10` | `points` out of range; prefixed `tasks[N]: ` for a batch item. |
| `anchor must be a non-empty string` | Blank `anchor`. |
| `evidence[N]: command must be a non-empty string` / `result must be "pass" or "fail"` / `sha must be a string` / `at must be an ISO 8601 time` / `at must not be in the future` | A malformed evidence item; `at` may lie at most five minutes after the call. |
| `metadata.<ns> refused #N: <reason>` | A namespace validator refused the change (see [CONTRACT.md](../CONTRACT.md#3-namespaces)). |
| `guard <id> refused: <reason>` / `guard <id> timed out after 10000 ms` | A change guard refused the call (see [CONTRACT.md](../CONTRACT.md#4-change-guards)). |
| `illegal transition completed → in_progress` | Target status not reachable from the current one. |
| `cannot block #N on itself` | `addBlockedBy` includes the task's own id. |
| `addBlockedBy: #N not found` / `is deleted` | Unknown or tombstoned dependency. |
| `addBlockedBy would create a cycle in the blockedBy graph` | The edge would close a cycle. |
| `#N is already deleted` | `delete` on a tombstone. |

Errors are returned in-band: `content` carries `Error: …` and `details.error`
carries the bare message. Task state is unchanged. A namespace or guard refusal is also
flagged `isError: true`, so pi reports it to the model as a failed call; other
rejections keep rpiv-todo's behaviour and are not flagged.

## Prompt guidance

The tool ships a `promptSnippet` and ten `promptGuidelines` bullets telling the
model when to open a list, to create independent tasks in one `tasks[]` call,
to keep exactly one task `in_progress`, to mark work completed immediately
rather than in batches, never to complete a task with failing tests, and the
literal `update {id, status}` call shape for changing a task's status; the tenth
describes `points`, `anchor`, and `evidence`. Both are
overridable — see
[configuration.md](./configuration.md#guidance).
