---
name: appless-ui
description: Generate a native mobile app SCREEN on demand instead of a text reply — the AppLess / generative-UI pattern. Use when the user asks to "show", "display", "open a screen/dashboard/app for", "make it a UI/screen", or when a rich visual (dashboard, list, chart, form, gallery, map, chat) fits the answer far better than prose. Renders in generative-UI clients (e.g. the nanoless / AppLess app) via openui-lang.
---

# AppLess UI — generate a screen, not a paragraph

This is the [AppLess](https://openui.com) generative-UI concept, made real for
NanoClaw. AppLess generates a phone screen the instant you ask — but on its own
it has no integrations, so its screens are *plausible fiction*. **You are a
NanoClaw agent with real tools and connected accounts, so your screens are
grounded in the user's ACTUAL data.** That difference is the whole point: a
weather screen shows the real forecast, an inbox screen shows real emails, a
wallet screen shows real transactions.

You respond by emitting **openui-lang** — a compact UI language the client
renders as native iOS/Android components. See `openui-lang.md` (next to this
file) for the full component reference; this file is the contract for *when* and
*how* to use it.

## When to render a screen vs. reply in text

Render a screen when the user asks to **see / show / open / display** something,
or asks for something a screen represents better than a sentence: a dashboard,
a list of items, a chart/trend, a form to fill, a gallery, a map, a chat thread,
a settings page, an itinerary, a receipt. When in doubt and the surface supports
it, prefer the screen.

Reply in normal text (no openui-lang) for conversational turns, confirmations,
clarifying questions, or anything that isn't a "show me" request.

## The rule that makes this real: ground in actual data FIRST

**Before you render, fetch the real data.** Call your tools / connectors
(email, calendar, files, tasks, web search, whatever is connected) to get the
user's actual content, then render *that*. Never invent values when you can
fetch them.

- "show my unread emails" → query the mail connector, render the real senders,
  subjects, times.
- "today's schedule" → read the calendar, render the real events.
- "my spending this month" → pull the real transactions, render real totals in a
  HeroStat + chart + list.

Only fall back to representative/example content when the relevant account isn't
connected or a fetch genuinely returns nothing — and when you do, don't imply it
is real.

## Output contract

When rendering a screen, your **entire message body is openui-lang** — no
greeting, no prose, no explanation, no code fences around it. The renderer parses
the message directly.

1. First line is always `root = Card([...])` so the shell appears immediately.
2. Then component definitions; leaf data last (this streams top-down nicely).
3. Every referenced name must be defined; every defined name (except `root`)
   must be reachable from `root`.
4. Arguments are POSITIONAL, one assignment per line. See `openui-lang.md`.
5. Make tappable rows/buttons carry `Action([@ToAssistant("...")])` describing
   the next screen — taps come back to you as a new request, and you render the
   next screen (grounded in real data again).

## Example

User: "show me my calendar today"
You (after reading the real calendar) emit ONLY:

```
root = Card([header, summary, list])
header = CardHeader("Today", "Wednesday · 3 events")
summary = HeroStat("3", "MEETINGS", "next in 40 min")
list = ListBlock([e1, e2, e3], "SCHEDULE")
e1 = ListItem("Standup", "9:30 – 9:45 AM", "users", "Zoom", Action([@ToAssistant("Open the Standup event: attendees, the Zoom link, and the agenda")]))
e2 = ListItem("Design review", "11:00 AM – 12:00 PM", "pen", "Room 4", Action([@ToAssistant("Open the Design review event: attendees, location and notes")]))
e3 = ListItem("1:1 with Sam", "3:30 – 4:00 PM", "user", null, Action([@ToAssistant("Open the 1:1 with Sam: recent threads and talking points")]))
```

(The header/times/names above would be the **real** ones you read from the
calendar, not these placeholders.)
