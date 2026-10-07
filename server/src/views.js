// What a screen receives when it connects (and after every reconnect): one full copy of the
// state it needs. Students get their own group only, with their own tray; names only of the
// students of their group. Teachers get the roster and the overview of their own class.

function setup(session) {
  const r = session.toRecord();
  return {
    id: r.id,
    code: r.code,
    status: r.status,
    pieceCount: r.pieceCount,
    cols: r.cols,
    rows: r.rows,
    aspect: r.aspect,
    seed: r.seed,
    builtinKey: r.builtinKey,
    imageId: r.imageId,
    hints: r.hints,
    startedAt: r.startedAt,
  };
}

export function groupMates(session, number) {
  return session
    .roster()
    .filter((m) => m.group === number)
    .map(({ id, name, color, online }) => ({ id, name, color, online }));
}

export function studentState(session, memberId, now) {
  const member = session.member(memberId);
  const board = member.group === null ? null : session.boardState(member.group);
  return {
    now,
    session: setup(session),
    me: { memberId, name: member.name, group: member.group, color: member.color },
    group:
      member.group === null
        ? null
        : {
            number: member.group,
            mates: groupMates(session, member.group),
            board: board && {
              clusters: board.clusters.map(({ id, x, y, z, locked, pieces, heldBy, heldAt }) => ({
                id,
                x,
                y,
                z,
                locked,
                pieces,
                heldBy,
                heldAt,
              })),
              tray: board.trays[memberId] ?? [],
              progress: board.progress,
              completedAt: board.completedAt,
            },
          },
  };
}

export function teacherState(session, now) {
  return { now, session: setup(session), roster: session.roster(), overview: session.overview() };
}
