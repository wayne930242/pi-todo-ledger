# Changelog

## 0.10.0

- When a bound subagent's run ends, the ledger records what it spent on its todo in `metadata.herdr.spend`: tokens, cost, wall time, runs, and models, summed over every run of the todo. A resume of the same session replaces that session's figures instead of counting them twice; a forked child's copy of its launcher's turns is not counted; an end is tied only to the todo its launch bound; the host's `subagent:run-end` event counts an end the model never read, once by its run id. A run with fallback models counts every spawned attempt (`attempts` on its end), the failed ones too. `todo get` shows a `spend:` line. The figures are an estimate from the child's transcript, not a bill. See [CONTRACT.md](CONTRACT.md#run-spend-metadataherdrspend).
- A fallback's final session file is recorded on its run (`metadata.herdr.runs[].also`), so a resume of the file the result names binds to the same todo and counts there.
- The event and the message of one run count once however many other runs of the todo end in between: the ledger keeps a proof of a half-counted run until its other half comes, or its pi process ends.
- Known limit: when Maestro fails to read a resumed run's summary as it delivers the end, it sends neither the message nor the host's event, and that end is not counted.
- The spend write is synchronous: it reads the list from the branch pi is on at that moment and appends in the same tick, so it never lands on a branch the session switched to. It waits only behind a `todo` call of the session already running or queued, and does not ask change guards, which are awaited: a spend write changes only `metadata.herdr` and records a run that already happened.

## 0.9.0

- With pi-straw-boss loaded, the panel shows the merge-train cars the session sent, under the todo whose ticket they carry (`🚂 1128c ▰▰▰▱▱▱▱ merge 12m · 等 1128b`), and the questions it asked that wait on you, under the todo they block (`⏸ 等你：要不要連同 ws04 一起部署？ 4m`). A car or question with no todo goes in a group: `其他車廂` / `Other cars`, `火車` / `Trains`, or `等你` / `Waiting on you`. They come from sb's `straw-boss:car-rows:v1` and `straw-boss:ask-rows:v1` probes; without sb nothing of them shows.
- A question goes under its todo only by the uid sb bound it with, so a todo that takes its id after `clear` is not marked blocked; a car's `<session8>#<id>` must carry this session's own prefix. An sb that sends neither the uid nor its session puts the row in its group. A compact row cuts a long question before its `+N`, never the count.
- They rank with the run rows under the row budget, and in compact mode share their todo's row, a question waiting on you first. The collapsed row counts the questions waiting on you. The panel looks for changes every 5 seconds, so a question shows while its dialog waits.
- Placing questions, and cars by `<session8>#<id>`, needs pi-straw-boss 0.116.2 or later, whose probes name their session. With an older sb, questions go in `等你` and only cars placed by uid go under their todo.

## 0.8.2

- Shortened `todo`'s instructions by describing each option once. Task actions, validation and saved snapshots are unchanged.

## 0.8.1

- Over the row budget, the panel ranks the rows: task rows in progress, then their live run rows, then the `Other workers` group, then open and completed tasks with no live run. A long list no longer pushes every worker off the panel: run rows stay under their todos and are claimed, so the host's Subagents box lists only the rest. Both views use the ranking; rows keep their tree or list order.
- Compact mode: when some live run would still get no row of its own, each task's runs share the task's row (`◐ #55 S3 地圖 tab… ⟶ coremaptab-ui · opus · 執行中 4m`), led by the most active run with `+N` for the rest, and `Other workers` takes one row in the same form. The task part is cut first on a narrow row. A painted compact row claims every run it stands for, so the Subagents box empties. When every run fits, the two-row layout stays.
- The full view's summary counts hidden tasks in progress apart from pending ones, as in `+63 more (54 completed, 1 in progress, 8 pending)`.

## 0.8.0

- `todo` `create` and `update` take `waitsOn` (what the task waits on, such as `trains to end`) and `until` (a future ISO time) to mark a task as waiting; `update` with `null` clears either. They write the `metadata.waitsOn` and `metadata.until` keys the panel, `/todos`, and tool results already show as `⏸`, so the `todo/v1` snapshot keeps its shape and older lists read as before.
- `until`, and a `metadata.until` already stored, follow the date rule pi-straw-boss reads: an ISO date or date-time with a `T` on a real calendar day. `2099-02-30` and `2099-12-01 09:00` are refused and mark no wait.
- Completing or deleting a task removes its wait mark; a namespace validator for a wait key runs only when the call sets that key or removes one the task had. A new prompt guideline tells the model to mark a task waiting instead of leaving it open without a word, and to clear both fields to end a wait early.

## 0.7.3

- Warn at startup if rpiv-todo is still installed or another extension provides a competing todo tool or command. The warning identifies the active tool and how to remove a configured package.
- Show runs bound to hidden tasks in Other workers with their task numbers, instead of leaving them in the host panel when there is room.

## 0.7.2

- Runs of this session that belong to no todo, such as a scout sent out on the side, now show on the panel as an `Other workers` group (`其他 worker` in zh-TW) after the tasks, in the same row format as bound runs. It is not a warning. With no todos, the panel shows its heading and the group.
- Tasks keep their rows first; the group gets the rows left, and runs that do not fit are counted in the summary row, such as `+5 待處理、2 worker`. The collapsed row counts them too. The panel claims only the group rows it paints, so the host's Subagents box keeps the rest. A run that gets bound later moves under its todo.

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
