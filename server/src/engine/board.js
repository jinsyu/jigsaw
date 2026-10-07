// The board of one group, as the rt server holds it in memory (spec: the server decides).
//
// Pure and synchronous: no sockets, no database, no timers. The clock (now) and the dealing
// order (random) are injected. Every action returns { result, events }: `result` answers the
// student who asked ({ ok: true, ... } or { ok: false, reason }), `events` are what the
// network layer sends to the group room, in order. Rule violations never throw.
//
// Snapping is public/js/puzzle/snap.js itself (resolveDropWithHolds), the same code the
// screens run, so the screen's instant result and the server's answer cannot differ.
//
// Rules (spec, puzzle rules 1, 2, 6, 7, 8)
// - Only the owner takes a piece out of a tray. Taking is a drop of a new one-piece
//   cluster (clamp, merges, frame) and leaves it released.
// - grab: the first one wins; locked clusters and clusters held by someone else are refused.
//   The holder grabbing again extends the hold (the screen does that while dragging).
// - A hold ends after HOLD_MS without a grab or drop from the holder, HOLD_LIMIT_MS after the
//   first grab whatever happens, or when the holder disconnects.
// - A member offline for GONE_MS loses the pieces left in the tray: they are dealt to the
//   online members of the group (late members too). With nobody online nothing moves yet.
//   A member who comes back earlier keeps the tray.
// - The first drop that locks the last piece sets completedAt.
// Expired holds and gone members are handled at the start of every action and by tick().
import { layoutFor } from '../../../public/js/puzzle/geometry.js';
import { HOLD_MS, SNAP_TOLERANCE, grabRefusal, resolveDropWithHolds } from '../../../public/js/puzzle/snap.js';
import { dealEvenly } from '../../../public/js/puzzle/deal.js';

// The longest a cluster stays held, however often the holder extends it (spec risk: a
// tampered screen could otherwise keep a cluster forever).
export const HOLD_LIMIT_MS = 60_000;
// Offline this long: the tray goes to the others (spec rule 7).
export const GONE_MS = 60_000;

const refuse = (reason, extra = {}) => ({ result: { ok: false, reason, ...extra }, events: [] });

/**
 * @param {object} options
 * @param {number} options.cols
 * @param {number} options.rows
 * @param {number} options.aspect   picture width / height
 * @param {Array<{ id: string, online?: boolean }>} options.members
 * @param {Record<string, number[]>} [options.trays]  piece indexes (row * cols + col) per member.
 *   Left out: every piece is dealt evenly to the members (a new puzzle). Pieces in no tray and
 *   no cluster stay unowned.
 * @param {Array<{ id: number, x: number, y: number, locked?: boolean, pieces: number[][],
 *   heldBy?: string|null, heldAt?: number, heldSince?: number }>} [options.clusters]
 * @param {number|null} [options.completedAt]
 * @param {number} [options.tolerance]
 * @param {() => number} options.now
 * @param {() => number} options.random  [0, 1)
 */
