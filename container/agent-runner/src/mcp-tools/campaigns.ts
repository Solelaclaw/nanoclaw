/**
 * Campaigns / Leads MCP tools — agent → SoleLaClawde web bridge.
 *
 * The SDR agent in the container uses these to persist its work:
 *   - `campaign_create` — start a new campaign on-the-fly in chat
 *   - `campaign_add_leads` — batch-insert prospects sourced from Apollo
 *   - `lead_update` — per-lead lifecycle update (drafted/approved/sent + body)
 *   - `lead_batch_status` — uniform status flip across many leads (approve all)
 *
 * All four hit `/api/internal/agent/*` on the web app, authenticated
 * with the service token `SOLELACLAWDE_AGENT_API_TOKEN` + the X-Acting-
 * Platform-Id header carrying the session's NanoClaw platform id. The
 * web app resolves that to the Supabase user + their org and scopes
 * every write accordingly.
 *
 * Soft-fail mode: if `SOLELACLAWDE_AGENT_API_TOKEN` or
 * `SOLELACLAWDE_API_URL` are not set in the container env, the tools
 * return a structured error so the agent can degrade to "chat-only,
 * no persistence" mode rather than crash. Useful for personal
 * (non-PRO) agents where the SDR workflow isn't applicable anyway.
 */
import { getSessionRouting } from '../db/session-routing.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function bridgeConfig(): { url: string; token: string } | null {
  const url = process.env.SOLELACLAWDE_API_URL;
  const token = process.env.SOLELACLAWDE_AGENT_API_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/+$/, ''), token };
}

function actingPlatformId(): string | null {
  const r = getSessionRouting();
  return r.platform_id ?? null;
}

