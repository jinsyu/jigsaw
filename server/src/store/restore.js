// Server start: open classes from the database back into the registry. A class whose saved
// state does not fit (registry.restore throws) is closed in the database right away, so its
// code is free again and its students are told the class ended when they come back.
export async function restoreOpenSessions({ registry, persistence, db, now = Date.now, log = console }) {
  const records = await persistence.loadOpenSessions();
  const failed = [];
  for (const record of records) {
    try {
      registry.restore(record);
    } catch (error) {
      failed.push(record.id);
      log.error(`[restore] 수업 ${record.id} 복구 실패: ${error?.message ?? error}`);
    }
  }
  if (failed.length > 0) {
    const { error } = await db
      .from('sessions')
      .update({ status: 'ended', ended_at: new Date(now()).toISOString() })
      .in('id', failed);
    if (error) throw error;
  }
  return { restored: records.length - failed.length, failed };
}
