export interface RelationRow {
  memo_id: number;
  related_memo_id: number;
  type: string;
}

export async function listRelations(
  db: D1Database,
  memoId: number
): Promise<RelationRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM memo_relation WHERE memo_id = ? OR related_memo_id = ?")
    .bind(memoId, memoId)
    .all<RelationRow>();
  return results;
}

export async function createRelation(
  db: D1Database,
  data: { memoId: number; relatedMemoId: number; type: string }
): Promise<void> {
  await db
    .prepare(
      "INSERT OR IGNORE INTO memo_relation (memo_id, related_memo_id, type) VALUES (?, ?, ?)"
    )
    .bind(data.memoId, data.relatedMemoId, data.type)
    .run();
}

function chunkValues<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

export async function setRelations(
  db: D1Database,
  memoId: number,
  relations: { relatedMemoId: number; type: string }[]
): Promise<void> {
  await db.prepare("DELETE FROM memo_relation WHERE memo_id = ?").bind(memoId).run();
  if (relations.length === 0) {
    return;
  }

  for (const chunk of chunkValues(relations, 300)) {
    const placeholders = chunk.map(() => "(?, ?, ?)").join(", ");
    const params = chunk.flatMap((rel) => [memoId, rel.relatedMemoId, rel.type]);
    await db.prepare(
      `INSERT OR IGNORE INTO memo_relation (memo_id, related_memo_id, type) VALUES ${placeholders}`
    ).bind(...params).run();
  }
}

export async function deleteRelation(
  db: D1Database,
  memoId: number,
  relatedMemoId: number,
  type: string
): Promise<void> {
  await db
    .prepare("DELETE FROM memo_relation WHERE memo_id = ? AND related_memo_id = ? AND type = ?")
    .bind(memoId, relatedMemoId, type)
    .run();
}
