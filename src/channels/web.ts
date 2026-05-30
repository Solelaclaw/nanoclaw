/**
 * Web channel — exposes NanoClaw to a multi-user web app via HTTP + SSE.
 *
 * Companion to the `cli` channel: same dispatch shape, but the transport is a
 * local HTTP server bound to 127.0.0.1 (the web app proxies to it). The web
 * app does two things against this server:
 *
 *   POST /messages              — write one inbound chat from a user
 *     headers:  X-Solelaclawde-Token: <SOLELACLAWDE_WEB_CHANNEL_TOKEN>
 *     body:     { userId: string, text: string,
 *                 displayName?: string, threadId?: string|null }
 *     returns:  { id: string }            (the platform_id that routed it)
 *
 *   GET  /stream/:userId        — long-lived SSE: agent replies for that user
 *     headers:  Authorization: Bearer <SOLELACLAWDE_WEB_CHANNEL_TOKEN>
 *     emits:    `data: {"text": "..."}\n\n`
 *               `data: {"typing": true}\n\n`            (when adapter.setTyping fires)
 *
 *   POST /admin/route           — admin-transport injection (mirrors cli `to`)
 *     body:     { to: DeliveryAddress, replyTo?: DeliveryAddress, text: string,
 *                 sender?: string, senderId?: string }
 *
 *   GET  /health                — { ok: true }
 *
 * platform_id convention: each web user has a stable id `web:<userId>`. The
 * router uses (channelType=web, platform_id=web:<userId>) as the messaging
 * group key; pair it with a per-user agent_group in `messaging_group_agents`
 * to give every user their own container + memory.
 *
 * Replies fan out to every SSE client subscribed to that userId — opening the
 * site in two tabs delivers to both, no stealing. If no client is connected,
 * the outbound row stays in outbound.db and the next connect re-reads it via
 * the web app's own chat history pull (the web app is the source of truth for
 * shown history, not the SSE stream).
 *
 * Security: bound to 127.0.0.1 only. The shared bearer token is required on
 * every request — the web app and NanoClaw share it via env, and nothing else
 * on the host is supposed to talk to this port. Putting this on a public
 * interface without a real auth layer would let anyone impersonate any user.
 */
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';

import BetterSqlite3 from 'better-sqlite3';
import qrcode from 'qrcode';

import { log } from '../log.js';
import { WEB_BASE_URL } from '../connect-url-rewrite.js';
import { readEnvFile } from '../env.js';
import { DATA_DIR, GROUPS_DIR } from '../config.js';

/** NanoClaw doesn't export its project root constant, so we reconstruct it
 * from GROUPS_DIR (which is `<root>/groups/`). Used when spawning the
 * Baileys pairing script — it expects cwd at the host checkout. */
const PROJECT_ROOT = path.dirname(GROUPS_DIR);
import { getDb } from '../db/connection.js';
import { createAgentGroup, getAgentGroup, getAgentGroupByFolder } from '../db/agent-groups.js';
import {
  createContainerConfig,
  deleteContainerConfig,
  ensureContainerConfig,
  getContainerConfig,
  updateContainerConfigJson,
  updateContainerConfigScalars,
} from '../db/container-configs.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroup,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
  setMessagingGroupDeniedAt,
  updateMessagingGroup,
} from '../db/messaging-groups.js';
import { initGroupFilesystem } from '../group-init.js';
import { restartAgentGroupContainers } from '../container-restart.js';
import { addMember } from '../modules/permissions/db/agent-group-members.js';
import {
  deletePendingChannelApproval,
  getPendingChannelApproval,
} from '../modules/permissions/db/pending-channel-approvals.js';
import { deletePendingSenderApproval } from '../modules/permissions/db/pending-sender-approvals.js';
import { upsertUser } from '../modules/permissions/db/users.js';
import { routeInbound } from '../router.js';
import { resolveSession } from '../session-manager.js';
import { wakeContainer } from '../container-runner.js';
import type { ChannelAdapter, ChannelSetup, DeliveryAddress, InboundEvent, OutboundMessage } from './adapter.js';
import { getRegisteredChannelNames, registerChannelAdapter } from './channel-registry.js';

const CHANNEL_TYPE = 'web';
const DEFAULT_PORT = 11000;
const DEFAULT_HOST = '127.0.0.1';

// WEB_BASE_URL imported at top alongside the other module-scope
// imports — kept as the host-wide single source of truth so this
// channel's card-lift uses the exact same value as
// delivery.ts's rewriteConnectUrls.

/**
 * Folder name of the "template" agent group whose filesystem + container
 * config are copied to every new user's agent on signup. Mirrors NanoClaw's
 * own "init-first-agent" pattern but applied per-web-user. If unset or the
 * target folder doesn't exist, provisioning falls back to the default
 * scaffold (initGroupFilesystem with a baked-in instructions string).
 */
const TEMPLATE_AGENT_FOLDER =
  readEnvFile(['SOLELACLAWDE_TEMPLATE_AGENT_FOLDER']).SOLELACLAWDE_TEMPLATE_AGENT_FOLDER ?? '_template';

interface SseClient {
  res: http.ServerResponse;
  userId: string;
}

function platformIdFor(userId: string): string {
  return `web:${userId}`;
}

/**
 * Sanitize a skill slug for use as a folder name. Filesystem-safe subset
 * (lowercase alnum + hyphens), no path separators, no leading/trailing
 * hyphens. Empty when input doesn't reduce to anything valid.
 */
function sanitizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/**
 * Render a skill row into the SKILL.md format the container agent
 * consumes — frontmatter with name + description, then the markdown body.
 * Mirrors the Anthropic Skills pattern (pptx, docx, etc.).
 */
function renderSkillMd(s: { slug: string; name: string; description: string; body: string }): string {
  const fmName = s.name.replace(/[\r\n]+/g, ' ').trim() || s.slug;
  const fmDescription = s.description.replace(/[\r\n]+/g, ' ').trim();
  return `---\nname: ${fmName}\ndescription: ${fmDescription}\n---\n\n${s.body.trim()}\n`;
}

function userIdFromPlatformId(platformId: string): string | null {
  if (!platformId.startsWith('web:')) return null;
  return platformId.slice(4);
}

/** Friendly labels for channel types that NanoClaw can register. Falls back
 * to the raw type when a label isn't listed (e.g. for newly added channels
 * we haven't seen yet). */
const CHANNEL_LABELS: Record<string, string> = {
  cli: 'Terminal',
  web: 'Web chat',
  telegram: 'Telegram',
  discord: 'Discord',
  slack: 'Slack',
  whatsapp: 'WhatsApp',
  imessage: 'iMessage',
  matrix: 'Matrix',
  signal: 'Signal',
  github: 'GitHub',
  linear: 'Linear',
  teams: 'Microsoft Teams',
  webex: 'Webex',
  gchat: 'Google Chat',
  resend: 'Email (Resend)',
  emacs: 'Emacs',
  deltachat: 'DeltaChat',
  wechat: 'WeChat',
};

/** Channels with end-user pairing flows we've built. The rest are listed
 * but marked "Coming soon" until each gets a dedicated connect handler.
 *
 * Adding an entry here is the wire that makes the UI show a "Connect" button
 * on `/channels` — the actual pairing endpoint must also exist under
 * `/admin/channels/<type>/connect`. */
const USER_SELF_CONNECT_CHANNELS = new Set<string>(['whatsapp']);

/** Files in the template group folder that are operator-curated and should
 * be cloned to every new user's agent. Symlinks and the composed CLAUDE.md
 * are skipped — initGroupFilesystem regenerates them per-group at spawn. */
const TEMPLATE_CLONE_FILES = new Set([
  'CLAUDE.local.md', // primary: the per-agent persona + memory
  'memory.json', // optional: structured memory if the operator added one
]);

/**
 * Copy operator-curated content from the template folder to the new user's
 * agent group folder. Safe to call after initGroupFilesystem has scaffolded
 * the standard layout — we only overwrite the files listed in
 * TEMPLATE_CLONE_FILES plus any custom skills the operator dropped into
 * `skills/` (the standard skill symlinks installed by initGroupFilesystem
 * resolve in-container, so co-locating fork-specific markdown skills works).
 */
function cloneAgentGroupContent(sourceFolder: string, targetFolder: string): void {
  const sourceDir = path.join(GROUPS_DIR, sourceFolder);
  const targetDir = path.join(GROUPS_DIR, targetFolder);
  if (!fs.existsSync(sourceDir) || !fs.existsSync(targetDir)) return;

  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    if (entry.name === 'CLAUDE.md') continue; // regenerated at spawn time
    if (entry.name === 'container.json') continue; // regenerated from container_configs
    if (entry.name.startsWith('.claude-')) continue; // host-managed fragments + shared

    const src = path.join(sourceDir, entry.name);
    const dst = path.join(targetDir, entry.name);

    if (entry.isFile() && TEMPLATE_CLONE_FILES.has(entry.name)) {
      try {
        // Substitute env-driven placeholders in text templates. Keeps the
        // template environment-agnostic; cloned CLAUDE.local.md gets the
        // current host's URLs baked in.
        const raw = fs.readFileSync(src, 'utf-8');
        const substituted = raw.replaceAll('{{PUBLIC_URL}}', WEB_BASE_URL);
        fs.writeFileSync(dst, substituted);
      } catch (err) {
        log.warn('Template clone: failed to copy file', { entry: entry.name, err });
      }
      continue;
    }

    if (entry.isDirectory() && entry.name === 'skills') {
      copyDirectoryRecursive(src, dst);
      continue;
    }
  }
}

function copyDirectoryRecursive(srcDir: string, dstDir: string): void {
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(dstDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const s = path.join(srcDir, entry.name);
    const d = path.join(dstDir, entry.name);
    if (entry.isDirectory()) copyDirectoryRecursive(s, d);
    else if (entry.isFile()) {
      // Don't overwrite a file that already exists (e.g. a default symlink
      // the host wired up). Custom files-only from the template land here.
      if (fs.existsSync(d)) continue;
      fs.copyFileSync(s, d);
    }
  }
}

/**
 * Replicate the template's container_configs row onto the new agent group.
 * initGroupFilesystem already inserted a default row via ensureContainerConfig,
 * so we delete + reinsert with the template's values. The agent_group_id PK
 * comes from the new group; everything else is inherited so packages, mcp
 * servers, image_tag, skills allowlist, etc. all flow through.
 */
function cloneContainerConfig(sourceAgentGroupId: string, targetAgentGroupId: string, now: string): void {
  const source = getContainerConfig(sourceAgentGroupId);
  if (!source) return;
  try {
    deleteContainerConfig(targetAgentGroupId);
    createContainerConfig({
      ...source,
      agent_group_id: targetAgentGroupId,
      updated_at: now,
    });
  } catch (err) {
    log.warn('Template clone: container_config replication failed', { err });
  }
}

/** Friendly labels for OneCLI app-ids the agent is most likely to suggest. */
const APP_LABELS: Record<string, string> = {
  gmail: 'Gmail',
  'google-calendar': 'Google Calendar',
  'google-drive': 'Google Drive',
  'google-docs': 'Google Docs',
  'google-sheets': 'Google Sheets',
  'google-slides': 'Google Slides',
  'google-tasks': 'Google Tasks',
  youtube: 'YouTube',
  notion: 'Notion',
  github: 'GitHub',
  jira: 'Jira',
  confluence: 'Confluence',
  linear: 'Linear',
  slack: 'Slack',
  todoist: 'Todoist',
};

/**
 * In-memory state for the operator's WhatsApp pairing flow. Lives at module
 * scope so the admin UI can poll a single endpoint and pick up every QR
 * rotation Baileys produces — the underlying script regenerates the QR every
 * ~20s and we stream them as they arrive.
 */
type PairStatus = 'idle' | 'pending' | 'paired' | 'failed';
interface WhatsAppPairState {
  status: PairStatus;
  /** Latest QR as a data URL (image/png base64) ready to drop into <img src>. */
  qrDataUrl: string | null;
  phone: string | null;
  errorMessage: string | null;
  updatedAt: string;
}
let pairState: WhatsAppPairState = {
  status: 'idle',
  qrDataUrl: null,
  phone: null,
  errorMessage: null,
  updatedAt: new Date().toISOString(),
};
let pairProcess: ChildProcess | null = null;

/**
 * Parse one stdout line from the pairing script. Three signals matter:
 *
 *   `QR: <data>`                 → render to a PNG data URL and stash
 *   `STATUS: success`            → terminal: paired
 *   `STATUS: failed` / ERROR     → terminal: failed (TTL or rejection)
 *
 * Everything else is informational and ignored.
 */
async function handlePairLine(line: string): Promise<void> {
  if (line.startsWith('QR: ')) {
    const data = line.slice(4).trim();
    try {
      const dataUrl = await qrcode.toDataURL(data, { width: 400, margin: 2 });
      pairState = {
        ...pairState,
        status: 'pending',
        qrDataUrl: dataUrl,
        updatedAt: new Date().toISOString(),
      };
    } catch (err) {
      log.warn('WhatsApp pair: QR render failed', { err });
    }
    return;
  }
  if (line.startsWith('STATUS: success')) {
    pairState = {
      status: 'paired',
      qrDataUrl: null,
      phone: pairState.phone,
      errorMessage: null,
      updatedAt: new Date().toISOString(),
    };
    return;
  }
  if (line.startsWith('STATUS: failed') || line.startsWith('ERROR: ')) {
    pairState = {
      ...pairState,
      status: 'failed',
      qrDataUrl: null,
      errorMessage: line.startsWith('ERROR: ') ? line.slice('ERROR: '.length) : 'pairing failed',
      updatedAt: new Date().toISOString(),
    };
  }
}

/** Recognized URL shapes the agent might emit pointing at a connect flow:
 *   - `http://<host>:10254/connections?connect=gmail`  (OneCLI dashboard — raw)
 *   - `http://localhost:3000/api/connect/gmail`         (our proxy — already shaped)
 * Both are normalized to a card pointing at our proxy so the end user never
 * sees an OneCLI URL. */
