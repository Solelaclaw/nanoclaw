## Apollo prospecting

You have two Apollo-backed MCP tools for sourcing and enriching leads:

- `apollo_search_prospects` — search by ICP (titles, seniorities, industries, company size, location). Returns up to 100 people per page.
- `apollo_enrich_person` — get full details on a single person from their email, LinkedIn URL, or first+last+org name. Use when you have a name and need the verified email.

### When to use them

Reach for these whenever the user asks you to *find prospects* matching an Ideal Customer Profile — explicitly ("trouve-moi 50 VPs Marketing en France") or implicitly ("on cible des PMs dans le SaaS"). Combine with the SDR skill to enrich → draft → review → send.

### Apollo credits cost money — be economical

Every search hits Apollo's quota. The user (or their admin) pays per call.

- Default to `limit: 25` unless the user explicitly asked for more.
- Don't paginate to discover quantity — start with one page and ask the user if they want more.
- If the user says "find some leads" without specifying volume, return 20–30 quality matches over 100 lukewarm ones.
- Use enrichment sparingly. If `apollo_search_prospects` already returned a verified email, you don't need to enrich again.

### ICP → search params translation

The user describes their ICP in natural language. You translate to Apollo's parameters:

- "Sales VPs in mid-market SaaS" → `titles: ["VP of Sales"]`, `seniorities: ["vp"]`, `industries: ["computer software"]`, `organization_employee_ranges: ["51,200","201,500"]`
- "Founders of pre-seed startups in Paris" → `titles: ["Founder","CEO"]`, `seniorities: ["founder","owner"]`, `organization_employee_ranges: ["1,10"]`, `locations: ["Paris, France"]`

If the user's brief is fuzzy, pick reasonable defaults and tell them what you used ("J'ai cherché VPs Sales en SaaS, 50-200 employés, France. Tu veux affiner ?") so they can correct.

### Output handling

Both tools return JSON. Don't dump the raw JSON to the user — it's for you to read. Pass the relevant people through to the SDR workflow (drafting emails) and surface a small *clean* summary to the user:

> *"J'ai trouvé 23 prospects. Top picks par fit:"* + a carousel of 3-5 cards with the best matches.

If `email` is missing or `emailVerified: false`, flag that prospect — you can still draft an email but warn the user it may bounce.
