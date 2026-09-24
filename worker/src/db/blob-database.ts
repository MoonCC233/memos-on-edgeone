/**
 * Blob Database — SQL-compatible engine over EdgeOne Blob storage.
 *
 * All tables live as JSON documents (db/<table>.json) in Blob storage.
 * A small SQL parser/evaluator covers the query shapes used by this app:
 *   SELECT  (WHERE / ORDER BY / LIMIT / OFFSET, aggregates COUNT/SUM/COALESCE)
 *   INSERT  (multi-row VALUES, OR IGNORE, ON CONFLICT DO UPDATE/DO NOTHING, RETURNING)
 *   UPDATE  (SET with strftime/NULL/literals, WHERE, RETURNING)
 *   DELETE  (WHERE)
 *
 * Parameters ("?") are bound once per execution by rewriting the parsed AST,
 * so evaluation order matches SQLite bind order exactly and multi-condition
 * WHERE clauses never mis-consume parameters.
 */

import { StorageProvider } from "../storage";

// Table data structure stored in Blob
interface TableData<T = any> {
  rows: T[];
  nextId: number;
}

// All tables in the system
export interface DatabaseSchema {
  user: UserRow;
  user_setting: { user_id: number; key: string; value: string };
  memo: MemoRow;
  memo_relation: { memo_id: number; related_memo_id: number; type: string };
  attachment: AttachmentRow;
  idp: IdpRow;
  inbox: InboxRow;
  reaction: ReactionRow;
  memo_share: MemoShareRow;
  user_identity: UserIdentityRow;
  webhook: WebhookRow;
  shortcut: ShortcutRow;
}

export interface UserRow {
  id: number;
  created_ts: number;
  updated_ts: number;
  row_status: string;
  username: string;
  role: string;
  email: string;
  nickname: string;
  password_hash: string;
  avatar_url: string;
  description: string;
}

export interface MemoRow {
  id: number;
  uid: string;
  creator_id: number;
  created_ts: number;
  updated_ts: number;
  row_status: string;
  content: string;
  visibility: string;
  pinned: number;
  payload: string;
}

export interface AttachmentRow {
  id: number;
  uid: string;
  creator_id: number;
  created_ts: number;
  updated_ts: number;
  filename: string;
  type: string;
  size: number;
  memo_id: number | null;
  storage_type: string;
  reference: string;
  payload: string;
}

export interface IdpRow {
  id: number;
  uid: string;
  name: string;
  type: string;
  identifier_filter: string;
  config: string;
}

export interface InboxRow {
  id: number;
  created_ts: number;
  sender_id: number;
  receiver_id: number;
  status: string;
  message: string;
}

export interface ReactionRow {
  id: number;
  created_ts: number;
  creator_id: number;
  content_id: string;
  reaction_type: string;
}

export interface MemoShareRow {
  id: number;
  uid: string;
  memo_id: number;
  creator_id: number;
  created_ts: number;
  expires_ts: number | null;
}

export interface UserIdentityRow {
  id: number;
  user_id: number;
  provider: string;
  extern_uid: string;
  created_ts: number;
  updated_ts: number;
}

export interface WebhookRow {
  id: number;
  creator_id: number;
  created_ts: number;
  updated_ts: number;
  url: string;
  display_name: string;
}

export interface ShortcutRow {
  id: number;
  creator_id: number;
  created_ts: number;
  updated_ts: number;
  title: string;
  filter: string;
}

const TABLE_PREFIX = "db/";
const TABLES = [
  "user",
  "user_setting",
  "memo",
  "memo_relation",
  "attachment",
  "idp",
  "inbox",
  "reaction",
  "memo_share",
  "user_identity",
  "webhook",
  "shortcut",
] as const;

type TableName = (typeof TABLES)[number];

/**
 * Column defaults applied on INSERT when the statement does not supply a
 * value — mirrors the NOT NULL DEFAULT clauses of the original SQLite schema
 * (most importantly user.row_status = 'NORMAL', without which sign-in would
 * treat every new user as archived).
 */
const TABLE_DEFAULTS: Record<string, Record<string, any>> = {
  user: {
    row_status: "NORMAL",
    email: "",
    nickname: "",
    avatar_url: "",
    description: "",
  },
  memo: { row_status: "NORMAL", pinned: 0, payload: "{}" },
  attachment: { payload: "" },
  idp: { identifier_filter: "", config: "{}" },
  webhook: { display_name: "" },
};

// ---------------------------------------------------------------------------
// Expression / condition AST
// ---------------------------------------------------------------------------

type Expr =
  | { k: "param" }
  | { k: "lit"; v: string | number | null }
  /** Qualified names (memo.content, tag_item.value) resolve by last segment. */
  | { k: "col"; name: string }
  /** `excluded.<col>` — only valid inside ON CONFLICT DO UPDATE assignments. */
  | { k: "excluded"; name: string }
  | { k: "json_extract"; json: Expr; path: string }
  | { k: "json_array_length"; arg: Expr }
  | { k: "coalesce"; args: Expr[] }
  | { k: "sum"; arg: Expr }
  | { k: "count_star" };

type Cond =
  | { k: "and"; l: Cond; r: Cond }
  | { k: "or"; l: Cond; r: Cond }
  | { k: "not"; c: Cond }
  | { k: "cmp"; op: string; l: Expr; r: Expr }
  | { k: "isnull"; e: Expr; neg: boolean }
  | { k: "in"; e: Expr; list: Expr[]; neg: boolean }
  | { k: "like"; e: Expr; pat: Expr; neg: boolean; esc: string | null }
  /** EXISTS (SELECT 1 FROM json_each(<json>, '<path>') AS <alias> WHERE ...) */
  | { k: "exists_json_each"; json: Expr; path: string; alias: string; inner: Cond };

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

export class BlobDatabase {
  public readonly storage: StorageProvider;
  private cache: Map<string, TableData> = new Map();
  private dirty = new Set<string>();
  private initialized = false;

  constructor(storage: StorageProvider) {
    this.storage = storage;
  }

  private getTableKey(tableName: string): string {
    return `${TABLE_PREFIX}${tableName}.json`;
  }

  private async getTable<T>(tableName: string): Promise<TableData<T>> {
    const cached = this.cache.get(tableName);
    if (cached) return cached as TableData<T>;

    const key = this.getTableKey(tableName);
    const result = await this.storage.get(key);

    let data: TableData<T>;
    if (!result || !result.body) {
      data = { rows: [], nextId: 1 };
    } else {
      try {
        const text = await this.readBody(result.body);
        data = JSON.parse(text);
        if (!data || !Array.isArray(data.rows)) data = { rows: [], nextId: 1 };
        if (!data.nextId) data.nextId = data.rows.length + 1;
      } catch {
        data = { rows: [], nextId: 1 };
      }
    }

    this.cache.set(tableName, data as TableData);
    return data;
  }