async function bridgeFetch(
  path: string,
  init: { method: 'POST' | 'PATCH'; body?: unknown } = { method: 'POST' },
): Promise<{ status: number; data: unknown }> {
  const cfg = bridgeConfig();
  if (!cfg) {
    throw new Error(
      'SoleLaClawde bridge not configured — set SOLELACLAWDE_AGENT_API_TOKEN + SOLELACLAWDE_API_URL on the agent container. Skipping persistence; continue in chat-only mode if appropriate.',
    );
  }
  const pid = actingPlatformId();
  if (!pid) {
    throw new Error('No platform id on this session — cannot identify the acting user. Did the session_routing row get populated?');
  }
  const res = await fetch(`${cfg.url}${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      'X-Acting-Platform-Id': pid,
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  return { status: res.status, data };
}

// ─── campaign_create ─────────────────────────────────────────────────────

export const campaignCreate: McpToolDefinition = {
  tool: {
    name: 'campaign_create',
    description:
      'MANDATORY first step of any SDR workflow. Call this BEFORE searching Apollo, BEFORE drafting any emails, BEFORE showing the user anything. If you skip this and go straight to apollo_search_prospects + chat drafting, the rep loses their pipeline — work disappears the moment the session ends. Returns `{ id }` — store this campaign id and pass it to EVERY subsequent campaign_add_leads / lead_update call for this run. Name should be short and descriptive ("Outreach Q1 — SaaS VPs"). Status starts at "active". Do not proceed with prospecting until this returns 200.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Short campaign name shown in the dashboard.' },
        icpId: {
          type: 'string',
          description:
            'Optional ICP (Ideal Customer Profile) id to attach. When provided, the agent reads the saved ICP\'s criteria + value prop + voice/tone. When omitted, the campaign is "ad-hoc" — the agent uses whatever criteria the user gave in chat.',
        },
      },
      required: ['name'],
    },
  },
  async handler(args) {
    try {
      const name = args.name as string;
      const icpId = (args.icpId as string | undefined) ?? null;
      if (!name?.trim()) return err('name is required');
      const { status, data } = await bridgeFetch('/api/internal/agent/campaigns', {
        method: 'POST',
        body: { name: name.trim(), icpId },
      });
      if (status >= 400) {
        return err(`campaign_create ${status}: ${JSON.stringify(data).slice(0, 300)}`);
      }
      log(`campaign_create: ok ${JSON.stringify(data).slice(0, 120)}`);
      return ok(JSON.stringify(data));
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

// ─── campaign_add_leads ──────────────────────────────────────────────────

interface LeadInput {
  source?: 'apollo' | 'csv' | 'manual';
  apolloPersonId?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  emailVerified?: boolean;
  title?: string;
  seniority?: string;
  linkedinUrl?: string;
  location?: string;
  companyName?: string;
  companyDomain?: string;
  companyIndustry?: string;
  companyEmployees?: number;
  companySummary?: string;
}

export const campaignAddLeads: McpToolDefinition = {
  tool: {
    name: 'campaign_add_leads',
    description:
      'MANDATORY second step. Call this IMMEDIATELY after `apollo_search_prospects` returns prospects, BEFORE drafting any emails. Pass each Apollo person\'s trimmed fields (name, email, title, company, etc.) as one item in the `leads` array. Returns `{ created, ids }` — `ids` are in the same order as the input so you can use them for follow-up `lead_update` calls (writing the draft body, marking sent, etc.). Without this call, the leads exist only in your context and disappear when the session ends — the rep loses everything. Status of inserted rows is "enriched".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        campaignId: { type: 'string', description: 'Campaign id from `campaign_create`.' },
        leads: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              source: { type: 'string', enum: ['apollo', 'csv', 'manual'] },
              apolloPersonId: { type: 'string' },
              firstName: { type: 'string' },
              lastName: { type: 'string' },
              email: { type: 'string' },
              emailVerified: { type: 'boolean' },
              title: { type: 'string' },
              seniority: { type: 'string' },
              linkedinUrl: { type: 'string' },
              location: { type: 'string' },
              companyName: { type: 'string' },
              companyDomain: { type: 'string' },
              companyIndustry: { type: 'string' },
              companyEmployees: { type: 'number' },
              companySummary: { type: 'string' },
            },
          },
          minItems: 1,
          maxItems: 100,
        },
      },
      required: ['campaignId', 'leads'],
    },
  },
  async handler(args) {
    try {
      const campaignId = args.campaignId as string;
      const leads = args.leads as LeadInput[];
      if (!campaignId) return err('campaignId is required');
      if (!Array.isArray(leads) || leads.length === 0) return err('leads must be a non-empty array');
      const { status, data } = await bridgeFetch(
        `/api/internal/agent/campaigns/${encodeURIComponent(campaignId)}/leads`,
        { method: 'POST', body: { leads } },
      );
      if (status >= 400) {
        return err(`campaign_add_leads ${status}: ${JSON.stringify(data).slice(0, 300)}`);
      }
      log(`campaign_add_leads: ok ${JSON.stringify(data).slice(0, 120)}`);
      return ok(JSON.stringify(data));
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

// ─── lead_update ─────────────────────────────────────────────────────────

export const leadUpdate: McpToolDefinition = {
  tool: {
    name: 'lead_update',
    description:
      'Update one lead at a lifecycle transition. Call after drafting (`{ status: "drafted", draftSubject, draftBody }`), after the user approves it (`{ status: "approved" }`), or after Gmail confirms a send (`{ status: "sent", gmailMessageId }`). Timestamps (`draftedAt`, `sentAt`, etc.) are auto-set when the matching status is passed — you do NOT need to send them explicitly.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        leadId: { type: 'string', description: 'Lead id from `campaign_add_leads` response.' },
        status: {
          type: 'string',
          enum: [
            'new',
            'enriched',
            'drafted',
            'approved',
            'sent',
            'replied',
            'bounced',
            'unsubscribed',
            'failed',
          ],
        },
        draftSubject: { type: 'string', description: 'Email subject line (use with status: drafted).' },
        draftBody: { type: 'string', description: 'Email body — 4-6 short sentences, personalised (use with status: drafted).' },
        gmailMessageId: { type: 'string', description: 'Gmail API message id of the sent email (use with status: sent).' },
        emailVerified: { type: 'boolean', description: 'Override the email verification flag after a re-enrich.' },
      },
      required: ['leadId'],
    },
  },
  async handler(args) {
    try {
      const leadId = args.leadId as string;
      if (!leadId) return err('leadId is required');
      const body: Record<string, unknown> = {};
      const now = new Date().toISOString();
      if (typeof args.status === 'string') {
        body.status = args.status;
        // Auto-populate the timestamp column matching this status.
        if (args.status === 'drafted') body.draftedAt = now;
        else if (args.status === 'approved') body.approvedAt = now;
        else if (args.status === 'sent') body.sentAt = now;
        else if (args.status === 'replied') body.repliedAt = now;
        else if (args.status === 'bounced') body.bouncedAt = now;
      }
      if (typeof args.draftSubject === 'string') body.draftSubject = args.draftSubject;
      if (typeof args.draftBody === 'string') body.draftBody = args.draftBody;
      if (typeof args.gmailMessageId === 'string') body.gmailMessageId = args.gmailMessageId;
      if (typeof args.emailVerified === 'boolean') body.emailVerified = args.emailVerified;

      const { status, data } = await bridgeFetch(
        `/api/internal/agent/leads/${encodeURIComponent(leadId)}`,
        { method: 'PATCH', body },
      );
      if (status >= 400) {
        return err(`lead_update ${status}: ${JSON.stringify(data).slice(0, 300)}`);
      }
      return ok(JSON.stringify(data));
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

// ─── lead_batch_status ───────────────────────────────────────────────────

export const leadBatchStatus: McpToolDefinition = {
  tool: {
    name: 'lead_batch_status',
    description:
      'Flip the status of many leads at once. Use for "approve all" / "reject all" patterns when the user reviews a carousel batch. Up to 200 ids per call. Timestamp matching the status is auto-set (e.g. `approved` sets `approvedAt`). Prefer per-lead `lead_update` when you need to attach per-row data like `gmailMessageId`.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 200 },
        status: {
          type: 'string',
          enum: [
            'new',
            'enriched',
            'drafted',
            'approved',
            'sent',
            'replied',
            'bounced',
            'unsubscribed',
            'failed',
          ],
        },
      },
      required: ['ids', 'status'],
    },
  },
  async handler(args) {
    try {
      const ids = args.ids as string[];
      const status = args.status as string;
      if (!Array.isArray(ids) || ids.length === 0) return err('ids must be a non-empty array');
      if (!status) return err('status is required');
      const { status: code, data } = await bridgeFetch('/api/internal/agent/leads/batch-status', {
        method: 'POST',
        body: { ids, status, timestamp: new Date().toISOString() },
      });
      if (code >= 400) {
        return err(`lead_batch_status ${code}: ${JSON.stringify(data).slice(0, 300)}`);
      }
      log(`lead_batch_status: ${status} → ${JSON.stringify(data)}`);
      return ok(JSON.stringify(data));
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

registerTools([campaignCreate, campaignAddLeads, leadUpdate, leadBatchStatus]);
