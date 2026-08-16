/**
 * Per-user OneCLI config fetcher.
 *
 * SoleLaClawde V2.4 Phase 2: each web-channel user has their own
 * OneCLI project (`solela-<id>`) + agent (`me`) + a per-agent token
 * that scopes the OneCLI gateway to THAT user's project. With the
 * gateway scoped per-user, the agent container sees:
 *
 *   - the org-level Anthropic secret (auto-applied to every
 *     project, per OneCLI's "org secrets apply across all projects"
 *     model — Cloud only)
 *   - any project-scoped secrets in `solela-<id>` (per-user OAuth
 *     tokens stored by /api/connect/<app> on the web app side)
 *
 * Without a per-user gateway, the host's legacy ONECLI_API_KEY
 * (project-scoped to the shared `solelaClaw` project) would either
 * leak across tenants (if we kept ensureAgent) or strand the user
 * with no credential injection at all (if we skip the gateway).
 *
 * This module fetches the config on demand from the Solela web app's
 * internal endpoint and caches it in process memory. The token never
 * lands on disk — restart of nanoclaw.service clears the cache and
 * forces a fresh fetch on next spawn.
 *
 * Endpoint: GET <SOLELACLAWDE_PUBLIC_URL>/api/internal/agent-onecli-config
 *           ?agentGroupId=<id>
 *           header: X-Solelaclawde-Token: <SOLELACLAWDE_WEB_CHANNEL_TOKEN>
 *
 * The bearer is the same shared secret the web app uses for the
 * outbound bridge to the VM — symmetric trust model.
 */
import { readEnvFile } from './env.js';
import { log } from './log.js';

export interface AgentOneCliConfig {
  projectId: string;
  agentIdentifier: string;
  /** Plaintext per-agent OneCLI access token. Project-scoped by
   * construction — when used as the SDK's `apiKey`, the gateway
   * automatically scopes secret-injection to the user's project. */
  token: string;
}

const FETCH_TIMEOUT_MS = 10_000;

/** Process-local cache. Cleared on service restart, no persistence. */
const cache = new Map<string, AgentOneCliConfig>();
/** In-flight fetch dedup so concurrent wakeContainer calls for the
 * same agent_group_id don't fire N parallel requests. */
const inFlight = new Map<string, Promise<AgentOneCliConfig | null>>();

function getEnv(): { baseUrl: string; bearer: string } | null {
  const env = readEnvFile(['SOLELACLAWDE_PUBLIC_URL', 'SOLELACLAWDE_WEB_BASE_URL', 'SOLELACLAWDE_WEB_CHANNEL_TOKEN']);
  const baseUrl = (
    process.env.SOLELACLAWDE_PUBLIC_URL ??
    env.SOLELACLAWDE_PUBLIC_URL ??
    env.SOLELACLAWDE_WEB_BASE_URL ??
    ''
  ).replace(/\/+$/, '');
  const bearer = process.env.SOLELACLAWDE_WEB_CHANNEL_TOKEN ?? env.SOLELACLAWDE_WEB_CHANNEL_TOKEN;
  if (!baseUrl || !bearer) {
    log.error('[onecli-per-user] missing SOLELACLAWDE_PUBLIC_URL or SOLELACLAWDE_WEB_CHANNEL_TOKEN');
    return null;
  }
  return { baseUrl, bearer };
}

/**
 * Fetch the per-agent OneCLI config for `agentGroupId`. Returns:
 *  - the cached config if present
 *  - a fresh fetched config (and caches it) on success
 *  - null on any failure (missing env, network error, 4xx, 5xx),
 *    after logging — caller decides whether to spawn anyway with a
 *    degraded gateway, or to fail the spawn.
 *
 * Concurrent calls for the same agent_group_id share one in-flight
 * fetch (no thundering herd at startup).
 */
export async function fetchAgentOneCliConfig(agentGroupId: string): Promise<AgentOneCliConfig | null> {
  const hit = cache.get(agentGroupId);
  if (hit) return hit;

  const existing = inFlight.get(agentGroupId);
  if (existing) return existing;

  const promise = (async (): Promise<AgentOneCliConfig | null> => {
    const e = getEnv();
    if (!e) return null;
    const url = new URL('/api/internal/agent-onecli-config', e.baseUrl);
    url.searchParams.set('agentGroupId', agentGroupId);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: { 'X-Solelaclawde-Token': e.bearer },
        signal: controller.signal,
      });
    } catch (err) {
      log.error('[onecli-per-user] fetch failed', { agentGroupId, err });
      return null;
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log.error('[onecli-per-user] non-2xx from web app', {
        agentGroupId,
        status: res.status,
        body: body.slice(0, 200),
      });
      return null;
    }

    let json: AgentOneCliConfig;
    try {
      json = (await res.json()) as AgentOneCliConfig;
    } catch (err) {
      log.error('[onecli-per-user] bad JSON', { agentGroupId, err });
      return null;
    }

    if (!json.projectId || !json.agentIdentifier || !json.token) {
      log.error('[onecli-per-user] incomplete config from web app', { agentGroupId, json });
      return null;
    }

    cache.set(agentGroupId, json);
    return json;
  })();

  inFlight.set(agentGroupId, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(agentGroupId);
  }
}

/** Forget a cached entry — e.g. after a 401 from the OneCLI gateway
 * suggests the token rotated. The next spawn re-fetches. */
export function invalidateAgentOneCliConfig(agentGroupId: string): void {
  cache.delete(agentGroupId);
}
