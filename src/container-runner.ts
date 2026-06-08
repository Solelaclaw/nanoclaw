/**
 * Container Runner v2
 * Spawns agent containers with session folder + agent group folder mounts.
 * The container runs the v2 agent-runner which polls the session DB.
 */
import { ChildProcess, execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import {
  CONTAINER_IMAGE,
  CONTAINER_IMAGE_BASE,
  CONTAINER_INSTALL_LABEL,
  DATA_DIR,
  GROUPS_DIR,
  ONECLI_API_KEY,
  ONECLI_ORG_API_KEY,
  ONECLI_URL,
  TIMEZONE,
} from './config.js';
import { fetchAgentOneCliConfig } from './onecli-per-user.js';
import { materializeContainerJson } from './container-config.js';
import { getContainerConfig } from './db/container-configs.js';
import { updateContainerConfigScalars, updateContainerConfigJson } from './db/container-configs.js';
import { CONTAINER_RUNTIME_BIN, hostGatewayArgs, readonlyMountArgs, stopContainer } from './container-runtime.js';
import { composeGroupClaudeMd } from './claude-md-compose.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getDb, hasTable } from './db/connection.js';
import { initGroupFilesystem } from './group-init.js';
import { stopTypingRefresh } from './modules/typing/index.js';
import { log } from './log.js';
import { validateAdditionalMounts } from './modules/mount-security/index.js';
// Provider host-side config barrel — each provider that needs host-side
// container setup self-registers on import.
import './providers/index.js';
import {
  getProviderContainerConfig,
  type ProviderContainerContribution,
  type VolumeMount,
} from './providers/provider-container-registry.js';
import {
  heartbeatPath,
  markContainerRunning,
  markContainerStopped,
  sessionDir,
  writeSessionRouting,
} from './session-manager.js';
import type { AgentGroup, Session } from './types.js';
import { getMessagingGroup } from './db/messaging-groups.js';

const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });

/** Active containers tracked by session ID. */
const activeContainers = new Map<string, { process: ChildProcess; containerName: string }>();

/**
 * In-flight wake promises, keyed by session id. Deduplicates concurrent
 * `wakeContainer` calls while the first spawn is still mid-setup (async
 * buildContainerArgs, OneCLI gateway apply, etc.) — otherwise a second
 * wake in that window passes the `activeContainers.has` check and spawns
 * a duplicate container against the same session directory, producing
 * racy double-replies.
 */
const wakePromises = new Map<string, Promise<boolean>>();

export function getActiveContainerCount(): number {
  return activeContainers.size;
}

export function isContainerRunning(sessionId: string): boolean {
  return activeContainers.has(sessionId);
}

/**
 * Wake up a container for a session. If already running or mid-spawn, no-op
 * (the in-flight wake promise is reused).
 *
 * The container runs the v2 agent-runner which polls the session DB.
 *
 * Contract: never throws. Returns `true` on successful spawn, `false` on
 * transient spawn failure (e.g. OneCLI gateway unreachable). Callers don't
 * need to wrap — the inbound row stays pending and host-sweep retries on
 * its next tick. Callers that care (e.g. the router's typing indicator)
 * can branch on the boolean.
 */
export function wakeContainer(session: Session): Promise<boolean> {
  if (activeContainers.has(session.id)) {
    log.debug('Container already running', { sessionId: session.id });
    return Promise.resolve(true);
  }
  const existing = wakePromises.get(session.id);
  if (existing) {
    log.debug('Container wake already in-flight — joining existing promise', { sessionId: session.id });
    return existing;
  }
  const promise = spawnContainer(session)
    .then(() => true)
    .catch((err) => {
      log.warn('wakeContainer failed — host-sweep will retry', { sessionId: session.id, err });
      return false;
    })
    .finally(() => {
      wakePromises.delete(session.id);
    });
  wakePromises.set(session.id, promise);
  return promise;
}

