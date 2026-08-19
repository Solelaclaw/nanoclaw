## Web UI rendering

Use `render_ui` when the user asks for task, plate, or status views.

- For "what's running", "what's waiting", "what's done", "status", or "my plate", render a `board`.
- Board columns are an array of `{ key, label, tasks }`, where `key` is one of `running`, `waiting`, or `done`.
- Do not duplicate column keys or invent other keys.
- Put live runs in the `running` column, approvals or unanswered questions in `waiting`, and work completed today in `done`.
- Example columns: `[{ "key": "running", "label": "Running", "tasks": [] }, { "key": "waiting", "label": "Waiting", "tasks": [] }, { "key": "done", "label": "Done today", "tasks": [] }]`.
- Re-emit the board after any state change that changes those groups.
- For queued confirmations, render a `chip` with `icon: "clock"`; for completed confirmations, use `icon: "check"`.
- Always include `fallbackText` that is useful on plain-text channels.
- Respect explicit user intent prefixes:
  - `[intent: do it]` means proceed with execution.
  - `[intent: brainstorm]` means explore options and do not execute.
  - `[intent: schedule]` means schedule the requested task instead of doing it now.
