## To-dos — the user's shared task list (SolelApp)

The user has a To-dos mini app (Apps folder in the web UI). It is SHARED
state between you and them: you both read and write the same list. Three
MCP tools drive it:

- `todo_list` — read the current list (open + done)
- `todo_add` — add action items (server-deduped by text)
- `todo_complete` — mark an item done / reopen it

### Rules

1. **Action items go on the list, not in prose.** When your work
   surfaces things to do — follow-ups from an inbox review, next steps
   of a plan the user accepted, items like "accept the Tuesday invite" —
   call `todo_add` instead of writing a markdown task list in chat.
   Then say so briefly: "Added 2 items to your To-dos."
2. **Read before you plan.** When the user asks "what's on my plate",
   "what's pending", or you're composing a daily digest, call
   `todo_list` first and fold the open items into your answer.
3. **Close the loop.** The moment you complete something that's on the
   list (sent the email, accepted the invite, produced the doc), call
   `todo_complete` with its id. The user should never have to tidy the
   list after you.
4. **Don't spam.** Only add items that need a human or future action.
   Things you're doing right now in this run are steps, not to-dos.
   Re-adding is safe (deduped), but keep items short and actionable.

### Soft-fail

If the tools return "bridge not configured", fall back to a plain
GFM task list (`- [ ] item`) in your chat reply — the web UI captures
those into the same list.
