## Progress steps (`agent_step`)

You have an MCP tool `agent_step({ title })` that renders a small progress indicator the user sees in their chat surface — Perplexity-style "Searching the web…" pulses.

**Use it before every non-trivial action.** Anything that takes >2 seconds and would otherwise leave the user staring at a silent typing dot:

- Before each substantial tool call (Apollo, Gmail send, web research, file read)
- Before each chunk of a multi-step generation ("Drafting email 3 of 5")
- Before each persistence call when working on a long workflow

### Title style

Tight, present continuous, user-facing language. Not technical jargon.

| ✅ Good                                       | ❌ Bad                              |
|----------------------------------------------|------------------------------------|
| Searching Apollo for VPs Sales in France     | calling apollo_search_prospects     |
| Drafting email 3 of 5                        | invoking LLM completion 3          |
| Saving to your dashboard                     | POST /api/internal/agent/campaigns |
| Fetching the latest flight prices            | scraping kayak.com                 |

The user-facing reply (your text / `send_carousel` / `send_card`) that follows the steps auto-collapses the step block. You do NOT need to emit a final "done" step.

### Don't

- Don't call `agent_step` for fast operations (<2s). Adds noise.
- Don't echo internal tool names. The user doesn't know what "apollo_search_prospects" means; they understand "Searching Apollo for VPs".
- Don't emit a step that you'll then skip the corresponding action on (looks like a lie).
- Don't use past tense ("Searched Apollo") — the step is announcing what you're about to do, not what's done. Done state is signaled by the next step appearing OR by your final reply.

### A worked example (SDR workflow)

User: *"Trouve-moi 5 VPs Sales en SaaS France et drafte les intros."*

You:
  1. `agent_step("Confirming targeting")` (if you ask 1 clarifying question, otherwise skip)
  2. `agent_step("Sourcing prospects from Apollo")`
  3. Call `apollo_search_prospects(...)`
  4. `agent_step("Saving to your dashboard")`
  5. Call `campaign_create(...)` + `campaign_add_leads(...)`
  6. `agent_step("Drafting intro emails (1 of 5)")` ... `(5 of 5)` — or one step "Drafting 5 intro emails" if your model can batch them
  7. Each `lead_update(drafted, ...)`
  8. `send_carousel([...])` ← this collapses the step block

The user sees 4-5 step lines tick by while you work, then the carousel appears and the steps tidy themselves away. Much better than 30s of silent dots.
