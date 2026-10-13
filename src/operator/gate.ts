import crypto from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { and, eq, isNull } from 'drizzle-orm';
import { audit } from '../audit.js';
import type { AppContext } from '../context.js';
import { immediate } from '../persistence/db.js';
import { operatorState, pinRequests } from '../persistence/schema.js';
import { MINUTE } from '../shared/clock.js';

export const MAX_PIN_FAILURES = 3;
const PIN_TOKEN_TTL = 10 * MINUTE;
export const PIN_RE = /^\d{4,12}$/;

export type OperatorState = typeof operatorState.$inferSelect;

export type PinResult =
  | { ok: true; purpose: 'unlock' | 'approval'; approvalId: string | null }
  | { ok: false; reason: 'bad_token' | 'disabled' | 'no_pin' | 'locked_out'; remaining?: number }
  | { ok: false; reason: 'wrong'; remaining: number; purpose: 'unlock' | 'approval'; approvalId: string | null };

/** Milliseconds until the next local midnight in `timeZone`. */
export function msUntilMidnight(now: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(now));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const elapsed = ((get('hour') * 60 + get('minute')) * 60 + get('second')) * 1000 + (now % 1000);
  return 24 * 3600_000 - elapsed;
}

/** Local calendar day, e.g. "2026-10-13". */
export function dayKey(now: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(now),
  );
}

/**
 * The gate in front of Claude: Operator Mode on/off, the daily PIN unlock, the idle lock,
 * 3-strike lockout (re-enable at the PC only) and trusted mode.
 */
export class Gate {
  constructor(private readonly ctx: AppContext) {}

  state(): OperatorState {
    const row = this.ctx.db.select().from(operatorState).where(eq(operatorState.id, 1)).get();
    if (row) return row;
    this.ctx.db
      .insert(operatorState)
      .values({ id: 1, enabled: this.ctx.config.OPERATOR_ENABLED, updatedAt: this.ctx.clock.now() })
      .onConflictDoNothing()
      .run();
    return this.ctx.db.select().from(operatorState).where(eq(operatorState.id, 1)).get()!;
  }

  private update(set: Partial<OperatorState>): void {
    this.state();
    this.ctx.db
      .update(operatorState)
      .set({ ...set, updatedAt: this.ctx.clock.now() })
      .where(eq(operatorState.id, 1))
      .run();
  }

  private pinHash(): string | null {
    return this.state().pinHash ?? this.ctx.config.OPERATOR_PIN_HASH ?? null;
  }

  hasPin(): boolean {
    return this.pinHash() !== null;
  }

  /** Unlocked = enabled, PIN entered today, and active within the idle limit. */
  isUnlocked(): boolean {
    const s = this.state();
    const now = this.ctx.clock.now();
    if (!s.enabled || !s.unlockedUntil || s.unlockedUntil <= now) return false;
    const idleMs = this.ctx.config.OPERATOR_IDLE_MIN * MINUTE;
    return s.lastActivityAt !== null && now - s.lastActivityAt < idleMs;
  }

  /** Keep the idle timer fresh while the owner is active or a task runs. */
  touch(): void {
    if (this.isUnlocked()) this.update({ lastActivityAt: this.ctx.clock.now() });
  }

  recordOwnerMessage(at: number): void {
    this.update({ lastOwnerMessageAt: Math.max(at, this.state().lastOwnerMessageAt ?? 0) });
  }

  /** Create a one-time PIN token (bound to an approval for CRITICAL actions). */
  newPinToken(purpose: 'unlock' | 'approval', approvalId: string | null = null): string {
    const token = crypto.randomBytes(16).toString('hex');
    const now = this.ctx.clock.now();
    this.ctx.db
      .insert(pinRequests)
      .values({ token, purpose, approvalId, createdAt: now, expiresAt: now + PIN_TOKEN_TTL })
      .run();
    return token;
  }

