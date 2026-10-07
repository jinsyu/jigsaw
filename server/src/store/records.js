// session.toRecord() <-> jigsaw table rows. Pure. Times are ms in the engine and ISO
// timestamps in the database. No names anywhere (toRecord() has none).

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
const ms = (text) => (text == null ? null : Date.parse(text));

export function sessionRow(record) {
  return {
    id: record.id,
    teacher_id: record.teacherId,
    code: record.code,
    builtin_key: record.builtinKey,
    image_id: record.imageId,
    piece_count: record.pieceCount,
    cols: record.cols,
    rows: record.rows,
    aspect: record.aspect,
    seed: record.seed,
    status: record.status,
    hint_preview: record.hints.preview,
    hint_outline: record.hints.outline,
    hint_picture_button: record.hints.pictureButton,
    hint_underlay: record.hints.underlay,
    created_at: iso(record.createdAt),
    started_at: iso(record.startedAt),
    ended_at: iso(record.endedAt),
  };
}

export function groupRow(record, group, savedAt) {
  return {
    session_id: record.id,
    number: group.number,
    completed_at: iso(group.completedAt),
    board: group.board,
    updated_at: iso(savedAt),
  };
}

export function memberRow(record, member) {
  return {
    id: member.id,
    session_id: record.id,
    group_number: member.group,
    color: member.color,
    token_hash: member.tokenHash,
    joined_at: iso(member.joinedAt),
  };
}

export function recordFromRows(session, groups, members) {
  return {
    id: session.id,
    teacherId: session.teacher_id,
    code: session.code,
    seed: Number(session.seed),
    pieceCount: session.piece_count,
    cols: session.cols,
    rows: session.rows,
    aspect: session.aspect,
    builtinKey: session.builtin_key,
    imageId: session.image_id,
    hints: {
      preview: session.hint_preview,
      outline: session.hint_outline,
      pictureButton: session.hint_picture_button,
      underlay: session.hint_underlay,
    },
    status: session.status,
    createdAt: ms(session.created_at),
    startedAt: ms(session.started_at),
    endedAt: ms(session.ended_at),
    groups: [...groups]
      .sort((a, b) => a.number - b.number)
      .map((g) => ({ number: g.number, completedAt: ms(g.completed_at), board: g.board })),
    members: [...members]
      .sort((a, b) => ms(a.joined_at) - ms(b.joined_at))
      .map((m) => ({
        id: m.id,
        group: m.group_number,
        color: m.color,
        tokenHash: m.token_hash,
        joinedAt: ms(m.joined_at),
      })),
  };
}