async function spawnContainer(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    log.error('Agent group not found', { agentGroupId: session.agent_group_id });
    return;
  }

  // Refresh the destination map and default reply routing so any admin
  // changes take effect on wake. Destinations come from the agent-to-agent
  // module — skip when the module isn't installed (table absent).
  if (hasTable(getDb(), 'agent_destinations')) {
    const { writeDestinations } = await import('./modules/agent-to-agent/write-destinations.js');
    writeDestinations(agentGroup.id, session.id);
  }
  writeSessionRouting(agentGroup.id, session.id);

  // Materialize container.json from DB — writes fresh file and returns
  // the config object, threaded through provider resolution, buildMounts,
  // and buildContainerArgs so we don't re-read.
  const containerConfig = materializeContainerJson(agentGroup.id);

  // Resolve the effective provider + any host-side contribution it declares
  // (extra mounts, env passthrough). Computed once and threaded through both
  // buildMounts and buildContainerArgs so side effects (mkdir, etc.) fire once.
  const { provider, contribution } = resolveProviderContribution(session, agentGroup, containerConfig);

  const mounts = buildMounts(agentGroup, session, containerConfig, contribution);
  const containerName = `nanoclaw-v2-${agentGroup.folder}-${Date.now()}`;
  // OneCLI agent identifier is always the agent group id — stable across
  // sessions and reversible via getAgentGroup() for approval routing.
  const agentIdentifier = agentGroup.id;
  const args = await buildContainerArgs(
    mounts,
    containerName,
    agentGroup,
    containerConfig,
    provider,
    contribution,
    session,
    agentIdentifier,
  );

  log.info('Spawning container', { sessionId: session.id, agentGroup: agentGroup.name, containerName });

  // Clear any orphan heartbeat from a previous container instance — the
  // sweep's ceiling check treats a missing file as "fresh spawn, give grace"
  // (host-sweep.ts line 87). Without this, the stale mtime can trigger an
  // immediate kill before the new container touches the file itself.
  fs.rmSync(heartbeatPath(agentGroup.id, session.id), { force: true });

  const container = spawn(CONTAINER_RUNTIME_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  activeContainers.set(session.id, { process: container, containerName });
  markContainerRunning(session.id);

  // Log stderr
  container.stderr?.on('data', (data) => {
    for (const line of data.toString().trim().split('\n')) {
      if (line) log.debug(line, { container: agentGroup.folder });
    }
  });

  // stdout is unused in v2 (all IO is via session DB)
  container.stdout?.on('data', () => {});

  // No host-side idle timeout. Stale/stuck detection is driven by the host
  // sweep reading heartbeat mtime + processing_ack claim age + container_state
  // (see src/host-sweep.ts). This avoids killing long-running legitimate work
  // on a wall-clock timer.

  container.on('close', (code) => {
    activeContainers.delete(session.id);
    markContainerStopped(session.id);
    stopTypingRefresh(session.id);
    log.info('Container exited', { sessionId: session.id, code, containerName });
  });

  container.on('error', (err) => {
    activeContainers.delete(session.id);
    markContainerStopped(session.id);
    stopTypingRefresh(session.id);
    log.error('Container spawn error', { sessionId: session.id, err });
  });
}

/** Kill a container for a session. */
export function killContainer(sessionId: string, reason: string, onExit?: () => void): void {
  const entry = activeContainers.get(sessionId);
  if (!entry) return;

  if (onExit) {
    entry.process.once('close', onExit);
  }

  log.info('Killing container', { sessionId, reason, containerName: entry.containerName });
  try {
    stopContainer(entry.containerName);
  } catch {
    entry.process.kill('SIGKILL');
  }
}

/**
 * Resolve the provider name for a session:
 *
 *   sessions.agent_provider
 *     → container_configs.provider
 *     → 'claude'
 *
 * Pure so the precedence can be unit-tested without a DB or filesystem.
 */
export function resolveProviderName(
  sessionProvider: string | null | undefined,
  containerConfigProvider: string | null | undefined,
): string {
  return (sessionProvider || containerConfigProvider || 'claude').toLowerCase();
}

