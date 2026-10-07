// One class (수업) in the rt server's memory: its students, groups and one board per group.
//
// Pure and synchronous like board.js: the clock and the dealing order are injected, and
// every action returns { result, events }. Events carry where they go:
//   { to: 'session', ... }          every screen of the class (teacher and students)
//   { to: 'teacher', ... }          the teacher's screens only
//   { to: 'group', group: n, ... }  the students of group n (board.js events)
// Refusals use the error names the screens already know (formerly the SQL errors).
//
// Student names live only in member.name (memory). toRecord(), the form that is saved,
// has no names (spec D14). Names go out only in roster() / overview() / 'join' events,
// which the network layer sends to this class's screens.
import { createBoard } from './board.js';

const PUZZLE_ACTIONS = new Set(['takeFromTray', 'grab', 'drop', 'release']);

const refuse = (error) => ({ result: { ok: false, error }, events: [] });
const toGroup = (group, events) => events.map((event) => ({ to: 'group', group, ...event }));

/**
 * @param {object} options  checked by registry.js before it gets here
 * @param {string} options.id
 * @param {string} options.teacherId
 * @param {string} options.code
 * @param {number} options.seed
 * @param {number} options.pieceCount
 * @param {number} options.cols
 * @param {number} options.rows
 * @param {number} options.aspect
 * @param {string|null} options.builtinKey
 * @param {string|null} options.imageId
 * @param {object} options.hints     normalizeHints() result
 * @param {number} options.groupCount
 * @param {() => number} options.now
 * @param {() => number} options.random
 */
