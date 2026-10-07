// Supabase reads and RPC calls used by the teacher screens.
// Teachers only read through RLS and change sessions through RPCs (T4).

const SESSION_FIELDS = 'id, code, status, builtin_key, image_id, piece_count, created_at, started_at, ended_at';

export async function listSessions(client) {
  const { data, error } = await client
    .from('sessions')
    .select(`${SESSION_FIELDS}, groups(count)`)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return data.map(({ groups, ...s }) => ({ ...s, groupCount: groups?.[0]?.count ?? 0 }));
}

export async function getSession(client, id) {
  const { data, error } = await client
    .from('sessions')
    .select(`${SESSION_FIELDS}, groups(id, number)`)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const groups = [...data.groups].sort((a, b) => a.number - b.number);
  return { ...data, groups };
}

// picture: { builtinKey, aspect } or { imageId }
export async function createSession(client, { picture, pieceCount, groupCount }) {
  const args = { p_piece_count: pieceCount, p_group_count: groupCount };
  if (picture.imageId) args.p_image_id = picture.imageId;
  else Object.assign(args, { p_builtin_key: picture.builtinKey, p_aspect: picture.aspect });
  const { data, error } = await client.rpc('create_session', args);
  if (error) throw error;
  return data;
}

export async function endSession(client, id) {
  const { error } = await client.rpc('end_session', { p_session: id });
  if (error) throw error;
}

// Students of a session (no names: those come from Presence on session:<id>).
export async function listMembers(client, sessionId) {
  const { data, error } = await client
    .from('members')
    .select('id, user_id, group_id, color')
    .eq('session_id', sessionId)
    .order('id');
  if (error) throw error;
  return data;
}

// group null = back to "no group yet".
export async function assignMember(client, memberId, groupId) {
  const { data, error } = await client.rpc('assign_member', { p_member: memberId, p_group: groupId });
  if (error) throw error;
  return data;
}

export async function randomizeGroups(client, sessionId) {
  const { data, error } = await client.rpc('randomize_groups', { p_session: sessionId });
  if (error) throw error;
  return data;
}

export async function startSession(client, sessionId) {
  const { data, error } = await client.rpc('start_session', { p_session: sessionId });
  if (error) throw error;
  return data;
}