function resolveProviderContribution(
  session: Session,
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
): { provider: string; contribution: ProviderContainerContribution } {
  const provider = resolveProviderName(session.agent_provider, containerConfig.provider);
  const fn = getProviderContainerConfig(provider);
  const contribution = fn
    ? fn({
        sessionDir: sessionDir(agentGroup.id, session.id),
        agentGroupId: agentGroup.id,
        hostEnv: process.env,
      })
    : {};
  return { provider, contribution };
}

function buildMounts(
  agentGroup: AgentGroup,
  session: Session,
  containerConfig: import('./container-config.js').ContainerConfig,
  providerContribution: ProviderContainerContribution,
): VolumeMount[] {
  const projectRoot = process.cwd();

  // Per-group filesystem state lives forever after first creation. Init is
  // idempotent: it only writes paths that don't already exist, so this call
  // is a no-op for groups that have spawned before.
  initGroupFilesystem(agentGroup);

  // Sync skill symlinks based on container.json selection before mounting.
  const claudeDir = path.join(DATA_DIR, 'v2-sessions', agentGroup.id, '.claude-shared');
  syncSkillSymlinks(claudeDir, containerConfig);

  // Compose CLAUDE.md fresh every spawn from the shared base, enabled skill
  // fragments, and MCP server instructions. See `claude-md-compose.ts`.
  composeGroupClaudeMd(agentGroup);

  const mounts: VolumeMount[] = [];
  const sessDir = sessionDir(agentGroup.id, session.id);
  const groupDir = path.resolve(GROUPS_DIR, agentGroup.folder);

  // Session folder at /workspace (contains inbound.db, outbound.db, outbox/, .claude/)
  mounts.push({ hostPath: sessDir, containerPath: '/workspace', readonly: false });

  // Agent group folder at /workspace/agent (RW for working files + CLAUDE.local.md)
  mounts.push({ hostPath: groupDir, containerPath: '/workspace/agent', readonly: false });

  // container.json — nested RO mount on top of RW group dir so the agent
  // can read its config but cannot modify it.
  const containerJsonPath = path.join(groupDir, 'container.json');
  if (fs.existsSync(containerJsonPath)) {
    mounts.push({ hostPath: containerJsonPath, containerPath: '/workspace/agent/container.json', readonly: true });
  }

  // Composer-managed CLAUDE.md artifacts — nested RO mounts. These are
  // regenerated from the shared base + fragments on every spawn; any
  // agent-side writes would be clobbered, so enforce read-only. Only
  // CLAUDE.local.md (per-group memory) remains RW via the group-dir mount.
  // `.claude-shared.md` is a symlink whose target (`/app/CLAUDE.md`) is
  // already RO-mounted, so writes through it fail regardless — no need for
  // a nested mount there.
  const composedClaudeMd = path.join(groupDir, 'CLAUDE.md');
  if (fs.existsSync(composedClaudeMd)) {
    mounts.push({ hostPath: composedClaudeMd, containerPath: '/workspace/agent/CLAUDE.md', readonly: true });
  }
  const fragmentsDir = path.join(groupDir, '.claude-fragments');
  if (fs.existsSync(fragmentsDir)) {
    mounts.push({ hostPath: fragmentsDir, containerPath: '/workspace/agent/.claude-fragments', readonly: true });
  }

  // Global memory directory — always read-only.
  const globalDir = path.join(GROUPS_DIR, 'global');
  if (fs.existsSync(globalDir)) {
    mounts.push({ hostPath: globalDir, containerPath: '/workspace/global', readonly: true });
  }

  // Shared CLAUDE.md — read-only, imported by the composed entry point via
  // the `.claude-shared.md` symlink inside the group dir.
  const sharedClaudeMd = path.join(process.cwd(), 'container', 'CLAUDE.md');
  if (fs.existsSync(sharedClaudeMd)) {
    mounts.push({ hostPath: sharedClaudeMd, containerPath: '/app/CLAUDE.md', readonly: true });
  }

  // Per-group .claude-shared at /home/node/.claude (Claude state, settings,
  // skill symlinks)
  mounts.push({ hostPath: claudeDir, containerPath: '/home/node/.claude', readonly: false });

  // Shared agent-runner source — read-only, same code for all groups.
  const agentRunnerSrc = path.join(projectRoot, 'container', 'agent-runner', 'src');
  mounts.push({ hostPath: agentRunnerSrc, containerPath: '/app/src', readonly: true });

  // Shared skills — read-only, symlinks in .claude-shared/skills/ point here.
  const skillsSrc = path.join(projectRoot, 'container', 'skills');
  if (fs.existsSync(skillsSrc)) {
    mounts.push({ hostPath: skillsSrc, containerPath: '/app/skills', readonly: true });
  }

  // Additional mounts from container config
  if (containerConfig.additionalMounts && containerConfig.additionalMounts.length > 0) {
    const validated = validateAdditionalMounts(containerConfig.additionalMounts, agentGroup.name);
    mounts.push(...validated);
  }

  // Provider-contributed mounts (e.g. opencode-xdg)
  if (providerContribution.mounts) {
    mounts.push(...providerContribution.mounts);
  }

  return mounts;
}

