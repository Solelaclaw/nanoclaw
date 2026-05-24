/**
 * Apollo.io MCP tools — prospect search + person enrichment.
 *
 * Used by the SDR container skill to source and enrich leads from an
 * Ideal Customer Profile. The API key is injected by the OneCLI gateway
 * (host pattern `api.apollo.io` configured in the vault) or by the env
 * var `APOLLO_API_KEY` as a fallback for installs that haven't migrated
 * to OneCLI yet.
 *
 * Tool surface kept deliberately small: two endpoints cover the SDR
 * workflow.
 *  - `apollo_search_prospects` returns a paginated list of people
 *    matching ICP criteria (title, seniority, industry, company size,
 *    location).
 *  - `apollo_enrich_person` returns full details (verified email when
 *    available, LinkedIn, current role, recent news) for one person
 *    identified by email or LinkedIn URL.
 *
 * Apollo returns LOTS of fields. We trim to the SDR-relevant subset to
 * keep the agent context manageable. If the agent needs a field we
 * don't expose, add it to `pickPerson` rather than relaxing the trim.
 */
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const APOLLO_BASE = 'https://api.apollo.io/api/v1';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function getApiKey(): string | undefined {
  return process.env.APOLLO_API_KEY;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

interface ApolloPerson {
  id?: string;
  first_name?: string;
  last_name?: string;
  name?: string;
  title?: string;
  seniority?: string;
  linkedin_url?: string;
  email?: string;
  email_status?: string;
  organization?: {
    id?: string;
    name?: string;
    website_url?: string;
    industry?: string;
    estimated_num_employees?: number;
    founded_year?: number;
    short_description?: string;
    primary_domain?: string;
    headquarters_city?: string;
    headquarters_country?: string;
  };
  city?: string;
  state?: string;
  country?: string;
}

/** Trim Apollo's response to the SDR-relevant fields so the agent context
 * stays small. Returns a flat shape easier for the LLM to reason about. */
function pickPerson(p: ApolloPerson) {
  const o = p.organization;
  return {
    id: p.id,
    name: p.name ?? `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim(),
    title: p.title,
    seniority: p.seniority,
    linkedin: p.linkedin_url,
    email: p.email,
    emailVerified: p.email_status === 'verified',
    location:
      [p.city, p.state, p.country].filter(Boolean).join(', ') || undefined,
    company: o
      ? {
          name: o.name,
          industry: o.industry,
          employees: o.estimated_num_employees,
          founded: o.founded_year,
          website: o.website_url ?? (o.primary_domain ? `https://${o.primary_domain}` : undefined),
          location: [o.headquarters_city, o.headquarters_country].filter(Boolean).join(', ') || undefined,
          summary: o.short_description,
        }
      : undefined,
  };
}

async function apolloFetch(path: string, body: Record<string, unknown>): Promise<unknown> {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error(
      'APOLLO_API_KEY not configured. Ask your admin to add the Apollo secret to OneCLI (host pattern `api.apollo.io`) or set APOLLO_API_KEY on the container env.',
    );
  }
  const url = `${APOLLO_BASE}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      'x-api-key': apiKey,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Apollo ${path} → ${res.status} ${detail.slice(0, 300)}`);
  }
  return res.json();
}

