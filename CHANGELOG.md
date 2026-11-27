# Changelog

## 0.7.1

- The panel key (`collapseKey`, default `ctrl+shift+t`) now cycles focus view → full view → collapsed → focus view, starting from the configured `view`. The chosen state lasts for the session.
- A dim hint names the key and the next state at the end of the summary row, such as `+5 pending · ctrl+shift+t full` (`+5 待處理 · ctrl+shift+t 完整` in zh-TW). With nothing to summarize it takes a closing row when one is spare. It is cut first on a narrow row, and `"off"` shows none.

## 0.7.0

- The panel shows each live Herdr run beneath its todo. It claims only the run rows it displays, so the Subagents widget can still show runs the panel leaves out.
- Focus view is now the default: the panel lists work in progress and the next open tasks, then summarizes the rest. Set `view` to `"full"` to see the dependency tree instead.
- The panel omits an `activeForm` that repeats the task subject. Run rows distinguish idle and waiting runs once the host reports those states.

## 0.6.0

- A successful Herdr `subagent` launch with a todo `item` sets the task's owner to the full child name and records the run id in `metadata.herdr.id`. Worktree launches that return a pane id also set `metadata.herdr.pane`. Namespace validators and guards can refuse the assignment without undoing the launch.
- Use a stable uid or `<session8>#<id>` from the calling session. A pending assignment to a legacy task without a uid survives ordinary updates but not a list clear or branch replay. The `todo/v1` schema stays unchanged.

## 0.5.0

- `get`, `list`, `create`, and `update` print the task's stable `uid` for use as a subagent `item`. Tasks restored without a `uid` keep their numeric id only.
- The panel and `/todos` show owners as `@owner` and indent open tasks under their first unfinished blocker. A shared graph name appears once in the heading; for a mixed plan each root shows its own graph.
- Set `metadata.waitsOn` to a name or `metadata.until` to a future ISO time to show `⏸` and the reason in the panel, `/todos`, and tool results. Waiting is a display convention, not a new status.

## 0.4.0

- Tasks take an optional `graph`: `single-loop`, `fan-out/fan-in`, or `orchestrator-worker`, the work graph of the plan the task belongs to. `create` (single or each `tasks[]` item) and `update` set it, `update` with `graph: null` clears it, and any other value is refused with the three names. `get` shows it, and `list` groups open tasks by graph, then tasks without one, then closed tasks.
- A task whose `metadata.graph` holds one of the three names is read with that `graph` on replay and import. The metadata stays as it was; other values stay metadata only.
- `import` takes `session` instead of `path`: a full or unique-prefix session id, looked up in pi's session directories, or a session `.jsonl` path. It restores the newest `todo/v1` snapshot on that session's current branch, so a list survives a session that died without a handover file.

## 0.3.0

- New tasks keep the same `uid` when a branch is restored or a snapshot is imported. Older tasks without a `uid` remain valid.
- Snapshots now record their session. Import copies that session id to `origin.session` on each task.
- Evidence accepts an optional `ref` pointing to the tool call or child that ran the check.
