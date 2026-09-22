export interface WebhookRow {
  id: number;
  creator_id: number;
  created_ts: number;
  updated_ts: number;
  url: string;
  display_name: string;
}

export async function listWebhooksByCreatorId(
  db: D1Database,
  creatorId: number
): Promise<WebhookRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM webhook WHERE creator_id = ? ORDER BY created_ts DESC")
    .bind(creatorId)
    .all<WebhookRow>();
  return results;
}

export async function getWebhookById(
  db: D1Database,
  id: number
): Promise<WebhookRow | null> {
  return db.prepare("SELECT * FROM webhook WHERE id = ?").bind(id).first<WebhookRow>();
}

export async function createWebhook(
  db: D1Database,
  data: { creatorId: number; url: string; displayName: string }
): Promise<WebhookRow> {
  const result = await db
    .prepare(
      "INSERT INTO webhook (creator_id, url, display_name) VALUES (?, ?, ?) RETURNING *"
    )
    .bind(data.creatorId, data.url, data.displayName)
    .first<WebhookRow>();
  return result!;
}

export async function updateWebhook(
  db: D1Database,
  id: number,
  data: Partial<{ url: string; display_name: string }>
): Promise<WebhookRow | null> {
  const fields: string[] = [];
  const values: (string | number)[] = [];

  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
  }

  if (fields.length === 0) return getWebhookById(db, id);

  fields.push("updated_ts = strftime('%s', 'now')");
  values.push(id);

  const query = `UPDATE webhook SET ${fields.join(", ")} WHERE id = ? RETURNING *`;
  return db.prepare(query).bind(...values).first<WebhookRow>();
}

export async function deleteWebhook(db: D1Database, id: number): Promise<void> {
  await db.prepare("DELETE FROM webhook WHERE id = ?").bind(id).run();
}
