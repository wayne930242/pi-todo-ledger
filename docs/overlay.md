# Overlay and `/todos` display

How pi-todo-ledger renders the task list — when the overlay appears, what each glyph means, how
overflow is trimmed, and which strings localize.

## When the overlay exists

The widget is mounted above the Pi editor under the key `rpiv-todos`, the key rpiv-todo uses.

| Stage | Condition |
| --- | --- |
| Created | At the first session start that has a UI. A headless session never creates it. |
| Registered | While at least one overlay-visible task exists, or the run host lists a run of this session (see [Other workers](#other-workers)). The widget unregisters itself when both are gone, and re-registers when a task or a run appears. With no task, a refresh after a `subagent` or `subagent_resume` call, or at the end of a turn, finds the new run. |
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

Rows come in this order, until the row budget runs out:

1. the heading;
2. every task in progress, each followed by its run rows;
3. the next two open tasks in display order, or the next three when nothing is in progress;
4. the [Other workers](#other-workers) group, with the rows the tasks and their runs leave;
5. completed tasks from the current turn, only if rows are left after the group; they are drawn above the group, but get their rows after it;
6. one summary row counting the hidden tasks in progress, pending, and completed, then the hidden other workers, in that order, such as `+1 in progress, 5 pending, 2 completed, 2 workers` (`+1 進行中、5 待處理、2 已完成、2 worker` in zh-TW). Zero counts are left out, and with nothing hidden there is no summary row.

The summary row ends with a dim hint that names the panel key and the state it switches to next; see [Switching views](#switching-views).

`maxWidgetLines` is a hard cap here too: tasks in progress that do not fit are counted in the summary, and run rows that do not fit fold into `· N runs`.
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

- In the focus view, tasks in progress, the next tasks and their runs come first. The group gets the rows left: its heading and as many runs as fit, or nothing when fewer than two rows are left. The runs that do not fit are added to the summary row as `+2 workers` (`+2 worker` in zh-TW), or after the task counts, as in `+5 待處理、2 worker`.
- In the full view, the group follows the tree and lists every run within `maxWidgetLines`; the rest are counted in the summary row, as in `+3 more (3 pending), 2 workers`.
- In the collapsed view, the closing row counts the group before the key hint: `└─ +2 worker · ctrl+shift+t 焦點`.

The panel claims a group row the way it claims a bound run row: only a row painted in full, checked by its exact line in the fullscreen layout. A row cut by the width, clipped by the layout, covered by a popup, or folded into the summary stays unclaimed, so the Subagents widget keeps showing that run. When no ledger claims a run, the host's own widget is the fallback that shows it.

## Overflow

The content-row budget is `maxWidgetLines` (default `12`), and the heading counts
against it. The focus view applies it as described [above](#focus-view). In the
full view, when there are more tasks than fit:

1. one row is reserved for the summary line;
2. completed tasks are dropped first, newest first — the oldest completed rows
   are the last completed rows to go;
3. if the unfinished tasks alone still overflow, the tail of that list is
   truncated;
4. the last row becomes `+N more (X completed, Y pending)`.

In the full view, Pi's tool-output expansion shortcut (`ctrl+o` by default)
expands the widget to show every task. Collapsing Pi's tool output reapplies the configured
row budget. Unfinished work is therefore the last thing to disappear in the
compact view. See [configuration.md](./configuration.md#maxwidgetlines) for the
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
