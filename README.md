# pi-todo-ledger

A todo list for [pi](https://github.com/earendil-works/pi) agents that other extensions can read and check without importing it.
It is a fork of [`@juicesharp/rpiv-todo`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo) 2.15.0: the `todo` tool, the `/todos` command, and the live panel above the editor work as they do in rpiv-todo.
On top of them it publishes a bookkeeping contract, [CONTRACT.md](CONTRACT.md):

- **Snapshot entry.** Every change appends a `todo/v1` entry with the whole list to the session branch. Its shape is fixed by [`schema/todo-v1.schema.json`](schema/todo-v1.schema.json).
- **Change event.** `todo:changed` on `pi.events` carries `{ v: 1, sessionId, tasks }` after every change and when a session's list is restored.
- **Namespace validators.** An extension that owns `metadata.<ns>` registers a validator with `todo:namespace`; the tool runs it before committing and returns its refusal as a tool error.
- **Change guards.** An extension that must approve whole calls (including creates without metadata, batches, deletes, and `clear`) registers an async guard with `todo:guard`; the tool awaits it before committing.
- **Stable identity.** Each new task gets a `uid` that survives replay and import. Imported tasks also name their source session when the snapshot records it.
- **Bookkeeping fields.** Tasks gain `points` (effort, 0 to 10), `anchor` (the check that shows the task is done), and `evidence` (an append-only list of check runs, each `{ command, sha?, ref?, result, at }`).
- **Work graph.** A task can name the graph of the plan it belongs to: `single-loop`, `fan-out/fan-in`, or `orchestrator-worker`. `list` groups open tasks by it.

## Replaces rpiv-todo

This package registers the tool name `todo`, as rpiv-todo does, so install one or the other.
With both installed, the two `todo` tools clash.

Switching keeps your lists.
On a session started under rpiv-todo, the extension restores the list from rpiv-todo's records (`rpiv-todo-state` entries, else `todo` tool results) and writes `todo/v1` entries from the next change on.
It reads rpiv-todo's config file too, until you create one of its own (see [Configuration](#configuration)).

```sh
pi remove npm:@juicesharp/rpiv-todo
pi install npm:pi-todo-ledger
```

Then run `/reload` or restart pi.

## Using it

Nothing changes for the agent: it calls `todo` with the same actions and parameters as before (`create`, `update`, `list`, `get`, `delete`, `clear`, with `blockedBy`, `owner`, `activeForm`, and `metadata`).
The new fields are optional parameters of `create` (and of each `tasks[]` item) and `update`:

```text
{ "action": "create", "subject": "Fix replay of old sessions", "points": 2, "anchor": "npm test -- replay" }
{ "action": "update", "id": 1, "evidence": [{ "command": "npm test -- replay", "sha": "f503b7f", "result": "pass" }] }
```

`points` and `anchor` are replaced by an update that sets them.
`evidence` items are appended after the existing ones; `at` defaults to the time of the call.
`get` shows all three fields.

`create`, `update`, `get`, and `list` print each task's stable `uid` if it has one (for example, `t_k7wrx2jzfq`).
Pass that value as a subagent's `item`; use the shorter `#id` only within the list.

The panel and `/todos` indent each open task under its first unfinished blocker and show its owner as `@owner`.
To mark a task as waiting for someone, set `metadata.waitsOn` to their name; to defer it until a particular time, set `metadata.until` to an ISO timestamp, e.g. `2027-01-15T09:00:00+08:00`.
An open task shows `⏸` with the name or the future deadline in local time.
These keys are display conventions: they neither schedule a wake-up nor change the task's `status` or the `todo/v1` contract.

`graph` names the work graph of the plan a task belongs to, one of `single-loop`, `fan-out/fan-in`, and `orchestrator-worker`; any other value is refused.
One session often runs several plans, so each task carries its own.
An update replaces it and `graph: null` clears it.
When an open task names a graph, `list` shows open tasks under one `<graph>:` header per graph, then `no graph:`, then `closed:`.
A `metadata.graph` holding one of the three names, as earlier sessions wrote it, is read as `graph` when the list is restored or imported.

```text
{ "action": "create", "tasks": [{ "subject": "Port the parser", "graph": "fan-out/fan-in" }, { "subject": "Port the printer", "graph": "fan-out/fan-in" }] }
```

To pick up another session's list, for example after its pane died, call `todo` in the new session before creating any tasks and name the old session by its id, a unique prefix of it, or its `.jsonl` file:

```json
{ "action": "import", "session": "01a2130c" }
```

The tool looks the id up in pi's session directories (`PI_CODING_AGENT_SESSION_DIR` when set, and `sessions` under the agent directory, `PI_CODING_AGENT_DIR` or `~/.pi/agent`) and restores the newest `todo/v1` snapshot on that session's current branch.
An id that matches several sessions, or none, is refused.

A snapshot file works too: save the `data` from a `todo/v1` entry as JSON and import it by path.

```json
{ "action": "import", "path": "handover.json" }
```

A relative path starts in the new session's working directory.
Import keeps the task ids, dependencies, evidence, tombstones, and next id; it never merges with or replaces an existing list.

## Reading the list from another extension

Listen for the event, or read the newest snapshot on the branch:

```ts
pi.events.on("todo:changed", (data) => {
  const { sessionId, tasks } = data as { v: 1; sessionId: string; tasks: Array<{ id: number; status: string }> };
});

function currentTasks(ctx: ExtensionContext) {
  let tasks: unknown[] = [];
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === "todo/v1") tasks = (entry.data as { tasks: unknown[] }).tasks;
  }
  return tasks;
}
```

[CONTRACT.md](CONTRACT.md) describes when each fires, how validators and guards register, and what a refusal looks like.

## Configuration

Optional. Create `~/.config/pi-todo-ledger/config.json`, or `$XDG_CONFIG_HOME/pi-todo-ledger/config.json` if you set that variable.
Without one, the extension reads `rpiv-todo/config.json` from the same directories.

```json
{
  "maxWidgetLines": 8,
  "collapseKey": "alt+t"
}
```

| Setting | What it does | Default |
| --- | --- | --- |
| `maxWidgetLines` | Content rows the panel may use, heading included. Minimum `3`. Pi's tool-output expansion mode shows all tasks. | `12` |
| `collapseKey` | Key that collapses and expands the panel, in pi keybinding form (`alt+o`, `ctrl+shift+t`). `"off"` registers no shortcut. Needs `/reload` to rebind. | `"ctrl+shift+t"` |
| `guidance` | Replaces the built-in instructions the extension gives the model about the todo list (`promptSnippet`, `promptGuidelines`). Needs `/reload`. | built-ins |

More detail: [Configuration](docs/configuration.md), [`todo` tool reference](docs/tool-schema.md), [Panel and `/todos`](docs/overlay.md).
The panel's text is localized when [`@juicesharp/rpiv-i18n`](https://www.npmjs.com/package/@juicesharp/rpiv-i18n) is installed, and English otherwise.

## License

MIT. Copyright juicesharp (rpiv-todo) and wayne930242 (this fork); see [LICENSE](LICENSE) and [NOTICE](NOTICE).
