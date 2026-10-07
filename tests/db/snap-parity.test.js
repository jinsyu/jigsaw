// T5 (D7): the SQL snap check gives exactly the JS result for every case of
// tests/fixtures/snap-cases.json.
// 1. Pure: jigsaw_private.resolve_drop + jigsaw_private.held_by_other vs snap.js resolveDropWithHolds,
//    bit for bit (Object.is on every coordinate), and within 1e-9 of the fixture.
// 2. RPC: the same case laid out in a real group and played through jigsaw.drop (and
//    jigsaw.take_from_tray when the dropped cluster is one piece), compared with JS.
import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HOLD_MS, SNAP_TOLERANCE } from '../../public/js/puzzle/snap.js';
import {
  NOW,
  byOf,
  expectCaseResult,
  onlineOf,
  runCase,
  table,
} from '../fixtures/snap-case.js';
import { TEACHERS, addMember, cleanup, deleteSessions, sql, studentClient } from './helpers.js';

// Fixed uids for the pure check (labels in the fixture: me, amy, ...).
const PURE_UIDS = {
  me: '00000000-0000-4000-8000-00000000000a',
  amy: '00000000-0000-4000-8000-00000000000b',
  ben: '00000000-0000-4000-8000-00000000000c',
};

async function sqlResolve(input) {
  const online = onlineOf(input);
  const clusters = input.clusters.map((c) => ({
    id: c.id,
    x: c.x,
    y: c.y,
    locked: c.locked === true,
    pieces: c.pieces,
    holder: c.heldBy ? PURE_UIDS[c.heldBy] : null,
    heldMsAgo: c.heldMsAgo ?? 0,
    holderOnline: c.heldBy ? online.includes(c.heldBy) : false,
  }));
  const { rows } = await sql(
    `select jigsaw_private.resolve_drop($1, $2, $3,
       coalesce((
         select jsonb_agg(jsonb_build_object(
           'id', c -> 'id', 'x', c -> 'x', 'y', c -> 'y', 'locked', c -> 'locked', 'pieces', c -> 'pieces',
           'held', (c ->> 'id')::bigint <> $5 and jigsaw_private.held_by_other(
             (c ->> 'holder')::uuid,
             $9::timestamptz - (c ->> 'heldMsAgo')::integer * interval '1 millisecond',
             (c ->> 'holderOnline')::boolean,
             $10::uuid,
             $9::timestamptz)))
         from jsonb_array_elements($4::jsonb) c), '[]'::jsonb),
       $5, $6, $7, $8) as r`,
    [
      input.grid.cols,
      input.grid.rows,
      input.grid.aspect,
      JSON.stringify(clusters),
      input.drop.id,
      input.drop.x,
      input.drop.y,
      input.tolerance,
      new Date(NOW).toISOString(),
      PURE_UIDS[byOf(input)],
    ],
  );
  return rows[0].r;
}

// Same value and same bits (no rounding anywhere on the way).
function expectSameBits(sqlResult, jsResult) {
  expect(sqlResult).toEqual(jsResult);
  expect(Object.is(sqlResult.x, jsResult.x)).toBe(true);
  expect(Object.is(sqlResult.y, jsResult.y)).toBe(true);
  sqlResult.clusters.forEach((c, i) => {
    expect(Object.is(c.x, jsResult.clusters[i].x)).toBe(true);
    expect(Object.is(c.y, jsResult.clusters[i].y)).toBe(true);
  });
}

describe('pure SQL resolve_drop = snap.js resolveDropWithHolds', () => {
  afterAll(cleanup);

  it('shares the tolerance with snap.js and the fixture', async () => {
    const { rows } = await sql('select jigsaw_private.snap_tolerance() as tol');
    expect(rows[0].tol).toBe(SNAP_TOLERANCE);
    expect(rows[0].tol).toBe(table.defaultTolerance);
  });

  it('uses the same 10 second hold boundary as snap.js', async () => {
    const { rows } = await sql(
      `select jigsaw_private.held_by_other($1, $3::timestamptz - $4::integer * interval '1 ms', true, $2, $3) as before,
              jigsaw_private.held_by_other($1, $3::timestamptz - $5::integer * interval '1 ms', true, $2, $3) as at`,
      [PURE_UIDS.amy, PURE_UIDS.me, new Date(NOW).toISOString(), HOLD_MS - 1, HOLD_MS],
    );
    expect(rows[0]).toEqual({ before: true, at: false });
  });

  it('refuses a locked dropped cluster like snap.js does', async () => {
    const clusters = JSON.stringify([{ id: 1, x: 0, y: 0, locked: true, pieces: [[0, 0]] }]);
    await expect(
      sql('select jigsaw_private.resolve_drop(4, 3, $1, $2::jsonb, 1, 10, 10, 40)', [4 / 3, clusters]),
    ).rejects.toMatchObject({ code: '22023', message: 'dropped_cluster_locked' });
  });

  describe.each(table.cases)('$name', ({ input, expected }) => {
    it('SQL and JS agree bit for bit and match the fixture', async () => {
      const fromSql = await sqlResolve(input);
      const fromJs = runCase(input);
      expectSameBits(fromSql, fromJs);
      expectCaseResult(fromSql, expected);
    });
  });
});