  private async readBody(body: ReadableStream | ArrayBuffer | string): Promise<string> {
    if (typeof body === "string") return body;
    if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);

    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return new TextDecoder().decode(result);
  }

  private async saveTable<T>(tableName: string, data: TableData<T>): Promise<void> {
    this.cache.set(tableName, data as TableData);
    this.dirty.delete(tableName);
    const key = this.getTableKey(tableName);
    await this.storage.put(key, JSON.stringify(data), { contentType: "application/json" });
  }

  private markDirty(tableName: string): void {
    this.dirty.add(tableName);
  }

  /**
   * Tables are loaded lazily on first access (see getTable) — pre-loading all
   * twelve tables on every request would cost twelve Blob round trips per call.
   */
  async init(): Promise<void> {
    this.initialized = true;
  }

  /** Persist only tables that were mutated since the last flush. */
  async persist(): Promise<void> {
    if (this.dirty.size === 0) return;
    const names = [...this.dirty];
    for (const tableName of names) {
      const data = this.cache.get(tableName);
      if (data) await this.saveTable(tableName, data);
      else this.dirty.delete(tableName);
    }
  }

  // D1Database-compatible interface
  prepare(sql: string): BlobPreparedStatement {
    return new BlobPreparedStatement(this, sql);
  }

  async dump(): Promise<ArrayBuffer> {
    throw new Error("dump() not supported");
  }

  async batch<T = unknown>(statements: BlobPreparedStatement[]): Promise<BlobResult<T>[]> {
    const results: BlobResult<T>[] = [];
    for (const stmt of statements) {
      const result = await stmt.all<T>();
      results.push(result);
    }
    await this.persist();
    return results;
  }

  async exec(sql: string): Promise<BlobExecResult> {
    const stmt = this.prepare(sql);
    const result = await stmt.run();
    await this.persist();
    return { count: result.meta.rows_written, duration: 0 };
  }

  // Internal methods for statement execution
  async executeQuery<T>(sql: string, params: any[]): Promise<T[]> {
    const parsed = parseSimpleSQL(sql);

    switch (parsed.type) {
      case "select":
        return await this.executeSelect<T>(parsed, params);
      case "insert": {
        const result = await this.executeInsert<T>(parsed, params);
        await this.persist();
        return result;
      }
      case "update": {
        const result = await this.executeUpdate(parsed, params);
        await this.persist();
        return result;
      }
      case "delete": {
        await this.executeDelete(parsed, params);
        await this.persist();
        return [];
      }
    }
  }

  private async executeSelect<T>(query: SelectQuery, params: any[]): Promise<T[]> {
    const table = await this.getTable(query.table);
    let rows = [...table.rows] as any[];

    // Bind WHERE parameters once; the shared cursor then points at the
    // LIMIT / OFFSET parameters (they appear after WHERE in source order).
    const st = { i: 0 };
    const boundWhere = query.where ? bindCond(query.where, params, st) : undefined;

    let limit = query.limit;
    let offset = query.offset;
    if (query.limitIsParam) limit = Number(params[st.i++]);
    if (query.offsetIsParam) offset = Number(params[st.i++]);

    if (boundWhere) {
      rows = rows.filter((row) => evalCond(boundWhere, row));
    }

    // Aggregates (COUNT / SUM / COALESCE) resolve over the whole filtered set
    // before ORDER BY / LIMIT, matching SQL semantics.
    if (query.items.some((it) => containsAgg(it.expr))) {
      const out: any = {};
      for (const it of query.items) {
        out[it.alias] = evalAggregate(it.expr, rows);
      }
      return [out] as T[];
    }

    if (query.orderBy && query.orderBy.length > 0) {
      const keys = query.orderBy;
      const colKey = (name: string) =>
        name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
      rows.sort((a, b) => {
        for (const key of keys) {
          const av = a[colKey(key.column)];
          const bv = b[colKey(key.column)];
          const cmp = av < bv ? -1 : av > bv ? 1 : 0;
          if (cmp !== 0) return key.direction === "DESC" ? -cmp : cmp;
        }
        return 0;
      });
    }

    if (offset !== undefined && Number.isFinite(offset)) {
      rows = rows.slice(offset);
    }
    if (limit !== undefined && Number.isFinite(limit)) {
      rows = rows.slice(0, limit);
    }

    if (query.star) return rows as T[];

    return rows.map((row) => {
      const selected: any = {};
      for (const it of query.items) {
        selected[it.alias] = evalExpr(it.expr, row);
      }
      return selected;
    }) as T[];
  }

  private async executeInsert<T>(query: InsertQuery, params: any[]): Promise<T[]> {
    const table = await this.getTable(query.table);
    const st = { i: 0 };
    const now = Math.floor(Date.now() / 1000);
    const defaults = TABLE_DEFAULTS[query.table] || {};

    // Conflict target: explicit ON CONFLICT, or every inserted column for
    // INSERT OR IGNORE (heuristic — good enough for memo_relation style rows).
    const conflictCols: string[] | null = query.conflict
      ? query.conflict.cols
      : query.orIgnore
        ? query.columns
        : null;
    const action: "nothing" | "update" | null = query.conflict
      ? query.conflict.action
      : query.orIgnore
        ? "nothing"
        : null;
    const conflictSet =
      query.conflict && query.conflict.action === "update"
        ? query.conflict.assignments.map((a) => ({
            column: a.column,
            expr: parseValueRaw(a.raw),
          }))
        : [];

    const results: any[] = [];
    let changed = false;

    // Bind every placeholder up front, in SQLite textual order: all VALUES
    // placeholders (group-major, column-minor) first, then any ON CONFLICT
    // DO UPDATE placeholders (the conflict clause follows VALUES in source).
    // NOTE: bindExpr returns a rewritten expression and never mutates its
    // input — the return value MUST be used. Discarding it used to leave
    // { k: "param" } in the tree, making evalExpr throw "Unbound SQL
    // parameter" and 500ing every parameterized INSERT.
    const boundGroups = query.valueGroups.map((group) =>
      query.columns.map((_col, ci) => {
        const raw = group[ci];
        if (raw === undefined) return undefined;
        return bindExpr(parseValueRaw(raw), params, st);
      })
    );
    const boundConflictSet = conflictSet.map((a) => ({
      column: a.column,
      expr: bindExpr(a.expr, params, st),
    }));

    for (let gi = 0; gi < boundGroups.length; gi++) {
      const row: any = { ...defaults };
      const boundGroup = boundGroups[gi];
      for (let ci = 0; ci < query.columns.length; ci++) {
        const expr = boundGroup[ci];
        if (expr === undefined) continue;
        row[query.columns[ci]] = evalExpr(expr, null);
      }

      if (row.id === undefined || row.id === null) row.id = table.nextId++;
      if (!row.created_ts) row.created_ts = now;
      if (!row.updated_ts) row.updated_ts = now;

      if (conflictCols && action) {
        const existing = (table.rows as any[]).find((r) =>
          conflictCols.every((c) => valueEquals(r[c], row[c]))
        );
        if (existing) {
          if (action === "nothing") continue; // skipped; RETURNING gets nothing
          for (const a of boundConflictSet) {
            existing[a.column] = evalExpr(a.expr, null, row);
          }
          changed = true;
          if (query.returning) results.push(existing);
          continue;
        }
      }

      table.rows.push(row);
      changed = true;
      if (query.returning) results.push(row);
    }

    if (changed) this.markDirty(query.table);
    return results;
  }

  private async executeUpdate(query: UpdateQuery, params: any[]): Promise<any[]> {
    const table = await this.getTable(query.table);
    const st = { i: 0 };
    const now = Math.floor(Date.now() / 1000);

    // SET parameters come textually before WHERE parameters.
    const setValues = query.set.map((s) => ({
      column: s.column,
      value: evalSetValue(s.raw, params, st),
    }));
    const boundWhere = query.where ? bindCond(query.where, params, st) : undefined;

    const matched: any[] = [];
    for (const row of table.rows as any[]) {
      if (!boundWhere || evalCond(boundWhere, row)) {
        for (const { column, value } of setValues) {
          row[column] = value;
        }
        row.updated_ts = now;
        matched.push(row);
      }
    }

    if (matched.length > 0) this.markDirty(query.table);
    return query.returning ? matched : [];
  }

  private async executeDelete(query: DeleteQuery, params: any[]): Promise<void> {
    const table = await this.getTable(query.table);
    const st = { i: 0 };
    const boundWhere = query.where ? bindCond(query.where, params, st) : undefined;

    const before = table.rows.length;
    table.rows = boundWhere
      ? (table.rows as any[]).filter((row) => !evalCond(boundWhere, row))
      : [];
    if (table.rows.length !== before) this.markDirty(query.table);
  }

  // CRUD Helper methods (for direct use when SQL is too complex)
  async findAll<T>(tableName: string): Promise<T[]> {
    const table = await this.getTable<T>(tableName);
    return [...table.rows];
  }

  async findById<T>(tableName: string, id: number): Promise<T | null> {
    const table = await this.getTable<T>(tableName);
    return table.rows.find((row: any) => row.id === id) || null;
  }

  async findOne<T>(tableName: string, predicate: (row: any) => boolean): Promise<T | null> {
    const table = await this.getTable<T>(tableName);
    return table.rows.find(predicate) || null;
  }

  async findMany<T>(tableName: string, predicate: (row: any) => boolean): Promise<T[]> {
    const table = await this.getTable<T>(tableName);
    return table.rows.filter(predicate);
  }

  async insert<T>(tableName: string, data: Partial<T>): Promise<T> {
    const table = await this.getTable<T>(tableName);
    const newRow: any = {
      ...data,
      id: table.nextId++,
      created_ts: (data as any).created_ts || Math.floor(Date.now() / 1000),
      updated_ts: (data as any).updated_ts || Math.floor(Date.now() / 1000),
    };
    table.rows.push(newRow);
    await this.saveTable(tableName, table);
    return newRow as T;
  }

  async update<T>(tableName: string, id: number, data: Partial<T>): Promise<T | null> {
    const table = await this.getTable<T>(tableName);
    const index = table.rows.findIndex((row: any) => row.id === id);
    if (index === -1) return null;

    table.rows[index] = {
      ...(table.rows[index] as any),
      ...data,
      updated_ts: Math.floor(Date.now() / 1000),
    };
    await this.saveTable(tableName, table);
    return table.rows[index];
  }

  async delete(tableName: string, id: number): Promise<boolean> {
    const table = await this.getTable(tableName);
    const beforeLength = table.rows.length;
    table.rows = table.rows.filter((row: any) => row.id !== id);
    if (table.rows.length < beforeLength) {
      await this.saveTable(tableName, table);
      return true;
    }
    return false;
  }

  async deleteWhere(tableName: string, predicate: (row: any) => boolean): Promise<number> {
    const table = await this.getTable(tableName);
    const beforeLength = table.rows.length;
    table.rows = table.rows.filter((row) => !predicate(row));
    const deleted = beforeLength - table.rows.length;
    if (deleted > 0) {
      await this.saveTable(tableName, table);
    }
    return deleted;
  }

  async count(tableName: string, predicate?: (row: any) => boolean): Promise<number> {
    const table = await this.getTable(tableName);
    if (!predicate) return table.rows.length;
    return table.rows.filter(predicate).length;
  }
}