/**
 * Sync skill symlinks in .claude-shared/skills/ to match the container.json
 * selection. Each symlink points to a container path (/app/skills/<name>)
 * so it's dangling on the host but valid inside the container.
 */
function syncSkillSymlinks(claudeDir: string, containerConfig: import('./container-config.js').ContainerConfig): void {
  const skillsDir = path.join(claudeDir, 'skills');
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
  }

  // Determine desired skill set
  const projectRoot = process.cwd();
  const sharedSkillsDir = path.join(projectRoot, 'container', 'skills');
  let desired: string[];
  if (containerConfig.skills === 'all') {
    // Recompute from shared dir — newly-added upstream skills appear automatically
    desired = fs.existsSync(sharedSkillsDir)
      ? fs.readdirSync(sharedSkillsDir).filter((e) => {
          try {
            return fs.statSync(path.join(sharedSkillsDir, e)).isDirectory();
          } catch {
            return false;
          }
        })
      : [];
  } else {
    desired = containerConfig.skills;
  }

  const desiredSet = new Set(desired);

  // Remove symlinks not in the desired set
  for (const entry of fs.readdirSync(skillsDir)) {
    const entryPath = path.join(skillsDir, entry);
    let isSymlink = false;
    try {
      isSymlink = fs.lstatSync(entryPath).isSymbolicLink();
    } catch {
      continue;
    }
    if (isSymlink && !desiredSet.has(entry)) {
      fs.unlinkSync(entryPath);
    }
  }

  // Create symlinks for desired skills (container path targets)
  for (const skill of desired) {
    const linkPath = path.join(skillsDir, skill);
    let exists = false;
    try {
      fs.lstatSync(linkPath);
      exists = true;
    } catch {
      /* missing */
    }
    if (!exists) {
      fs.symlinkSync(`/app/skills/${skill}`, linkPath);
    }
  }
}

