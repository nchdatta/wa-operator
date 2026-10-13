import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** Durable inbound work: verified webhook deliveries and Telegram updates. */
export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: ['whatsapp_webhook', 'telegram_update', 'baileys_message'] }).notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    payloadJson: text('payload_json').notNull(),
    status: text('status', { enum: ['queued', 'done', 'failed'] })
      .notNull()
      .default('queued'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: integer('next_attempt_at').notNull(),
    lastError: text('last_error'),
    createdAt: integer('created_at').notNull(),
    doneAt: integer('done_at'),
  },
  (t) => [uniqueIndex('jobs_dedupe').on(t.dedupeKey), index('jobs_due').on(t.status, t.nextAttemptAt)],
);

/** One row per owner message ever handled, so a re-delivered message is never acted on twice. */
export const inboundMessages = sqliteTable('inbound_messages', {
  id: text('id').primaryKey(),
  channel: text('channel').notNull(),
  kind: text('kind').notNull(),
  receivedAt: integer('received_at').notNull(),
});

/** Single row (id = 1): the gate. */
export const operatorState = sqliteTable('operator_state', {
  id: integer('id').primaryKey(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  disabledReason: text('disabled_reason'),
  pinHash: text('pin_hash'),
  unlockedUntil: integer('unlocked_until'),
  lastActivityAt: integer('last_activity_at'),
  failedPins: integer('failed_pins').notNull().default(0),
  trusted: integer('trusted', { mode: 'boolean' }).notNull().default(false),
  /** /trust full: commands and edits run too; sends, deletes, installs, network and CRITICAL still ask. */
  fullTrust: integer('full_trust', { mode: 'boolean' }).notNull().default(false),
  /** Last Claude rate-limit info (JSON), so a restart still knows the limit was hit. */
  rateLimit: text('rate_limit'),
  /** Last time the owner messaged us (24-hour customer-service window). */
  lastOwnerMessageAt: integer('last_owner_message_at'),
  updatedAt: integer('updated_at').notNull(),
});

/** One-time tokens for PIN entry (WhatsApp Flow token or Telegram prompt). */
export const pinRequests = sqliteTable('pin_requests', {
  token: text('token').primaryKey(),
  purpose: text('purpose', { enum: ['unlock', 'approval'] }).notNull(),
  approvalId: text('approval_id'),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  usedAt: integer('used_at'),
});

/** One Claude session per day; `resume` continues it after a restart. */
export const operatorSessions = sqliteTable('operator_sessions', {
  day: text('day').primaryKey(),
  sessionId: text('session_id').notNull(),
  createdAt: integer('created_at').notNull(),
  closedAt: integer('closed_at'),
});

/** One owner instruction = one run. Only one runs at a time; the rest wait as `queued`. */
export const operatorRuns = sqliteTable(
  'operator_runs',
  {
    id: text('id').primaryKey(),
    status: text('status', { enum: ['queued', 'running', 'done', 'failed', 'stopped', 'interrupted'] }).notNull(),
    prompt: text('prompt').notNull(),
    sourceMessageId: text('source_message_id'),
    sessionId: text('session_id'),
    toolCalls: integer('tool_calls').notNull().default(0),
    tainted: integer('tainted', { mode: 'boolean' }).notNull().default(false),
    resultPreview: text('result_preview'),
    error: text('error'),
    createdAt: integer('created_at').notNull(),
    startedAt: integer('started_at'),
    finishedAt: integer('finished_at'),
  },
  (t) => [index('runs_status').on(t.status, t.createdAt)],
);

/** Tool calls waiting for (or decided by) the owner. */
export const proposedActions = sqliteTable(
  'proposed_actions',
  {
    id: text('id').primaryKey(),
    source: text('source', { enum: ['owner_tool'] }).notNull(),
    runId: text('run_id'),
    toolUseId: text('tool_use_id'),
    toolName: text('tool_name').notNull(),
    /** Redacted, truncated rendering shown on the card. */
    preview: text('preview').notNull(),
    inputHash: text('input_hash').notNull(),
    tier: text('tier', { enum: ['MEDIUM', 'HIGH', 'CRITICAL'] }).notNull(),
    reason: text('reason').notNull(),
    status: text('status', { enum: ['pending', 'approved', 'rejected', 'expired', 'edit'] }).notNull(),
    needsPin: integer('needs_pin', { mode: 'boolean' }).notNull().default(false),
    cardMessageId: text('card_message_id'),
    editNote: text('edit_note'),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    decidedAt: integer('decided_at'),
  },
  (t) => [index('actions_status').on(t.status)],
);

/** Owner-confirmed tiers for MCP tools, and tools seen for the first time (suggested tier). */
export const toolTiers = sqliteTable('tool_tiers', {
  toolName: text('tool_name').primaryKey(),
  tier: text('tier', { enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'DENY'] }),
  suggested: text('suggested').notNull(),
  firstSeenAt: integer('first_seen_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/** Messages that could not go out because the 24-hour window was closed; sent when the owner writes. */
export const deferredMessages = sqliteTable('deferred_messages', {
  id: text('id').primaryKey(),
  text: text('text').notNull(),
  createdAt: integer('created_at').notNull(),
  sentAt: integer('sent_at'),
});

export const auditEvents = sqliteTable(
  'audit_events',
  {
    id: text('id').primaryKey(),
    actor: text('actor', { enum: ['owner', 'claude', 'system', 'stranger', 'cli'] }).notNull(),
    action: text('action').notNull(),
    target: text('target'),
    outcome: text('outcome').notNull(),
    /** IDs, tiers and short redacted previews only. */
    metadataJson: text('metadata_json'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('audit_created').on(t.createdAt)],
);
