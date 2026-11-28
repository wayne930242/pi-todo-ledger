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

Install this package or its predecessor, `@juicesharp/rpiv-todo`, not both. At startup the ledger warns if another extension owns the `todo` tool or registers `/todo` or `/todos`. It also checks personal and project package settings and installation paths for rpiv-todo. The warning names the active tool provider and gives the removal command for a matching package declaration. For an extension loaded with `-e`, omit it on the next launch. Pi does not expose losing tool registrations: a later, unknown extension that only registers `todo` cannot be detected.
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
Pass that value as a Herdr `subagent`'s `item` (or use `<session8>#<id>` from the same session).
Once the launch is acknowledged, the ledger sets `owner` to the child's full name and records its run id in [`metadata.herdr`](CONTRACT.md#optional-herdr-launch-identity-metadataherdr).
Use `metadata.herdr.id` to resolve or message the worker by its run key.
When a bound run ends, the ledger adds its tokens, cost, wall time, and models to [`metadata.herdr.spend`](CONTRACT.md#run-spend-metadataherdrspend), summed over the todo's runs; `get` shows them.
Use a name with `/boss send` only if it matches the name Straw Boss shows; a launch named `API worker` may appear there as `api-worker`.
You can still set `owner` by hand.

The panel lists each task's live bound runs under it.
A run that belongs to no task, such as a scout sent out on the side, is listed under an `Other workers` group (`其他 worker` in zh-TW) after the tasks, in the same row format; the panel shows that group even when the list is empty.
The panel claims every run row it paints, so the host's Subagents box shows only the runs the panel does not.
See [docs/overlay.md](docs/overlay.md#other-workers).

`/todos` and the panel's full view indent each open task under its first unfinished blocker; the panel's default focus view lists tasks flat and names every unfinished blocker after the subject. Both show the owner as `@owner`.
To mark a task as waiting, pass `waitsOn` with what it waits on (a person, CI, `trains to end`); to defer it until a particular time, pass `until` with an ISO timestamp, e.g. `2027-01-15T09:00:00+08:00`.
`create` and `update` take both, `update` with `null` clears one, and completing or deleting the task clears both.
They are stored as `metadata.waitsOn` and `metadata.until`, which earlier releases already read, so setting those keys directly still works.
An open task shows `⏸` with what it waits on or the future deadline in local time.
A wait neither schedules a wake-up nor changes the task's `status`; it tells readers such as anchorloop's close guard and sb's board that the task is held up, not forgotten.
A wait with only `until` ends when that time passes; a `waitsOn` wait lasts until it is cleared, so to end a wait early clear both fields you set.
`until` takes an ISO date or date-time with a `T` on a real calendar day, the form pi-straw-boss reads; `2099-02-30` and `2099-12-01 09:00` are refused, and such a value written straight into metadata does not mark the task as waiting.

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
  "collapseKey": "alt+t",
  "view": "full"
}
```

| Setting | What it does | Default |
| --- | --- | --- |
| `view` | The panel's starting state. `"focus"` lists the tasks in progress and the next open ones, and folds the rest into one summary row. `"full"` shows the whole dependency tree. | `"focus"` |
| `maxWidgetLines` | Content rows the panel may use, heading included. Minimum `3`. Pi's tool-output expansion mode lifts the limit. | `12` |
| `collapseKey` | Key that cycles the panel focus → full → collapsed → focus, starting from `view`, in pi keybinding form (`alt+o`, `ctrl+shift+t`). A dim hint such as `+5 pending · ctrl+shift+t full` names the next state. `"off"` registers no shortcut and shows no hint. Needs `/reload` to rebind. | `"ctrl+shift+t"` |
| `guidance` | Replaces the built-in instructions the extension gives the model about the todo list (`promptSnippet`, `promptGuidelines`). Needs `/reload`. | built-ins |

More detail: [Configuration](docs/configuration.md), [`todo` tool reference](docs/tool-schema.md), [Panel and `/todos`](docs/overlay.md).
The panel's text follows the locale chosen in [`@juicesharp/rpiv-i18n`](https://www.npmjs.com/package/@juicesharp/rpiv-i18n) when it is installed.
Traditional Chinese needs `--locale zh-TW` or a `zh_TW` system locale, because the `/languages` picker offers only Simplified `zh`.
Without rpiv-i18n the panel is Traditional Chinese under a `zh_TW` or `zh_Hant` system locale and English otherwise; see [Localization](docs/overlay.md#localization).

## License

MIT. Copyright juicesharp (rpiv-todo) and wayne930242 (this fork); see [LICENSE](LICENSE) and [NOTICE](NOTICE).