async function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
  provider: string,
  providerContribution: ProviderContainerContribution,
  session: Session,
  agentIdentifier?: string,
): Promise<string[]> {
  const args: string[] = ['run', '--rm', '--name', containerName, '--label', CONTAINER_INSTALL_LABEL];

  // SoleLaClawde fork customization: apply per-container resource caps so one
  // user can't OOM the host on the shared multi-tenant install. Defaults
  // (1 GB RAM, 0.5 vCPU) are conservative; tune via env at the host level
  // when sizing the exe.dev VM. Setting either to empty string disables it.
  const memMax = process.env.SOLELACLAWDE_AGENT_MEMORY_MAX ?? '1g';
  const cpuMax = process.env.SOLELACLAWDE_AGENT_CPU_MAX ?? '0.5';
  if (memMax) args.push('--memory', memMax, '--memory-swap', memMax);
  if (cpuMax) args.push('--cpus', cpuMax);

  // Environment — only vars read by code we don't own.
  // Everything NanoClaw-specific is in container.json (read by runner at startup).
  args.push('-e', `TZ=${TIMEZONE}`);

  // SoleLaClawde bridge env — the SDR agent's `campaigns_*` MCP tools
  // read these to call the internal API on the web app for persisting
  // Lead rows and lifecycle status flips. Optional: when unset, the
  // tools surface a clean "bridge not configured" error to the agent
  // and the workflow can still run in chat-only mode without
  // persistence.
  if (process.env.SOLELACLAWDE_AGENT_API_TOKEN) {
    args.push('-e', `SOLELACLAWDE_AGENT_API_TOKEN=${process.env.SOLELACLAWDE_AGENT_API_TOKEN}`);
  }
  args.push('-e', `SOLELACLAWDE_API_URL=${process.env.SOLELACLAWDE_API_URL ?? 'https://app.solela.ai'}`);

  // OpenTelemetry — let the agent-runner inside the container emit
  // per-channel / per-model token + cost metrics. Container-shape
  // identity becomes resource attributes on every datapoint;
  // OTLP transport env (endpoint + optional headers) pass through
  // so swapping backends doesn't need a container rebuild.
  args.push('-e', `NANOCLAW_AGENT_GROUP_ID=${session.agent_group_id}`);
  args.push('-e', `NANOCLAW_SESSION_ID=${session.id}`);
  if (session.messaging_group_id) {
    const mg = getMessagingGroup(session.messaging_group_id);
    if (mg?.channel_type) {
      args.push('-e', `NANOCLAW_CHANNEL_TYPE=${mg.channel_type}`);
    }
  }
  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    args.push('-e', `OTEL_EXPORTER_OTLP_ENDPOINT=${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}`);
  }
  if (process.env.OTEL_EXPORTER_OTLP_HEADERS) {
    args.push('-e', `OTEL_EXPORTER_OTLP_HEADERS=${process.env.OTEL_EXPORTER_OTLP_HEADERS}`);
  }
  if (process.env.NANOCLAW_AGENT_RUNNER_VERSION) {
    args.push('-e', `NANOCLAW_AGENT_RUNNER_VERSION=${process.env.NANOCLAW_AGENT_RUNNER_VERSION}`);
  }

  // Apollo API key — used by the apollo_search_prospects /
  // apollo_enrich_person MCP tools. The host-side env is the source of
  // truth for now; longer-term this moves into OneCLI's vault (host
  // pattern `api.apollo.io`) so per-user keys can override.
  if (process.env.APOLLO_API_KEY) {
    args.push('-e', `APOLLO_API_KEY=${process.env.APOLLO_API_KEY}`);
  }

  // Provider-contributed env vars (e.g. XDG_DATA_HOME, OPENCODE_*, NO_PROXY).
  if (providerContribution.env) {
    for (const [key, value] of Object.entries(providerContribution.env)) {
      args.push('-e', `${key}=${value}`);
    }
  }

  // OneCLI gateway — injects HTTPS_PROXY + certs so container API calls
  // are routed through the agent vault for credential injection. Treated as
  // a transient hard failure: if we can't wire the gateway, we don't spawn.
  // The caller (router or host-sweep) catches the throw, leaves the inbound
  // message pending, and the next sweep tick retries.
  //
  // SoleLaClawde V2.4 split (web channel vs everything else):
  //
  //  - Web-channel agents (folder `web-*`): each Solela user has their
  //    OWN OneCLI project (`solela-<id>`) + agent (`me`) + per-agent
  //    token provisioned by the web app at signup. We fetch that token
  //    from the web app's internal API, construct a per-USER OneCLI SDK
  //    client, and use IT for `applyContainerConfig`. The gateway is
  //    then scoped to the user's own project: org-level secrets (the
  //    Anthropic LLM key) auto-apply + project-level secrets (per-user
  //    OAuth tokens from /api/connect/<app>) inject only for that user.
  //
  //    We do NOT call `ensureAgent` for web users. The SDK's version
  //    hits the legacy `POST /api/agents` endpoint, which doesn't
  //    accept per-agent regenerated tokens (returns 401 — only project
  //    or org keys are honoured there). It's also unnecessary: the
  //    web app already POSTs the agent via `/v1/agents` during
  //    `backfillOneCliProvisioning` at signup. The agent is guaranteed
  //    to exist by the time we get here.
  //
  //  - Non-web channels (Telegram, Slack, WhatsApp, …): keep the legacy
  //    single-project behavior — they're not yet on V2.4, and their
  //    OneCLI identity is the agent_group_id under the shared project
  //    bound to ONECLI_API_KEY.
  //
  // If web-channel config fetch fails, we DO NOT silently fall back to
  // the legacy host key — that would re-create the cross-tenant leak
  // V2.4 exists to close. We throw, the inbound stays pending, the
  // sweep retries.
  const isWebChannelAgent = agentGroup.folder.startsWith('web-');
  if (isWebChannelAgent) {
    if (!ONECLI_ORG_API_KEY) {
      throw new Error(
        'ONECLI_ORG_API_KEY not set on the VM — required for V2.4 per-user gateway provisioning. Add it to /home/exedev/nanoclaw/.env and restart nanoclaw.service.',
      );
    }
    const userCfg = await fetchAgentOneCliConfig(agentGroup.id);
    if (!userCfg) {
      throw new Error(
        `Web-channel agent ${agentGroup.id}: failed to fetch per-user OneCLI config from web app — refusing to spawn (no fallback to legacy shared key, that would re-leak across tenants)`,
      );
    }

    // Per-user TZ override — the web app captures the user's IANA
    // timezone on /chat mount and ships it here via the bridge. We
    // patch the `TZ=…` arg we already pushed (line ~426) with the
    // user's value so the agent's "tomorrow 3pm" lands on THEIR
    // wall clock instead of the VM host's. Null/missing falls back
    // to the host TIMEZONE constant (the original behaviour).
    if (userCfg.timezone) {
      // args was filled earlier as [..., '-e', `TZ=<HOST_TZ>`, ...].
      // Find that exact entry and rewrite it. Searching by prefix
      // 'TZ=' keeps the patch resilient to upstream re-ordering of
      // the args list.
      const tzIdx = args.findIndex((a) => typeof a === 'string' && a.startsWith('TZ='));
      if (tzIdx !== -1) {
        args[tzIdx] = `TZ=${userCfg.timezone}`;
        log.info('Per-user TZ applied to container', {
          agentGroupId: agentGroup.id,
          timezone: userCfg.timezone,
        });
      }
    }
    // The SDK's `applyContainerConfig` only sends `Authorization: Bearer`
    // — no `X-Project-Id` header. So even with the org-scoped admin key
    // it can't tell OneCLI which project to scope to. And the SDK's
    // public `applyContainerConfig` options don't expose a `projectId`
    // override either.
    //
    // We replicate what the SDK does internally, but add the
    // `X-Project-Id` header so OneCLI scopes the returned gateway
    // config to the user's own `solela-<id>` project — same auth
    // combo we already use successfully against /v1/projects,
    // /v1/agents, /v1/secrets via our typed client on Vercel.
    //
    // Result: container's HTTPS_PROXY + CA cert wired to a gateway
    // view scoped to the user's project. Org-scope secrets (the
    // Anthropic LLM key) auto-apply across projects → chat works.
    // Per-user OAuth tokens (from /api/connect/<app>, stored in
    // `solela-<id>`) inject only for their owner.
    const cfgUrl = `${ONECLI_URL.replace(/\/+$/, '')}/api/container-config?agent=${encodeURIComponent(userCfg.agentIdentifier)}`;
    const cfgRes = await fetch(cfgUrl, {
      headers: {
        Authorization: `Bearer ${ONECLI_ORG_API_KEY}`,
        'X-Project-Id': userCfg.projectId,
      },
    });
    if (!cfgRes.ok) {
      const body = await cfgRes.text().catch(() => '');
      throw new Error(`OneCLI /api/container-config ${cfgRes.status}: ${body.slice(0, 200)}`);
    }
    const cfg = (await cfgRes.json()) as {
      env: Record<string, string>;
      caCertificate: string;
      caCertificateContainerPath: string;
    };

    for (const [k, v] of Object.entries(cfg.env)) {
      args.push('-e', `${k}=${v}`);
    }
    // Per-agent cert path avoids collisions on concurrent spawns of
    // different users (each gets their own file, mounted RO).
    const certHostPath = path.join(DATA_DIR, 'onecli-ca', `${agentGroup.id}.crt`);
    fs.mkdirSync(path.dirname(certHostPath), { recursive: true });
    fs.writeFileSync(certHostPath, cfg.caCertificate);
    args.push('-v', `${certHostPath}:${cfg.caCertificateContainerPath}:ro`);

    log.info('OneCLI per-user gateway applied (org-key + X-Project-Id)', {
      containerName,
      projectId: userCfg.projectId,
      agentIdentifier: userCfg.agentIdentifier,
      envKeys: Object.keys(cfg.env),
    });
  } else {
    if (agentIdentifier) {
      await onecli.ensureAgent({ name: agentGroup.name, identifier: agentIdentifier });
    }
    const onecliApplied = await onecli.applyContainerConfig(args, {
      addHostMapping: false,
      agent: agentIdentifier,
    });
    if (!onecliApplied) {
      throw new Error('OneCLI gateway not applied — refusing to spawn container without credentials');
    }
    log.info('OneCLI gateway applied', { containerName });
  }

  // Host gateway
  args.push(...hostGatewayArgs());

  // User mapping
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  // Volume mounts
  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  // Override entrypoint: run v2 entry point directly via Bun (no tsc, no stdin).
  args.push('--entrypoint', 'bash');

  // Use per-agent-group image if one has been built, otherwise base image
  const imageTag = containerConfig.imageTag || CONTAINER_IMAGE;
  args.push(imageTag);

  args.push('-c', 'exec bun run /app/src/index.ts');

  return args;
}

