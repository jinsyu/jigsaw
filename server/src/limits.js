// Small in-memory limiters. Keys are client addresses or socket ids; they are never logged.

// At most `limit` hits per key in each window of windowMs.
export function createWindowLimiter({ limit, windowMs, now = Date.now }) {
  const windows = new Map();
  return {
    hit(key) {
      const t = now();
      let w = windows.get(key);
      if (!w || t - w.start >= windowMs) {
        w = { start: t, count: 0 };
        windows.set(key, w);
      }
      w.count += 1;
      return w.count <= limit;
    },
    prune() {
      const t = now();
      for (const [key, w] of windows) if (t - w.start >= windowMs) windows.delete(key);
    },
  };
}

// ratePerSecond with bursts up to `burst`, for one socket.
export function createTokenBucket({ ratePerSecond, burst = ratePerSecond * 2, now = Date.now }) {
  let tokens = burst;
  let last = now();
  return {
    take() {
      const t = now();
      tokens = Math.min(burst, tokens + ((t - last) / 1000) * ratePerSecond);
      last = t;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  };
}

// Wrong class codes per address. A whole school can share one address (NAT), and a class
// starting together makes typos too, so every successful join in the same window raises the
// allowance: blocked when wrong > limit + successes * bonusPerJoin. While blocked, every join
// from that address is refused for blockMs (a right code too, or guessing would still pay off).
export function createWrongCodeGuard({ limit, bonusPerJoin = 0, windowMs, blockMs, now = Date.now }) {
  const windows = new Map(); // key -> { start, wrong, joined }
  const blockedUntil = new Map();

  function windowOf(key) {
    const t = now();
    let w = windows.get(key);
    if (!w || t - w.start >= windowMs) {
      w = { start: t, wrong: 0, joined: 0 };
      windows.set(key, w);
    }
    return w;
  }

  return {
    blocked(key) {
      const until = blockedUntil.get(key);
      if (until === undefined) return false;
      if (now() < until) return true;
      blockedUntil.delete(key);
      return false;
    },
    fail(key) {
      const w = windowOf(key);
      w.wrong += 1;
      if (w.wrong > limit + w.joined * bonusPerJoin) blockedUntil.set(key, now() + blockMs);
    },
    succeed(key) {
      windowOf(key).joined += 1;
    },
    prune() {
      const t = now();
      for (const [key, w] of windows) if (t - w.start >= windowMs) windows.delete(key);
      for (const [key, until] of blockedUntil) if (t >= until) blockedUntil.delete(key);
    },
  };
}

// Open sockets per address and in total.
export function createConnectionCounter({ maxTotal, maxPerKey }) {
  const perKey = new Map();
  let total = 0;
  return {
    tryOpen(key) {
      const n = perKey.get(key) ?? 0;
      if (total >= maxTotal || n >= maxPerKey) return false;
      perKey.set(key, n + 1);
      total += 1;
      return true;
    },
    close(key) {
      const n = perKey.get(key) ?? 0;
      if (n <= 1) perKey.delete(key);
      else perKey.set(key, n - 1);
      total = Math.max(0, total - 1);
    },
    get total() {
      return total;
    },
  };
}
