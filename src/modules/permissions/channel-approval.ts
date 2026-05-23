/**
 * Unknown-channel registration flow — SOLELACLAWDE V2 overlay.
 *
 * The only behavioral change from upstream is the delivery-null branch:
 *   - upstream: if `pickApprovalDelivery` returns null, log a warning and
 *     return WITHOUT creating a `pending_channel_approvals` row.
 *   - V2:       always create the row (with `approver_user_id = approvers[0]`
 *     as a fallback when no DM is reachable). The web inbox claims the row
 *     via the /admin/pending-approvals API. DM delivery is best-effort.
 *
 * Rationale: SoleLaClawde users have no NanoClaw DM channel by default. The
 * org-scoped inbox is the canonical approval surface; the DM card is a
 * fallback for owners who happen to be wired into a chat platform.
 *
 * Keep this file in sync with upstream `nanoclaw/src/modules/permissions/
 * channel-approval.ts` — the install.sh overlay clobbers the upstream file.
 */
import { normalizeOptions, type NormalizedOption, type RawOption } from '../../channels/ask-question.js';
import { createAgentGroup, getAgentGroup, getAgentGroupByFolder, getAllAgentGroups } from '../../db/agent-groups.js';
import { getChannelAdapter } from '../../channels/channel-registry.js';
import { getMessagingGroup, updateMessagingGroup } from '../../db/messaging-groups.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { initGroupFilesystem } from '../../group-init.js';
import { log } from '../../log.js';
import type { InboundEvent } from '../../channels/adapter.js';
import type { AgentGroup } from '../../types.js';
import { pickApprovalDelivery, pickApprover } from '../approvals/primitive.js';
import { createPendingChannelApproval, hasInFlightChannelApproval } from './db/pending-channel-approvals.js';
import { hasAdminPrivilege } from './db/user-roles.js';

// ── Value constants (response handler in index.ts parses these) ──

export const CONNECT_PREFIX = 'connect:';
export const NEW_AGENT_VALUE = 'new_agent';
export const CHOOSE_EXISTING_VALUE = 'choose_existing';
export const REJECT_VALUE = 'reject';

// ── Utilities ──

function toFolder(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'unnamed'
  );
}

// ── Card builders ──

function visibleAgentGroupsForApprover(
  agentGroups: AgentGroup[],
  approverUserId: string | null | undefined,
): AgentGroup[] {
  if (!approverUserId) return agentGroups;
  return agentGroups.filter((agentGroup) => hasAdminPrivilege(approverUserId, agentGroup.id));
}

function buildApprovalOptions(agentGroups: AgentGroup[], approverUserId?: string | null): RawOption[] {
  const visibleAgentGroups = visibleAgentGroupsForApprover(agentGroups, approverUserId);
  const options: RawOption[] = [];
  if (visibleAgentGroups.length === 1) {
    options.push({
      label: `Connect to ${visibleAgentGroups[0].name}`,
      selectedLabel: `✅ Connected to ${visibleAgentGroups[0].name}`,
      value: `${CONNECT_PREFIX}${visibleAgentGroups[0].id}`,
    });
  } else if (visibleAgentGroups.length > 1) {
    options.push({
      label: 'Choose existing agent',
      selectedLabel: '📋 Choosing…',
      value: CHOOSE_EXISTING_VALUE,
    });
  }
  options.push({
    label: 'Connect new agent',
    selectedLabel: '🆕 Connecting new agent…',
    value: NEW_AGENT_VALUE,
  });
  options.push({
    label: 'Reject',
    selectedLabel: '🙅 Rejected',
    value: REJECT_VALUE,
  });
  return options;
}

function buildQuestionText(
  isGroup: boolean,
  senderName: string | undefined,
  channelName: string | null,
  channelType: string,
): string {
  const who = senderName ?? 'Someone';
  if (isGroup) {
    const where = channelName ? `${channelName} on ${channelType}` : `a ${channelType} channel`;
    return `${who} mentioned your bot in ${where}. How would you like to handle this channel?`;
  }
  return `${who} sent your bot a DM on ${channelType}. How would you like to handle it?`;
}

// ── Main flow ──

export interface RequestChannelApprovalInput {
  messagingGroupId: string;
  event: InboundEvent;
}

