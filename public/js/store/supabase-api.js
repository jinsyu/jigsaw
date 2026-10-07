// The server side of remote-store.js on a supabase-js client: one board read, the puzzle
// RPCs and the group:<id> private channel. Kept thin so remote-store.js can be tested
// with a fake.

// One statement, so clusters and pieces come from the same snapshot (a drop in between
// cannot leave a piece pointing at a cluster that is already gone).
const BOARD_SELECT = 'completed_at, clusters(id, x, y, z, locked, grabbed_by, grabbed_at, pieces(col, row, owner_id, on_board))';

export function createSupabaseApi(client) {
  return {
    async loadBoard(groupId) {
      const { data, error } = await client.from('groups').select(BOARD_SELECT).eq('id', groupId).maybeSingle();
      if (error) throw error;
      if (!data) throw new Error(`group ${groupId} is not readable`);
      return data;
    },
    take: (groupId, piece, x, y) => client.rpc('take_from_tray', { p_group: groupId, p_piece: piece, p_x: x, p_y: y }),
    grab: (clusterId) => client.rpc('grab', { p_cluster: clusterId }),
    drop: (clusterId, x, y) => client.rpc('drop', { p_cluster: clusterId, p_x: x, p_y: y }),

    // Broadcasts only (the RPCs send them); Presence lives on session:<id>.
    subscribe(groupId, { onEvent, onStatus }) {
      const channel = client.channel(`group:${groupId}`, { config: { private: true } });
      channel.on('broadcast', { event: '*' }, (message) => onEvent(message.event, message.payload ?? {}));
      channel.subscribe((status, error) => {
        if (error) console.error(error);
        onStatus(status);
      });
      return () => {
        client.removeChannel(channel).catch(() => {});
      };
    },
  };
}