const ONECLI_CONNECT_RE = /https?:\/\/[^\s)\]]+\/connections\?[^\s)\]]*\bconnect=([a-z][a-z0-9-]*)\b[^\s)\]]*/i;
const PROXY_CONNECT_RE = /https?:\/\/[^\s)\]]+\/api\/connect\/([a-z][a-z0-9-]*)\b[^\s)\]]*/i;

/**
 * Lift any connect URL hidden inside prose into a structured Card payload.
 * Always rewrites the action URL to our `/api/connect/<app>` proxy — the
 * end-user UI must never expose the OneCLI dashboard. Returns null when the
 * text doesn't contain a recognised connect URL.
 *
 * The agent's prose becomes the card's description with the URL line removed
 * so we don't show the raw URL twice. App slug → friendly label via the
 * APP_LABELS table; unknown apps fall back to the slug itself.
 */
function promoteOneCliConnectToCard(text: string): { card: Record<string, unknown>; fallbackText: string } | null {
  // Match either shape; carry the originating regex so we can strip its
  // matched text from the description without re-running detection.
  let appId: string | undefined;
  let matchedRe: RegExp | undefined;
  const oc = text.match(ONECLI_CONNECT_RE);
  if (oc) {
    appId = oc[1].toLowerCase();
    matchedRe = ONECLI_CONNECT_RE;
  } else {
    const px = text.match(PROXY_CONNECT_RE);
    if (px) {
      appId = px[1].toLowerCase();
      matchedRe = PROXY_CONNECT_RE;
    }
  }
  if (!appId || !matchedRe) return null;

  const label = APP_LABELS[appId] ?? appId.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  // The action URL ALWAYS points to our proxy. Whatever OneCLI URL the agent
  // surfaced gets discarded — we don't want the user clicking through to the
  // OneCLI dashboard. Base URL comes from env so dev and prod work the same
  // way; falls back to localhost:3000 only as a last resort.
  const proxyUrl = `${WEB_BASE_URL}/api/connect/${appId}`;

  const description =
    text
      .replace(ONECLI_CONNECT_RE, '')
      .replace(PROXY_CONNECT_RE, '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s*[:;,]\s*$/g, '')
      .trim() || `I need ${label} access to do that. Click below — your credentials stay private.`;

  return {
    card: {
      title: `Connect ${label}`,
      description,
      actions: [{ label: `Connect ${label}`, url: proxyUrl, style: 'primary' }],
    },
    fallbackText: `Connect ${label}: ${proxyUrl}`,
  };
}

function extractText(message: OutboundMessage): string | null {
  const content = message.content as Record<string, unknown> | string | undefined;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object') {
    if (typeof content.markdown === 'string') return content.markdown;
    if (typeof content.text === 'string') return content.text;
  }
  return null;
}

function parseAddress(raw: unknown): DeliveryAddress | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.channelType !== 'string' || typeof obj.platformId !== 'string') return null;
  const threadId =
    obj.threadId === null || obj.threadId === undefined ? null : typeof obj.threadId === 'string' ? obj.threadId : null;
  return { channelType: obj.channelType, platformId: obj.platformId, threadId };
}