  async submitPin(token: string, pin: string): Promise<PinResult> {
    const now = this.ctx.clock.now();
    const req = this.ctx.db
      .select()
      .from(pinRequests)
      .where(and(eq(pinRequests.token, token), isNull(pinRequests.usedAt)))
      .get();
    if (!req || req.expiresAt <= now) {
      audit(this.ctx, { actor: 'owner', action: 'pin.submit', outcome: 'bad_token' });
      return { ok: false, reason: 'bad_token' };
    }
    const s = this.state();
    if (!s.enabled) return { ok: false, reason: s.disabledReason === 'lockout' ? 'locked_out' : 'disabled' };
    const stored = this.pinHash();
    if (!stored) return { ok: false, reason: 'no_pin' };

    const good = PIN_RE.test(pin) && (await verify(stored, pin).catch(() => false));
    // Re-check and record atomically so two racing submissions cannot both pass or both miss a strike.
    return immediate(this.ctx.db, (): PinResult => {
      const fresh = this.ctx.db.select().from(pinRequests).where(eq(pinRequests.token, token)).get();
      if (!fresh || fresh.usedAt) return { ok: false, reason: 'bad_token' };
      if (!good) {
        const failed = this.state().failedPins + 1;
        if (failed >= MAX_PIN_FAILURES) {
          this.update({ failedPins: failed, enabled: false, disabledReason: 'lockout', unlockedUntil: null });
          this.ctx.db.update(pinRequests).set({ usedAt: now }).where(isNull(pinRequests.usedAt)).run();
          audit(this.ctx, { actor: 'owner', action: 'pin.submit', outcome: 'locked_out', metadata: { failed } });
          return { ok: false, reason: 'locked_out' };
        }
        this.update({ failedPins: failed });
        audit(this.ctx, { actor: 'owner', action: 'pin.submit', outcome: 'wrong', metadata: { failed } });
        this.ctx.db.update(pinRequests).set({ usedAt: now }).where(eq(pinRequests.token, token)).run();
        return {
          ok: false,
          reason: 'wrong',
          remaining: MAX_PIN_FAILURES - failed,
          purpose: req.purpose,
          approvalId: req.approvalId,
        };
      }
      this.ctx.db.update(pinRequests).set({ usedAt: now }).where(eq(pinRequests.token, token)).run();
      const set: Partial<OperatorState> = { failedPins: 0, lastActivityAt: now };
      if (req.purpose === 'unlock') set.unlockedUntil = now + msUntilMidnight(now, this.ctx.config.BUSINESS_TIMEZONE);
      this.update(set);
      audit(this.ctx, { actor: 'owner', action: 'pin.submit', outcome: 'ok', metadata: { purpose: req.purpose } });
      return { ok: true, purpose: req.purpose, approvalId: req.approvalId };
    });
  }

  lock(reason: string): void {
    this.update({ unlockedUntil: null });
    audit(this.ctx, { actor: 'system', action: 'gate.lock', outcome: reason });
  }

  // ---- PC-side controls (CLI) ----

  enable(): void {
    this.update({ enabled: true, disabledReason: null, failedPins: 0 });
    audit(this.ctx, { actor: 'cli', action: 'gate.enable', outcome: 'ok' });
  }

  disable(reason = 'disabled at the PC'): void {
    this.update({ enabled: false, disabledReason: reason, unlockedUntil: null });
    audit(this.ctx, { actor: 'cli', action: 'gate.disable', outcome: reason });
  }

  async setPin(pin: string): Promise<void> {
    if (!PIN_RE.test(pin)) throw new Error('The PIN must be 4 to 12 digits.');
    if (/^(\d)\1+$/.test(pin) || '0123456789012'.includes(pin) || '9876543210987'.includes(pin))
      throw new Error('Pick a PIN that is not a repeated or sequential run of digits.');
    this.update({ pinHash: await hash(pin), failedPins: 0, unlockedUntil: null });
    audit(this.ctx, { actor: 'cli', action: 'gate.set_pin', outcome: 'ok' });
  }

  /** off, on (MEDIUM runs) or full (MEDIUM and most HIGH run). */
  setTrusted(level: boolean | 'full'): void {
    this.update({ trusted: level !== false, fullTrust: level === 'full' });
    audit(this.ctx, {
      actor: 'owner',
      action: 'gate.trusted',
      outcome: level === 'full' ? 'full' : level ? 'on' : 'off',
    });
  }
}
