# openui-lang reference

The UI language you emit to render a screen. The client parses your message and
renders native components. Read `SKILL.md` for *when* to use this and the rule to
ground screens in the user's real data.

## Syntax rules

1. Each statement on its own line: `identifier = Expression`
2. `root` is the entry point — every program must define `root = Card(...)`.
3. Expressions: strings `"..."`, numbers, booleans, `null`, arrays `[...]`,
   objects `{...}`, or component calls `TypeName(arg1, arg2, ...)`.
4. Use references: define `name = ...` on one line, use `name` later.
5. Every variable except `root` MUST be referenced by another — unreferenced
   variables are silently dropped.
6. Arguments are POSITIONAL (order matters, no names). Write
   `ListBlock([a, b], "TODAY")`, never `ListBlock([a, b], header="TODAY")` —
   colon/named syntax silently breaks.
7. Optional trailing arguments can be omitted. Pass `null` for an unused middle
   slot: `ListItem("Battery", null, "battery-full", "82%", action)`.
8. Assignments are TOP-LEVEL ONLY, one per line. An assignment inside an array is
   a syntax error: NOT `root = Card([x = TextContent("hi")])`.

## Component signatures (`?` = optional)

### Structure
- `Card(children[])` — root of every screen; children stack vertically.
- `CardHeader(title, subtitle?)` — iOS large-title header.
- `TextContent(text, style?)` — style: `small` | `default` | `large` | `small-heavy` | `large-heavy`.
- `TextCallout(variant, title, description?)` — variant: `neutral|info|success|warning|danger`.

### Lists
- `ListBlock(items[], header?)` — inset grouped list; items are ListItem/Toggle; header is an uppercase section label.
- `ListItem(title, subtitle?, leading?, trailing?, action?)` — leading is a lucide icon name (`"wifi"`) or `{src, alt}` thumbnail; trailing is short right-side text (`"82%"`, `"4:32 PM"`); rows with an action get a chevron.
- `Toggle(title, on, icon?, subtitle?)` — settings switch (local state only, no action).
- `KVList(rows[], header?)` — rows are `{label, value}`; for detail facts (order summary, flight info, specs).

### Stats & charts
- `HeroStat(value, label?, sublabel?)` — one huge headline number.
- `StatTiles(items[])` — 2–4 tiles `{label, value, delta?, icon?}`; delta `"+.."` renders green, `"-.."` red.
- `BarChart(labels[], series[], variant?, xLabel?, yLabel?)` / `HorizontalBarChart(...)`
- `LineChart(labels[], series[], variant?, ...)` / `AreaChart(...)` — variant: `linear|natural|step`.
- `PieChart(labels[], values[], variant?, appearance?)` — variant `pie|donut`.
- `Series(category, values[])` — one data series; values count must match labels.

### Media & social
- `ImageBlock(src, caption?)` — full-width hero image.
- `PhotoGrid(images[])` — 3-col grid of `{src, alt}`.
- `Bubbles(messages[])` — chat thread; messages are `{text, me?, time?}` (me:true = right/blue).
- `Chips(labels[])` — filter pills; tapping one regenerates the screen filtered to it (no action needed). Put the active one first.
- `Tabs(items[])` / `TabItem(label, children[])` — segmented control switching content instantly.
- `MapView(placeName, zoom?)` — real interactive map (zoom 12 city, 15 neighborhood, 17 street).

### Forms & buttons
- `Form(name, buttons, fields?)` — input screens only (compose/checkout/search/booking); `buttons` is REQUIRED (a Buttons ref).
- `FormControl(label, input, hint?)`, `Input(name, placeholder?, type?, rules?, value?)`, `TextArea(...)`, `Select(name, items[], ...)`, `SelectItem(value, label)`, `DatePicker(...)`, `Slider(name, variant, min, max, ...)`.
- `Buttons(buttons[], direction?)` / `Button(label, action?, variant?, type?, size?)` — variant `primary|secondary|tertiary`.

## Actions

`Action([@steps...])` wires taps. Steps:
- `@ToAssistant("message")` — sends a message back to you; you render the next screen. Buttons/ListItems without an explicit action auto-send their label.
- `@OpenUrl("https://...")` — open a URL. For cross-app: `@OpenUrl("genos://open?app=APPID&request=...")` (apps: maps, calendar, music, messages, food, flights, banking, fitness, photos, notes, settings, weather).

## Key rules

- **Every tappable element (Button, ListItem) carries `Action([@ToAssistant("...")])`** with a specific description of the destination screen. A screen needs at least 2 distinct `@ToAssistant` actions — a screen with none is a dead end.
- Images use the client image service: `/api/img?q=KEYWORDS&seed=N&w=W&h=H` (hero `w=800&h=440`, thumb `w=200&h=200`).
- Icons are lucide kebab-case: `wifi bluetooth battery-full map-pin calendar clock mail send user users home star credit-card banknote trending-up coffee utensils plane music message-circle bell lock cloud sun` (etc.).
- Keep screens COMPACT: 6–16 statements, one screen of content.
- Dashboard pattern (stats/finance/fitness/weather): HeroStat or StatTiles first, then AT MOST one chart, then a ListBlock.
- Never render Back/Done/Cancel/Home buttons — the OS shell owns navigation. Every button moves FORWARD.
- Streaming: write `root = Card(...)` first, then components, then leaf data last, so the shell appears immediately and fills in top-down.

## Two more examples

Dashboard (grounded in real transactions):
```
root = Card([header, balance, tiles, chart, txTitle, txs])
header = CardHeader("Wallet", "Checking · ··4821")
balance = HeroStat("$8,427.50", "AVAILABLE", "+$1,204 this month")
tiles = StatTiles([{label: "Spent", value: "$2,318", delta: "-12%", icon: "arrow-down-right"}, {label: "Saved", value: "$940", delta: "+8%", icon: "piggy-bank"}])
chart = AreaChart(["Mar", "Apr", "May", "Jun"], [spend], "natural")
spend = Series("Spending", [1890, 2480, 2210, 2318])
txTitle = TextContent("Recent", "large-heavy")
txs = ListBlock([t1, t2])
t1 = ListItem("Blue Bottle Coffee", "Today 9:12 AM", "coffee", "-$6.40", Action([@ToAssistant("Open the Blue Bottle transaction: amount, category, card, and a map of the store")]))
t2 = ListItem("Payroll", "Jul 1", "banknote", "+$5,200", Action([@ToAssistant("Open the payroll deposit: employer, account and date")]))
```

Compose (form + send action):
```
root = Card([header, compose])
header = CardHeader("Reply to Maya")
compose = Form("reply", btns, [msg])
msg = FormControl("Message", input)
input = Input("text", "Message…")
btns = Buttons([send])
send = Button("Send", Action([@ToAssistant("Send the reply and show the updated thread with my message appended")]), "primary")
```