// Prepared statement compatible with D1
export class BlobPreparedStatement {
  private params: any[] = [];

  constructor(
    private db: BlobDatabase,
    public sql: string
  ) {}

  bind(...values: any[]): this {
    this.params = values;
    return this;
  }

  async first<T = any>(colName?: string): Promise<T | null> {
    const rows = await this.db.executeQuery<T>(this.sql, this.params);
    if (rows.length === 0) return null;
    const row = rows[0];
    if (colName && colName in (row as any)) {
      return (row as any)[colName];
    }
    return row;
  }

  async all<T = any>(): Promise<BlobResult<T>> {
    try {
      const rows = await this.db.executeQuery<T>(this.sql, this.params);
      return {
        results: rows,
        success: true,
        meta: {
          duration: 0,
          rows_read: rows.length,
          rows_written: 0,
        },
      };
    } catch (error: any) {
      return {
        results: [],
        success: false,
        error: error.message,
        meta: { duration: 0, rows_read: 0, rows_written: 0 },
      };
    }
  }

  async run(): Promise<BlobResult<unknown>> {
    try {
      await this.db.executeQuery(this.sql, this.params);
      return {
        results: [],
        success: true,
        meta: { duration: 0, rows_read: 0, rows_written: 1 },
      };
    } catch (error: any) {
      return {
        results: [],
        success: false,
        error: error.message,
        meta: { duration: 0, rows_read: 0, rows_written: 0 },
      };
    }
  }