/** Build a per-agent-group Docker image with custom packages. */
export async function buildAgentGroupImage(agentGroupId: string): Promise<void> {
  const agentGroup = getAgentGroup(agentGroupId);
  if (!agentGroup) throw new Error('Agent group not found');

  const configRow = getContainerConfig(agentGroup.id);
  if (!configRow) throw new Error('Container config not found');
  const aptPackages = JSON.parse(configRow.packages_apt) as string[];
  const npmPackages = JSON.parse(configRow.packages_npm) as string[];
  if (aptPackages.length === 0 && npmPackages.length === 0) {
    throw new Error('No packages to install. Use install_packages first.');
  }

  let dockerfile = `FROM ${CONTAINER_IMAGE}\nUSER root\n`;
  if (aptPackages.length > 0) {
    dockerfile += `RUN apt-get update && apt-get install -y ${aptPackages.join(' ')} && rm -rf /var/lib/apt/lists/*\n`;
  }
  if (npmPackages.length > 0) {
    // pnpm skips build scripts unless packages are allowlisted. Append each
    // to /root/.npmrc (base image sets it up for agent-browser) so packages
    // with postinstall — e.g. playwright, puppeteer, native addons — don't
    // install silently broken.
    const allowlist = npmPackages.map((p) => `echo 'only-built-dependencies[]=${p}' >> /root/.npmrc`).join(' && ');
    dockerfile += `RUN ${allowlist} && pnpm install -g ${npmPackages.join(' ')}\n`;
  }
  dockerfile += 'USER node\n';

  const imageTag = `${CONTAINER_IMAGE_BASE}:${agentGroupId}`;

  log.info('Building per-agent-group image', { agentGroupId, imageTag, apt: aptPackages, npm: npmPackages });

  // Write Dockerfile to temp file and build
  const tmpDockerfile = path.join(DATA_DIR, `Dockerfile.${agentGroupId}`);
  fs.writeFileSync(tmpDockerfile, dockerfile);
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} build -t ${imageTag} -f ${tmpDockerfile} .`, {
      cwd: DATA_DIR,
      stdio: 'pipe',
      timeout: 900_000,
    });
  } finally {
    fs.unlinkSync(tmpDockerfile);
  }

  // Store the image tag in the DB
  updateContainerConfigScalars(agentGroup.id, { image_tag: imageTag });

  log.info('Per-agent-group image built', { agentGroupId, imageTag });
}
