// Who is a jigsaw teacher (jigsaw.teachers) and the shared gyosil profile (core.profiles:
// id, display_name, terms_agreed_at, created_at). core.profiles is read and written only here.
export function createTeachers(db) {
  const profiles = () => db.schema('core').from('profiles');

  async function isTeacher(uid) {
    const { data, error } = await db.from('teachers').select('id').eq('id', uid).maybeSingle();
    if (error) throw error;
    return data !== null;
  }

  async function profile(uid) {
    const { data, error } = await profiles().select('display_name, terms_agreed_at').eq('id', uid).maybeSingle();
    if (error) throw error;
    return data ? { displayName: data.display_name, termsAgreedAt: data.terms_agreed_at } : null;
  }

  // 함께 퍼즐 시작하기: the shared profile (name, terms agreed now) and the jigsaw.teachers row.
  async function start(uid, displayName) {
    const saved = await profiles().upsert(
      { id: uid, display_name: displayName, terms_agreed_at: new Date().toISOString() },
      { onConflict: 'id' },
    );
    if (saved.error) throw saved.error;
    const joined = await db.from('teachers').upsert({ id: uid }, { onConflict: 'id', ignoreDuplicates: true });
    if (joined.error) throw joined.error;
  }

  return { isTeacher, profile, start };
}
