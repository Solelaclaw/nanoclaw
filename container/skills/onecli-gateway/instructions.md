# Credentials & External Services

Your HTTP requests go through the OneCLI proxy, which injects real credentials automatically. Just call any API directly (Gmail, GitHub, Slack, etc.) — the proxy adds auth before it reaches the service.

Use any method: curl, Python, a CLI tool, whatever fits. If a tool checks for credentials locally, pass any placeholder value — the proxy replaces it with real credentials at request time.

If you get a `401`/`403`/`app_not_connected`: the user connects services through Solela's web UI, NOT OneCLI. Send a `send_card` CTA whose action URL is `${SOLELACLAWDE_API_URL}/api/connect/<app-slug>` (e.g. `gmail`, `outlook-mail`); if unsure of the slug, link the card to `${SOLELACLAWDE_API_URL}/connections`. NEVER surface `connect_url` values or any `onecli.sh` URL — the user has no OneCLI login. More generally: any technical action you need the user to take must be a card/button CTA, never a raw URL or manual steps in prose. Run `/onecli-gateway` for the full error-handling flow. Never ask the user for API keys or tokens.