function createAdapter(): ChannelAdapter | null {
  // NanoClaw deliberately does NOT load .env into process.env (see src/env.ts
  // header) — read directly from the file via readEnvFile to match the
  // convention used everywhere else in the host.
  const env = readEnvFile([
    'SOLELACLAWDE_WEB_CHANNEL_TOKEN',
    'SOLELACLAWDE_WEB_CHANNEL_PORT',
    'SOLELACLAWDE_WEB_CHANNEL_HOST',
  ]);
  const token = env.SOLELACLAWDE_WEB_CHANNEL_TOKEN;
  if (!token) {
    // Returning null tells the registry to skip the channel — matches the
    // "credentials missing → silent skip" convention used by other channels.
    return null;
  }
  const port = Number(env.SOLELACLAWDE_WEB_CHANNEL_PORT) || DEFAULT_PORT;
  const host = env.SOLELACLAWDE_WEB_CHANNEL_HOST || DEFAULT_HOST;

  let server: http.Server | null = null;
  const clientsByUser = new Map<string, Set<SseClient>>();

  function addClient(userId: string, client: SseClient): void {
    let set = clientsByUser.get(userId);
    if (!set) {
      set = new Set();
      clientsByUser.set(userId, set);
    }
    set.add(client);
  }

  function removeClient(userId: string, client: SseClient): void {
    const set = clientsByUser.get(userId);
    if (!set) return;
    set.delete(client);
    if (set.size === 0) clientsByUser.delete(userId);
  }

  function broadcast(userId: string, payload: Record<string, unknown>): void {
    const set = clientsByUser.get(userId);
    if (!set || set.size === 0) return;
    const line = `data: ${JSON.stringify(payload)}\n\n`;
    for (const client of set) {
      try {
        client.res.write(line);
      } catch (err) {
        log.warn('Failed to write to web SSE client', { userId, err });
      }
    }
  }

  function checkAuth(req: http.IncomingMessage): boolean {
    const header = req.headers['x-solelaclawde-token'] ?? req.headers.authorization;
    if (!header) return false;
    const value = Array.isArray(header) ? header[0] : header;
    if (!value) return false;
    const presented = value.startsWith('Bearer ') ? value.slice(7) : value;
    return presented === token;
  }

  async function readJsonBody(req: http.IncomingMessage, limit = 1024 * 1024): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      req.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > limit) {
          reject(new Error('payload too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch (err) {
          reject(err);
        }
      });
      req.on('error', reject);
    });
  }

  function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  const adapter: ChannelAdapter = {
    name: 'web',
    channelType: CHANNEL_TYPE,
    supportsThreads: false,

    async setup(config: ChannelSetup): Promise<void> {
      server = http.createServer((req, res) => {
        const url = req.url ?? '/';

        if (req.method === 'GET' && url === '/health') {
          writeJson(res, 200, { ok: true });
          return;
        }

        if (!checkAuth(req)) {
          writeJson(res, 401, { error: 'unauthorized' });
          return;
        }

        if (req.method === 'POST' && url === '/messages') {
          void handleInbound(req, res, config);
          return;
        }

        if (req.method === 'POST' && url === '/admin/route') {
          void handleAdminRoute(req, res, config);
          return;
        }

        if (req.method === 'POST' && url === '/admin/provision') {
          void handleProvision(req, res);
          return;
        }

        if (req.method === 'GET' && url === '/admin/channels') {
          handleChannels(res);
          return;
        }

        if (req.method === 'GET' && url.startsWith('/admin/chat-history')) {
          handleChatHistory(res, url);
          return;
        }

        if (req.method === 'GET' && url.startsWith('/admin/contacts')) {
          handleContactsFromMemory(res, url);
          return;
        }

        if (req.method === 'GET' && url.startsWith('/admin/agent-activity')) {
          handleAgentActivity(res, url);
          return;
        }

        if (req.method === 'GET' && url.startsWith('/admin/agent-usage')) {
          handleAgentUsage(res, url);
          return;
        }

        if (req.method === 'GET' && url.startsWith('/admin/channel-status')) {
          handleChannelStatus(res, url);
          return;
        }

        if (req.method === 'GET' && (url === '/admin/channels/links' || url.startsWith('/admin/channels/links?'))) {
          handleChannelLinks(res, url);
          return;
        }

        if (req.method === 'POST' && url === '/admin/channels/whatsapp/connect') {
          void handleWhatsAppConnect(req, res);
          return;
        }

        if (req.method === 'POST' && url === '/admin/channels/whatsapp/claim-link') {
          void handleWhatsAppClaimLink(req, res);
          return;
        }

        if (req.method === 'POST' && url === '/admin/channels/telegram/claim-link') {
          void handleTelegramClaimLink(req, res);
          return;
        }

        if (req.method === 'POST' && url === '/admin/channels/whatsapp/pair-start') {
          void handleWhatsAppPairStart(req, res);
          return;
        }

        if (req.method === 'GET' && url === '/admin/channels/whatsapp/pair-status') {
          handleWhatsAppPairStatus(res);
          return;
        }

        // V2 inbox surface — orchestrates the web app's `/inbox` view.
        if (
          req.method === 'GET' &&
          (url === '/admin/pending-approvals' || url.startsWith('/admin/pending-approvals?'))
        ) {
          handleListPendingApprovals(res, url);
          return;
        }

        if (req.method === 'POST' && url === '/admin/pending-approvals/decide') {
          void handleDecidePendingApproval(req, res);
          return;
        }

        // SoleLaClawde — pre-warm the user's web-channel container so
        // the FIRST chat message doesn't pay the full ~6-11s cold-start
        // (docker spawn + agent-runner Bun init + Claude SDK warmup).
        // Fired by the web app at the end of onboarding while the user
        // is still navigating, so by the time they actually type their
        // first message the container is already running.
        if (req.method === 'POST' && url === '/admin/wake-container') {
          void handleWakeContainer(req, res);
          return;
        }

        // SoleLaClawde — cascade-delete one user's entire NanoClaw
        // footprint (agent_group, sessions, messaging_groups, users,
        // filesystem). Used by the wipe-user.ts admin script to reset
        // a test account end-to-end.
        if (req.method === 'POST' && url === '/admin/wipe-user') {
          void handleWipeUser(req, res);
          return;
        }

        // V2.2 — enterprise skills sync. POSTed by the web app whenever a
        // skill is created/edited/deleted, or when a member joins/leaves an
        // org, to rewrite the agent's skills/enterprise/ folder.
        {
          const m = url.match(/^\/admin\/agents\/([^/]+)\/skills\/sync$/);
          if (m && req.method === 'POST') {
            void handleSyncAgentSkills(req, res, m[1]);
            return;
          }
        }

        if (req.method === 'GET' && url.startsWith('/stream/')) {
          handleStream(req, res, url);
          return;
        }

        writeJson(res, 404, { error: 'not found' });
      });

      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(port, host, () => {
          log.info('Web channel listening', { host, port });
          resolve();
        });
      });
    },

    async teardown(): Promise<void> {
      for (const set of clientsByUser.values()) {
        for (const client of set) {
          try {
            client.res.end();
          } catch {
            // best-effort
          }
        }
      }
      clientsByUser.clear();
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = null;
      }
    },

    isConnected(): boolean {
      return server !== null;
    },

    async deliver(platformId, _threadId, message: OutboundMessage): Promise<string | undefined> {
      const userId = userIdFromPlatformId(platformId);
      if (!userId) return undefined;
      const content = message.content as Record<string, unknown> | undefined;

      // Step payload — emitted by the agent's `agent_step` MCP tool.
      // Renders as a Perplexity-style progress line in the chat. The
      // chat client groups consecutive steps + auto-collapses the
      // group when the next non-step message arrives.
      if (content && content.type === 'step' && typeof content.title === 'string') {
        broadcast(userId, { step: { title: content.title } });
        return undefined;
      }

      // Card payload — emitted by the agent's send_card MCP tool. Carries
      // title/description plus a list of URL link buttons. The chat UI renders
      // these inline so the user can click straight through to e.g. an OAuth
      // start URL on the OneCLI dashboard, without ever leaving the
      // conversation.
      if (content && content.type === 'card' && content.card) {
        broadcast(userId, { card: content.card, fallbackText: content.fallbackText });
        return undefined;
      }

      // Carousel payload — emitted by the agent's send_carousel MCP tool.
      // Unlike the chat-sdk-bridge which renders one card per message
      // (because most chat platforms don't have a true carousel
      // primitive), the web client renders a horizontal scrollable strip
      // of cards in-line. The full items array goes through unchanged;
      // the renderer in apps/web/src/app/chat/_components/chat-client.tsx
      // owns the visual layout.
      if (content && content.type === 'carousel' && Array.isArray(content.items)) {
        broadcast(userId, {
          carousel: content.items,
          fallbackText: content.fallbackText,
        });
        return undefined;
      }

      const text = extractText(message);
      if (text === null) return undefined;

      // Server-side fallback: even when our CLAUDE.local.md tells the agent
      // to use send_card for OneCLI connect URLs, the model sometimes prefers
      // a friendly prose reply with the URL inline ("Please connect Gmail
      // here: http://..."). Plain text URLs don't render as clickable buttons
      // in our chat UI, so the user is stuck. Detect the OneCLI connect URL
      // pattern, lift it into a card payload, and broadcast that instead.
      // The text without the URL becomes the card's description so we don't
      // lose context.
      const promoted = promoteOneCliConnectToCard(text);
      if (promoted) {
        broadcast(userId, { card: promoted.card, fallbackText: promoted.fallbackText });
        return undefined;
      }

      broadcast(userId, { text });
      return undefined;
    },

    async setTyping(platformId: string): Promise<void> {
      const userId = userIdFromPlatformId(platformId);
      if (!userId) return;
      broadcast(userId, { typing: true });
    },
  };

  async function handleInbound(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    config: ChannelSetup,
  ): Promise<void> {
    let body: { userId?: unknown; text?: unknown; displayName?: unknown; threadId?: unknown };
    try {
      body = (await readJsonBody(req)) as typeof body;
    } catch (err) {
      writeJson(res, 400, { error: 'invalid json', detail: (err as Error).message });
      return;
    }
    if (typeof body.userId !== 'string' || !body.userId) {
      writeJson(res, 400, { error: 'userId required' });
      return;
    }
    if (typeof body.text !== 'string' || !body.text) {
      writeJson(res, 400, { error: 'text required' });
      return;
    }
    const userId = body.userId;
    const platformId = platformIdFor(userId);
    const displayName = typeof body.displayName === 'string' ? body.displayName : userId;
    const threadId = typeof body.threadId === 'string' ? body.threadId : null;

    try {
      await config.onInbound(platformId, threadId, {
        id: `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'chat',
        timestamp: new Date().toISOString(),
        // DMs are always mentions — same convention as the chat-sdk bridge's
        // onDirectMessage handler. Skipping this would make the router fall
        // back to text-match against the agent's display name.
        isMention: true,
        isGroup: false,
        content: {
          text: body.text,
          sender: displayName,
          senderId: `web:${userId}`,
        },
      });
      writeJson(res, 202, { id: platformId });
    } catch (err) {
      log.error('Web channel inbound failed', { err });
      writeJson(res, 500, { error: 'inbound failed' });
    }
  }

  async function handleAdminRoute(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    config: ChannelSetup,
  ): Promise<void> {
    let body: { to?: unknown; replyTo?: unknown; text?: unknown; sender?: unknown; senderId?: unknown };
    try {
      body = (await readJsonBody(req)) as typeof body;
    } catch (err) {
      writeJson(res, 400, { error: 'invalid json', detail: (err as Error).message });
      return;
    }
    const to = parseAddress(body.to);
    if (!to) {
      writeJson(res, 400, { error: 'to address invalid' });
      return;
    }
    if (typeof body.text !== 'string' || !body.text) {
      writeJson(res, 400, { error: 'text required' });
      return;
    }
    const event: InboundEvent = {
      channelType: to.channelType,
      platformId: to.platformId,
      threadId: to.threadId,
      message: {
        id: `web-admin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'chat',
        timestamp: new Date().toISOString(),
        content: JSON.stringify({
          text: body.text,
          sender: typeof body.sender === 'string' ? body.sender : 'web-admin',
          senderId: typeof body.senderId === 'string' ? body.senderId : 'web-admin',
        }),
      },
      replyTo: parseAddress(body.replyTo) ?? undefined,
    };
    try {
      await config.onInboundEvent(event);
      writeJson(res, 202, { ok: true });
    } catch (err) {
      log.error('Web channel admin route failed', { err });
      writeJson(res, 500, { error: 'route failed' });
    }
  }

  async function handleProvision(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: {
      userId?: unknown;
      displayName?: unknown;
      agentName?: unknown;
      instructions?: unknown;
      /** Optional per-agent container skill whitelist (V2.6+).
       *
       * When provided, the caller (solelaclawde web app) is choosing the
       * exact set of container/skills/* to enable for this agent —
       * e.g. Pro agents in a business org get the SDR + utility set,
       * Personal users get the personal-assistant + utility set.
       *
       * When omitted, the agent's container_config keeps its default
       * (currently `"all"` — every container skill is enabled).
       * Solelaclawde is responsible for sending the right list at
       * provision time based on Organization.kind. */
      skills?: unknown;
      /** V3 marketplace — author-authored skill body and persona for
       *  agents provisioned from a Solela marketplace template. Both
       *  optional; stored on container_configs and inlined into the
       *  agent's CLAUDE.md at every spawn (see
       *  src/claude-md-compose.ts). When omitted, the agent uses
       *  only the built-in skill set from `skills` above + the
       *  default `instructions` body. */
      customSkillMarkdown?: unknown;
      customPersona?: unknown;
    };
    try {
      body = (await readJsonBody(req)) as typeof body;
    } catch (err) {
      writeJson(res, 400, { error: 'invalid json', detail: (err as Error).message });
      return;
    }
    if (typeof body.userId !== 'string' || !body.userId) {
      writeJson(res, 400, { error: 'userId required' });
      return;
    }
    const userId = body.userId;
    const displayName = (typeof body.displayName === 'string' && body.displayName) || userId;
    const agentName = (typeof body.agentName === 'string' && body.agentName.trim()) || `${displayName}'s assistant`;

    // Validate skills if provided — must be an array of non-empty strings.
    // Rejecting malformed input here surfaces a clear error to the caller
    // rather than silently corrupting the container_config.
    let skills: string[] | undefined;
    if (body.skills !== undefined) {
      if (!Array.isArray(body.skills) || body.skills.some((s) => typeof s !== 'string' || !s.trim())) {
        writeJson(res, 400, { error: 'skills must be an array of non-empty strings' });
        return;
      }
      skills = body.skills as string[];
    }

    // V3 marketplace — validate the custom skill body + persona.
    let customSkillMarkdown: string | undefined;
    if (body.customSkillMarkdown !== undefined) {
      if (typeof body.customSkillMarkdown !== 'string') {
        writeJson(res, 400, { error: 'customSkillMarkdown must be a string' });
        return;
      }
      // Cap at 20KB — the same limit the marketplace's Prisma schema
      // enforces. Anything beyond is almost certainly an injection.
      if (body.customSkillMarkdown.length > 20000) {
        writeJson(res, 400, { error: 'customSkillMarkdown exceeds 20000 chars' });
        return;
      }
      customSkillMarkdown = body.customSkillMarkdown;
    }
    let customPersona: string | undefined;
    if (body.customPersona !== undefined) {
      if (typeof body.customPersona !== 'string') {
        writeJson(res, 400, { error: 'customPersona must be a string' });
        return;
      }
      if (body.customPersona.length > 4000) {
        writeJson(res, 400, { error: 'customPersona exceeds 4000 chars' });
        return;
      }
      customPersona = body.customPersona;
    }
    // Per-user instructions teach the agent the in-conversation tool-connect
    // pattern: any request that would need an external service maps to a
    // `send_card` call with an OneCLI OAuth start URL. The user clicks
    // through, OneCLI handles OAuth, and the credential is injected via the
    // gateway on the next request — the agent never touches the secret.
    //
    // The prompt is intentionally directive ("you MUST call send_card before
    // attempting") because Claude otherwise tends to politely say "let me
    // try" and then fail silently when the tool isn't installed yet.
    const instructions =
      (typeof body.instructions === 'string' && body.instructions) ||
      [
        `# ${agentName}`,
        '',
        `You are ${agentName}, a personal assistant for ${displayName}.`,
        '',
        'Introduce yourself briefly on the first message, then act as a capable, concise general-purpose assistant.',
        '',
        '## Connecting external tools (IMPORTANT)',
        '',
        'You currently have no external-service MCP tools installed (no Gmail, no Calendar, no Drive, …). When the user asks for anything that would require one of these services, you **MUST**:',
        '',
        '1. Call the `send_card` MCP tool with the schema below — do this BEFORE attempting any other action. Do not ask the user for permission first. Do not say "let me try" — just send the card.',
        '2. After the card is sent, your text reply should be one short line: "I sent you a connection card — click it, then ask me again."',
        '',
        '### Service ↔ app-id mapping',
        '',
        '| User intent | OneCLI `app-id` |',
        '|---|---|',
        '| Send / read email | `gmail` |',
        '| Schedule, list, edit events | `google-calendar` |',
        '| Read / write files in Drive | `google-drive` |',
        '| Edit a Google Doc | `google-docs` |',
        '| Edit a Google Sheet | `google-sheets` |',
        '| YouTube actions | `youtube` |',
        '| Notion pages / databases | `notion` |',
        '| GitHub issues / PRs / code | `github` |',
        '| Jira / Confluence | `jira` / `confluence` |',
        '| Linear | `linear` |',
        '| Slack | `slack` |',
        '| Todoist | `todoist` |',
        '',
        "If the user's intent maps to none of the above, fall back to plain text and explain what you can do.",
        '',
        '### Card schema for `send_card`',
        '',
        '```json',
        '{',
        '  "card": {',
        '    "title": "Connect <Service>",',
        '    "description": "I need access to <Service> so I can <what you were asked to do>. Click below — OneCLI handles the OAuth, so I never see your password.",',
        '    "actions": [',
        '      {',
        '        "label": "Connect <Service>",',
        `        "url": "${WEB_BASE_URL}/api/connect/<app-id>",`,
        '        "style": "primary"',
        '      }',
        '    ]',
        '  },',
        `  "fallbackText": "Connect <Service>: ${WEB_BASE_URL}/api/connect/<app-id>"`,
        '}',
        '```',
        '',
        'Replace `<Service>` with the human name (e.g. "Gmail", "Google Calendar") and `<app-id>` with the slug from the mapping table.',
        '',
        '### Retry behavior',
        '',
        'When the user comes back after connecting:',
        '- If they say "done" / "connected" / similar → retry the original action.',
        '- If the retry still fails ("not connected", "unauthorized"), send the card again — the OAuth may not have completed.',
        '',
        'Never ask the user to paste tokens, API keys, or passwords into the chat.',
      ].join('\n');

    const now = new Date().toISOString();
    const namespacedUserId = `web:${userId}`;
    const platformId = `web:${userId}`;
    const folder = `web-${userId}`.replace(/[^a-zA-Z0-9_-]/g, '-');
    // OneCLI's POST /api/agents requires identifier to match
    // /^[a-z][a-z0-9-]{0,49}$/ — at most 50 chars, lowercase letters / digits /
    // hyphens, starting with a letter. Better-Auth's User.id is a CUID-style
    // mixedCase value that can blow both constraints (length + case). Hash
    // it to a stable 16-hex-char slug so the OneCLI agent identifier is
    // deterministic per user but always within the allowed alphabet.
    const userSlug = `u${crypto.createHash('sha1').update(userId).digest('hex').slice(0, 15)}`;
    const agentGroupId = `ag-web-${userSlug}`;

    try {
      // 1. User row in NanoClaw's central DB. upsertUser is idempotent.
      upsertUser({
        id: namespacedUserId,
        kind: 'web',
        display_name: displayName,
        created_at: now,
      });

      // 2. Agent group + filesystem.
      // Preferred path on FIRST creation: clone the operator-curated template
      // (CLAUDE.local.md, container config, custom skills). Fallback: bare
      // scaffold seeded with the default `instructions` string (used when
      // there's no template yet, e.g. on a fresh install).
      //
      // Returning users skip BOTH paths: their CLAUDE.local.md has accumulated
      // memory and their container_config may have been tuned — we never want
      // to overwrite that. The `isNew` gate below enforces this.
      const template = TEMPLATE_AGENT_FOLDER ? getAgentGroupByFolder(TEMPLATE_AGENT_FOLDER) : undefined;
      let ag = getAgentGroupByFolder(folder);
      const isNew = !ag;
      if (!ag) {
        createAgentGroup({
          id: agentGroupId,
          name: agentName,
          folder,
          agent_provider: template?.agent_provider ?? null,
          created_at: now,
        });
        ag = getAgentGroupByFolder(folder)!;
      }
      initGroupFilesystem(ag, template || !isNew ? undefined : { instructions });

      if (isNew && template && template.id !== ag.id) {
        cloneAgentGroupContent(template.folder, ag.folder);
        cloneContainerConfig(template.id, ag.id, now);
      }

      // V2.6 — apply per-agent skill whitelist if the caller sent one.
      // Overwrites whatever default (or cloned-from-template) the agent
      // started with. Idempotent: passing the same list twice is a no-op.
      // For an EXISTING agent we still apply so admins can re-tune the
      // skill set without re-provisioning the user (covers the case where
      // solelaclawde upgrades an org from personal → business).
      if (skills) {
        ensureContainerConfig(ag.id);
        updateContainerConfigJson(ag.id, 'skills', skills);
      }

      // V3 marketplace — apply the author-authored skill body and persona
      // if the caller provided them. Stored on container_configs and
      // read at every container spawn by composeGroupClaudeMd, which
      // inlines them as CLAUDE.md fragments. Idempotent — re-provisioning
      // an existing agent with new template content updates the values
      // in place (covers "buyer upgrades to a newer template publication").
      //
      // Restart-after-update: composeGroupClaudeMd runs at spawn time,
      // so a warm container keeps its cached CLAUDE.md even after we
      // write the new values to the DB. Without a restart, the next
      // user message uses the OLD skill — the visitor clicks "Use this
      // agent" on solela.ai and thinks it didn't work. Same pattern as
      // the WhatsApp/Telegram pairing flow (lines ~1872, ~2082): when
      // wiring changes invalidate the running container's view of the
      // world, restart immediately so the next message wakes a fresh
      // container that reads the new state. Fire-and-forget — the
      // restart is best-effort, and a slow/failed restart still leaves
      // the next idle-timeout cycle as the fallback.
      if (customSkillMarkdown !== undefined || customPersona !== undefined) {
        ensureContainerConfig(ag.id);
        updateContainerConfigScalars(ag.id, {
          ...(customSkillMarkdown !== undefined ? { custom_skill_md: customSkillMarkdown } : {}),
          ...(customPersona !== undefined ? { custom_persona: customPersona } : {}),
        });
        restartAgentGroupContainers(ag.id, 'marketplace skill/persona updated');
      }

      // 3. Membership row — gives the user access without granting admin.
      // We intentionally do NOT grant owner/admin: web users should not be
      // able to manage other users' groups. The operator running the deploy
      // has owner via init-first-agent on a separate channel (e.g. telegram).
      addMember({
        user_id: namespacedUserId,
        agent_group_id: ag.id,
        added_by: null,
        added_at: now,
      });

      // 4. Messaging group (channel_type='web', platform_id='web:<userId>').
      let mg = getMessagingGroupByPlatform('web', platformId);
      if (!mg) {
        const mgId = `mg-web-${userId}-${Date.now().toString(36)}`;
        createMessagingGroup({
          id: mgId,
          channel_type: 'web',
          platform_id: platformId,
          name: displayName,
          is_group: 0,
          unknown_sender_policy: 'strict',
          created_at: now,
        });
        mg = getMessagingGroupByPlatform('web', platformId)!;
      }

      // 5. Wire mg→ag. DMs match every message (engage_pattern='.').
      const existing = getMessagingGroupAgentByPair(mg.id, ag.id);
      if (!existing) {
        createMessagingGroupAgent({
          id: `mga-${userId}-${Date.now().toString(36)}`,
          messaging_group_id: mg.id,
          agent_group_id: ag.id,
          engage_mode: 'pattern',
          engage_pattern: '.',
          sender_scope: 'all',
          ignored_message_policy: 'drop',
          // 'agent-shared' — one session per agent_group, ALL messaging_groups
          // (web, WhatsApp, Telegram, …) share it. Same memory across channels.
          // The alternative 'shared' (one session per messaging_group) gives
          // the user separate memories per channel, which is wrong for the
          // SoleLaClawde single-assistant-per-user model.
          session_mode: 'agent-shared',
          priority: 0,
          created_at: now,
        });
      }

      writeJson(res, 200, {
        ok: true,
        userId: namespacedUserId,
        agentGroupId: ag.id,
        messagingGroupId: mg.id,
        platformId,
      });
    } catch (err) {
      log.error('Web channel provision failed', { err, userId });
      writeJson(res, 500, { error: 'provision failed', detail: (err as Error).message });
    }
  }

  /**
   * Pre-warm the user's web-channel container so the FIRST chat message
   * doesn't pay the cold-start cost (docker spawn + agent-runner Bun
   * boot + Claude SDK init ≈ 6–11 s the first time).
   *
   * Called by the web app at the end of onboarding (while the user is
   * still going through WhatsApp + tools steps) so by the time they
   * land on /chat and type, the container is already running and the
   * first message is processed in 1–3 s.
   *
   * Idempotent: if the container is already running, `wakeContainer`
   * is a no-op. If the session doesn't exist yet, `resolveSession`
   * creates it on the fly (same path the router takes for an inbound).
   *
   * Body: `{ userId }` — the Supabase user id (the same one passed
   * to /admin/provision). We derive the web messaging_group +
   * agent_group from it.
   *
   * Returns 202 immediately — spawn is fire-and-forget. The caller
   * (web app) shouldn't block on this; it's an optimization hint.
   */
  async function handleWakeContainer(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: { userId?: unknown };
    try {
      body = (await readJsonBody(req)) as typeof body;
    } catch (err) {
      writeJson(res, 400, { error: 'invalid json', detail: (err as Error).message });
      return;
    }
    if (typeof body.userId !== 'string' || !body.userId) {
      writeJson(res, 400, { error: 'userId required' });
      return;
    }
    const userId = body.userId;
    const platformId = platformIdFor(userId);
    const folder = `web-${userId}`.replace(/[^a-zA-Z0-9_-]/g, '-');

    const ag = getAgentGroupByFolder(folder);
    if (!ag) {
      writeJson(res, 404, { error: 'agent group not found', detail: `no agent for ${userId}` });
      return;
    }
    const mg = getMessagingGroupByPlatform('web', platformId);
    if (!mg) {
      writeJson(res, 404, { error: 'web messaging group not found', detail: `no mg for ${platformId}` });
      return;
    }
    // session_mode 'shared' matches the wiring set up by handleProvision
    // (DMs match every message via engage_pattern='.', no threading).
    const { session } = resolveSession(ag.id, mg.id, null, 'shared');

    // Fire-and-forget. wakeContainer returns false on transient spawn
    // failure but never throws — log + 202 either way.
    void wakeContainer(session).then((woke) => {
      if (!woke) {
        log.warn('Pre-warm: wakeContainer returned false', {
          userId,
          agentGroupId: ag.id,
          sessionId: session.id,
        });
      } else {
        log.info('Pre-warm: container waking', {
          userId,
          agentGroupId: ag.id,
          sessionId: session.id,
        });
      }
    });

    writeJson(res, 202, {
      ok: true,
      agentGroupId: ag.id,
      sessionId: session.id,
    });
  }

  /**
   * Cascade-delete every NanoClaw row + filesystem byte tied to one
   * user. Used by the SoleLaClawde admin wipe-user.ts script to reset
   * a test account end-to-end.
   *
   * Body: `{ userId }` — the Supabase user id, same as the rest of
   * the bridge endpoints.
   *
   * Cleanup order (each step is non-fatal: errors are logged + we
   * keep going so a partial state still gets mostly cleaned up):
   *
   *   1. Stop any running container for the agent_group
   *   2. List sessions for the agent_group, delete each session row
   *      AND its on-disk DBs (data/v2-sessions/<agentGroupId>/<id>/)
   *   3. Delete the entire data/v2-sessions/<agentGroupId>/ tree
   *   4. messaging_group_agents WHERE agent_group_id
   *   5. messaging_groups linked to this user (web + whatsapp if paired)
   *   6. agent_group_members + user_roles WHERE agent_group_id
   *   7. user_dms tied to web:<userId> or whatsapp:<phone> entries
   *   8. container_configs WHERE agent_group_id
   *   9. agent_groups WHERE id
   *  10. users WHERE id = 'web:<userId>'
   *  11. rm -rf groups/<folder>
   *
   * Returns 200 with a summary { agentGroupId, deleted: {...counts} }.
   */
  async function handleWipeUser(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: { userId?: unknown };
    try {
      body = (await readJsonBody(req)) as typeof body;
    } catch (err) {
      writeJson(res, 400, { error: 'invalid json', detail: (err as Error).message });
      return;
    }
    if (typeof body.userId !== 'string' || !body.userId) {
      writeJson(res, 400, { error: 'userId required' });
      return;
    }
    const userId = body.userId;
    const namespacedUserId = `web:${userId}`;
    const folder = `web-${userId}`.replace(/[^a-zA-Z0-9_-]/g, '-');

    const ag = getAgentGroupByFolder(folder);
    if (!ag) {
      // Idempotent — nothing to wipe means we already succeeded
      writeJson(res, 200, { ok: true, alreadyWiped: true, userId });
      return;
    }

    const db = getDb();
    const deleted: Record<string, number> = {
      sessions: 0,
      messagingGroupAgents: 0,
      messagingGroups: 0,
      agentGroupMembers: 0,
      userRoles: 0,
      userDms: 0,
      containerConfigs: 0,
      users: 0,
      agentGroups: 0,
    };

    // 1. Stop containers (best-effort)
    try {
      const { execSync } = await import('child_process');
      const names = execSync(`docker ps --filter "name=nanoclaw-v2-${folder}-" --format '{{.Names}}'`, {
        encoding: 'utf8',
      })
        .split('\n')
        .filter(Boolean);
      for (const name of names) {
        try {
          execSync(`docker rm -f ${name}`, { stdio: 'pipe' });
        } catch (err) {
          log.warn('wipeUser: docker rm failed', { name, err });
        }
      }
    } catch (err) {
      // docker ps failed — not fatal; the container's --rm will clean it
      // up when it exits naturally
      log.warn('wipeUser: docker ps failed', { err });
    }

    // 2-3. Sessions: rows + on-disk DBs
    try {
      const sessionRows = db.prepare('SELECT id FROM sessions WHERE agent_group_id = ?').all(ag.id) as Array<{
        id: string;
      }>;
      for (const s of sessionRows) {
        const dir = path.join(DATA_DIR, 'v2-sessions', ag.id, s.id);
        fs.rmSync(dir, { recursive: true, force: true });
      }
      const res1 = db.prepare('DELETE FROM sessions WHERE agent_group_id = ?').run(ag.id);
      deleted.sessions = res1.changes;
      // Drop the per-agent-group session root too (in case it's just the
      // last session's folder + .claude-shared / heartbeats left over).
      fs.rmSync(path.join(DATA_DIR, 'v2-sessions', ag.id), { recursive: true, force: true });
    } catch (err) {
      log.warn('wipeUser: sessions cleanup failed', { err });
    }

    // 4. messaging_group_agents
    try {
      // Collect mg ids first so we can delete the mg rows that
      // are exclusively tied to this agent_group.
      const mgaRows = db
        .prepare('SELECT messaging_group_id FROM messaging_group_agents WHERE agent_group_id = ?')
        .all(ag.id) as Array<{ messaging_group_id: string }>;
      const mgIds = [...new Set(mgaRows.map((r) => r.messaging_group_id))];

      const res2 = db.prepare('DELETE FROM messaging_group_agents WHERE agent_group_id = ?').run(ag.id);
      deleted.messagingGroupAgents = res2.changes;

      // 5. messaging_groups (only those left without any wiring after
      // step 4 — keeps shared mgs intact if any)
      for (const mgId of mgIds) {
        const stillLinked = db
          .prepare('SELECT 1 FROM messaging_group_agents WHERE messaging_group_id = ? LIMIT 1')
          .get(mgId);
        if (!stillLinked) {
          const res3 = db.prepare('DELETE FROM messaging_groups WHERE id = ?').run(mgId);
          deleted.messagingGroups += res3.changes;
        }
      }
    } catch (err) {
      log.warn('wipeUser: messaging cleanup failed', { err });
    }

    // 6. agent_group_members + user_roles
    try {
      const res4 = db.prepare('DELETE FROM agent_group_members WHERE agent_group_id = ?').run(ag.id);
      deleted.agentGroupMembers = res4.changes;
    } catch (err) {
      log.warn('wipeUser: members cleanup failed', { err });
    }
    try {
      const res4b = db.prepare('DELETE FROM user_roles WHERE agent_group_id = ?').run(ag.id);
      deleted.userRoles = res4b.changes;
    } catch (err) {
      // user_roles table may not exist on older installs — non-fatal
      log.warn('wipeUser: user_roles cleanup skipped', { err });
    }

    // 7. user_dms for this user
    try {
      const res5 = db.prepare('DELETE FROM user_dms WHERE user_id = ?').run(namespacedUserId);
      deleted.userDms = res5.changes;
    } catch (err) {
      log.warn('wipeUser: user_dms cleanup failed', { err });
    }

    // 8. container_configs for this agent_group
    try {
      deleteContainerConfig(ag.id);
      deleted.containerConfigs = 1;
    } catch (err) {
      log.warn('wipeUser: container_configs cleanup failed', { err });
    }

    // 9. agent_groups
    try {
      const res6 = db.prepare('DELETE FROM agent_groups WHERE id = ?').run(ag.id);
      deleted.agentGroups = res6.changes;
    } catch (err) {
      log.warn('wipeUser: agent_groups cleanup failed', { err });
    }

    // 10. users row
    try {
      const res7 = db.prepare('DELETE FROM users WHERE id = ?').run(namespacedUserId);
      deleted.users = res7.changes;
    } catch (err) {
      log.warn('wipeUser: users cleanup failed', { err });
    }

    // 11. groups folder
    try {
      fs.rmSync(path.join(GROUPS_DIR, folder), { recursive: true, force: true });
    } catch (err) {
      log.warn('wipeUser: groups folder cleanup failed', { err });
    }

    log.info('wipeUser complete', { userId, agentGroupId: ag.id, deleted });
    writeJson(res, 200, { ok: true, userId, agentGroupId: ag.id, deleted });
  }

  /**
   * Pair an end-user's WhatsApp number to their existing agent group. The
   * web app sends `{ userId, phone, displayName? }`; we normalize the number
   * to digits-only and:
   *
   *   1. upsert the user with id `whatsapp:<digits>` (their WhatsApp identity)
   *   2. add that user as a member of the web user's agent group, so the
   *      access gate lets the inbound through.
   *   3. create the messaging_group keyed on (whatsapp, whatsapp:<digits>)
   *      with unknown_sender_policy='public' — the first inbound from this
   *      number must NOT trigger an operator approval gate.
   *   4. wire the messaging_group → agent_group so the router knows where to
   *      send it.
   *
   * Side effect: when the user later texts the operator's WhatsApp bot, the
   * adapter generates a platform_id matching this messaging_group's row and
   * the router routes the message to their personal agent. The operator
   * must have installed the `/add-whatsapp` skill on NanoClaw and paired the
   * bot once via QR for this to work end-to-end.
   *
   * Idempotent: re-pairing the same phone is a no-op other than refreshing
   * the user's display_name.
   */
  async function handleWhatsAppConnect(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: { userId?: unknown; phone?: unknown; displayName?: unknown };
    try {
      body = (await readJsonBody(req)) as typeof body;
    } catch (err) {
      writeJson(res, 400, { error: 'invalid json', detail: (err as Error).message });
      return;
    }
    if (typeof body.userId !== 'string' || !body.userId) {
      writeJson(res, 400, { error: 'userId required' });
      return;
    }
    if (typeof body.phone !== 'string' || !body.phone) {
      writeJson(res, 400, { error: 'phone required' });
      return;
    }
    const digits = body.phone.replace(/\D/g, '');
    if (digits.length < 8 || digits.length > 15) {
      writeJson(res, 400, { error: 'phone must be 8–15 digits in E.164 form' });
      return;
    }

    const webUserFolder = `web-${body.userId}`.replace(/[^a-zA-Z0-9_-]/g, '-');
    const agentGroup = getAgentGroupByFolder(webUserFolder);
    if (!agentGroup) {
      writeJson(res, 404, {
        error: 'agent group not found',
        detail: 'the web user has not provisioned an agent yet; send a chat message first',
      });
      return;
    }

    const now = new Date().toISOString();
    const waUserId = `whatsapp:${digits}`;
    const waPlatformId = `whatsapp:${digits}`;
    const displayName = (typeof body.displayName === 'string' && body.displayName) || `+${digits}`;

    try {
      // 1. WhatsApp identity in the central users table.
      upsertUser({
        id: waUserId,
        kind: 'whatsapp',
        display_name: displayName,
        created_at: now,
      });

      // 2. Grant member access on the agent group so the router accepts
      //    inbounds from this WhatsApp user without operator approval.
      addMember({
        user_id: waUserId,
        agent_group_id: agentGroup.id,
        added_by: null,
        added_at: now,
      });

      // 3. Messaging group keyed on the phone. `is_group=0` for DM,
      //    `unknown_sender_policy='public'` so the first message goes
      //    straight through (no admin approval card).
      let mg = getMessagingGroupByPlatform('whatsapp', waPlatformId);
      if (!mg) {
        createMessagingGroup({
          id: `mg-wa-${digits}-${Date.now().toString(36)}`,
          channel_type: 'whatsapp',
          platform_id: waPlatformId,
          name: displayName,
          is_group: 0,
          unknown_sender_policy: 'public',
          created_at: now,
        });
        mg = getMessagingGroupByPlatform('whatsapp', waPlatformId)!;
      }

      // 4. Wire messaging_group → agent_group with the standard DM-style
      //    engage_mode=pattern + engage_pattern='.', so every message from
      //    this number triggers the user's agent.
      if (!getMessagingGroupAgentByPair(mg.id, agentGroup.id)) {
        createMessagingGroupAgent({
          id: `mga-wa-${digits}-${Date.now().toString(36)}`,
          messaging_group_id: mg.id,
          agent_group_id: agentGroup.id,
          engage_mode: 'pattern',
          engage_pattern: '.',
          sender_scope: 'all',
          ignored_message_policy: 'drop',
          // 'agent-shared' — see web-provision rationale above. WhatsApp must
          // share its session with the user's web chat so the agent has one
          // continuous memory across both channels.
          session_mode: 'agent-shared',
          priority: 0,
          created_at: now,
        });
      }

      writeJson(res, 200, {
        ok: true,
        phone: digits,
        whatsappUserId: waUserId,
        messagingGroupId: mg.id,
        agentGroupId: agentGroup.id,
        // The operator's bot phone, if configured. The UI displays this so
        // the user knows where to text to start their conversation. If unset
        // the UI shows a generic "text your operator's bot" message.
        botPhone: readEnvFile(['SOLELACLAWDE_WHATSAPP_BOT_PHONE']).SOLELACLAWDE_WHATSAPP_BOT_PHONE ?? null,
      });
    } catch (err) {
      log.error('WhatsApp connect failed', { err, userId: body.userId });
      writeJson(res, 500, { error: 'connect failed', detail: (err as Error).message });
    }
  }

  /**
   * Start (or restart) the Baileys QR pairing flow as a child process and
   * stream its QR strings into module state so the operator's admin UI can
   * render them live. Wipes any stale `store/auth/` so the run always starts
   * fresh. Idempotent: if a pairing is already in flight, returns the
   * current state instead of spawning a duplicate.
   */
  async function handleWhatsAppPairStart(_req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (pairProcess && !pairProcess.killed && pairState.status === 'pending') {
      writeJson(res, 200, { ...pairState });
      return;
    }
    try {
      fs.rmSync(path.join(PROJECT_ROOT, 'store', 'auth'), { recursive: true, force: true });
    } catch (err) {
      log.warn('WhatsApp pair: failed to wipe stale auth', { err });
    }
    pairState = {
      status: 'pending',
      qrDataUrl: null,
      phone: null,
      errorMessage: null,
      updatedAt: new Date().toISOString(),
    };

    // pnpm is the operator's package manager, so we shell out via it. The
    // env passes through (PATH, NODE, …) so tsx + the project's node_modules
    // resolve like a normal local run.
    pairProcess = spawn('pnpm', ['exec', 'tsx', 'setup/index.ts', '--step', 'whatsapp-auth', '--', '--method', 'qr'], {
      cwd: PROJECT_ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let buf = '';
    pairProcess.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) void handlePairLine(line);
      }
    });
    pairProcess.stderr?.on('data', (chunk: Buffer) => {
      log.debug('whatsapp-pair stderr', { line: chunk.toString('utf8').trim() });
    });
    pairProcess.on('exit', (code) => {
      pairProcess = null;
      // If we exit without reaching 'paired', flip to 'failed' so the UI
      // can show "QR expired, try again" instead of spinning forever.
      if (pairState.status !== 'paired') {
        pairState = {
          ...pairState,
          status: 'failed',
          qrDataUrl: null,
          errorMessage: pairState.errorMessage ?? `pair script exited (code=${code ?? 'null'})`,
          updatedAt: new Date().toISOString(),
        };
      }
    });

    writeJson(res, 202, { ...pairState });
  }

  function handleWhatsAppPairStatus(res: http.ServerResponse): void {
    writeJson(res, 200, { ...pairState });
  }

  /**
   * Token-based WhatsApp link claim — the TrustClaw-style flow.
   *
   * The web app issues short tokens out-of-band; the user texts the operator
   * bot from their phone with `link <token>`. WhatsApp's first message from
   * an unknown number triggers NanoClaw's `channelRequestGate`, which inserts
   * a row in `pending_sender_approvals`. This endpoint scans those rows for
   * a body match on `link <token>` (case-insensitive, trimmed) and, when it
   * finds one, atomically transfers the underlying messaging_group to the
   * web user's agent group and clears the approval. The user sees no
   * "operator approval pending" detour — by the time they refresh their
   * status, they are linked.
   *
   * Caller responsibility: validate the token belongs to `userId` before
   * calling this; the channel adapter trusts the bearer token and the
   * caller-supplied `userId`.
   *
   * Body: `{ userId: string, token: string }`
   * Returns: `{ found: true, identifier, phone }` or `{ found: false }`
   */
  async function handleWhatsAppClaimLink(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: { userId?: unknown; token?: unknown };
    try {
      body = (await readJsonBody(req)) as typeof body;
    } catch (err) {
      writeJson(res, 400, { error: 'invalid json', detail: (err as Error).message });
      return;
    }
    if (typeof body.userId !== 'string' || !body.userId) {
      writeJson(res, 400, { error: 'userId required' });
      return;
    }
    if (typeof body.token !== 'string' || !body.token) {
      writeJson(res, 400, { error: 'token required' });
      return;
    }
    const token = body.token.trim();
    if (token.length < 4 || token.length > 32) {
      writeJson(res, 400, { error: 'token must be 4–32 chars' });
      return;
    }
    const folder = `web-${body.userId}`.replace(/[^a-zA-Z0-9_-]/g, '-');
    const agentGroup = getAgentGroupByFolder(folder);
    if (!agentGroup) {
      writeJson(res, 404, { error: 'agent group not found for web user' });
      return;
    }

    // Look for an unprocessed WhatsApp approval whose user-typed text
    // contains `link <token>`. The match is case-insensitive on the token
    // and tolerant of leading prefixes ("/start", "@bot link xxx", …) so
    // users can copy-paste from the UI without exact-formatting stress.
    const tokenRe = new RegExp(`\\blink\\s+${token.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b`, 'i');
    // Scan BOTH approval tables. `pending_channel_approvals` fires the first
    // time an unknown number messages the bot (the channel isn't wired yet —
    // this is the typical link-flow path). `pending_sender_approvals` fires
    // when the channel is already wired but a new sender appears on it (less
    // common for WhatsApp 1:1, but possible). Same `original_message` shape
    // in both, so one regex / extractor works for both.
    type Row = {
      approval_id: string;
      messaging_group_id: string;
      sender_identity: string | null;
      sender_name: string | null;
      original_message: string;
      kind: 'channel' | 'sender';
    };
    const rows: Row[] = [
      ...(getDb()
        .prepare(
          `SELECT pca.messaging_group_id AS approval_id, pca.messaging_group_id,
                  NULL AS sender_identity, NULL AS sender_name,
                  pca.original_message, 'channel' AS kind
             FROM pending_channel_approvals pca
             JOIN messaging_groups mg ON mg.id = pca.messaging_group_id
            WHERE mg.channel_type = 'whatsapp'`,
        )
        .all() as Row[]),
      ...(getDb()
        .prepare(
          `SELECT psa.id AS approval_id, psa.messaging_group_id, psa.sender_identity,
                  psa.sender_name, psa.original_message, 'sender' AS kind
             FROM pending_sender_approvals psa
             JOIN messaging_groups mg ON mg.id = psa.messaging_group_id
            WHERE mg.channel_type = 'whatsapp'`,
        )
        .all() as Row[]),
    ];

    let match: Row | undefined;
    let matchSenderIdentity: string | null = null;
    let matchSenderName: string | null = null;
    for (const row of rows) {
      try {
        // original_message is a JSON-encoded InboundEvent. `message.content`
        // is either a string (legacy native adapters JSON-encode it once) or
        // an object (Chat SDK adapters — WhatsApp Cloud, etc.). We sniff
        // both shapes and pull the text + sender out.
        const event = JSON.parse(row.original_message) as {
          message?: { content?: unknown; senderId?: string; sender?: string };
        };
        const inner = event.message?.content;
        let text = '';
        let senderIdFromContent: string | undefined;
        let senderNameFromContent: string | undefined;
        if (typeof inner === 'string') {
          try {
            const parsed = JSON.parse(inner) as { text?: string; senderId?: string; sender?: string };
            text = typeof parsed.text === 'string' ? parsed.text : inner;
            senderIdFromContent = parsed.senderId;
            senderNameFromContent = parsed.sender;
          } catch {
            text = inner;
          }
        } else if (inner && typeof inner === 'object') {
          // Chat SDK shape: { text?, body?, sender?, senderId?, author?, ... }.
          // The chat-sdk-bridge projects author into top-level senderId/sender
          // before persisting, so those fields are what we look for first.
          const obj = inner as Record<string, unknown>;
          text = (typeof obj.text === 'string' && obj.text) || (typeof obj.body === 'string' && obj.body) || '';
          senderIdFromContent = typeof obj.senderId === 'string' ? obj.senderId : undefined;
          senderNameFromContent = typeof obj.sender === 'string' ? obj.sender : undefined;
        }
        if (tokenRe.test(text)) {
          match = row;
          matchSenderIdentity = row.sender_identity ?? senderIdFromContent ?? event.message?.senderId ?? null;
          matchSenderName = row.sender_name ?? senderNameFromContent ?? event.message?.sender ?? null;
          break;
        }
      } catch {
        // skip malformed rows
      }
    }

    if (!match || !matchSenderIdentity) {
      writeJson(res, 200, { found: false });
      return;
    }

    const now = new Date().toISOString();
    // sender_identity might look like:
    //   "whatsapp:33612345678"                    (legacy)
    //   "whatsapp:<bot_phone_id>:<user_phone>"    (Chat SDK Cloud adapter)
    //   "33612345678@s.whatsapp.net"              (Baileys raw)
    // Strip the channel prefix and the JID suffix; what's left is the user's
    // phone digits, with the bot's phone id stripped when present.
    const idTail = matchSenderIdentity.startsWith('whatsapp:')
      ? matchSenderIdentity.slice('whatsapp:'.length)
      : matchSenderIdentity;
    const stripped = idTail.replace(/@s\.whatsapp\.net$/, '');
    // For Chat SDK Cloud, the format is "<bot_id>:<user_phone>". Take the
    // last segment.
    const phone = stripped.includes(':') ? stripped.split(':').pop()! : stripped;
    const displayName = matchSenderName || `+${phone}`;

    try {
      // 1. Persist the WhatsApp identity (idempotent).
      upsertUser({
        id: matchSenderIdentity,
        kind: 'whatsapp',
        display_name: displayName,
        created_at: now,
      });

      // 2. Grant membership on the agent group so the router accepts the
      //    user without operator approval going forward.
      addMember({
        user_id: matchSenderIdentity,
        agent_group_id: agentGroup.id,
        added_by: null,
        added_at: now,
      });

      // 3a. Set a human name on the messaging_group BEFORE wiring so the
      //     auto-created agent_destinations row gets a meaningful local_name
      //     (e.g. "whatsapp-d-posal") instead of the fallback
      //     "whatsapp-mg-1779…". createMessagingGroupAgent reads mg.name at
      //     destination-creation time — naming it later doesn't backfill.
      //     createMessagingGroupAgent normalizes whatever string we pass.
      const wg = getMessagingGroup(match.messaging_group_id);
      if (wg && !wg.name) {
        updateMessagingGroup(match.messaging_group_id, {
          name: `whatsapp ${displayName}`,
        });
      }

      // 3. Wire the (already-created-during-auto-create) messaging_group to
      //    the web user's agent_group. Idempotent if wiring exists.
      if (!getMessagingGroupAgentByPair(match.messaging_group_id, agentGroup.id)) {
        createMessagingGroupAgent({
          id: `mga-wa-link-${Date.now().toString(36)}`,
          messaging_group_id: match.messaging_group_id,
          agent_group_id: agentGroup.id,
          engage_mode: 'pattern',
          engage_pattern: '.',
          sender_scope: 'all',
          ignored_message_policy: 'drop',
          // 'agent-shared' — see web-provision rationale above. The user
          // expects one continuous assistant memory regardless of whether
          // they're texting via WhatsApp or chatting via web.
          session_mode: 'agent-shared',
          priority: 0,
          created_at: now,
        });
      }

      // 4. Lift the policy to 'public' so subsequent messages from this
      //    phone go through without re-triggering the approval gate.
      updateMessagingGroup(match.messaging_group_id, { unknown_sender_policy: 'public' });

      // 5. Clear the pending approval — operator's pending approval card
      //    becomes stale; the host's approval-handler will silently drop it.
      //    Channel and sender approvals live in distinct tables; pick the
      //    right one based on which table the row came from.
      if (match.kind === 'channel') {
        // PK on pending_channel_approvals is messaging_group_id, not a
        // separate `id` column — that's why approval_id == messaging_group_id
        // on these rows.
        getDb()
          .prepare('DELETE FROM pending_channel_approvals WHERE messaging_group_id = ?')
          .run(match.messaging_group_id);
      } else {
        deletePendingSenderApproval(match.approval_id);
      }

      // 6. Flush stale destinations on any running container for this
      //    agent_group. The container loads agent_destinations once at
      //    spawn time and doesn't auto-refresh — without a restart the
      //    agent keeps replying to the original (web) channel even after
      //    we've added whatsapp as a destination. Without this restart,
      //    paired WhatsApp replies go to the user's web tab, not their
      //    phone (see container/agent-runner/src/destinations.ts and the
      //    DESTINATION PROJECTION NOTE on createMessagingGroupAgent).
      //    No wakeMessage → containers come back on the user's next msg.
      restartAgentGroupContainers(agentGroup.id, 'channel paired (whatsapp)');

      writeJson(res, 200, {
        found: true,
        identifier: matchSenderIdentity,
        phone,
      });
    } catch (err) {
      log.error('WhatsApp claim-link failed', { err, token });
      writeJson(res, 500, { error: 'claim failed', detail: (err as Error).message });
    }
  }

  /**
   * Token-based Telegram link claim — sibling of `handleWhatsAppClaimLink`.
   *
   * Two text shapes are accepted because Telegram has two natural delivery
   * paths for the same token:
   *
   *   - `link <token>` — typed manually by the user (matches the WhatsApp
   *     fallback copy on the web form).
   *   - `/start <token>` — fired automatically by the
   *     `https://t.me/<bot>?start=<token>` deep link on the user's first
   *     tap of the "Open Telegram" button on the web form. This is the
   *     happy path — zero typing.
   *
   * Identity parsing differs from WhatsApp: Telegram identities look like
   * `telegram:<chatId>` (positive integer for DMs, negative for groups).
   * The response surfaces `chatId` instead of `phone`.
   *
   * Body: `{ userId: string, token: string }`
   * Returns: `{ found: true, identifier, chatId }` or `{ found: false }`
   */
  async function handleTelegramClaimLink(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: { userId?: unknown; token?: unknown };
    try {
      body = (await readJsonBody(req)) as typeof body;
    } catch (err) {
      writeJson(res, 400, { error: 'invalid json', detail: (err as Error).message });
      return;
    }
    if (typeof body.userId !== 'string' || !body.userId) {
      writeJson(res, 400, { error: 'userId required' });
      return;
    }
    if (typeof body.token !== 'string' || !body.token) {
      writeJson(res, 400, { error: 'token required' });
      return;
    }
    const token = body.token.trim();
    if (token.length < 4 || token.length > 32) {
      writeJson(res, 400, { error: 'token must be 4–32 chars' });
      return;
    }
    const folder = `web-${body.userId}`.replace(/[^a-zA-Z0-9_-]/g, '-');
    const agentGroup = getAgentGroupByFolder(folder);
    if (!agentGroup) {
      writeJson(res, 404, { error: 'agent group not found for web user' });
      return;
    }

    // Accept either `link <token>` (manual) or `/start <token>` (deep link).
    // Both are case-insensitive. Token is regex-escaped before splicing in.
    const escToken = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const tokenRe = new RegExp(`(?:\\blink\\s+|\\/start\\s+)${escToken}\\b`, 'i');

    type Row = {
      approval_id: string;
      messaging_group_id: string;
      sender_identity: string | null;
      sender_name: string | null;
      original_message: string;
      kind: 'channel' | 'sender';
    };
    const rows: Row[] = [
      ...(getDb()
        .prepare(
          `SELECT pca.messaging_group_id AS approval_id, pca.messaging_group_id,
                  NULL AS sender_identity, NULL AS sender_name,
                  pca.original_message, 'channel' AS kind
             FROM pending_channel_approvals pca
             JOIN messaging_groups mg ON mg.id = pca.messaging_group_id
            WHERE mg.channel_type = 'telegram'`,
        )
        .all() as Row[]),
      ...(getDb()
        .prepare(
          `SELECT psa.id AS approval_id, psa.messaging_group_id, psa.sender_identity,
                  psa.sender_name, psa.original_message, 'sender' AS kind
             FROM pending_sender_approvals psa
             JOIN messaging_groups mg ON mg.id = psa.messaging_group_id
            WHERE mg.channel_type = 'telegram'`,
        )
        .all() as Row[]),
    ];

    let match: Row | undefined;
    let matchSenderIdentity: string | null = null;
    let matchSenderName: string | null = null;
    for (const row of rows) {
      try {
        const event = JSON.parse(row.original_message) as {
          message?: { content?: unknown; senderId?: string; sender?: string };
        };
        const inner = event.message?.content;
        let text = '';
        let senderIdFromContent: string | undefined;
        let senderNameFromContent: string | undefined;
        if (typeof inner === 'string') {
          try {
            const parsed = JSON.parse(inner) as {
              text?: string;
              senderId?: string;
              sender?: string;
            };
            text = typeof parsed.text === 'string' ? parsed.text : inner;
            senderIdFromContent = parsed.senderId;
            senderNameFromContent = parsed.sender;
          } catch {
            text = inner;
          }
        } else if (inner && typeof inner === 'object') {
          const obj = inner as Record<string, unknown>;
          text = (typeof obj.text === 'string' && obj.text) || (typeof obj.body === 'string' && obj.body) || '';
          senderIdFromContent = typeof obj.senderId === 'string' ? obj.senderId : undefined;
          senderNameFromContent = typeof obj.sender === 'string' ? obj.sender : undefined;
        }
        if (tokenRe.test(text)) {
          match = row;
          matchSenderIdentity = row.sender_identity ?? senderIdFromContent ?? event.message?.senderId ?? null;
          matchSenderName = row.sender_name ?? senderNameFromContent ?? event.message?.sender ?? null;
          break;
        }
      } catch {
        // skip malformed rows
      }
    }

    if (!match || !matchSenderIdentity) {
      writeJson(res, 200, { found: false });
      return;
    }

    const now = new Date().toISOString();
    // `telegram:<chatId>` — strip the prefix; whatever remains is the
    // numeric chat id (negative for groups/channels, positive for DMs).
    const chatId = matchSenderIdentity.startsWith('telegram:')
      ? matchSenderIdentity.slice('telegram:'.length)
      : matchSenderIdentity;
    const displayName = matchSenderName || `tg:${chatId}`;

    try {
      upsertUser({
        id: matchSenderIdentity,
        kind: 'telegram',
        display_name: displayName,
        created_at: now,
      });

      addMember({
        user_id: matchSenderIdentity,
        agent_group_id: agentGroup.id,
        added_by: null,
        added_at: now,
      });

      // Name the messaging_group BEFORE wiring so the auto-created
      // agent_destinations row gets a meaningful local_name (e.g.
      // "telegram-d-posal") instead of the fallback "telegram-mg-1779…".
      // createMessagingGroupAgent normalizes whatever string we pass.
      const tgMg = getMessagingGroup(match.messaging_group_id);
      if (tgMg && !tgMg.name) {
        updateMessagingGroup(match.messaging_group_id, {
          name: `telegram ${displayName}`,
        });
      }

      if (!getMessagingGroupAgentByPair(match.messaging_group_id, agentGroup.id)) {
        createMessagingGroupAgent({
          id: `mga-tg-link-${Date.now().toString(36)}`,
          messaging_group_id: match.messaging_group_id,
          agent_group_id: agentGroup.id,
          engage_mode: 'pattern',
          engage_pattern: '.',
          sender_scope: 'all',
          ignored_message_policy: 'drop',
          // 'agent-shared' so Telegram + Web share one continuous
          // assistant memory for this user — mirrors the WhatsApp variant.
          // Prior value 'shared' meant a separate session per (mg, agent),
          // which forked the agent's memory across channels.
          session_mode: 'agent-shared',
          priority: 0,
          created_at: now,
        });
      }

      updateMessagingGroup(match.messaging_group_id, { unknown_sender_policy: 'public' });

      if (match.kind === 'channel') {
        getDb()
          .prepare('DELETE FROM pending_channel_approvals WHERE messaging_group_id = ?')
          .run(match.messaging_group_id);
      } else {
        deletePendingSenderApproval(match.approval_id);
      }

      // Flush stale destinations on running containers — see the WhatsApp
      // sibling for the rationale. Without this, Telegram replies go to
      // the user's web tab (the destination cached at the container's
      // last spawn) instead of back to Telegram. D Posal hit this today.
      restartAgentGroupContainers(agentGroup.id, 'channel paired (telegram)');

      writeJson(res, 200, {
        found: true,
        identifier: matchSenderIdentity,
        chatId,
      });
    } catch (err) {
      log.error('Telegram claim-link failed', { err, token });
      writeJson(res, 500, { error: 'claim failed', detail: (err as Error).message });
    }
  }

  /**
   * V2 inbox: list pending channel approvals so the web app can show them in
   * `/inbox`. Optional `?agentGroupId=X` narrows to a single agent group; with
   * no filter we return everything (the web app does the org-scoping based on
   * which agent groups belong to which org).
   */
  function handleListPendingApprovals(res: http.ServerResponse, url: string): void {
    const parsed = new URL(url, 'http://x');
    const agentGroupId = parsed.searchParams.get('agentGroupId');

    interface Row {
      messaging_group_id: string;
      agent_group_id: string;
      approver_user_id: string;
      created_at: string;
      title: string;
      options_json: string;
      original_message: string;
      channel_type: string;
      channel_name: string | null;
    }
    const rows = (
      agentGroupId
        ? getDb()
            .prepare(
              `SELECT pca.messaging_group_id, pca.agent_group_id, pca.approver_user_id,
                      pca.created_at, pca.title, pca.options_json, pca.original_message,
                      mg.channel_type, mg.name AS channel_name
                 FROM pending_channel_approvals pca
                 JOIN messaging_groups mg ON mg.id = pca.messaging_group_id
                WHERE pca.agent_group_id = ?
                ORDER BY pca.created_at DESC`,
            )
            .all(agentGroupId)
        : getDb()
            .prepare(
              `SELECT pca.messaging_group_id, pca.agent_group_id, pca.approver_user_id,
                      pca.created_at, pca.title, pca.options_json, pca.original_message,
                      mg.channel_type, mg.name AS channel_name
                 FROM pending_channel_approvals pca
                 JOIN messaging_groups mg ON mg.id = pca.messaging_group_id
                ORDER BY pca.created_at DESC`,
            )
            .all()
    ) as Row[];

    const approvals = rows.map((r) => {
      let senderName: string | null = null;
      try {
        const event = JSON.parse(r.original_message) as {
          message?: { content?: unknown };
        };
        const inner = event.message?.content;
        if (typeof inner === 'string') {
          try {
            const obj = JSON.parse(inner) as { senderName?: string; sender?: string };
            senderName = obj.senderName ?? obj.sender ?? null;
          } catch {
            // ignore
          }
        } else if (inner && typeof inner === 'object') {
          const obj = inner as Record<string, unknown>;
          senderName =
            (typeof obj.senderName === 'string' && obj.senderName) ||
            (typeof obj.sender === 'string' && obj.sender) ||
            null;
        }
      } catch {
        // ignore
      }
      return {
        kind: 'channel' as const,
        messagingGroupId: r.messaging_group_id,
        agentGroupId: r.agent_group_id,
        channelType: r.channel_type,
        channelName: r.channel_name,
        senderName,
        title: r.title,
        createdAt: r.created_at,
        options: JSON.parse(r.options_json),
      };
    });

    writeJson(res, 200, { channelApprovals: approvals });
  }

  /**
   * V2 inbox: decide a pending channel approval from the web inbox. Body:
   *   { messagingGroupId: string,
   *     action: 'connect' | 'reject',
   *     agentGroupId?: string  // required for connect; falls back to the
   *                            // row's agent_group_id when omitted }
   *
   * On `connect`: wire the messaging group to the target agent group, grant
   * the triggering sender membership, drop the pending row, replay the
   * stored event so the original message gets delivered.
   *
   * On `reject`: stamp `messaging_groups.denied_at` and drop the pending row
   * so the router stops escalating on this channel.
   *
   * Auth is the shared bearer token — the web app does its own org-scoped
   * authorization before calling here.
   */
  async function handleDecidePendingApproval(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: { messagingGroupId?: unknown; action?: unknown; agentGroupId?: unknown };
    try {
      body = (await readJsonBody(req)) as typeof body;
    } catch (err) {
      writeJson(res, 400, { error: 'invalid json', detail: (err as Error).message });
      return;
    }
    if (typeof body.messagingGroupId !== 'string' || !body.messagingGroupId) {
      writeJson(res, 400, { error: 'messagingGroupId required' });
      return;
    }
    if (body.action !== 'connect' && body.action !== 'reject') {
      writeJson(res, 400, { error: "action must be 'connect' or 'reject'" });
      return;
    }

    const row = getPendingChannelApproval(body.messagingGroupId);
    if (!row) {
      writeJson(res, 404, { error: 'pending approval not found' });
      return;
    }

    if (body.action === 'reject') {
      setMessagingGroupDeniedAt(row.messaging_group_id, new Date().toISOString());
      deletePendingChannelApproval(row.messaging_group_id);
      log.info('Channel registration denied via inbox', {
        messagingGroupId: row.messaging_group_id,
      });
      writeJson(res, 200, { ok: true, action: 'reject' });
      return;
    }

    const targetAgentGroupId =
      typeof body.agentGroupId === 'string' && body.agentGroupId ? body.agentGroupId : row.agent_group_id;
    if (!getAgentGroup(targetAgentGroupId)) {
      writeJson(res, 404, { error: 'target agent group not found' });
      return;
    }

    let event: InboundEvent;
    try {
      event = JSON.parse(row.original_message) as InboundEvent;
    } catch (err) {
      log.error('Inbox decide: failed to parse stored event', {
        messagingGroupId: row.messaging_group_id,
        err,
      });
      deletePendingChannelApproval(row.messaging_group_id);
      writeJson(res, 500, { error: 'stored event was malformed; pending row dropped' });
      return;
    }

    const isGroup = event.threadId !== null;
    const now = new Date().toISOString();
    const mgaId = `mga-inbox-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    createMessagingGroupAgent({
      id: mgaId,
      messaging_group_id: row.messaging_group_id,
      agent_group_id: targetAgentGroupId,
      engage_mode: isGroup ? 'mention-sticky' : 'pattern',
      engage_pattern: isGroup ? null : '.',
      sender_scope: 'known',
      ignored_message_policy: 'accumulate',
      // 'agent-shared' — see web-provision rationale above. An inbox-
      // approved channel joins the user's existing assistant memory rather
      // than starting a fresh thread isolated from the rest.
      session_mode: 'agent-shared',
      priority: 0,
      created_at: now,
    });

    // Grant the triggering sender (the user whose message kicked the
    // approval) membership so sender_scope='known' doesn't bounce the
    // replayed event into a sender-approval cascade. The sender id lives in
    // the encoded `message.content` JSON — mirroring extractAndUpsertUser in
    // src/modules/permissions/index.ts, minus the upsertUser side-effect
    // (the user row already exists by the time we're here).
    const senderId = (() => {
      try {
        const content = JSON.parse(event.message.content) as Record<string, unknown>;
        const raw =
          (typeof content.senderId === 'string' && content.senderId) ||
          (typeof content.sender === 'string' && content.sender) ||
          (typeof (content.author as { userId?: unknown } | undefined)?.userId === 'string'
            ? (content.author as { userId: string }).userId
            : null);
        if (!raw) return null;
        return raw.includes(':') ? raw : `${event.channelType}:${raw}`;
      } catch {
        return null;
      }
    })();
    if (senderId) {
      addMember({
        user_id: senderId,
        agent_group_id: targetAgentGroupId,
        added_by: null,
        added_at: now,
      });
    }

    deletePendingChannelApproval(row.messaging_group_id);

    try {
      await routeInbound(event);
    } catch (err) {
      log.error('Inbox decide: replay failed', {
        messagingGroupId: row.messaging_group_id,
        err,
      });
    }

    log.info('Channel registration approved via inbox', {
      messagingGroupId: row.messaging_group_id,
      agentGroupId: targetAgentGroupId,
      mgaId,
    });
    writeJson(res, 200, { ok: true, action: 'connect', agentGroupId: targetAgentGroupId, mgaId });
  }

  /**
   * V2.2 / V2.3 — Rewrite the agent's `skills/enterprise/` and / or
   * `skills/personal/` folders to match the supplied lists. Wipe +
   * recreate per category; idempotent. The two categories are
   * independent — passing only `enterprise` leaves `personal` alone
   * and vice-versa. Other files in `skills/` (or anywhere outside
   * these two subtrees) are never touched.
   *
   * Body shape:
   *   { enterprise?: [{ slug, name, description, body }, ...],
   *     personal?:   [{ slug, name, description, body }, ...] }
   *
   * Slug is sanitized server-side — filesystem name = lowercase, alnum +
   * hyphens only — so a malicious payload can't escape the skills dir.
   */
  async function handleSyncAgentSkills(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    agentGroupId: string,
  ): Promise<void> {
    let body: { enterprise?: unknown; personal?: unknown };
    try {
      body = (await readJsonBody(req)) as typeof body;
    } catch (err) {
      writeJson(res, 400, { error: 'invalid json', detail: (err as Error).message });
      return;
    }

    if (body.enterprise !== undefined && !Array.isArray(body.enterprise)) {
      writeJson(res, 400, { error: 'enterprise must be an array' });
      return;
    }
    if (body.personal !== undefined && !Array.isArray(body.personal)) {
      writeJson(res, 400, { error: 'personal must be an array' });
      return;
    }
    if (body.enterprise === undefined && body.personal === undefined) {
      writeJson(res, 400, { error: 'enterprise or personal required' });
      return;
    }

    const ag = getAgentGroup(agentGroupId);
    if (!ag) {
      writeJson(res, 404, { error: 'agent group not found' });
      return;
    }

    type Skill = { slug: string; name: string; description: string; body: string };
    function normalize(raw: unknown[]): Skill[] {
      const out: Skill[] = [];
      for (const r of raw) {
        if (!r || typeof r !== 'object') continue;
        const o = r as Record<string, unknown>;
        const slug = sanitizeSlug(typeof o.slug === 'string' ? o.slug : '');
        const name = typeof o.name === 'string' ? o.name : slug;
        const description = typeof o.description === 'string' ? o.description : '';
        const skillBody = typeof o.body === 'string' ? o.body : '';
        if (!slug) continue;
        out.push({ slug, name, description, body: skillBody });
      }
      return out;
    }

    const enterprise = body.enterprise !== undefined ? normalize(body.enterprise as unknown[]) : null;
    const personal = body.personal !== undefined ? normalize(body.personal as unknown[]) : null;

    // Skills land in the directory that NanoClaw mounts to /home/node/.claude
    // inside the container, which is where the Claude Agent SDK discovers
    // them. Built-in skills coexist here as SYMLINKS — our skills are real
    // directories, and syncSkillSymlinks in container-runner.ts only ever
    // deletes symlinks-not-in-desired-set, so our directories survive
    // every container spawn.
    //
    // We prefix folder names with `org-` (enterprise) and `me-` (personal)
    // so the two categories share a namespace cleanly and can't collide
    // with built-in skill names (`welcome`, `onecli-gateway`, etc.).
    const skillsDir = path.join(DATA_DIR, 'v2-sessions', ag.id, '.claude-shared', 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });

    function writeCategory(prefix: 'org-' | 'me-', skills: Skill[]): void {
      // Wipe just our category's prefixed directories — leave symlinks and
      // the other category alone.
      for (const entry of fs.readdirSync(skillsDir)) {
        if (!entry.startsWith(prefix)) continue;
        const entryPath = path.join(skillsDir, entry);
        let stat;
        try {
          stat = fs.lstatSync(entryPath);
        } catch {
          continue;
        }
        if (stat.isSymbolicLink()) continue;
        fs.rmSync(entryPath, { recursive: true, force: true });
      }
      for (const s of skills) {
        const skillDir = path.join(skillsDir, prefix + s.slug);
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(path.join(skillDir, 'SKILL.md'), renderSkillMd(s), 'utf-8');
      }
    }

    try {
      if (enterprise !== null) writeCategory('org-', enterprise);
      if (personal !== null) writeCategory('me-', personal);
      log.info('Agent skills synced', {
        agentGroupId,
        skillsDir,
        enterprise: enterprise?.length ?? 'unchanged',
        personal: personal?.length ?? 'unchanged',
      });
      writeJson(res, 200, {
        ok: true,
        enterprise: enterprise?.length ?? null,
        personal: personal?.length ?? null,
      });
    } catch (err) {
      log.error('Agent skill sync failed', {
        agentGroupId,
        err: (err as Error).message,
      });
      writeJson(res, 500, { error: 'sync failed', detail: (err as Error).message });
    }
  }

  /**
   * Return the channels NanoClaw has registered (cli, web, plus anything the
   * operator installed via `/add-<channel>` skills — discord, telegram, …).
   * The web app's /channels page renders one card per entry so the user can
   * pick where they want their assistant to be reachable.
   */
  function handleChannels(res: http.ServerResponse): void {
    const channels = getRegisteredChannelNames().map((name) => ({
      type: name,
      label: CHANNEL_LABELS[name] ?? name,
      installed: true,
      // Whether end-users can self-connect via this UI. CLI is local-only
      // and `web` is implicit (every user already has it). The rest need
      // per-channel pairing flows (Telegram /start handshake, Discord
      // OAuth, …) — surfaced as "Coming soon" until each lands.
      userSelfConnect: USER_SELF_CONNECT_CHANNELS.has(name),
    }));
    writeJson(res, 200, { channels });
  }

  /**
   * Per-user channel wirings — what does this agent already have linked?
   *
   * Drives the /channels page in the web app: instead of every non-web
   * channel showing a generic "Connect" button regardless of state, the
   * page can now display "Connected as @<handle>" + a green status pill
   * when a row exists in messaging_group_agents for that agent +
   * channel_type pair.
   *
   * GET /admin/channels/links?agentGroupId=<id>
   *   → { links: [{ channelType, platformId, name?, mgaId }] }
   *
   * `platformId` is the canonical channel-side identifier (the phone for
   * WhatsApp, the numeric chat id for Telegram). `name` is the user-side
   * display name when NanoClaw has stored one (Telegram chat title,
   * WhatsApp display name) — used for the "Connected as …" subline.
   *
   * Multiple links per channel-type are possible (a user with two
   * Telegram chats wired to the same agent group, for instance) — the
   * web app coalesces them at render time.
   */
  function handleChannelLinks(res: http.ServerResponse, url: string): void {
    const parsed = new URL(url, 'http://x');
    const agentGroupId = parsed.searchParams.get('agentGroupId');
    if (!agentGroupId) {
      writeJson(res, 400, { error: 'agentGroupId required' });
      return;
    }

    interface Row {
      mga_id: string;
      messaging_group_id: string;
      channel_type: string;
      platform_id: string;
      name: string | null;
    }
    const rows = getDb()
      .prepare(
        `SELECT mga.id          AS mga_id,
                mg.id           AS messaging_group_id,
                mg.channel_type AS channel_type,
                mg.platform_id  AS platform_id,
                mg.name         AS name
           FROM messaging_group_agents mga
           JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
          WHERE mga.agent_group_id = ?
          ORDER BY mga.created_at ASC`,
      )
      .all(agentGroupId) as Row[];

    const links = rows.map((r) => ({
      mgaId: r.mga_id,
      messagingGroupId: r.messaging_group_id,
      channelType: r.channel_type,
      platformId: r.platform_id,
      name: r.name,
    }));

    writeJson(res, 200, { links });
  }

  /**
   * Batch "what channels does each agent have wired" rollup for the
   * admin dashboard's Channels column.
   *
   * GET /admin/channel-status?agentGroupIds=<id1>,<id2>,...
   *   → { status: { [agentGroupId]: { channels: [
   *         { type, platformId, name, lastActiveAt }, ...
   *       ] } } }
   *
   * Single SQL query across all requested agents (one round trip, no
   * N+1) — same JOIN as the per-agent /admin/channels/links endpoint
   * but unrolled into a multi-agent IN(...) clause and grouped on the
   * client. Each entry carries the most recent session.last_active
   * tied to that messaging-group + agent pair so the UI can color
   * the chip ("active <24h" / "stale" / "never").
   *
   * The Web channel is included implicitly here only when there's a
   * messaging_groups row of channel_type='web' for the agent (which
   * the provision flow always creates), so callers don't need to
   * special-case it.
   */
  interface ChannelStatusEntry {
    type: string;
    platformId: string;
    name: string | null;
    lastActiveAt: string | null;
  }

  function handleChannelStatus(res: http.ServerResponse, url: string): void {
    const parsed = new URL(url, 'http://x');
    const raw = parsed.searchParams.get('agentGroupIds');
    if (!raw) {
      writeJson(res, 400, { error: 'agentGroupIds required' });
      return;
    }
    const ids = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 500);
    if (ids.length === 0) {
      writeJson(res, 200, { status: {} });
      return;
    }

    interface Row {
      agent_group_id: string;
      channel_type: string;
      platform_id: string;
      name: string | null;
      last_active: string | null;
    }

    // SQLite has no array-binding for IN clauses — build the placeholder
    // list ourselves. `ids` is already capped at 500 above.
    const placeholders = ids.map(() => '?').join(',');
    const rows = getDb()
      .prepare(
        `SELECT mga.agent_group_id AS agent_group_id,
                mg.channel_type    AS channel_type,
                mg.platform_id     AS platform_id,
                mg.name            AS name,
                (SELECT MAX(s.last_active)
                   FROM sessions s
                  WHERE s.agent_group_id     = mga.agent_group_id
                    AND s.messaging_group_id = mg.id) AS last_active
           FROM messaging_group_agents mga
           JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
          WHERE mga.agent_group_id IN (${placeholders})
          ORDER BY mga.created_at ASC`,
      )
      .all(...ids) as Row[];

    const status: Record<string, { channels: ChannelStatusEntry[] }> = {};
    for (const id of ids) status[id] = { channels: [] };
    for (const r of rows) {
      status[r.agent_group_id].channels.push({
        type: r.channel_type,
        platformId: r.platform_id,
        name: r.name,
        lastActiveAt: r.last_active,
      });
    }

    writeJson(res, 200, { status });
  }

  /**
   * Read-through chat history for the web channel.
   *
   * GET /admin/chat-history?agentGroupId=<id>&limit=50
   *   → { messages: [{ id, role, kind, content, timestamp }, ...] }
   *
   * Merges every session's `inbound.db` (web-channel rows only — we don't
   * leak Telegram/WhatsApp transcripts into the web UI) and `outbound.db`
   * under `data/v2-sessions/<agentGroupId>/<sessionId>/`, sorts by
   * timestamp ASC, returns the most recent `limit` rows.
   *
   * The endpoint stays read-only and stateless — no caching, no copies
   * to Postgres. Per the V2 privacy decision the transcript lives only
   * on the VM; this endpoint exposes it back to the web app per request
   * so users see history on reload without us persisting it anywhere
   * else. Shape conversion (content JSON → UiMessage carousel/card/text)
   * happens in the solelaclawde bridge layer, NOT here.
   *
   * Caller scoping is on the web-app side: only that user's own agent
   * group id is sent (resolved from their Supabase session), so the
   * existing bridge-token auth + the platform_id ↔ assistant mapping
   * are the only access controls in play. We deliberately do NOT
   * cross-check the agentGroupId against the bridge token's caller —
   * the web app is the trust boundary here.
   */
  function handleChatHistory(res: http.ServerResponse, url: string): void {
    const parsed = new URL(url, 'http://x');
    const agentGroupId = parsed.searchParams.get('agentGroupId');
    const limit = Math.min(Math.max(parseInt(parsed.searchParams.get('limit') ?? '50', 10) || 50, 1), 200);
    if (!agentGroupId) {
      writeJson(res, 400, { error: 'agentGroupId required' });
      return;
    }

    const sessionsRoot = path.join(DATA_DIR, 'v2-sessions', agentGroupId);
    if (!fs.existsSync(sessionsRoot)) {
      writeJson(res, 200, { messages: [] });
      return;
    }

    interface Row {
      id: string;
      role: 'user' | 'assistant';
      kind: string;
      content: string;
      timestamp: string;
      _ts: number;
    }
    const merged: Row[] = [];

    for (const sessionDirName of fs.readdirSync(sessionsRoot)) {
      if (!sessionDirName.startsWith('sess-')) continue;
      const sessionPath = path.join(sessionsRoot, sessionDirName);

      // Outbound — assistant messages, all kinds (chat / chat-sdk).
      const outDbPath = path.join(sessionPath, 'outbound.db');
      if (fs.existsSync(outDbPath)) {
        try {
          const db = new BetterSqlite3(outDbPath, { readonly: true, fileMustExist: true });
          try {
            const rows = db
              .prepare(
                `SELECT id, kind, content, timestamp
                   FROM messages_out
                  ORDER BY timestamp DESC
                  LIMIT ?`,
              )
              .all(limit) as { id: string; kind: string; content: string; timestamp: string }[];
            for (const r of rows) {
              merged.push({
                ...r,
                role: 'assistant',
                _ts: Date.parse(r.timestamp) || 0,
              });
            }
          } finally {
            db.close();
          }
        } catch (err) {
          log.warn('chat-history: failed reading outbound.db', { sessionDirName, err });
        }
      }

      // Inbound — user messages. Filter to web channel only so the web
      // UI doesn't surface Telegram/WhatsApp messages from a shared
      // agent-shared session.
      const inDbPath = path.join(sessionPath, 'inbound.db');
      if (fs.existsSync(inDbPath)) {
        try {
          const db = new BetterSqlite3(inDbPath, { readonly: true, fileMustExist: true });
          try {
            const rows = db
              .prepare(
                `SELECT id, kind, content, timestamp
                   FROM messages_in
                  WHERE channel_type = 'web'
                  ORDER BY timestamp DESC
                  LIMIT ?`,
              )
              .all(limit) as { id: string; kind: string; content: string; timestamp: string }[];
            for (const r of rows) {
              merged.push({
                ...r,
                role: 'user',
                _ts: Date.parse(r.timestamp) || 0,
              });
            }
          } finally {
            db.close();
          }
        } catch (err) {
          log.warn('chat-history: failed reading inbound.db', { sessionDirName, err });
        }
      }
    }

    // Sort ASC by timestamp, keep the most recent `limit` rows.
    merged.sort((a, b) => a._ts - b._ts);
    const trimmed = merged.slice(-limit).map((r) => ({
      id: r.id,
      role: r.role,
      kind: r.kind,
      content: r.content,
      timestamp: r.timestamp,
    }));

    writeJson(res, 200, { messages: trimmed });
  }

  /**
   * Batch "last agent activity" lookup for the admin dashboard.
   *
   * GET /admin/agent-activity?agentGroupIds=<id1>,<id2>,...
   *   → { activity: { [agentGroupId]: lastActiveAtIso | null } }
   *
   * Cheap signal: max mtime across the agent's session DB files
   * (`outbound.db` + `inbound.db` under
   * `data/v2-sessions/<agentGroupId>/sess-<id>/`). We deliberately avoid
   * opening each SQLite file and doing `SELECT MAX(timestamp)` — that
   * would be N×M DB opens for N agents × M sessions per page render.
   * File mtime is accurate to within a few seconds of the last write,
   * which is plenty for a "last active" admin column.
   *
   * Returns null for any agent that has never spawned a session yet
   * (provisioned but unused). Caps `agentGroupIds` at 500 to keep one
   * request bounded.
   */
  function handleAgentActivity(res: http.ServerResponse, url: string): void {
    const parsed = new URL(url, 'http://x');
    const raw = parsed.searchParams.get('agentGroupIds');
    if (!raw) {
      writeJson(res, 400, { error: 'agentGroupIds required' });
      return;
    }
    const ids = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 500);
    const activity: Record<string, string | null> = {};
    for (const agentGroupId of ids) {
      activity[agentGroupId] = lastActivityFor(agentGroupId);
    }
    writeJson(res, 200, { activity });
  }

  function lastActivityFor(agentGroupId: string): string | null {
    const sessionsRoot = path.join(DATA_DIR, 'v2-sessions', agentGroupId);
    if (!fs.existsSync(sessionsRoot)) return null;
    let maxMs = 0;
    let entries: string[];
    try {
      entries = fs.readdirSync(sessionsRoot);
    } catch {
      return null;
    }
    for (const sessionDirName of entries) {
      if (!sessionDirName.startsWith('sess-')) continue;
      for (const dbName of ['outbound.db', 'inbound.db']) {
        const dbPath = path.join(sessionsRoot, sessionDirName, dbName);
        try {
          const stat = fs.statSync(dbPath);
          if (stat.mtimeMs > maxMs) maxMs = stat.mtimeMs;
        } catch {
          // missing file — that session never wrote to this DB
        }
      }
    }
    return maxMs > 0 ? new Date(maxMs).toISOString() : null;
  }

  /**
   * Per-agent token + dollar-cost rollup for the admin dashboard.
   *
   * GET /admin/agent-usage?agentGroupIds=<csv>&since=<24h|7d|30d|all>
   *   → { usage: { [agentGroupId]: AgentUsage } }
   *
   * Walks each agent's `data/v2-sessions/<id>/sess-*\/usage.jsonl`
   * files — written by the container on every SDK `result` event (see
   * `container/agent-runner/src/usage-log.ts`) — sums them, returns a
   * per-agent total plus a per-model breakdown.
   *
   * The `since` window defaults to 30d; valid values are 24h | 7d | 30d
   * | all. Records older than the window are skipped during the scan
   * (cheap — we never load the whole file when we don't need to).
   *
   * `costUsd` comes straight from the SDK's `total_cost_usd` /
   * `modelUsage[m].costUSD`, which Anthropic calculates including any
   * tool/cache surcharges. We never compute pricing ourselves. The
   * admin UI should label this "estimated API cost" since users on a
   * Claude.ai subscription don't actually pay this — the auth-mode
   * distinction lives in OneCLI, not here, so this endpoint stays
   * auth-agnostic.
   */
  interface AgentUsageModelBreakdown {
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    webSearchRequests: number;
  }

  interface AgentUsageTotals {
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    webSearchRequests: number;
    turnCount: number;
    byModel: Record<string, AgentUsageModelBreakdown>;
  }

  function handleAgentUsage(res: http.ServerResponse, url: string): void {
    const parsed = new URL(url, 'http://x');
    const raw = parsed.searchParams.get('agentGroupIds');
    if (!raw) {
      writeJson(res, 400, { error: 'agentGroupIds required' });
      return;
    }
    const ids = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 500);

    const sinceParam = (parsed.searchParams.get('since') ?? '30d').toLowerCase();
    const sinceMs = parseSinceWindow(sinceParam);
    if (sinceMs === null) {
      writeJson(res, 400, { error: 'since must be one of: 24h, 7d, 30d, all' });
      return;
    }

    const usage: Record<string, AgentUsageTotals> = {};
    for (const agentGroupId of ids) {
      usage[agentGroupId] = usageFor(agentGroupId, sinceMs);
    }
    writeJson(res, 200, { usage, since: sinceParam });
  }

  /** Resolve the `since` query param to a cutoff timestamp (ms since
   * epoch). Returns `0` for "all" (no filter). Returns `null` for an
   * invalid value. */
  function parseSinceWindow(value: string): number | null {
    if (value === 'all') return 0;
    const now = Date.now();
    if (value === '24h') return now - 24 * 60 * 60 * 1000;
    if (value === '7d') return now - 7 * 24 * 60 * 60 * 1000;
    if (value === '30d') return now - 30 * 24 * 60 * 60 * 1000;
    return null;
  }

  function emptyUsage(): AgentUsageTotals {
    return {
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      webSearchRequests: 0,
      turnCount: 0,
      byModel: {},
    };
  }

  function emptyModelBreakdown(): AgentUsageModelBreakdown {
    return {
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      webSearchRequests: 0,
    };
  }

  /** Sum all `usage.jsonl` lines for one agent, dropping anything
   * outside the time window. Tolerates malformed lines — the agent's
   * reply must not be blocked by a broken usage row. */
  function usageFor(agentGroupId: string, sinceMs: number): AgentUsageTotals {
    const totals = emptyUsage();
    const sessionsRoot = path.join(DATA_DIR, 'v2-sessions', agentGroupId);
    if (!fs.existsSync(sessionsRoot)) return totals;

    let entries: string[];
    try {
      entries = fs.readdirSync(sessionsRoot);
    } catch {
      return totals;
    }

    for (const sessionDirName of entries) {
      if (!sessionDirName.startsWith('sess-')) continue;
      const filePath = path.join(sessionsRoot, sessionDirName, 'usage.jsonl');
      let content: string;
      try {
        content = fs.readFileSync(filePath, 'utf8');
      } catch {
        // File doesn't exist for this session — likely a session that
        // ran before usage logging shipped. Skip silently.
        continue;
      }
      for (const line of content.split('\n')) {
        if (!line) continue;
        let row: Record<string, unknown>;
        try {
          row = JSON.parse(line);
        } catch {
          continue;
        }
        const ts = typeof row.ts === 'string' ? Date.parse(row.ts) : NaN;
        if (Number.isNaN(ts)) continue;
        if (sinceMs > 0 && ts < sinceMs) continue;

        totals.costUsd += numOr0(row.costUsd);
        totals.inputTokens += numOr0(row.inputTokens);
        totals.outputTokens += numOr0(row.outputTokens);
        totals.cacheReadTokens += numOr0(row.cacheReadTokens);
        totals.cacheWriteTokens += numOr0(row.cacheWriteTokens);
        totals.webSearchRequests += numOr0(row.webSearchRequests);
        totals.turnCount += 1;

        const byModel = row.byModel as Record<string, Record<string, unknown>> | undefined;
        if (byModel) {
          for (const [model, mu] of Object.entries(byModel)) {
            const bucket = totals.byModel[model] ?? emptyModelBreakdown();
            bucket.costUsd += numOr0(mu.costUsd);
            bucket.inputTokens += numOr0(mu.inputTokens);
            bucket.outputTokens += numOr0(mu.outputTokens);
            bucket.cacheReadTokens += numOr0(mu.cacheReadTokens);
            bucket.cacheWriteTokens += numOr0(mu.cacheWriteTokens);
            bucket.webSearchRequests += numOr0(mu.webSearchRequests);
            totals.byModel[model] = bucket;
          }
        }
      }
    }
    return totals;
  }

  function numOr0(v: unknown): number {
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  }

  /**
   * People/contacts the agent has surfaced in its working memory.
   *
   * GET /admin/contacts?agentGroupId=<id>&limit=200
   *   → { contacts: [{ id, name, role, company, email?, linkedinUrl?,
   *                    badge?, imageUrl?, firstSeenAt }, ...] }
   *
   * Source of truth: the agent's outbound carousel messages. Whenever
   * the agent sends a `send_carousel` payload (currently used by SDR
   * for prospect picks, the shopping skill for product options, the
   * gift-finder skill for recipient ideas, etc.), every item in that
   * carousel is a "person or option the agent has surfaced" for the
   * user. We extract those items as contacts.
   *
   * Why scan the agent's memory instead of the structured Lead table:
   * the Lead table is populated only when the agent successfully calls
   * the campaigns API (campaign_add_leads). When that path fails — e.g.
   * stale session_routing → 404 on the internal-agent API — the Lead
   * table stays empty even though the agent DID surface contacts to
   * the user via carousel. Reading from outbound directly gives the
   * /contacts page a reliable "what did the agent show me" source
   * regardless of whether the structured persistence path worked.
   *
   * Dedup: items with the same title are deduped, keeping the most
   * recent occurrence (the agent often shows the same prospect across
   * iterations). The Lead table can later be re-introduced as a richer
   * source on top of this baseline (merge by name + company).
   */
  function handleContactsFromMemory(res: http.ServerResponse, url: string): void {
    const parsed = new URL(url, 'http://x');
    const agentGroupId = parsed.searchParams.get('agentGroupId');
    const limit = Math.min(Math.max(parseInt(parsed.searchParams.get('limit') ?? '200', 10) || 200, 1), 500);
    if (!agentGroupId) {
      writeJson(res, 400, { error: 'agentGroupId required' });
      return;
    }

    const sessionsRoot = path.join(DATA_DIR, 'v2-sessions', agentGroupId);
    if (!fs.existsSync(sessionsRoot)) {
      writeJson(res, 200, { contacts: [] });
      return;
    }

    interface CarouselItemRaw {
      title?: string;
      description?: string;
      imageUrl?: string;
      badge?: string;
      actionUrl?: string;
      actionLabel?: string;
    }

    interface ContactOut {
      id: string;
      name: string;
      description?: string;
      imageUrl?: string;
      badge?: string;
      actionUrl?: string;
      actionLabel?: string;
      firstSeenAt: string;
    }

    // Keep the most-recent occurrence per `title` — agent often
    // re-presents the same prospect across iterations of a batch.
    const byTitle = new Map<string, { ts: number; row: ContactOut }>();

    for (const sessionDirName of fs.readdirSync(sessionsRoot)) {
      if (!sessionDirName.startsWith('sess-')) continue;
      const outDbPath = path.join(sessionsRoot, sessionDirName, 'outbound.db');
      if (!fs.existsSync(outDbPath)) continue;
      try {
        const db = new BetterSqlite3(outDbPath, { readonly: true, fileMustExist: true });
        try {
          const rows = db
            .prepare(
              `SELECT id, content, timestamp
                 FROM messages_out
                WHERE kind = 'chat-sdk'
                ORDER BY timestamp DESC
                LIMIT ?`,
            )
            .all(limit) as { id: string; content: string; timestamp: string }[];
          for (const r of rows) {
            let payload: unknown;
            try {
              payload = JSON.parse(r.content);
            } catch {
              continue;
            }
            if (
              !payload ||
              typeof payload !== 'object' ||
              (payload as { type?: string }).type !== 'carousel' ||
              !Array.isArray((payload as { items?: unknown[] }).items)
            ) {
              continue;
            }
            const items = (payload as { items: CarouselItemRaw[] }).items;
            const ts = Date.parse(r.timestamp) || 0;
            for (const [i, it] of items.entries()) {
              if (!it.title) continue;
              const existing = byTitle.get(it.title);
              if (existing && existing.ts >= ts) continue;
              byTitle.set(it.title, {
                ts,
                row: {
                  id: `${r.id}-${i}`,
                  name: it.title,
                  description: it.description,
                  imageUrl: it.imageUrl,
                  badge: it.badge,
                  actionUrl: it.actionUrl,
                  actionLabel: it.actionLabel,
                  firstSeenAt: r.timestamp,
                },
              });
            }
          }
        } finally {
          db.close();
        }
      } catch (err) {
        log.warn('contacts-from-memory: failed reading outbound.db', { sessionDirName, err });
      }
    }

    // Sort by recency desc — most recently surfaced first.
    const contacts = [...byTitle.values()].sort((a, b) => b.ts - a.ts).map((e) => e.row);

    writeJson(res, 200, { contacts });
  }

  function handleStream(req: http.IncomingMessage, res: http.ServerResponse, url: string): void {
    const userId = decodeURIComponent(url.slice('/stream/'.length));
    if (!userId) {
      writeJson(res, 400, { error: 'userId required' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // Initial comment forces some proxies to flush headers immediately.
    res.write(': ok\n\n');

    const client: SseClient = { res, userId };
    addClient(userId, client);

    // Heartbeat every 25s — keeps idle proxies/load balancers from hanging up.
    const heartbeat = setInterval(() => {
      try {
        res.write(': hb\n\n');
      } catch {
        clearInterval(heartbeat);
      }
    }, 25000);

    const cleanup = () => {
      clearInterval(heartbeat);
      removeClient(userId, client);
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
  }

  return adapter;
}

registerChannelAdapter('web', { factory: createAdapter });
