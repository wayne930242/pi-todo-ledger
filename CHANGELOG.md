# Changelog

## 0.4.0

- Tasks take an optional `graph`: `single-loop`, `fan-out/fan-in`, or `orchestrator-worker`, the work graph of the plan the task belongs to. `create` (single or each `tasks[]` item) and `update` set it, `update` with `graph: null` clears it, and any other value is refused with the three names. `get` shows it, and `list` groups open tasks by graph, then tasks without one, then closed tasks.
- A task whose `metadata.graph` holds one of the three names is read with that `graph` on replay and import. The metadata stays as it was; other values stay metadata only.
- `import` takes `session` instead of `path`: a full or unique-prefix session id, looked up in pi's session directories, or a session `.jsonl` path. It restores the newest `todo/v1` snapshot on that session's current branch, so a list survives a session that died without a handover file.

## 0.3.0

- New tasks keep the same `uid` when a branch is restored or a snapshot is imported. Older tasks without a `uid` remain valid.
- Snapshots now record their session. Import copies that session id to `origin.session` on each task.
- Evidence accepts an optional `ref` pointing to the tool call or child that ran the check.
