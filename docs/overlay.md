# Overlay and `/todos` display

How pi-todo-ledger renders the task list — when the overlay appears, what each glyph means, how
overflow is trimmed, and which strings localize.

## When the overlay exists

The widget is mounted above the Pi editor under the key `rpiv-todos`, the key rpiv-todo uses.

| Stage | Condition |
| --- | --- |
| Created | At the first session start that has a UI. A headless session never creates it. |
| Registered | While at least one overlay-visible task exists, or the run host lists a run of this session (see [Other workers](#other-workers)), or pi-straw-boss lists a car or a question of it (see [Cars and questions](#cars-and-questions-pi-straw-boss)). The widget unregisters itself when all are gone, and re-registers when one appears. With no task, a refresh after a `subagent` or `subagent_resume` call, or at the end of a turn, finds the new run; a car or question is found within 5 seconds. |
| Bound | Only the foreground session's overlay is refreshed. A detached or child session has its own task state and never rebinds or repaints the foreground panel. |
| Disposed | On the foreground session's shutdown. A child session shutting down leaves the overlay alone. |

Task state is partitioned by session id, so parallel sessions cannot read or
overwrite each other's lists. Nothing is written to disk: on session start,
compaction, and session-tree changes, the list is rebuilt by walking the branch
and taking the last saved snapshot, which replaces the whole list
(last-write-wins). See [tool-schema.md](./tool-schema.md#persistence) for where
snapshots are saved.

## Focus view

The panel opens in the focus view. It shows what is being worked on and what comes next, and folds the rest into one row:

```text
● Todos (0/8)
├─ ◐ #8 執行等待
│    └ fixture-test · astra · 執行中 6s
├─ ○ #1 檢查畫面
├─ ○ #2 確認版面
└─ +5 待處理 · ctrl+shift+t 完整
```

Rows are drawn in this order:

1. the heading;
2. every task in progress, each followed by its run rows;
3. the next two open tasks in display order, or the next three when nothing is in progress;
4. completed tasks from the current turn;
5. the [Other workers](#other-workers) group;
6. one summary row counting the hidden tasks in progress, pending, and completed, then the hidden other workers, in that order, such as `+1 in progress, 5 pending, 2 completed, 2 workers` (`+1 進行中、5 待處理、2 已完成、2 worker` in zh-TW). Zero counts are left out, and with nothing hidden there is no summary row.

The summary row ends with a dim hint that names the panel key and the state it switches to next; see [Switching views](#switching-views).

`maxWidgetLines` is a hard cap here too. Rows 2 to 5 share the budget by [rank](#overflow): run rows and the group come before the next open tasks, tasks in progress that do not fit are counted in the summary, and run rows that do not fit fold into `· N runs`.
Rows are flat, so the `⛓` tail lists every unfinished blocker of a task; `⏸`, owners, and the other marks are the same as in the full view.
Pi's tool-output expansion mode lifts the row cap but keeps this selection. Press the panel key for the tree below, set `"view": "full"` (see [configuration.md](./configuration.md#view)) to start there, or use `/todos` to see everything once.

## Anatomy of a row

The full view (`"view": "full"`) draws the whole dependency tree:

```text
● Todos (0/5) · fan-out/fan-in
├─ ◐ #1 Scope @Ari
├─   ○ #3 API
├─     ○ #4 Check API
├─   ○ #5 UI
├─ ⏸ #2 Approve waits Pat
└─ ctrl+shift+t collapse
```

- **Heading** — `● Todos (done/total)` in the accent color while any task is
  `pending` or `in_progress`; `○ Todos (done/total)` dimmed once everything is
  completed.
- **Glyphs** — `○` pending, `◐` in_progress, `✓` completed, `✗` deleted.
  Completed and deleted subjects render dim and struck through.
- **activeForm** — appended dim in parentheses, only while the task is
  `in_progress` and only when it differs from the subject (ignoring leading and trailing spaces).
- **Waiting** — `⏸` replaces the open-task glyph when `metadata.waitsOn` names a party or `metadata.until` is an ISO time in the future (the `todo` fields `waitsOn` and `until` write these keys). The row shows the party, the local deadline, or both. An elapsed deadline no longer marks a task as waiting.
- **Owner** — `@owner` follows the subject in muted text.
- **Dependencies** — open rows nest under the first unfinished `blockedBy` id; siblings are visited in id order. Other unfinished blockers appear in the `⛓ #1,#2` tail. If another prerequisite interrupts a branch, `↳ #N` names the parent the row returns to.
- **Graph** — the heading names the graph when all open tasks share it; otherwise a root shows its own graph, if set.
- **`#id` prefix** — shown on every overlay row when at least one visible task carries a `blockedBy`.
- **Prefixes** — `├─` on each row, `└─` on the last one. A blank spacer line is
  always appended below the panel so it is not flush against the input box.

Rows longer than the terminal width are truncated with `…`.

## Worker runs under a task

When pi-herdr-agents is loaded, each task lists its live bound runs (`metadata.herdr.runs`) under its row: name, short model, state, and time in that state.
A run that is not working keeps its one row and gains a mark before its name:

- `◇ … · idle 3m` (zh-TW `閒置`), dim: its turn ended, or a persistent specialist sits between tasks (Maestro lifecycle `waiting`).
- `? … · waiting 42s` (zh-TW `等待回覆`), in the warning color: the pane shows a dialog, approval, or question (Maestro lifecycle `blocked`).

Starting and working runs carry no mark; other lifecycle kinds show their state word only.
A pending cancel replaces the state with `cancelling` or `cancel unconfirmed` and drops the mark.
Run rows count against the row budget; a task whose runs do not fit shows `· N runs` instead.

The panel asks the Subagents widget to hide a run only once it knows the run's row reached the screen:

- In Pi's inline renderer every widget line is written, so a row drawn on two frames in a row counts.
- Pi's fullscreen layout can clip the panel after it is drawn. Each run row there ends in an invisible marker unique to the panel and run: an escape sequence shaped like OSC 8 with an `id` parameter and no URI. Pi counts it as zero width, and terminals drop it (Ghostty and Herdr discard it as an invalid OSC 8), so it neither shows nor opens a link. Right after Pi paints a frame, the panel looks in `getScreenLines()` for a line that starts with the exact row it drew, marker included. A row the layout cut off is absent, and a row under a popup, a search highlight, or a selection no longer matches, so in both cases its run stays in the Subagents widget. A changed claim triggers one more frame, so the Subagents widget catches up one frame later.
- A renderer that offers neither gives no evidence, and the Subagents widget keeps every run.

Collapsing the panel, or the run leaving the panel, returns the run to the Subagents widget.

## Other workers

An agent often sends out a run that belongs to no todo item: a quick scout, a reviewer, a one-off check.
The group follows the task rows. It includes unbound runs and runs whose task is folded away or cut by the row budget. A run from a hidden task carries its task number (`#4 worker-four`). A fully drawn run is claimed here; if there is no room, the summary counts it and the host can still show it.

```text
● Todos (0/3)
├─ ◐ #1 API
│    └ api-worker · astra · 執行中 5s
├─ ◐ #2 UI
│    └ ui-worker · astra · 執行中 42s
├─ ○ #3 Docs
├─ 其他 worker
│    ├ scout-x · astra · 執行中 3s
│    └ ◇ scout-y · sol · 閒置 1m
└─ ctrl+shift+t 完整
```

- The heading row reads `Other workers` (`其他 worker` in zh-TW), in muted text. The group is normal work, not a warning, so it has no warning colour or icon.
- Each run row has the format of a bound run row: the idle and waiting marks, the time in the current state, and the claim marker. A run waiting for a reply keeps the warning colour it has under a task.
- Runs appear in the host's order.
- A run counts as bound when its id is in the `metadata.herdr.runs` of a task the panel shows. A run bound to a completed task that has faded out, or to a deleted one, joins the group.
- When a run gets bound to a task, it moves under that task on the next frame and leaves the group, so it is never drawn twice.
- With no task at all, the panel still shows its heading and the group.

The group follows the row budget:

- In both views, tasks in progress and their runs come first, then the group, then the pending and completed tasks without a live run (see [Overflow](#overflow)). The group gets its heading and as many runs as fit, or nothing when fewer than two rows are left.
- The runs that do not fit are added to the summary row as `+2 workers` (`+2 worker` in zh-TW), or after the task counts, as in `+5 待處理、2 worker` in the focus view and `+3 more (3 pending), 2 workers` in the full view.
- In the collapsed view, the closing row counts the group before the key hint: `└─ +2 worker · ctrl+shift+t 焦點`.

The panel claims a group row the way it claims a bound run row: only a row painted in full, checked by its exact line in the fullscreen layout. A row cut by the width, clipped by the layout, covered by a popup, or folded into the summary stays unclaimed, so the Subagents widget keeps showing that run. When no ledger claims a run, the host's own widget is the fallback that shows it.

## Cars and questions (pi-straw-boss)

With pi-straw-boss (sb) loaded, the panel also shows what sb knows of the session and the host's run rows do not: the merge-train
cars it sent, and the questions it asked that wait on you. It reads them from two probes on `pi.events`, as it reads the run rows:
`straw-boss:car-rows:v1` and `straw-boss:ask-rows:v1` (sb's `docs/specs/2026-11-28-car-rows.md` and `2026-11-28-boss-asks.md`).
Without sb, or with an sb that does not answer them, nothing of them shows and the panel is as before.

```text
● Todos (1/10)
├─ ◐ #2 MP-5801 FE2 訂單列表改版
│    ├ fe2-list-build · opus · 執行中 31m
│    └ 🚂 1128c ▰▰▰▱▱▱▱ merge 12m · 等 1128b
├─ ◐ #3 MP-5804 v3 出貨單 API 修正
│    ├ ⏸ 等你：MP-5804 要不要連同 ws04 一起部署？ 4m
│    └ v3-ship-review · opus · 審查中 9m
├─ ○ #5 MP-5790 ws04 升級前檢查
├─ 其他 worker
│    └ train-scout · opus · 執行中 3m
└─ 其他車廂
     └ 📮 已送出 3m · 調度員還沒收 · MP-5779
```

- A car row goes under the todo sb names in its `item` (the todo's uid, or `<session8>#<id>`): sb picks the open todo whose subject
  names the car's ticket. sb writes every word of the row (`🚂 1128c ▰▰▰▱▱▱▱ merge`, `✅ 1128c 已落地 1.62.0-beta.24`, `↩ 退回`);
  the panel adds the time in the car's current stage and what it waits on, and colours a warning row `warning` and a returned or
  dropped one `error`. A car with no todo goes in the group sb names, `其他車廂` / `Other cars`, or `火車` / `Trains` for the trains an
  integrator received cars for.
- A question row, `⏸ 等你：<question> 4m` (`⏸ waits on you: …`), goes under the todo it blocks: the todo sb bound when the question was
  asked, by its id and uid. The uid must still be that todo's: after `clear` a new todo can take the id, and a question bound to the
  old one, or bound with no uid, goes in the group instead. The question is cut at 48 columns; `/boss asks` prints it whole. Only this session's questions and its subagents' show. One
  with no todo here goes in a `等你` / `Waiting on you` group, the first group, as `⏸ <question> 4m`. Another session's questions
  are on `/boss asks` and sb's GUI.
- Car and question rows rank with run rows (see [Overflow](#overflow)): a todo's live rows are its questions, its runs, then its cars, all
  together, and their groups rank with Other workers. A row in a group whose todo has no row carries its todo's number.
- In [compact mode](#compact-mode) they share the todo's row like runs. The row after ` ⟶ ` is the one that most wants attention: a
  question waiting on you first, then a returned or dropped car, then a working run, a run waiting for a reply or a car that warns,
  then the rest, idle runs last.
- The summary row counts the rows a group leaves out, such as `⏸ 等你 1` or `2 其他車廂`. The collapsed row counts the questions
  waiting on you: `└─ ⏸ 等你 1 · ctrl+shift+t 焦點`.
- sb reads its rows every 15 seconds, between turns too; the panel looks every 5 seconds and redraws when they changed, so a
  question asked in a dialog shows while the dialog waits.

## Overflow

The content-row budget is `maxWidgetLines` (default `12`), and the heading counts
against it. When the rows do not all fit, one row is reserved for the summary,
and both views hand out the rest by rank, in display order within each rank:

1. task rows of the tasks in progress;
2. live rows (runs, and sb's cars and questions), all of one task's together, with
   that task's row when it has none yet; a task in progress whose runs do not fit
   keeps its row and shows `· N runs`;
3. the groups, holding the live rows whose task got no row: `Waiting on you`,
   [Other workers](#other-workers), then the car groups;
4. open tasks with no live run;
5. completed tasks with no live run, oldest first.

Rows keep their display order whatever their rank: the full view still draws the
tree, and the focus view its flat list. The focus view ranks only the tasks it
selects (in progress, the next open ones, and this turn's completed ones). In the
full view the last row becomes `+N more (X completed, Y in progress, Z pending)`,
leaving out zero counts.

Ranking run rows above open tasks keeps the workers under their todos, so the
panel can claim them and the Subagents widget lists only what is left.

### Compact mode

When some live run would still get no row of its own, the panel switches to
compact mode for that frame. A task's runs then share the task's row, and the
Other workers group takes one row:

```text
● Todos (54/71)
├─ ◐ #35 Final BitD UAT round for the boss
├─ ◐ #55 S3 地圖 tab on core Table Maps, BitD map retired ⟶ coremaptab-ui · opus · 執行中 4m
├─   ○ #57 S4 map ports + two-way claims ↔ turf sync
├─ ◐ #56 F1 faction tracker storage (migration 198) ⟶ factionsdb-build · opus · 執行中 21m
├─ ◐ #65 EP sheet: centering, morph grid, 更換義體, Select, pictures
├─ ◐ #66 Site-wide: native selects → shared Select, then lint guard ⟶ selectsweep-ui · opus · 執行中 39m
├─ ◐ #67 EP rules book: add Flexbot Confidential + Rules Primer; Flexbot … ⟶ epbooks-build · opus · 執行中 30m
├─ ◐ #68 EP scenarios: 心智獵人, 小心WMD, 異噬, 超企業劫案, 奈米任務 ⟶ epscen-review · opus · 審查中 6m +2
├─ ◐ #70 Table session: reading dialogs dock to the workspace pane, chat stays usable
├─ 其他 worker ⟶ skald-scout · opus · 執行中 3m +1
└─ +62 項未顯示 (54 已完成, 8 待處理) · ctrl+shift+t 收合
```

- After ` ⟶ ` comes the most active run (working, then waiting for a reply, then
  other states, idle last; the host's order breaks ties), in the run row format,
  then `+N` for the task's other live runs.
- A narrow row cuts the task part with `…` first, so the run stays whole.
- The ranks above still apply; runs simply cost no rows, and the group costs one.
  A task with no live run keeps its plain row.
- A compact row painted in full claims every run it stands for, `+N` included,
  through the same inline or screen check as a run row. A row cut into its run,
  or with fewer than 12 columns left for the task, claims none.
- When every run fits on its own row, the panel keeps the two-row layout.

In the full view, Pi's tool-output expansion shortcut (`ctrl+o` by default)
expands the widget to show every task. Collapsing Pi's tool output reapplies the configured
row budget. Unfinished work is therefore the last thing to disappear under the
row budget. See [configuration.md](./configuration.md#maxwidgetlines) for the
budget's floor and reload semantics.

## Completed tasks fading out

A completed task stays on screen for the remainder of the turn in which it was
completed. At the start of the next agent turn, every completed row that has
already been displayed is hidden from later renders. Reloading or compacting the
session resets that tracking, so a fresh session shows the full list again.

## Switching views

`ctrl+shift+t` steps the panel through three states, always in this order:

1. focus view;
2. full view;
3. collapsed: the heading and one dim hint row, `└─ ctrl+shift+t focus`, which starts with the count of [other workers](#other-workers) when there are any.

The panel starts in the state `view` names, `"focus"` unless you set `"full"`,
and the next press continues the cycle from there: from `"full"` it goes to
collapsed, then focus, then full again. The chosen state holds until the next
press or the end of the session.

Each state shows a dim hint naming the key and the next state: `ctrl+shift+t
full`, `ctrl+shift+t collapse`, `ctrl+shift+t focus` (`完整`, `收合`, `焦點` in
zh-TW). In the focus and full views the hint ends the summary row after a ` · `.
It is the first thing cut when the row is too narrow. With nothing to summarize,
the hint takes its own closing `└─` row, and only when the row budget has a row
to spare, so it never pushes a task out. The hint always shows the configured
key.

Collapsing hides the run rows, including the Other workers group, so the panel
releases its claim on them; the Subagents widget can show them again. In the focus and full views the panel
claims the run rows it actually paints, as described under
[Worker runs under a task](#worker-runs-under-a-task).

Rebind or disable the shortcut with the `collapseKey` option; see
[configuration.md](./configuration.md#collapsekey). With `"off"` no hint is
shown. If the shortcut is set to `"off"` while the panel is collapsed, the
collapsed row becomes a static `collapsed` label rather than advertising an
unbindable key.

## `/todos`

`/todos` shows the whole dependency tree, independent of the overlay's row budget and auto-hiding.
Completed tasks follow in their own section.

```text
1 in progress · 4 pending · fan-out/fan-in
  ◐ #1 Scope @Ari
    ○ #3 API
      ○ #4 Check API
    ○ #5 UI
  ⏸ #2 Approve waits Pat
```

The header omits any count that is zero. Sections appear only when they have
tasks. Tombstoned tasks are never listed.

- With no tasks: `No todos yet. Ask the agent to add some!`
- In a non-interactive session: `/todos requires interactive mode`

## Localization

The overlay heading, both summary rows, the key hint, the Other workers heading and
count, the run states, the `/todos` section headers, and the status words all localize through
[`@juicesharp/rpiv-i18n`](https://www.npmjs.com/package/@juicesharp/rpiv-i18n)
when that package is installed. Bundled locales: `de`, `en`, `es`, `fr`, `pt`,
`pt-BR`, `ru`, `uk`, `zh` (Simplified), and `zh-TW` (Traditional).

The `/languages` picker has no Traditional Chinese entry; its `中文 (zh)` is
Simplified. An explicit choice always wins, and the system locale is only the
default. To get Traditional Chinese, use one of:

- `pi --locale zh-TW`;
- `{ "locale": "zh-TW" }` in rpiv-i18n's `locale.json` (see its README for the path);
- **System default** in `/languages`, with `LC_ALL`, `LC_MESSAGES`, or `LANG` set to
  a `zh_TW` or `zh_Hant` locale such as `zh_TW.UTF-8`.

LLM-facing output — the tool response envelope, reducer error messages, and the
schema descriptions — stays English by design.

The SDK is a soft optional peer, loaded through a dynamic import at module init.
When it is absent, the panel is Traditional Chinese under a `zh_TW` or `zh_Hant`
system locale and English otherwise, and the extension stays online: no warning,
no crash. Install it at any time with
`pi install npm:@juicesharp/rpiv-i18n` and restart the session. To add or
override a translation, drop a `locales/<code>.json` file mirroring `en.json` —
see the `@juicesharp/rpiv-i18n` README's "Contributing translations" section.
