export const TIERS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'DENY'] as const;
export type Tier = (typeof TIERS)[number];

export function rank(t: Tier): number {
  return TIERS.indexOf(t);
}

export function maxTier(...ts: Tier[]): Tier {
  return ts.reduce((a, b) => (rank(b) > rank(a) ? b : a), 'LOW' as Tier);
}

/** One step up, never past CRITICAL (DENY stays DENY). */
export function bump(t: Tier): Tier {
  if (t === 'DENY' || t === 'CRITICAL') return t;
  return TIERS[rank(t) + 1]!;
}

export function isTier(v: string): v is Tier {
  return (TIERS as readonly string[]).includes(v);
}