// ---------------------------------------------------------------------------
// The same cases through the RPCs
// ---------------------------------------------------------------------------

describe('drop / take_from_tray RPCs = snap.js for every case', () => {
  const sessionIds = [];
  const students = {};

  beforeAll(async () => {
    for (const label of ['me', 'amy', 'ben']) students[label] = await studentClient();
  });

  afterAll(async () => {
    await deleteSessions(sessionIds);
    await cleanup();
  });

  async function insertPlayingSession({ cols, rows, aspect }) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const { rows: inserted } = await sql(
          `insert into jigsaw.sessions
             (teacher_id, code, builtin_key, piece_count, cols, rows, aspect, seed, status, started_at)
           values ($1, $2, 'test-scene', $3, $4, $5, $6, $7, 'playing', now()) returning id`,
          [
            TEACHERS.one.id,
            String(randomInt(0, 1_000_000)).padStart(6, '0'),
            cols * rows,
            cols,
            rows,
            aspect,
            randomInt(1, 2 ** 32),
          ],
        );
        sessionIds.push(Number(inserted[0].id));
        return Number(inserted[0].id);
      } catch (error) {
        if (error.code !== '23505') throw error;
      }
    }
    throw new Error('could not pick a free session code');
  }

  // Lays the case out in a new group. Case cluster ids map to real ids in the same order
  // (tie-breaks depend on id order). Cells not in any case cluster are tray pieces of
  // nobody. mode 'take': the dropped one-piece cluster starts in my tray instead.
  async function layOut(input, mode) {
    const { cols, rows, aspect } = input.grid;
    const sessionId = await insertPlayingSession({ cols, rows, aspect });
    const { rows: group } = await sql(
      'insert into jigsaw.groups (session_id, number) values ($1, 1) returning id',
      [sessionId],
    );
    const groupId = Number(group[0].id);

    const online = onlineOf(input);
    const labels = new Set([byOf(input), ...online, ...input.clusters.map((c) => c.heldBy).filter(Boolean)]);
    let color = 0;
    for (const label of labels) {
      await addMember(sessionId, students[label].userId, groupId, color++);
      const seen = label === byOf(input) || online.includes(label) ? 'now()' : "now() - interval '1 minute'";
      await sql(`update jigsaw.members set last_seen = ${seen} where session_id = $1 and user_id = $2`, [
        sessionId,
        students[label].userId,
      ]);
    }

    const used = new Set(input.clusters.flatMap((c) => c.pieces.map(([col, row]) => `${col},${row}`)));
    const spare = [];
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) if (!used.has(`${col},${row}`)) spare.push([col, row]);
    }
    const ordered = [...input.clusters].sort((a, b) => a.id - b.id);
    const { rows: seq } = await sql(
      `select nextval(pg_get_serial_sequence('jigsaw.clusters', 'id')) as id
       from generate_series(1, $1) order by 1`,
      [ordered.length + spare.length],
    );
    const realIds = seq.map((r) => Number(r.id));
    const toReal = new Map(ordered.map((c, i) => [c.id, realIds[i]]));
    const toCase = new Map(ordered.map((c, i) => [realIds[i], c.id]));
    const me = students[byOf(input)].userId;

    for (const [i, c] of ordered.entries()) {
      const dropped = c.id === input.drop.id;
      const locksForJs = c.heldBy && c.heldMsAgo < HOLD_MS;
      // Keep the hold on the same side of the 10 s line by the time the RPC runs; the
      // exact boundary is covered by the pure check above.
      const heldAt = locksForJs ? "now() - interval '2 seconds'" : `now() - interval '${c.heldMsAgo ?? 0} milliseconds'`;
      const holder = dropped ? me : c.heldBy ? students[c.heldBy].userId : null;
      await sql(
        `insert into jigsaw.clusters (id, group_id, x, y, locked, grabbed_by, grabbed_at, z)
         overriding system value
         values ($1, $2, $3, $4, $5, $6, case when $6::uuid is null then null else ${dropped ? 'now()' : heldAt} end, $7)`,
        [realIds[i], groupId, c.x, c.y, c.locked === true, mode === 'take' && dropped ? null : holder, i + 1],
      );
      const inTray = mode === 'take' && dropped;
      for (const [col, row] of c.pieces) {
        await sql(
          `insert into jigsaw.pieces (group_id, col, "row", cluster_id, owner_id, on_board)
           values ($1, $2, $3, $4, $5, $6)`,
          [groupId, col, row, realIds[i], inTray ? me : null, !inTray],
        );
      }
    }
    for (const [j, [col, row]] of spare.entries()) {
      const id = realIds[ordered.length + j];
      await sql('insert into jigsaw.clusters (id, group_id) overriding system value values ($1, $2)', [id, groupId]);
      await sql(
        'insert into jigsaw.pieces (group_id, col, "row", cluster_id) values ($1, $2, $3, $4)',
        [groupId, col, row, id],
      );
    }
    return { groupId, toReal, toCase };
  }

  async function boardOf(groupId, toCase) {
    const { rows } = await sql(
      `select c.id, c.x, c.y, c.locked, c.grabbed_by,
              json_agg(json_build_array(p.col, p."row") order by p."row", p.col) as pieces
       from jigsaw.clusters c join jigsaw.pieces p on p.cluster_id = c.id and p.on_board
       where c.group_id = $1 group by c.id order by c.id`,
      [groupId],
    );
    return rows.map((r) => ({
      id: toCase.get(Number(r.id)),
      x: r.x,
      y: r.y,
      locked: r.locked,
      pieces: r.pieces,
      grabbedBy: r.grabbed_by,
    }));
  }

  async function expectRpcMatches(input, mode) {
    const { groupId, toReal, toCase } = await layOut(input, mode);
    const me = students[byOf(input)];
    const dropped = input.clusters.find((c) => c.id === input.drop.id);
    const { data, error } =
      mode === 'take'
        ? await me.client.rpc('take_from_tray', {
            p_group: groupId,
            p_piece: dropped.pieces[0][1] * input.grid.cols + dropped.pieces[0][0],
            p_x: input.drop.x,
            p_y: input.drop.y,
          })
        : await me.client.rpc('drop', {
            p_cluster: toReal.get(input.drop.id),
            p_x: input.drop.x,
            p_y: input.drop.y,
          });
    expect(error).toBeNull();
    const js = runCase(input);
    expect(data.ok).toBe(true);
    expect(toCase.get(data.id)).toBe(js.id);
    expect(Object.is(data.x, js.x) && Object.is(data.y, js.y)).toBe(true);
    expect(data.locked).toBe(js.locked);
    expect(data.absorbed.map((id) => toCase.get(id))).toEqual(js.absorbed);
    expect(data.progress).toEqual({ placed: js.placed, total: js.total, complete: js.complete });
    expect(data.completed_now).toBe(js.complete);

    const board = await boardOf(groupId, toCase);
    expect(board.map(({ grabbedBy, ...c }) => c)).toEqual(js.clusters);
    board.forEach((c, i) => {
      expect(Object.is(c.x, js.clusters[i].x) && Object.is(c.y, js.clusters[i].y)).toBe(true);
    });
    // The survivor is released; clusters held by others keep their holder.
    expect(board.find((c) => c.id === js.id).grabbedBy).toBeNull();
    const online = onlineOf(input);
    const stillHeld = input.clusters.filter(
      (k) => k.heldBy && k.heldBy !== byOf(input) && k.heldMsAgo < HOLD_MS && online.includes(k.heldBy),
    );
    for (const c of stillHeld) {
      expect(board.find((k) => k.id === c.id).grabbedBy).toBe(students[c.heldBy].userId);
    }
    const { rows } = await sql('select completed_at is not null as done from jigsaw.groups where id = $1', [groupId]);
    expect(rows[0].done).toBe(js.complete);
  }

  // The RPCs always use jigsaw_private.snap_tolerance(); cases with another tolerance are
  // covered by the pure check only.
  const rpcCases = table.cases.filter((c) => c.input.tolerance === table.defaultTolerance);

  it('runs every case except the tolerance-input ones', () => {
    expect(table.cases.length - rpcCases.length).toBe(1);
  });

  describe.each(rpcCases)('$name', ({ input }) => {
    it('drop RPC gives the JS result', async () => {
      await expectRpcMatches(input, 'drop');
    });

    const dropped = input.clusters.find((c) => c.id === input.drop.id);
    it.runIf(dropped.pieces.length === 1)('take_from_tray RPC gives the same result as the drop', async () => {
      await expectRpcMatches(input, 'take');
    });
  });
});
