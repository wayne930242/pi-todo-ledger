# Overlay and `/todos` display

How pi-todo-ledger renders the task list — when the overlay appears, what each glyph means, how
overflow is trimmed, and which strings localize.

## When the overlay exists

The widget is mounted above the Pi editor under the key `rpiv-todos`, the key rpiv-todo uses.

| Stage | Condition |
| --- | --- |
| Created | At the first session start that has a UI. A headless session never creates it. |
| Registered | Only while at least one overlay-visible task exists. The widget unregisters itself when the list empties, and re-registers when a task reappears. |
| Bound | Only the foreground session's overlay is refreshed. A detached or child session has its own task state and never rebinds or repaints the foreground panel. |
| Disposed | On the foreground session's shutdown. A child session shutting down leaves the overlay alone. |

Task state is partitioned by session id, so parallel sessions cannot read or
overwrite each other's lists. Nothing is written to disk: on session start,
compaction, and session-tree changes, the list is rebuilt by walking the branch
and taking the last saved snapshot, which replaces the whole list
(last-write-wins). See [tool-schema.md](./tool-schema.md#persistence) for where
snapshots are saved.

## Anatomy of a row

```text
● Todos (0/5) · fan-out/fan-in
├─ ◐ #1 Scope @Ari
├─   ○ #3 API
├─     ○ #4 Check API
├─   ○ #5 UI
└─ ⏸ #2 Approve waits Pat
```

- **Heading** — `● Todos (done/total)` in the accent color while any task is
  `pending` or `in_progress`; `○ Todos (done/total)` dimmed once everything is
  completed.
- **Glyphs** — `○` pending, `◐` in_progress, `✓` completed, `✗` deleted.
  Completed and deleted subjects render dim and struck through.
- **activeForm** — appended dim in parentheses, only while the task is
  `in_progress`.
- **Waiting** — `⏸` replaces the open-task glyph when `metadata.waitsOn` names a party or `metadata.until` is an ISO time in the future. The row shows the party, the local deadline, or both. An elapsed deadline no longer marks a task as waiting.
- **Owner** — `@owner` follows the subject in muted text.
- **Dependencies** — open rows nest under the first unfinished `blockedBy` id; siblings are visited in id order. Other unfinished blockers appear in the `⛓ #1,#2` tail. If another prerequisite interrupts a branch, `↳ #N` names the parent the row returns to.
- **Graph** — the heading names the graph when all open tasks share it; otherwise a root shows its own graph, if set.
- **`#id` prefix** — shown on every overlay row when at least one visible task carries a `blockedBy`.
- **Prefixes** — `├─` on each row, `└─` on the last one. A blank spacer line is
  always appended below the panel so it is not flush against the input box.

Rows longer than the terminal width are truncated with `…`.

## Worker runs under a task

When pi-herdr-agents is loaded, each task lists its live bound runs (`metadata.herdr.runs`) under its row: name, short model, state, and time in that state.
A pending cancel replaces the state with `cancelling` or `cancel unconfirmed`.
Run rows count against the row budget; a task whose runs do not fit shows `· N runs` instead.

The panel asks the Subagents widget to hide a run only once it knows the run's row reached the screen:

- In Pi's inline renderer every widget line is written, so a row drawn on two frames in a row counts.
- Pi's fullscreen layout can clip the panel after it is drawn. Each run row there ends in a zero-width marker (an OSC 8 hyperlink close with an `id` parameter), and right after Pi paints a frame the panel looks for that marker in `getScreenLines()`. A row the layout cut off has no marker on screen, so its run stays in the Subagents widget. A changed claim triggers one more frame, so the Subagents widget catches up one frame later.
- A renderer that offers neither gives no evidence, and the Subagents widget keeps every run.

Collapsing the panel, or the run leaving the panel, returns the run to the Subagents widget.

## Overflow

The content-row budget is `maxWidgetLines` (default `12`), and the heading counts
against it. When there are more tasks than fit:

1. one row is reserved for the summary line;
2. completed tasks are dropped first, newest first — the oldest completed rows
   are the last completed rows to go;
3. if the unfinished tasks alone still overflow, the tail of that list is
   truncated;
4. the last row becomes `+N more (X completed, Y pending)`.

Use Pi's tool-output expansion shortcut (`ctrl+o` by default) to expand the
widget and show every task. Collapsing Pi's tool output reapplies the configured
row budget. Unfinished work is therefore the last thing to disappear in the
compact view. See [configuration.md](./configuration.md#maxwidgetlines) for the
budget's floor and reload semantics.

## Completed tasks fading out

A completed task stays on screen for the remainder of the turn in which it was
completed. At the start of the next agent turn, every completed row that has
already been displayed is hidden from later renders. Reloading or compacting the
session resets that tracking, so a fresh session shows the full list again.

## Collapsing

Press `ctrl+shift+t` to collapse the panel to two lines — the heading plus a dim
`└─ ctrl+shift+t to expand` hint — and again to expand it. The hint always shows
the currently configured key.

Rebind or disable the shortcut with the `collapseKey` option; see
[configuration.md](./configuration.md#collapsekey). If the shortcut is set to
`"off"` while the panel is collapsed, the hint becomes a static `collapsed`
label rather than advertising an unbindable key.

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

The overlay heading, the `+N more` summary, the collapse hint, the `/todos`
section headers, and the status words all localize through
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