export async function requestChannelApproval(input: RequestChannelApprovalInput): Promise<void> {
  const { messagingGroupId, event } = input;

  if (hasInFlightChannelApproval(messagingGroupId)) {
    log.debug('Channel registration already in flight — dropping retry', { messagingGroupId });
    return;
  }

  const agentGroups = getAllAgentGroups();
  if (agentGroups.length === 0) {
    log.warn('Channel registration skipped — no agent groups configured. Run /init-first-agent.', {
      messagingGroupId,
    });
    return;
  }
  // Use first agent group for approver resolution — owners and global admins
  // are returned regardless of which group we pass.
  const referenceGroup = agentGroups[0];

  const approvers = pickApprover(referenceGroup.id);
  if (approvers.length === 0) {
    log.warn('Channel registration skipped — no owner or admin configured', {
      messagingGroupId,
      targetAgentGroupId: referenceGroup.id,
    });
    return;
  }

  const originMg = getMessagingGroup(messagingGroupId);
  const originChannelType = originMg?.channel_type ?? '';

  // Resolve channel name if not yet persisted.
  if (originMg && !originMg.name) {
    const channelAdapter = getChannelAdapter(originChannelType);
    if (channelAdapter?.resolveChannelName) {
      try {
        const name = await channelAdapter.resolveChannelName(originMg.platform_id);
        if (name) {
          updateMessagingGroup(originMg.id, { name });
          originMg.name = name;
        }
      } catch {
        /* non-critical */
      }
    }
  }

  // V2 behavioural change ↓ — create the pending row even when no DM delivery
  // is reachable. The org-scoped web inbox claims it via the admin API.
  const delivery = await pickApprovalDelivery(approvers, originChannelType);
  const approverUserId = delivery?.userId ?? approvers[0];

  const isGroup = event.message?.isGroup ?? originMg?.is_group === 1;

  let senderName: string | undefined;
  try {
    const parsed = JSON.parse(event.message.content) as Record<string, unknown>;
    senderName = (parsed.senderName ?? parsed.sender) as string | undefined;
  } catch {
    // non-critical
  }

  const channelName = originMg?.name ?? null;
  const title = isGroup ? '📣 Bot mentioned in new channel' : '💬 New direct message';
  const question = buildQuestionText(isGroup, senderName, channelName, originChannelType);
  const options = normalizeOptions(buildApprovalOptions(agentGroups, delivery.userId));

  createPendingChannelApproval({
    messaging_group_id: messagingGroupId,
    agent_group_id: referenceGroup.id,
    original_message: JSON.stringify(event),
    approver_user_id: approverUserId,
    created_at: new Date().toISOString(),
    title,
    options_json: JSON.stringify(options),
  });

  // No DM reachable → row is created, inbox will surface it, return early.
  if (!delivery) {
    log.info('Channel approval row created without DM delivery — claim via inbox', {
      messagingGroupId,
      approverUserId,
    });
    return;
  }

  const adapter = getDeliveryAdapter();
  if (!adapter) {
    log.error('Channel registration row created but no delivery adapter is wired', { messagingGroupId });
    return;
  }

  try {
    await adapter.deliver(
      delivery.messagingGroup.channel_type,
      delivery.messagingGroup.platform_id,
      null,
      'chat-sdk',
      JSON.stringify({
        type: 'ask_question',
        questionId: messagingGroupId,
        title,
        question,
        options,
      }),
    );
    log.info('Channel registration card delivered', {
      messagingGroupId,
      agentGroupCount: agentGroups.length,
      approver: delivery.userId,
    });
  } catch (err) {
    log.error('Channel registration card delivery failed', { messagingGroupId, err });
  }
}

// ── Helpers for the response handler (index.ts) ──

/**
 * Build normalized options for the agent-selection follow-up card.
 */
export function buildAgentSelectionOptions(
  agentGroups: AgentGroup[],
  approverUserId?: string | null,
): NormalizedOption[] {
  const visibleAgentGroups = visibleAgentGroupsForApprover(agentGroups, approverUserId);
  const options: RawOption[] = visibleAgentGroups.map((ag) => ({
    label: ag.name,
    selectedLabel: `✅ Connected to ${ag.name}`,
    value: `${CONNECT_PREFIX}${ag.id}`,
  }));
  options.push({
    label: 'Cancel',
    selectedLabel: '🙅 Cancelled',
    value: REJECT_VALUE,
  });
  return normalizeOptions(options);
}

/**
 * Create a new agent group and initialize its filesystem. Handles
 * folder-name collisions with numeric suffixes.
 */
export function createNewAgentGroup(name: string): AgentGroup {
  let folder = toFolder(name);
  const baseFolder = folder;
  let suffix = 2;
  while (getAgentGroupByFolder(folder)) {
    folder = `${baseFolder}-${suffix}`;
    suffix++;
  }

  const agId = `ag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  createAgentGroup({
    id: agId,
    name,
    folder,
    agent_provider: null,
    created_at: new Date().toISOString(),
  });

  const ag = getAgentGroup(agId)!;
  initGroupFilesystem(ag);
  return ag;
}