export function createBoard({
  cols,
  rows,
  aspect,
  members: memberList,
  trays: initialTrays,
  clusters: initialClusters = [],
  completedAt: initialCompletedAt = null,
  tolerance = SNAP_TOLERANCE,
  now,
  random,
}) {
  const layout = layoutFor(cols, rows, aspect);
  const total = cols * rows;
  const members = new Map();
  for (const m of memberList) addMemberRecord(m.id, m.online ?? true);

  let zTop = 0;
  const clusters = new Map();
  for (const c of initialClusters) {
    if (c.heldBy && !Number.isFinite(c.heldAt)) throw new RangeError(`held cluster without heldAt: ${c.id}`);
    clusters.set(c.id, {
      id: c.id,
      x: c.x,
      y: c.y,
      z: ++zTop,
      locked: c.locked === true,
      pieces: c.pieces.map(([col, row]) => [col, row]),
      heldBy: c.heldBy ?? null,
      heldAt: c.heldBy ? c.heldAt : null,
      heldSince: c.heldBy ? (c.heldSince ?? c.heldAt) : null,
    });
  }
  let nextId = Math.max(0, ...clusters.keys()) + 1;
  let completedAt = initialCompletedAt;

  if (initialTrays) {
    for (const [id, list] of Object.entries(initialTrays)) {
      if (!members.has(id)) throw new RangeError(`tray of an unknown member: ${id}`);
      members.get(id).tray = [...list];
    }
  } else {
    if (members.size === 0) throw new RangeError('a new board needs at least one member');
    const dealt = dealEvenly(allPieces(), [...members.keys()].map((id) => ({ id, count: 0 })), random);
    for (const [id, list] of Object.entries(dealt)) members.get(id).tray = list;
  }
  checkPieces();

  function addMemberRecord(id, online) {
    if (members.has(id)) throw new RangeError(`duplicate member: ${id}`);
    // A member created offline (server restart) starts the one-minute clock now.
    members.set(id, { id, online, offlineSince: online ? null : now(), tray: [] });
  }

  function allPieces() {
    return Array.from({ length: total }, (_, i) => i);
  }

  // Each piece is in at most one place (a cluster or a tray).
  function checkPieces() {
    const seen = new Set();
    const place = (piece) => {
      if (!Number.isInteger(piece) || piece < 0 || piece >= total) throw new RangeError(`bad piece: ${piece}`);
      if (seen.has(piece)) throw new RangeError(`piece in two places: ${piece}`);
      seen.add(piece);
    };
    for (const c of clusters.values()) c.pieces.forEach(([col, row]) => place(row * cols + col));
    for (const m of members.values()) m.tray.forEach(place);
  }

  const isOnline = (id) => members.get(id)?.online === true;

  function progress() {
    let placed = 0;
    for (const c of clusters.values()) if (c.locked) placed += c.pieces.length;
    return { placed, total, complete: placed === total };
  }

  function releaseHold(cluster, reason) {
    const by = cluster.heldBy;
    cluster.heldBy = null;
    cluster.heldAt = null;
    cluster.heldSince = null;
    return { type: 'release', clusterId: cluster.id, by, reason };
  }

  // Holds that ended and trays of gone members, as of now().
  function sweep() {
    const t = now();
    const events = [];
    for (const c of clusters.values()) {
      if (!c.heldBy) continue;
      if (!isOnline(c.heldBy)) events.push(releaseHold(c, 'offline'));
      else if (t - c.heldSince >= HOLD_LIMIT_MS) events.push(releaseHold(c, 'limit'));
      else if (t - c.heldAt >= HOLD_MS) events.push(releaseHold(c, 'idle'));
    }
    const gone = [...members.values()].filter((m) => !m.online && m.tray.length > 0 && t - m.offlineSince >= GONE_MS);
    const receivers = [...members.values()].filter((m) => m.online);
    if (gone.length > 0 && receivers.length > 0) {
      const fromOf = new Map(gone.flatMap((m) => m.tray.map((piece) => [piece, m.id])));
      const dealt = dealEvenly([...fromOf.keys()], receivers.map((m) => ({ id: m.id, count: m.tray.length })), random);
      for (const m of gone) m.tray = [];
      const pieces = [];
      for (const [to, list] of Object.entries(dealt)) {
        members.get(to).tray.push(...list);
        for (const piece of list) pieces.push({ piece, from: fromOf.get(piece), to });
      }
      pieces.sort((a, b) => a.piece - b.piece);
      events.push({ type: 'tray', pieces });
    }
    return events;
  }

  // Runs an action for a member after the sweep; the sweep's events come first.
  function act(memberId, action) {
    const swept = sweep();
    const member = members.get(memberId);
    const { result, events } = !member
      ? refuse('not-member')
      : !member.online
        ? refuse('offline')
        : action(member);
    return { result, events: [...swept, ...events] };
  }

  // Snap a cluster that `memberId` dropped at (x, y), with snap.js, and apply the result.
  function settle(memberId, dropped, x, y) {
    const plain = [...clusters.values()].map(({ id, x: cx, y: cy, locked, pieces, heldBy, heldAt }) => ({
      id,
      x: cx,
      y: cy,
      locked,
      pieces,
      heldBy,
      heldAt,
    }));
    const outcome = resolveDropWithHolds(
      layout,
      plain,
      { id: dropped.id, x, y },
      { me: memberId, now: now(), isOnline },
      tolerance,
    );
    for (const id of outcome.absorbed) clusters.delete(id);
    for (const next of outcome.clusters) {
      const c = clusters.get(next.id);
      c.x = next.x;
      c.y = next.y;
      c.locked = next.locked;
      c.pieces = next.pieces.map(([col, row]) => [col, row]);
    }
    const survivor = clusters.get(outcome.id);
    survivor.z = Math.max(survivor.z, dropped.z);
    if (survivor.heldBy === memberId) releaseHold(survivor, 'drop');
    const done = { placed: outcome.placed, total: outcome.total, complete: outcome.complete };
    const completedNow = done.complete && completedAt === null;
    if (completedNow) completedAt = now();
    const fields = {
      id: survivor.id,
      x: survivor.x,
      y: survivor.y,
      z: survivor.z,
      locked: survivor.locked,
      absorbed: [...outcome.absorbed],
      progress: done,
    };
    return { fields, completedNow };
  }

  const validPosition = (x, y) => Number.isFinite(x) && Number.isFinite(y);

  function takeFromTray(memberId, piece, x, y) {
    return act(memberId, (member) => {
      const at = member.tray.indexOf(piece);
      if (at < 0) return refuse('not-in-tray');
      if (!validPosition(x, y)) return refuse('bad-position');
      member.tray.splice(at, 1);
      const cluster = {
        id: nextId++,
        x,
        y,
        z: ++zTop,
        locked: false,
        pieces: [[piece % cols, Math.floor(piece / cols)]],
        heldBy: null,
        heldAt: null,
        heldSince: null,
      };
      clusters.set(cluster.id, cluster);
      const { fields, completedNow } = settle(member.id, cluster, x, y);
      const events = [{ type: 'take', by: member.id, piece, clusterId: cluster.id, ...fields }];
      if (completedNow) events.push({ type: 'complete', completedAt });
      return { result: { ok: true, piece, clusterId: cluster.id, ...fields, completedAt }, events };
    });
  }

  function grab(memberId, clusterId) {
    return act(memberId, (member) => {
      const cluster = clusters.get(clusterId);
      if (!cluster) return refuse('not-found');
      const t = now();
      const refusal = grabRefusal(cluster, member.id, t, isOnline);
      if (refusal === 'held') return refuse('held', { heldBy: cluster.heldBy });
      if (refusal) return refuse(refusal);
      const extending = cluster.heldBy === member.id;
      if (!extending) {
        cluster.heldSince = t;
        cluster.z = ++zTop;
      }
      cluster.heldBy = member.id;
      cluster.heldAt = t;
      const event = { type: 'grab', by: member.id, clusterId, z: cluster.z, heldAt: t };
      return { result: { ok: true, z: cluster.z, heldAt: t }, events: [event] };
    });
  }

  function drop(memberId, clusterId, x, y) {
    return act(memberId, (member) => {
      const cluster = clusters.get(clusterId);
      if (!cluster) return refuse('not-found');
      if (cluster.locked) return refuse('locked');
      if (cluster.heldBy !== member.id) return refuse('not-held');
      if (!validPosition(x, y)) return refuse('bad-position');
      const { fields, completedNow } = settle(member.id, cluster, x, y);
      const events = [{ type: 'drop', by: member.id, clusterId, ...fields }];
      if (completedNow) events.push({ type: 'complete', completedAt });
      return { result: { ok: true, clusterId, ...fields, completedAt }, events };
    });
  }

  // Lets go without moving (the screen was hidden). clusterId null: everything I hold.
  function release(memberId, clusterId = null) {
    return act(memberId, (member) => {
      if (clusterId === null) {
        const mine = [...clusters.values()].filter((c) => c.heldBy === member.id);
        return { result: { ok: true }, events: mine.map((c) => releaseHold(c, 'request')) };
      }
      const cluster = clusters.get(clusterId);
      if (!cluster) return refuse('not-found');
      if (cluster.heldBy !== member.id) return refuse('not-held');
      return { result: { ok: true }, events: [releaseHold(cluster, 'request')] };
    });
  }

  function memberOnline(memberId) {
    const events = sweep();
    const member = members.get(memberId);
    if (!member || member.online) return events;
    member.online = true;
    member.offlineSince = null;
    return [...events, { type: 'member', memberId, online: true }];
  }

  function memberOffline(memberId) {
    const member = members.get(memberId);
    if (!member || !member.online) return sweep();
    member.online = false;
    member.offlineSince = now();
    // The sweep sees the holder offline and lets go of everything they held.
    return [...sweep(), { type: 'member', memberId, online: false }];
  }

  // Off the board and in nobody's tray (left behind when the last member moved away).
  function unownedPieces() {
    const placed = new Set();
    for (const c of clusters.values()) c.pieces.forEach(([col, row]) => placed.add(row * cols + col));
    for (const m of members.values()) m.tray.forEach((piece) => placed.add(piece));
    return allPieces().filter((piece) => !placed.has(piece));
  }

  // A member who joins after the start: no tray, plays with the pieces on the board, except
  // that pieces in nobody's tray (the group had been left empty) go to this member.
  function addMember(memberId, { online = true } = {}) {
    if (members.has(memberId)) return [];
    const events = sweep();
    addMemberRecord(memberId, online);
    events.push({ type: 'member', memberId, online });
    const unowned = unownedPieces();
    if (unowned.length > 0) {
      members.get(memberId).tray.push(...unowned);
      events.push({ type: 'tray', pieces: unowned.map((piece) => ({ piece, from: null, to: memberId })) });
    }
    return events;
  }

  // A member moved to another group (or out of every group): holds end, and the tray goes to
  // the online members left (everyone left when nobody is online; nobody when the group is empty,
  // then the next member added gets it).
  function removeMember(memberId) {
    const events = sweep();
    const member = members.get(memberId);
    if (!member) return events;
    for (const c of clusters.values()) if (c.heldBy === memberId) events.push(releaseHold(c, 'moved'));
    members.delete(memberId);
    const left = [...members.values()];
    const online = left.filter((m) => m.online);
    const receivers = online.length > 0 ? online : left;
    const dealt = dealEvenly(member.tray, receivers.map((m) => ({ id: m.id, count: m.tray.length })), random);
    const pieces = [];
    for (const [to, list] of Object.entries(dealt)) {
      members.get(to).tray.push(...list);
      for (const piece of list) pieces.push({ piece, from: memberId, to });
    }
    if (pieces.length > 0) events.push({ type: 'tray', pieces: pieces.sort((a, b) => a.piece - b.piece) });
    events.push({ type: 'leave', memberId });
    return events;
  }

  function tick() {
    return sweep();
  }

  // Plain data for screens, the overview and saving (no names: members are ids only).
  function getState() {
    return {
      cols,
      rows,
      aspect,
      clusters: [...clusters.values()]
        .sort((a, b) => a.z - b.z)
        .map((c) => ({ ...c, pieces: c.pieces.map(([col, row]) => [col, row]) })),
      trays: Object.fromEntries([...members.values()].map((m) => [m.id, [...m.tray]])),
      members: [...members.values()].map((m) => ({ id: m.id, online: m.online })),
      progress: progress(),
      completedAt,
    };
  }

  return { takeFromTray, grab, drop, release, memberOnline, memberOffline, addMember, removeMember, tick, getState };
}