export function createClassSession({
  id,
  teacherId,
  code,
  seed,
  pieceCount,
  cols,
  rows,
  aspect,
  builtinKey,
  imageId,
  hints,
  groupCount,
  now,
  random,
}) {
  let status = 'waiting';
  const createdAt = now();
  let startedAt = null;
  let endedAt = null;
  // Map keeps insertion order = joining order (colours at the start follow it).
  const members = new Map();
  const groups = new Map(Array.from({ length: groupCount }, (_, i) => [i + 1, { number: i + 1, board: null }]));

  const groupMembers = (number) => [...members.values()].filter((m) => m.group === number);
  const assignment = (m) => ({ id: m.id, group: m.group, color: m.color });

  function freeColor(number, memberId) {
    const used = new Set(groupMembers(number).filter((m) => m.id !== memberId).map((m) => m.color));
    let color = 0;
    while (used.has(color)) color += 1;
    return color;
  }

  function newBoard(list) {
    return createBoard({
      cols,
      rows,
      aspect,
      members: list.map((m) => ({ id: m.id, online: m.online })),
      now,
      random,
    });
  }

  // registry.js calls these two; tokens themselves are never kept here.
  function addMember({ id: memberId, name, tokenHash }) {
    const member = { id: memberId, name, tokenHash, group: null, color: null, joinedAt: now(), online: false };
    members.set(memberId, member);
    return member;
  }

  function rename(memberId, name) {
    members.get(memberId).name = name;
  }

  function joinEvent(member) {
    const { id: memberId, name, group, color, online } = member;
    return { to: 'teacher', type: 'join', member: { id: memberId, name, group, color, online } };
  }

  function assign(memberId, number) {
    if (status === 'ended') return refuse('session_ended');
    const member = members.get(memberId);
    if (!member) return refuse('member_not_found');
    if (number !== null && !groups.has(number)) return refuse('invalid_group');
    if (member.group === number) return { result: { ok: true, group: number, color: member.color }, events: [] };

    const events = [];
    const from = member.group;
    member.group = number;
    member.color = number === null ? null : freeColor(number, memberId);
    if (status === 'playing') {
      const oldBoard = from === null ? null : groups.get(from).board;
      if (oldBoard) events.push(...toGroup(from, oldBoard.removeMember(memberId)));
      if (number !== null) {
        const group = groups.get(number);
        // An empty group got no puzzle at the start: it gets one now, all pieces to this student.
        if (group.board) events.push(...toGroup(number, group.board.addMember(memberId, { online: member.online })));
        else group.board = newBoard([member]);
      }
    }
    events.unshift({ to: 'session', type: 'groups', members: [assignment(member)] });
    return { result: { ok: true, group: member.group, color: member.color }, events };
  }

  // Every student into the groups, sizes differing by at most one (waiting room only).
  function randomize() {
    if (status !== 'waiting') return refuse('session_not_waiting');
    const shuffled = [...members.values()]
      .map((m) => ({ m, key: random() }))
      .sort((a, b) => a.key - b.key)
      .map(({ m }) => m);
    const numbers = [...groups.keys()];
    const filled = new Map(numbers.map((n) => [n, 0]));
    shuffled.forEach((m, i) => {
      m.group = numbers[i % numbers.length];
      m.color = filled.get(m.group);
      filled.set(m.group, m.color + 1);
    });
    const list = [...members.values()].map(assignment);
    return { result: { ok: true }, events: [{ to: 'session', type: 'groups', members: list }] };
  }

  // Puzzles for every group with students; colours 0.. in joining order.
  function start() {
    if (status !== 'waiting') return refuse('session_not_waiting');
    for (const group of groups.values()) {
      const list = groupMembers(group.number);
      if (list.length === 0) continue;
      list.forEach((m, i) => {
        m.color = i;
      });
      group.board = newBoard(list);
    }
    status = 'playing';
    startedAt = now();
    const list = [...members.values()].map(assignment);
    return {
      result: { ok: true, startedAt },
      events: [
        { to: 'session', type: 'groups', members: list },
        { to: 'session', type: 'start', startedAt },
      ],
    };
  }

  // Closes the class. Members are dropped (registry.js forgets their tokens); boards stay
  // for the record.
  function end() {
    if (status === 'ended') return { result: { ok: true, endedAt }, events: [] };
    status = 'ended';
    endedAt = now();
    members.clear();
    return { result: { ok: true, endedAt }, events: [{ to: 'session', type: 'end' }] };
  }

  function presence(memberId, online) {
    const member = members.get(memberId);
    if (!member || member.online === online || status === 'ended') return [];
    member.online = online;
    const events = [{ to: 'teacher', type: 'presence', memberId, online }];
    const board = member.group === null ? null : groups.get(member.group).board;
    if (board) {
      const boardEvents = online ? board.memberOnline(memberId) : board.memberOffline(memberId);
      events.push(...toGroup(member.group, boardEvents));
    }
    return events;
  }

  // A student's puzzle action on their own group's board.
  function puzzle(memberId, action, ...args) {
    const reason = (r) => ({ result: { ok: false, reason: r }, events: [] });
    if (!PUZZLE_ACTIONS.has(action)) return reason('bad-action');
    if (status !== 'playing') return reason('not-playing');
    const member = members.get(memberId);
    if (!member) return reason('not-member');
    const board = member.group === null ? null : groups.get(member.group).board;
    if (!board) return reason('no-group');
    const { result, events } = board[action](memberId, ...args);
    return { result, events: toGroup(member.group, events) };
  }

  function tick() {
    if (status !== 'playing') return [];
    return [...groups.values()].flatMap((g) => (g.board ? toGroup(g.number, g.board.tick()) : []));
  }

  // The teacher's list of students, with names (sent only to this class's teacher screens).
  function roster() {
    return [...members.values()].map(({ id: memberId, name, group, color, online }) => ({
      id: memberId,
      name,
      group,
      color,
      online,
    }));
  }

  // 모둠 한눈에 보기: every group's clusters (piece indexes), progress, completion; students.
  function overview() {
    return {
      status,
      startedAt,
      endedAt,
      groups: [...groups.values()].map((g) => {
        if (!g.board) {
          return { number: g.number, empty: true, completedAt: null, progress: null, clusters: [] };
        }
        const state = g.board.getState();
        return {
          number: g.number,
          empty: false,
          completedAt: state.completedAt,
          progress: state.progress,
          clusters: state.clusters.map((c) => ({
            id: c.id,
            x: c.x,
            y: c.y,
            locked: c.locked,
            heldBy: c.heldBy,
            pieces: c.pieces.map(([col, row]) => row * cols + col),
          })),
        };
      }),
      members: roster(),
    };
  }

  // What gets saved (T18). No names, no raw tokens, no holds or connection state.
  function toRecord() {
    return {
      id,
      teacherId,
      code,
      seed,
      pieceCount,
      cols,
      rows,
      aspect,
      builtinKey,
      imageId,
      hints: { ...hints },
      status,
      createdAt,
      startedAt,
      endedAt,
      groups: [...groups.values()].map((g) => {
        if (!g.board) return { number: g.number, completedAt: null, board: null };
        const state = g.board.getState();
        return {
          number: g.number,
          completedAt: state.completedAt,
          board: {
            clusters: state.clusters.map(({ id: clusterId, x, y, z, locked, pieces }) => ({
              id: clusterId,
              x,
              y,
              z,
              locked,
              pieces,
            })),
            trays: state.trays,
          },
        };
      }),
      members: [...members.values()].map(({ id: memberId, group, color, tokenHash, joinedAt }) => ({
        id: memberId,
        group,
        color,
        tokenHash,
        joinedAt,
      })),
    };
  }

  return {
    id,
    teacherId,
    code,
    get status() {
      return status;
    },
    member: (memberId) => members.get(memberId) ?? null,
    addMember,
    rename,
    joinEvent,
    assign,
    randomize,
    start,
    end,
    memberOnline: (memberId) => presence(memberId, true),
    memberOffline: (memberId) => presence(memberId, false),
    puzzle,
    tick,
    roster,
    overview,
    toRecord,
  };
}
