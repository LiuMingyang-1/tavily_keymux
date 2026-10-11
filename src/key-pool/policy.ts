export interface KeyState {
  fingerprint: string;
  disabled: boolean;
  blockedUntil: number;
  reason?: string;
  successes: number;
  failures: number;
  reportedCredits: number;
}

export interface PoolState {
  version: 1;
  next: number;
  keys: Record<string, KeyState>;
}

export type FailureAction = {
  retry: boolean;
  code: string;
  disabled?: boolean;
  blockedUntil?: number;
};

export function emptyKey(fingerprint: string): KeyState {
  return {
    fingerprint,
    disabled: false,
    blockedUntil: 0,
    successes: 0,
    failures: 0,
    reportedCredits: 0,
  };
}

export function reconcile(
  state: PoolState | undefined,
  fingerprints: Record<string, string>,
): PoolState {
  const previous = state ?? { version: 1, next: 0, keys: {} };
  return {
    version: 1,
    next: previous.next,
    keys: Object.fromEntries(
      Object.entries(fingerprints).map(([id, fingerprint]) => [
        id,
        previous.keys[id]?.fingerprint === fingerprint
          ? previous.keys[id]!
          : emptyKey(fingerprint),
      ]),
    ),
  };
}

/** The caller persists the cursor before starting network I/O. */
export function selectKey(
  state: PoolState,
  excluded: readonly string[],
  now: number,
): string | undefined {
  const ids = Object.keys(state.keys).sort();
  for (let offset = 0; offset < ids.length; offset++) {
    const index = (state.next + offset) % ids.length;
    const id = ids[index]!;
    const key = state.keys[id]!;
    if (!excluded.includes(id) && !key.disabled && key.blockedUntil <= now) {
      state.next = (index + 1) % ids.length;
      return id;
    }
  }
  return undefined;
}

export function retryDelay(header: string | null, now: number): number {
  if (!header) return 60_000;
  const seconds = Number(header);
  const delay = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(header) - now;
  return Number.isFinite(delay)
    ? Math.min(3_600_000, Math.max(1000, delay))
    : 60_000;
}

export function classifyFailure(
  status: number,
  retryAfter: string | null,
  now: number,
): FailureAction {
  if (status === 401)
    return { retry: true, code: "INVALID_KEY", disabled: true };
  // A 403 is not necessarily an invalid key. Avoid permanently disabling it.
  if (status === 403)
    return { retry: true, code: "KEY_FORBIDDEN", blockedUntil: now + 300_000 };
  if (status === 432 || status === 433) {
    const date = new Date(now);
    const nextMonth = Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth() + 1,
      1,
    );
    return { retry: true, code: "QUOTA_EXHAUSTED", blockedUntil: nextMonth };
  }
  if (status === 429)
    return {
      retry: true,
      code: "RATE_LIMITED",
      blockedUntil: now + retryDelay(retryAfter, now),
    };
  if (status === 0 || status === 408 || status >= 500) {
    return {
      retry: true,
      code: "UPSTREAM_UNAVAILABLE",
      blockedUntil: now + 15_000,
    };
  }
  return { retry: false, code: "UPSTREAM_REJECTED" };
}
