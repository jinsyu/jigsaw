// The server side of remote-store.js on a supabase-js client: one board read, the puzzle
// RPCs and the jigsaw:group:<id> private channel. Kept thin so remote-store.js can be tested
// with a fake.
import { groupTopic } from '../supabase-names.js';

export function createSupabaseApi(client) {
  return {
    async loadBoard(groupId) {
      // load_board: one statement (clusters and pieces from the same snapshot) with exact
      // float8 x / y (a plain select would round them to 15 digits).
      const { data, error } = await client.rpc('load_board', { p_group: groupId });
      if (error) throw error;
      if (!data) throw new Error(`group ${groupId} is not readable`);
      return data;
    },
    take: (groupId, piece, x, y) => client.rpc('take_from_tray', { p_group: groupId, p_piece: piece, p_x: x, p_y: y }),
    grab: (clusterId) => client.rpc('grab', { p_cluster: clusterId }),
    drop: (clusterId, x, y) => client.rpc('drop', { p_cluster: clusterId, p_x: x, p_y: y }),

    // Broadcasts only (the RPCs send them); Presence lives on jigsaw:session:<id>.
    subscribe(groupId, { onEvent, onStatus }) {
      const channel = client.channel(groupTopic(groupId), { config: { private: true } });
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