export const apolloSearchProspects: McpToolDefinition = {
  tool: {
    name: 'apollo_search_prospects',
    description:
      'Search Apollo for people matching an Ideal Customer Profile. Use during prospecting to source new leads from criteria the user described (titles, seniority, industries, company size, location). Returns up to `limit` matches (default 25, max 100 per call — paginate if you need more). Always trim the returned set to the most relevant before drafting emails — the user does NOT need 100 lukewarm prospects, they need a handful of strong ones.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        titles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Job titles to match — exact-ish, e.g. ["VP of Sales", "Head of Sales"]. Apollo does fuzzy matching.',
        },
        seniorities: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['owner', 'founder', 'c_suite', 'partner', 'vp', 'head', 'director', 'manager', 'senior', 'entry', 'intern'],
          },
          description: 'Seniority levels. Combine with titles for tight targeting.',
        },
        industries: {
          type: 'array',
          items: { type: 'string' },
          description: 'Industries (Apollo industry taxonomy strings, e.g. "computer software", "marketing & advertising").',
        },
        organization_employee_ranges: {
          type: 'array',
          items: { type: 'string' },
          description: 'Company size ranges, e.g. ["1,10","11,50","51,200","201,500"].',
        },
        locations: {
          type: 'array',
          items: { type: 'string' },
          description: 'Locations (city, region, country), e.g. ["Paris, France", "United Kingdom"].',
        },
        keywords: {
          type: 'string',
          description: 'Free-text keywords searched across person and org fields. Use sparingly — narrows hard.',
        },
        limit: {
          type: 'number',
          description: 'Max number of people to return (default 25, max 100).',
        },
        page: {
          type: 'number',
          description: 'Page number (1-indexed) for pagination. Default 1.',
        },
      },
      required: [],
    },
  },
  async handler(args) {
    try {
      const limit = Math.min(Math.max((args.limit as number) ?? 25, 1), 100);
      const page = Math.max((args.page as number) ?? 1, 1);
      const body: Record<string, unknown> = {
        per_page: limit,
        page,
      };
      if (Array.isArray(args.titles) && args.titles.length) body.person_titles = args.titles;
      if (Array.isArray(args.seniorities) && args.seniorities.length) body.person_seniorities = args.seniorities;
      if (Array.isArray(args.industries) && args.industries.length) body.organization_industries = args.industries;
      if (Array.isArray(args.organization_employee_ranges) && args.organization_employee_ranges.length) {
        body.organization_num_employees_ranges = args.organization_employee_ranges;
      }
      if (Array.isArray(args.locations) && args.locations.length) body.person_locations = args.locations;
      if (typeof args.keywords === 'string' && args.keywords.trim()) body.q_keywords = args.keywords.trim();

      log(`apollo_search_prospects: ${JSON.stringify(body)}`);
      // Note: `/mixed_people/api_search` is the EXTERNAL-API variant.
      // `/mixed_people/search` returns 403 for API keys — it's the
      // internal dashboard endpoint, only callable by browser sessions.
      // Apollo's docs put `api_search` under "API → Search People".
      const result = (await apolloFetch('/mixed_people/api_search', body)) as {
        people?: ApolloPerson[];
        pagination?: { page?: number; per_page?: number; total_entries?: number; total_pages?: number };
      };

      const people = (result.people ?? []).map(pickPerson);
      const pagination = result.pagination ?? {};
      return ok(
        JSON.stringify(
          {
            people,
            pagination: {
              page: pagination.page,
              perPage: pagination.per_page,
              totalEntries: pagination.total_entries,
              totalPages: pagination.total_pages,
            },
          },
          null,
          2,
        ),
      );
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

export const apolloEnrichPerson: McpToolDefinition = {
  tool: {
    name: 'apollo_enrich_person',
    description:
      'Enrich a single person to get full details (verified email, LinkedIn, current role, company info). Use when you already have a name/email/LinkedIn URL and need depth — for example after the user pasted a list of names, or to verify deliverability of an email before sending. Pass at least ONE of: email, linkedin_url, or (first_name + last_name + organization_name). Returns the same shape as `apollo_search_prospects` items but for one person.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        email: { type: 'string', description: 'Email to look up. Highest priority match.' },
        linkedin_url: { type: 'string', description: 'LinkedIn profile URL.' },
        first_name: { type: 'string' },
        last_name: { type: 'string' },
        organization_name: { type: 'string', description: 'Current company name (for first+last+org match).' },
      },
      required: [],
    },
  },
  async handler(args) {
    try {
      const body: Record<string, unknown> = {};
      if (typeof args.email === 'string') body.email = args.email;
      if (typeof args.linkedin_url === 'string') body.linkedin_url = args.linkedin_url;
      if (typeof args.first_name === 'string') body.first_name = args.first_name;
      if (typeof args.last_name === 'string') body.last_name = args.last_name;
      if (typeof args.organization_name === 'string') body.organization_name = args.organization_name;
      if (Object.keys(body).length === 0) {
        return err('Provide at least one of: email, linkedin_url, or first_name+last_name+organization_name.');
      }

      // Apollo's docs prefer `reveal_personal_emails: true` to surface
      // unlocked emails on enrich calls. Costs an extra credit but the
      // SDR use case needs the email.
      body.reveal_personal_emails = true;

      log(`apollo_enrich_person: ${JSON.stringify({ ...body, reveal_personal_emails: undefined })}`);
      const result = (await apolloFetch('/people/match', body)) as { person?: ApolloPerson };
      if (!result.person) {
        return ok(JSON.stringify({ person: null, reason: 'no match in Apollo' }, null, 2));
      }
      return ok(JSON.stringify({ person: pickPerson(result.person) }, null, 2));
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

registerTools([apolloSearchProspects, apolloEnrichPerson]);