  async raw<T = any>(): Promise<T[]> {
    return this.db.executeQuery<T>(this.sql, this.params);
  }
}

export interface BlobResult<T = unknown> {
  results: T[];
  success: boolean;
  error?: string;
  meta: {
    duration: number;
    rows_read: number;
    rows_written: number;
  };
}

export interface BlobExecResult {
  count: number;
  duration: number;
}

// ---------------------------------------------------------------------------
// Statement structures
// ---------------------------------------------------------------------------

interface SelectItem {
  expr: Expr;
  alias: string;
}

interface SelectQuery {
  type: "select";
  table: string;
  star: boolean;
  items: SelectItem[];
  where?: Cond;
  orderBy?: Array<{ column: string; direction: "ASC" | "DESC" }>;
  limit?: number;
  offset?: number;
  limitIsParam?: boolean;
  offsetIsParam?: boolean;
}

interface InsertQuery {
  type: "insert";
  table: string;
  columns: string[];
  valueGroups: string[][];
  orIgnore: boolean;
  conflict?: {
    cols: string[];
    action: "nothing" | "update";
    assignments: Array<{ column: string; raw: string }>;
  };
  returning: boolean;
}

interface UpdateQuery {
  type: "update";
  table: string;
  set: Array<{ column: string; raw: string }>;
  where?: Cond;
  returning: boolean;
}

