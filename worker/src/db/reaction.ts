export interface ReactionRow {
  id: number;
  created_ts: number;
  creator_id: number;
  content_id: string;
  reaction_type: string;
}

export async function listReactions(
  db: D1Database,
  contentId: string
): Promise<ReactionRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM reaction WHERE content_id = ? ORDER BY created_ts ASC")
    .bind(contentId)
    .all<ReactionRow>();
  return results;
}

export async function upsertReaction(
  db: D1Database,
  data: { creatorId: number; contentId: string; reactionType: string }
): Promise<ReactionRow> {
  const result = await db
    .prepare(
      `INSERT INTO reaction (creator_id, content_id, reaction_type)
       VALUES (?, ?, ?)
       ON CONFLICT (creator_id, content_id, reaction_type) DO NOTHING
       RETURNING *`
    )
    .bind(data.creatorId, data.contentId, data.reactionType)
    .first<ReactionRow>();

  if (!result) {
    return (await db
      .prepare(
        "SELECT * FROM reaction WHERE creator_id = ? AND content_id = ? AND reaction_type = ?"
      )
      .bind(data.creatorId, data.contentId, data.reactionType)
      .first<ReactionRow>())!;
  }
  return result;
}

export async function deleteReaction(
  db: D1Database,
  id: number,
  creatorId: number
): Promise<void> {
  await db
    .prepare("DELETE FROM reaction WHERE id = ? AND creator_id = ?")
    .bind(id, creatorId)
    .run();
}
