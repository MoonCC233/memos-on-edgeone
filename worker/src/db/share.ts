export interface ShareRow {
  id: number;
  uid: string;
  memo_id: number;
  creator_id: number;
  created_ts: number;
  expires_ts: number | null;
}

export async function createShare(
  db: D1Database,
  data: { memoId: number; creatorId: number; expiresTs?: number }
): Promise<ShareRow> {
  const uid = crypto.randomUUID().replace(/-/g, "").slice(0, 24);
  return (await db
    .prepare(
      "INSERT INTO memo_share (uid, memo_id, creator_id, expires_ts) VALUES (?, ?, ?, ?) RETURNING *"
    )
    .bind(uid, data.memoId, data.creatorId, data.expiresTs ?? null)
    .first<ShareRow>())!;
}

export async function listShares(
  db: D1Database,
  memoId: number
): Promise<ShareRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM memo_share WHERE memo_id = ? ORDER BY created_ts DESC")
    .bind(memoId)
    .all<ShareRow>();
  return results;
}

export async function getShareByUid(
  db: D1Database,
  uid: string
): Promise<ShareRow | null> {
  return db
    .prepare("SELECT * FROM memo_share WHERE uid = ?")
    .bind(uid)
    .first<ShareRow>();
}

export async function deleteShare(
  db: D1Database,
  uid: string,
  memoId: number
): Promise<void> {
  await db
    .prepare("DELETE FROM memo_share WHERE uid = ? AND memo_id = ?")
    .bind(uid, memoId)
    .run();
}
