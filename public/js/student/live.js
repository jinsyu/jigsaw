// Keeps a joined student in step with the class on session:<id> (private channel):
// - Presence: tracks { member, name } under the student's user id. The name goes nowhere else.
// - 'groups' / 'start': read my members row, my group and my groupmates again. start_session
//   renumbers colours without a 'groups' broadcast, so 'start' re-reads too (T4 review).
// - 'end', or my members row disappearing: the class is over.
// heartbeat() every 5 seconds keeps members.last_seen fresh while waiting, so trays dealt at
// the start are not taken for a student who was simply waiting (T6: gone after 1 minute).
// This screen joins no group:<id> channel; the puzzle screen (T11) does, and must leave the old
// group's channel and join the new one when a 'groups' broadcast moves this student.
import { presenceNames } from './presence.js';

const HEARTBEAT_MS = 5000;
const CONNECT_GRACE_MS = 5000;

export function connectClass({ client, sessionId, memberId, userId, name, onChange, onEnded }) {
  let stopped = false;
  let myName = name;
  let connection = 'connecting';
  let presence = {};
  let snapshot = null; // { code, status, group, myColor, mateRows }
  const channel = client.channel(`session:${sessionId}`, {
    config: { private: true, presence: { key: userId } },
  });

  function emit() {
    if (stopped || !snapshot) return;
    const { names } = presenceNames(presence, snapshot.mateRows);
    const mates = snapshot.mateRows.map((row) => ({
      id: row.id,
      color: row.color,
      me: row.id === memberId,
      online: row.id === memberId || names.has(row.id),
      name: row.id === memberId ? myName : (names.get(row.id) ?? null),
    }));
    onChange({
      name: myName,
      code: snapshot.code,
      status: snapshot.status,
      group: snapshot.group,
      myColor: snapshot.myColor,
      mates,
      connected: connection !== 'lost',
    });
  }

  function end() {
    if (stopped) return;
    stop();
    onEnded();
  }

  async function load() {
    const [session, me] = await Promise.all([
      client.from('sessions').select('code, status').eq('id', sessionId).maybeSingle(),
      client.from('members').select('id, user_id, group_id, color').eq('id', memberId).maybeSingle(),
    ]);
    if (session.error) throw session.error;
    if (me.error) throw me.error;
    // end_session deletes the members row, after which the session row is no longer readable.
    if (!session.data || session.data.status === 'ended' || !me.data) return end();

    let group = null;
    let mateRows = [me.data];
    if (me.data.group_id !== null) {
      const [groupRow, rows] = await Promise.all([
        client.from('groups').select('id, number').eq('id', me.data.group_id).maybeSingle(),
        client.from('members').select('id, user_id, color').eq('group_id', me.data.group_id).order('color').order('id'),
      ]);
      if (groupRow.error) throw groupRow.error;
      if (rows.error) throw rows.error;
      group = groupRow.data ? { id: groupRow.data.id, number: groupRow.data.number } : null;
      mateRows = rows.data;
    }
    snapshot = { code: session.data.code, status: session.data.status, group, myColor: me.data.color, mateRows };
    emit();
  }

  // One read at a time; a request during a read runs once more after it.
  let running = null;
  let queued = false;
  function refresh() {
    if (stopped) return Promise.resolve();
    if (running) {
      queued = true;
      return running;
    }
    running = load()
      .catch((error) => console.error(error))
      .finally(() => {
        running = null;
        if (queued && !stopped) {
          queued = false;
          refresh();
        }
      });
    return running;
  }

  async function beat() {
    if (stopped || document.visibilityState === 'hidden') return;
    const { data, error } = await client.rpc('heartbeat');
    if (error) console.error(error);
    else if (data?.ok === false) refresh(); // not in an open class any more
  }

  function setConnection(next) {
    if (connection === next) return;
    connection = next;
    emit();
  }

  channel
    .on('presence', { event: 'sync' }, () => {
      presence = channel.presenceState();
      emit();
    })
    .on('broadcast', { event: 'groups' }, () => refresh())
    .on('broadcast', { event: 'start' }, () => refresh())
    .on('broadcast', { event: 'end' }, () => end());

  const graceTimer = setTimeout(() => {
    if (connection === 'connecting') setConnection('lost');
  }, CONNECT_GRACE_MS);

  client.realtime
    .setAuth()
    .catch((error) => console.error(error))
    .then(() => {
      if (stopped) return;
      channel.subscribe((status) => {
        if (stopped) return;
        if (status === 'SUBSCRIBED') {
          setConnection('ok');
          channel.track({ member: memberId, name: myName }).catch((error) => console.error(error));
          refresh(); // catch up on anything sent while we were away
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          setConnection('lost');
          refresh(); // a refused join usually means the class ended
        }
      });
    });

  const heartbeatTimer = setInterval(beat, HEARTBEAT_MS);
  function onVisible() {
    if (document.visibilityState !== 'visible') return;
    beat();
    refresh();
  }
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', onVisible);
  refresh();

  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(graceTimer);
    clearInterval(heartbeatTimer);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('online', onVisible);
    client.removeChannel(channel).catch(() => {});
  }

  return {
    rename(next) {
      myName = next;
      emit();
      if (connection === 'ok') channel.track({ member: memberId, name: myName }).catch((error) => console.error(error));
    },
    stop,
  };
}
