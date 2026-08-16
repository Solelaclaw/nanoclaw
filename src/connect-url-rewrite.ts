/**
 * Outbound URL rewrite — hides OneCLI from the end user, in every
 * channel.
 *
 * The agent (and certain skills) may surface a raw OneCLI dashboard
 * URL when prompting the user to connect a credential:
 *
 *   http://127.0.0.1:10254/connections?connect=gmail
 *   https://gateway.onecli.sh/connections?connect=notion
 *
 * Or an already-proxied URL pointing at our local solelaclawde dev
 * port:
 *
 *   http://localhost:3000/api/connect/gmail
 *
 * Neither shape is fit for a real user to click — the first exposes
 * OneCLI, the second 404s in production. This module normalises both
 * to our public proxy URL:
 *
 *   https://app.solela.ai/api/connect/<app>
 *
 * Called from `delivery.ts` BEFORE the message reaches any channel
 * adapter, so web / WhatsApp / Telegram / Slack / etc. all benefit
 * from one source of truth. Previously this rewrite lived inside
 * `src/channels/web.ts` and only fired for the web channel — which
 * meant WhatsApp users got the raw OneCLI link.
 *
 * Web's card-lift (`promoteOneCliConnectToCard`) still runs
 * downstream and operates on the already-rewritten URL — same
 * regex matches, the host substring just happens to be solela.ai
 * by then.
 *
 * Operates on the raw string content. URLs in JSON-encoded payloads
 * are textual too, so this works for both plain-text messages and
 * structured card content (the regex doesn't care whether it's
 * inside a JSON value or a markdown link).
 */

import { readEnvFile } from './env.js';

/** Public URL of the solelaclawde web app. Reads from the env file
 *  at module load — same source `web.ts` uses, kept in sync via the
 *  shared key name. Falls back to localhost only as a last resort
 *  (dev / local testing without the env file present). */
export const WEB_BASE_URL = (() => {
  const env = readEnvFile(['SOLELACLAWDE_PUBLIC_URL', 'SOLELACLAWDE_WEB_BASE_URL']);
  return (env.SOLELACLAWDE_PUBLIC_URL ?? env.SOLELACLAWDE_WEB_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
})();

/**
 * OneCLI dashboard URL with a `connect=<app>` query — what the agent
 * might naively output when teaching the user to connect a tool.
 * The `g` flag is critical: agents sometimes emit multiple connect
 * links in one message; we rewrite all of them.
 */
const ONECLI_CONNECT_RE_G = /https?:\/\/[^\s)\]"]+\/connections\?[^\s)\]"]*\bconnect=([a-z][a-z0-9-]*)\b[^\s)\]"]*/gi;

/**
 * Localhost or otherwise non-prod proxy URL. Same shape as the
 * destination we're rewriting TO, so we use it to normalise dev/
 * localhost paths up to the prod host. App slug is captured group 1.
 *
 * The exclusion of `app.solela.ai` (and any host matching WEB_BASE_URL)
 * happens implicitly: when the URL is already correct, the rewrite
 * substitutes the same value back. Cost is one extra regex pass per
 * URL — negligible.
 */
const PROXY_CONNECT_RE_G = /https?:\/\/[^\s)\]"]+\/api\/connect\/([a-z][a-z0-9-]*)\b[^\s)\]"]*/gi;

/**
 * Rewrite every OneCLI/proxy connect URL inside `text` to the
 * canonical prod proxy URL. Pure: no side effects, no I/O.
 *
 * Pass plain message bodies, JSON-encoded card content, or anything
 * the channel will eventually transmit. The regex only matches URL
 * shapes so it never touches user text.
 */
export function rewriteConnectUrls(text: string): string {
  if (!text || typeof text !== 'string') return text;
  if (text.indexOf('/connect') < 0 && text.indexOf('connect=') < 0) {
    // Fast path — most messages have no connect URL at all. Avoid
    // running the regex on every outbound message.
    return text;
  }
  return text
    .replace(ONECLI_CONNECT_RE_G, (_match, appId: string) => {
      return `${WEB_BASE_URL}/api/connect/${appId.toLowerCase()}`;
    })
    .replace(PROXY_CONNECT_RE_G, (_match, appId: string) => {
      return `${WEB_BASE_URL}/api/connect/${appId.toLowerCase()}`;
    });
}