interface DeleteQuery {
  type: "delete";
  table: string;
  where?: Cond;
  returning: boolean;
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/** Split on a separator at paren-depth 0, respecting quoted strings. */
function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  let quote = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      cur += c;
      if (c === quote) quote = "";
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    if (c === "(") {
      depth++;
      cur += c;
      continue;
    }
    if (c === ")") {
      depth--;
      cur += c;
      continue;
    }
    if (c === sep && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter((x) => x !== "");
}

/** Index of the `)` matching the `(` at openIdx (quote-aware). */
function matchBalanced(s: string, openIdx: number): number {
  let depth = 0;
  let quote = "";
  for (let i = openIdx; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = "";
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error("Unbalanced parentheses in SQL");
}

/** Position of a keyword at paren-depth 0 outside string literals, or -1. */
function findTopLevelKeyword(s: string, from: number, kw: string): number {
  let depth = 0;
  let quote = "";
  const upper = kw.toUpperCase();
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = "";
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === "(") {
      depth++;
      continue;
    }
    if (c === ")") {
      depth--;
      continue;
    }
    if (depth === 0 && (i === 0 || !/[A-Za-z0-9_]/.test(s[i - 1]))) {
      if (s.slice(i, i + kw.length).toUpperCase() === upper) {
        const after = s[i + kw.length];
        if (after === undefined || !/[A-Za-z0-9_]/.test(after)) return i;
      }
    }
  }
  return -1;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Parse a scalar value expression used by INSERT VALUES / UPDATE SET. */
function parseValueRaw(raw: string): Expr {
  const t = raw.trim();
  if (/^strftime\s*\(/i.test(t)) return { k: "lit", v: nowSeconds() };
  if (/^current_timestamp$/i.test(t)) return { k: "lit", v: nowSeconds() };
  return SqlParser.value(t);
}

/** Parse, bind, and evaluate a scalar UPDATE SET value. */
function evalSetValue(raw: string, params: any[], st: { i: number }): any {
  // bindExpr is pure — it returns the rewritten expression, so it must be
  // used directly. Dropping the return value here (as this function did
  // before) leaves { k: "param" } unbound and evalExpr throws
  // "Unbound SQL parameter", 500ing every parameterized UPDATE.
  return evalExpr(bindExpr(parseValueRaw(raw), params, st), null);
}

// ---------------------------------------------------------------------------
// Statement parsers
// ---------------------------------------------------------------------------

function parseSimpleSQL(sql: string): SelectQuery | InsertQuery | UpdateQuery | DeleteQuery {
  const trimmed = sql.trim();
  const upper = trimmed.toUpperCase();

  if (upper.startsWith("SELECT")) return parseSelect(trimmed);
  if (upper.startsWith("INSERT")) return parseInsert(trimmed);
  if (upper.startsWith("UPDATE")) return parseUpdate(trimmed);
  if (upper.startsWith("DELETE")) return parseDelete(trimmed);

  throw new Error(`Unsupported SQL statement`);
}

function stripReturning(s: string): string {
  const m = /\s+RETURNING\s+[\s\S]+$/i.exec(s);
  return m ? s.slice(0, m.index) : s;
}

function hasReturning(s: string): boolean {
  return /\bRETURNING\b/i.test(s);
}

function parseSelect(sql: string): SelectQuery {
  const selectMatch = sql.match(/^SELECT\s+([\s\S]+?)\s+FROM\s+/i);
  if (!selectMatch) throw new Error("Invalid SELECT syntax");
  const selectListStr = selectMatch[1].trim();

  let rest = sql.slice(selectMatch[0].length);
  const tableMatch = rest.match(/^(\w+)/);
  if (!tableMatch) throw new Error("Invalid table name in SELECT");
  const table = tableMatch[1];
  rest = rest.slice(tableMatch[0].length);

  // Reject anything we cannot faithfully evaluate (JOIN, GROUP BY, ...) so
  // queries fail loudly instead of silently returning wrong rows.
  const afterTable = rest.trimStart();
  if (afterTable !== "" && !/^(WHERE|ORDER\s+BY|LIMIT|OFFSET)\b/i.test(afterTable)) {
    throw new Error(`Unsupported clause after table '${table}' in SELECT`);
  }

  const query: SelectQuery = { type: "select", table, star: false, items: [] };

  if (selectListStr === "*") {
    query.star = true;
  } else {
    for (const rawItem of splitTopLevel(selectListStr, ",")) {
      let item = rawItem;
      let alias: string | null = null;
      const asMatch = item.match(/^(.*?)\s+AS\s+([A-Za-z_][A-Za-z0-9_]*)$/i);
      if (asMatch) {
        item = asMatch[1].trim();
        alias = asMatch[2];
      }
      const expr = SqlParser.value(item);
      let finalAlias = alias;
      if (!finalAlias) {
        finalAlias = expr.k === "col" ? lastSegment(expr.name) : item;
      }
      query.items.push({ expr, alias: finalAlias });
    }
  }

  const whereMatch = rest.match(
    /^\s+WHERE\s+([\s\S]+?)(?=\s+ORDER\s+BY\s|\s+LIMIT\s|\s+OFFSET\s|$)/i
  );
  if (whereMatch) {
    query.where = SqlParser.cond(whereMatch[1].trim());
  }

  const orderMatch = rest.match(
    /\s+ORDER\s+BY\s+([\s\S]+?)(?=\s+LIMIT\s|\s+OFFSET\s|$)/i
  );
  if (orderMatch) {
    const keys: Array<{ column: string; direction: "ASC" | "DESC" }> = [];
    for (const part of splitTopLevel(orderMatch[1], ",")) {
      const m = part.match(/^([A-Za-z_][A-Za-z0-9_.]*)\s*(ASC|DESC)?$/i);
      if (!m) throw new Error(`Unsupported ORDER BY expression: ${part}`);
      keys.push({
        column: m[1],
        direction: ((m[2] || "ASC").toUpperCase() as "ASC" | "DESC"),
      });
    }
    if (keys.length > 0) query.orderBy = keys;
  }

  const limitMatch = rest.match(/\s+LIMIT\s+(\d+|\?)/i);
  if (limitMatch) {
    if (limitMatch[1] === "?") query.limitIsParam = true;
    else query.limit = parseInt(limitMatch[1], 10);
  }

  const offsetMatch = rest.match(/\s+OFFSET\s+(\d+|\?)/i);
  if (offsetMatch) {
    if (offsetMatch[1] === "?") query.offsetIsParam = true;
    else query.offset = parseInt(offsetMatch[1], 10);
  }

  return query;
}

function parseInsert(sql: string): InsertQuery {
  const s = sql.trim().replace(/;+\s*$/, "");
  const head = s.match(
    /^INSERT\s+(?:OR\s+(IGNORE|REPLACE)\s+)?INTO\s+([A-Za-z_][A-Za-z0-9_]*)\s*/i
  );
  if (!head) throw new Error("Invalid INSERT syntax");

  const orIgnore = !!head[1] && head[1].toUpperCase() === "IGNORE";
  const table = head[2];
  let pos = head[0].length;

  if (s[pos] !== "(") throw new Error("INSERT requires a column list");
  const colsEnd = matchBalanced(s, pos);
  const columns = splitTopLevel(s.slice(pos + 1, colsEnd), ",").map((c) =>
    c.replace(/"/g, "")
  );
  pos = colsEnd + 1;

  const vm = s.slice(pos).match(/^\s*VALUES\s*/i);
  if (!vm) throw new Error("INSERT without VALUES is not supported");
  pos += vm[0].length;

  const valueGroups: string[][] = [];
  for (;;) {
    while (pos < s.length && /\s/.test(s[pos])) pos++;
    if (pos >= s.length || s[pos] !== "(") break;
    const end = matchBalanced(s, pos);
    valueGroups.push(splitTopLevel(s.slice(pos + 1, end), ","));
    pos = end + 1;
    const cm = s.slice(pos).match(/^\s*,/);
    if (!cm) break;
    pos += cm[0].length;
  }
  if (valueGroups.length === 0) throw new Error("INSERT has no VALUES");

  let conflict: InsertQuery["conflict"];
  const oc = /^\s*ON\s+CONFLICT\s*\(/i.exec(s.slice(pos));
  if (oc) {
    const openIdx = pos + oc[0].length - 1; // index of '('
    const cEnd = matchBalanced(s, openIdx);
    const conflictCols = splitTopLevel(s.slice(openIdx + 1, cEnd), ",");
    pos = cEnd + 1;

    const nothing = /^\s*DO\s+NOTHING\b/i.exec(s.slice(pos));
    const update = /^\s*DO\s+UPDATE\s+SET\s+/i.exec(s.slice(pos));
    if (nothing) {
      conflict = { cols: conflictCols, action: "nothing", assignments: [] };
      pos += nothing[0].length;
    } else if (update) {
      pos += update[0].length;
      const assignStr = stripReturning(s.slice(pos));
      const assignments = splitTopLevel(assignStr, ",")
        .map((a) => {
          const eq = a.indexOf("=");
          if (eq < 0) throw new Error(`Invalid ON CONFLICT assignment: ${a}`);
          return { column: a.slice(0, eq).trim(), raw: a.slice(eq + 1).trim() };
        })
        .filter((a) => a.column !== "");
      conflict = { cols: conflictCols, action: "update", assignments };
      pos = s.length;
    } else {
      throw new Error("Unsupported ON CONFLICT clause");
    }
  }

  return {
    type: "insert",
    table,
    columns,
    valueGroups,
    orIgnore,
    conflict,
    returning: hasReturning(s),
  };
}

function parseUpdate(sql: string): UpdateQuery {
  const s = sql.trim().replace(/;+\s*$/, "");
  const head = s.match(/^UPDATE\s+([A-Za-z_][A-Za-z0-9_]*)\s+SET\s+/i);
  if (!head) throw new Error("Invalid UPDATE syntax");
  const table = head[1];
  const bodyStart = head[0].length;

  let setStr: string;
  let whereStr = "";
  const whereIdx = findTopLevelKeyword(s, bodyStart, "WHERE");
  if (whereIdx >= 0) {
    setStr = s.slice(bodyStart, whereIdx);
    whereStr = s.slice(whereIdx + "WHERE".length).trim();
  } else {
    setStr = s.slice(bodyStart);
  }

  const returning = hasReturning(s);
  const set = splitTopLevel(stripReturning(setStr), ",").map((assign) => {
    const eq = assign.indexOf("=");
    if (eq < 0) throw new Error(`Invalid SET assignment: ${assign}`);
    return {
      column: assign.slice(0, eq).trim(),
      raw: assign.slice(eq + 1).trim(),
    };
  });
  if (set.length === 0) throw new Error("UPDATE without SET clause");

  return {
    type: "update",
    table,
    set,
    where: whereStr ? SqlParser.cond(stripReturning(whereStr)) : undefined,
    returning,
  };
}

function parseDelete(sql: string): DeleteQuery {
  const s = sql.trim().replace(/;+\s*$/, "");
  const head = s.match(/^DELETE\s+FROM\s+([A-Za-z_][A-Za-z0-9_]*)/i);
  if (!head) throw new Error("Invalid DELETE syntax");
  const table = head[1];
  const rest = stripReturning(s.slice(head[0].length));
  const wm = /^\s+WHERE\s+([\s\S]+)$/i.exec(rest);
  return {
    type: "delete",
    table,
    where: wm ? SqlParser.cond(wm[1].trim()) : undefined,
    returning: hasReturning(s),
  };
}

// ---------------------------------------------------------------------------
// Recursive-descent expression / condition parser
// ---------------------------------------------------------------------------

class SqlParser {
  private i = 0;

  constructor(private src: string) {}

  /** Parse a complete boolean condition expression. */
  static cond(s: string): Cond {
    const p = new SqlParser(s);
    const c = p.parseCond();
    p.finish("condition");
    return c;
  }

  /** Parse a complete scalar expression. */
  static value(s: string): Expr {
    const p = new SqlParser(s);
    const e = p.parseExpr();
    p.finish("expression");
    return e;
  }

  private finish(what: string): void {
    this.ws();
    if (this.i < this.src.length) {
      throw new Error(
        `Unexpected SQL after ${what} at ${this.i}: '${this.src.slice(this.i)}' in: ${this.src}`
      );
    }
  }

  private ws(): void {
    while (this.i < this.src.length && /\s/.test(this.src[this.i])) this.i++;
  }

  private rest(): string {
    return this.src.slice(this.i);
  }

  private matchKeyword(...kws: string[]): string | null {
    this.ws();
    for (const kw of kws) {
      const m = new RegExp("^" + kw + "\\b", "i").exec(this.rest());
      if (m) {
        this.i += m[0].length;
        return kw.toUpperCase();
      }
    }
    return null;
  }

  private expect(ch: string): void {
    this.ws();
    if (this.src[this.i] !== ch) {
      throw new Error(
        `SQL parse error: expected '${ch}' at ${this.i} in: ${this.src}`
      );
    }
    this.i++;
  }

  // -- scalar expressions ---------------------------------------------------

  parseExpr(): Expr {
    this.ws();
    const c = this.src[this.i];
    if (c === undefined) {
      throw new Error(`SQL parse error: unexpected end of input in: ${this.src}`);
    }
    if (c === "?") {
      this.i++;
      return { k: "param" };
    }
    if (c === "(") {
      this.i++;
      const e = this.parseExpr();
      this.expect(")");
      return e;
    }
    if (c === "'" || c === '"') return this.parseStringLit();
    if (/[0-9]/.test(c) || ((c === "-" || c === "+") && /[0-9]/.test(this.src[this.i + 1] ?? ""))) {
      return this.parseNumber();
    }
    if (/[A-Za-z_]/.test(c)) return this.parseIdentOrCall();
    throw new Error(`SQL parse error: unexpected '${c}' at ${this.i} in: ${this.src}`);
  }

  private parseStringLit(): Expr {
    const q = this.src[this.i];
    this.i++;
    let out = "";
    let closed = false;
    while (this.i < this.src.length) {
      const c = this.src[this.i];
      if (c === q) {
        if (this.src[this.i + 1] === q) {
          out += q;
          this.i += 2;
          continue;
        }
        this.i++;
        closed = true;
        break;
      }
      out += c;
      this.i++;
    }
    if (!closed) {
      throw new Error(`SQL parse error: unterminated string in: ${this.src}`);
    }
    return { k: "lit", v: out };
  }

  private parseNumber(): Expr {
    this.ws();
    const m = this.rest().match(/^[+-]?\d+(\.\d+)?/);
    if (!m) throw new Error(`SQL parse error: invalid number in: ${this.src}`);
    this.i += m[0].length;
    return { k: "lit", v: Number(m[0]) };
  }

  private parseIdentOrCall(): Expr {
    const identRe = /^[A-Za-z_][A-Za-z0-9_]*/;
    const m = this.rest().match(identRe);
    if (!m) throw new Error(`SQL parse error: invalid identifier in: ${this.src}`);
    const first = m[0];
    this.i += m[0].length;

    let name = first;
    while (this.src[this.i] === ".") {
      this.i++;
      const m2 = this.rest().match(identRe);
      if (!m2) throw new Error(`SQL parse error: invalid qualified name in: ${this.src}`);
      name += "." + m2[0];
      this.i += m2[0].length;
    }

    if (first.toLowerCase() === "excluded" && name.includes(".")) {
      return { k: "excluded", name: name.slice(name.indexOf(".") + 1) };
    }

    if (this.src[this.i] === "(") {
      this.i++;
      const lower = name.toLowerCase();

      if (lower === "count") {
        this.ws();
        if (this.src[this.i] === "*") {
          this.i++;
          this.expect(")");
          return { k: "count_star" };
        }
        throw new Error("SQL: only COUNT(*) is supported");
      }

      const args: Expr[] = [];
      this.ws();
      if (this.src[this.i] !== ")") {
        for (;;) {
          args.push(this.parseExpr());
          this.ws();
          if (this.src[this.i] === ",") {
            this.i++;
            continue;
          }
          break;
        }
      }
      this.expect(")");

      if (lower === "json_extract") {
        if (args.length !== 2 || args[1].k !== "lit" || typeof args[1].v !== "string") {
          throw new Error("json_extract requires (json, 'path')");
        }
        return { k: "json_extract", json: args[0], path: args[1].v };
      }
      if (lower === "json_array_length") {
        if (args.length < 1) throw new Error("json_array_length requires 1 argument");
        return { k: "json_array_length", arg: args[0] };
      }
      if (lower === "coalesce") {
        if (args.length < 1) throw new Error("coalesce requires at least 1 argument");
        return { k: "coalesce", args };
      }
      if (lower === "sum") {
        if (args.length !== 1) throw new Error("sum requires 1 argument");
        return { k: "sum", arg: args[0] };
      }
      throw new Error(`Unsupported SQL function: ${name}`);
    }

    const lowerName = name.toLowerCase();
    if (lowerName === "null") return { k: "lit", v: null };
    if (lowerName === "true") return { k: "lit", v: 1 };
    if (lowerName === "false") return { k: "lit", v: 0 };
    if (lowerName === "current_timestamp") return { k: "lit", v: nowSeconds() };

    return { k: "col", name };
  }

  // -- boolean conditions ---------------------------------------------------

  parseCond(): Cond {
    return this.parseOr();
  }

  private parseOr(): Cond {
    let left = this.parseAnd();
    while (this.matchKeyword("OR")) {
      const right = this.parseAnd();
      left = { k: "or", l: left, r: right };
    }
    return left;
  }

  private parseAnd(): Cond {
    let left = this.parseNot();
    while (this.matchKeyword("AND")) {
      const right = this.parseNot();
      left = { k: "and", l: left, r: right };
    }
    return left;
  }

  private parseNot(): Cond {
    if (this.matchKeyword("NOT")) return { k: "not", c: this.parseNot() };
    return this.parsePrimaryCond();
  }

  private parsePrimaryCond(): Cond {
    this.ws();
    if (this.src[this.i] === "(") {
      this.i++;
      const c = this.parseCond();
      this.expect(")");
      return c;
    }
    if (this.matchKeyword("EXISTS")) return this.parseExists();

    const left = this.parseExpr();

    let neg = false;
    if (this.matchKeyword("NOT")) {
      neg = true;
    }

    if (this.matchKeyword("IS")) {
      const isNeg = this.matchKeyword("NOT") !== null;
      if (!this.matchKeyword("NULL")) {
        throw new Error(`SQL parse error: expected NULL after IS in: ${this.src}`);
      }
      return { k: "isnull", e: left, neg: isNeg };
    }

    if (this.matchKeyword("IN")) {
      this.expect("(");
      const list: Expr[] = [];
      this.ws();
      if (this.src[this.i] !== ")") {
        for (;;) {
          list.push(this.parseExpr());
          this.ws();
          if (this.src[this.i] === ",") {
            this.i++;
            continue;
          }
          break;
        }
      }
      this.expect(")");
      return { k: "in", e: left, list, neg };
    }

    if (this.matchKeyword("LIKE")) {
      const pat = this.parseExpr();
      let esc: string | null = null;
      if (this.matchKeyword("ESCAPE")) {
        const e = this.parseExpr();
        if (e.k !== "lit" || typeof e.v !== "string") {
          throw new Error(`SQL parse error: ESCAPE must be a string literal in: ${this.src}`);
        }
        esc = e.v;
      }
      return { k: "like", e: left, pat, neg, esc };
    }

    if (neg) {
      throw new Error(
        `SQL parse error: NOT must be followed by IN or LIKE in: ${this.src}`
      );
    }

    this.ws();
    const opMatch = this.rest().match(/^(==|!=|<>|>=|<=|=|>|<)/);
    if (!opMatch) {
      throw new Error(
        `SQL parse error: expected a comparison operator at ${this.i} in: ${this.src}`
      );
    }
    this.i += opMatch[0].length;
    const right = this.parseExpr();
    return { k: "cmp", op: opMatch[0], l: left, r: right };
  }

  private parseExists(): Cond {
    this.expect("(");
    const start = this.i;
    let depth = 1;
    let quote = "";
    while (this.i < this.src.length) {
      const c = this.src[this.i];
      if (quote) {
        if (c === quote) quote = "";
      } else if (c === "'" || c === '"') {
        quote = c;
      } else if (c === "(") {
        depth++;
      } else if (c === ")") {
        depth--;
        if (depth === 0) break;
      }
      this.i++;
    }
    if (depth !== 0) {
      throw new Error(`SQL parse error: unbalanced EXISTS(...) in: ${this.src}`);
    }
    const content = this.src.slice(start, this.i);
    this.expect(")");

    const m = /^\s*SELECT\s+1\s+FROM\s+json_each\s*\(/i.exec(content);
    if (!m) {
      throw new Error(`Unsupported EXISTS subquery: ${content}`);
    }

    const inner = new SqlParser(content);
    inner.i = m[0].length;
    const args: Expr[] = [];
    inner.ws();
    if (inner.src[inner.i] !== ")") {
      for (;;) {
        args.push(inner.parseExpr());
        inner.ws();
        if (inner.src[inner.i] === ",") {
          inner.i++;
          continue;
        }
        break;
      }
    }
    inner.expect(")");

    if (!inner.matchKeyword("AS")) {
      throw new Error(`Expected AS alias in json_each subquery: ${content}`);
    }
    const aliasMatch = inner.rest().match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (!aliasMatch) {
      throw new Error(`Expected alias identifier in json_each subquery: ${content}`);
    }
    inner.i += aliasMatch[0].length;

    if (!inner.matchKeyword("WHERE")) {
      throw new Error(`Expected WHERE in json_each subquery: ${content}`);
    }
    const innerCond = inner.parseCond();
    inner.finish("EXISTS subquery");

    const jsonArg = args[0];
    if (!jsonArg) throw new Error("json_each requires a json argument");
    let path = "$";
    if (args.length > 1) {
      const p = args[1];
      if (p.k !== "lit" || typeof p.v !== "string") {
        throw new Error("json_each path must be a string literal");
      }
      path = p.v;
    }

    return { k: "exists_json_each", json: jsonArg, path, alias: aliasMatch[0], inner: innerCond };
  }
}

// ---------------------------------------------------------------------------
// Parameter binding — rewrite param nodes once, in source order
// ---------------------------------------------------------------------------

function bindExpr(e: Expr, params: any[], st: { i: number }): Expr {
  switch (e.k) {
    case "param":
      if (st.i >= params.length) {
        throw new Error(`Missing SQL parameter #${st.i + 1}`);
      }
      return { k: "lit", v: normalizeParam(params[st.i++]) };
    case "json_extract":
      return { ...e, json: bindExpr(e.json, params, st) };
    case "json_array_length":
      return { ...e, arg: bindExpr(e.arg, params, st) };
    case "coalesce":
      return { ...e, args: e.args.map((a) => bindExpr(a, params, st)) };
    case "sum":
      return { ...e, arg: bindExpr(e.arg, params, st) };
    default:
      return e;
  }
}

function bindCond(c: Cond, params: any[], st: { i: number }): Cond {
  switch (c.k) {
    case "and":
    case "or":
      return { ...c, l: bindCond(c.l, params, st), r: bindCond(c.r, params, st) };
    case "not":
      return { ...c, c: bindCond(c.c, params, st) };
    case "cmp":
      return { ...c, l: bindExpr(c.l, params, st), r: bindExpr(c.r, params, st) };
    case "isnull":
      return { ...c, e: bindExpr(c.e, params, st) };
    case "in":
      return {
        ...c,
        e: bindExpr(c.e, params, st),
        list: c.list.map((x) => bindExpr(x, params, st)),
      };
    case "like":
      return { ...c, e: bindExpr(c.e, params, st), pat: bindExpr(c.pat, params, st) };
    case "exists_json_each":
      return {
        ...c,
        json: bindExpr(c.json, params, st),
        inner: bindCond(c.inner, params, st),
      };
  }
}

/**
 * Normalize bound parameters: SQLite stores booleans as 0/1, and this engine
 * persists JSON — coerce booleans so `flag = 1` style comparisons work.
 */
function normalizeParam(v: any): any {
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

function safeParseJson(value: any): any {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function getByPath(obj: any, path: string): any {
  if (obj === null || obj === undefined) return null;
  const segments = path
    .replace(/^\$/, "")
    .split(".")
    .filter((s) => s !== "");
  let cur = obj;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return null;
    cur = cur[seg];
  }
  return cur === undefined ? null : cur;
}

/** Mirror SQLite json_extract scalar coercion: true/false become 1/0. */
function normalizeJsonValue(v: any): any {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === undefined) return null;
  return v;
}

function evalExpr(e: Expr, row: any, excluded?: Record<string, any>): any {
  switch (e.k) {
    case "lit":
      return e.v;
    case "col": {
      const name = e.name.includes(".")
        ? e.name.slice(e.name.lastIndexOf(".") + 1)
        : e.name;
      const v = row === null || row === undefined ? undefined : row[name];
      return v === undefined ? null : v;
    }
    case "excluded":
      return excluded ? excluded[e.name] ?? null : null;
    case "json_extract": {
      const jsonVal = evalExpr(e.json, row, excluded);
      const obj = safeParseJson(jsonVal);
      if (obj === null || obj === undefined) return null;
      return normalizeJsonValue(getByPath(obj, e.path));
    }
    case "json_array_length": {
      const v = evalExpr(e.arg, row, excluded);
      if (v === null || v === undefined) return null;
      if (Array.isArray(v)) return v.length;
      const parsed = safeParseJson(v);
      return Array.isArray(parsed) ? parsed.length : null;
    }
    case "coalesce": {
      for (const a of e.args) {
        const v = evalExpr(a, row, excluded);
        if (v !== null && v !== undefined) return v;
      }
      return null;
    }
    case "sum":
    case "count_star":
      throw new Error("Aggregates are only allowed in the SELECT list");
    case "param":
      throw new Error("Unbound SQL parameter");
  }
}

function containsAgg(e: Expr): boolean {
  switch (e.k) {
    case "sum":
    case "count_star":
      return true;
    case "json_extract":
      return containsAgg(e.json);
    case "json_array_length":
      return containsAgg(e.arg);
    case "coalesce":
      return e.args.some(containsAgg);
    default:
      return false;
  }
}

/** Evaluate a SELECT-list expression over the filtered row set. */
function evalAggregate(e: Expr, rows: any[]): any {
  if (e.k === "count_star") return rows.length;
  if (e.k === "sum") {
    let sum = 0;
    for (const r of rows) {
      const v = evalExpr(e.arg, r);
      if (v !== null && v !== undefined) sum += Number(v) || 0;
    }
    return sum;
  }
  if (e.k === "coalesce") {
    for (const a of e.args) {
      const v = containsAgg(a) ? evalAggregate(a, rows) : evalExpr(a, rows[0] ?? null);
      if (v !== null && v !== undefined) return v;
    }
    return null;
  }
  if (e.k === "param") throw new Error("Unbound SQL parameter");
  return evalExpr(e, rows[0] ?? null);
}

function isNumericLike(v: any): boolean {
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "string" && v.trim() !== "") return !Number.isNaN(Number(v));
  return false;
}

function looseScalar(v: any): any {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === undefined) return null;
  return v;
}

/** SQLite-flavoured equality: NULL never equals anything (use IS NULL). */
function valueEquals(a: any, b: any): boolean {
  a = looseScalar(a);
  b = looseScalar(b);
  if (a === null || b === null) return a === b;
  if (typeof a === typeof b) return a === b;
  if (isNumericLike(a) && isNumericLike(b)) return Number(a) === Number(b);
  return String(a) === String(b);
}

function compareValues(op: string, l: any, r: any): boolean {
  if (l === null || r === null) return false; // NULL comparisons are unknown → false
  let a = looseScalar(l);
  let b = looseScalar(r);
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) {
    if (isNumericLike(a) && isNumericLike(b)) {
      a = Number(a);
      b = Number(b);
    } else {
      a = String(a);
      b = String(b);
    }
  }
  switch (op) {
    case "=":
    case "==":
      return a === b;
    case "!=":
    case "<>":
      return a !== b;
    case ">":
      return a > b;
    case "<":
      return a < b;
    case ">=":
      return a >= b;
    case "<=":
      return a <= b;
    default:
      throw new Error(`Unsupported comparison operator: ${op}`);
  }
}

const likeCache = new Map<string, RegExp>();

function regexEscape(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getLikeRegex(pattern: string, esc: string | null): RegExp {
  const key = `${esc ?? "\u0000"}:${pattern}`;
  const cached = likeCache.get(key);
  if (cached) return cached;

  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (esc !== null && ch === esc) {
      i++;
      const next = pattern[i];
      if (next === undefined) {
        out += "\\"; // dangling escape char — treat literally
      } else if (next === "%" || next === "_") {
        out += regexEscape(next);
      } else {
        out += regexEscape(next);
      }
      continue;
    }
    if (ch === "%") out += "[\\s\\S]*";
    else if (ch === "_") out += "[\\s\\S]";
    else out += regexEscape(ch);
  }
  const re = new RegExp(out + "$", "i");
  if (likeCache.size < 500) likeCache.set(key, re);
  return re;
}

function likeMatch(value: string, pattern: string, esc: string | null): boolean {
  return getLikeRegex(pattern, esc).test(value);
}

function evalCond(c: Cond, row: any): boolean {
  switch (c.k) {
    case "and":
      return evalCond(c.l, row) && evalCond(c.r, row);
    case "or":
      return evalCond(c.l, row) || evalCond(c.r, row);
    case "not":
      return !evalCond(c.c, row);
    case "cmp":
      return compareValues(c.op, evalExpr(c.l, row), evalExpr(c.r, row));
    case "isnull": {
      const v = evalExpr(c.e, row);
      const isNull = v === null || v === undefined;
      return c.neg ? !isNull : isNull;
    }
    case "in": {
      const v = evalExpr(c.e, row);
      const found = c.list.some((x) => valueEquals(evalExpr(x, row), v));
      return c.neg ? !found : found;
    }
    case "like": {
      const v = evalExpr(c.e, row);
      const pat = evalExpr(c.pat, row);
      const ok =
        v !== null &&
        v !== undefined &&
        pat !== null &&
        pat !== undefined &&
        likeMatch(String(v), String(pat), c.esc);
      return c.neg ? !ok : ok;
    }
    case "exists_json_each": {
      const jsonVal = evalExpr(c.json, row);
      const obj = safeParseJson(jsonVal);
      const arr = getByPath(obj, c.path);
      if (!Array.isArray(arr)) return false;
      return arr.some((el, idx) => evalCond(c.inner, { value: el, key: idx }));
    }
  }
}

function lastSegment(name: string): string {
  return name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
}

// Factory function
export function createBlobDatabase(storage: StorageProvider): BlobDatabase {
  return new BlobDatabase(storage);
}
