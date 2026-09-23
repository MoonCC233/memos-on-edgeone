/**
 * Blob Database - Complete replacement for Turso/SQL
 * Stores all Memos data as JSON documents in EdgeOne Blob storage
 * Provides D1Database-compatible interface for minimal code changes
 */

import { createStorageProvider, StorageProvider } from "../storage";

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

export class BlobDatabase {
  private storage: StorageProvider;
  private cache: Map<string, TableData> = new Map();
  private initialized = false;

  constructor(storage: StorageProvider) {
    this.storage = storage;
  }

  private getTableKey(tableName: string): string {
    return `${TABLE_PREFIX}${tableName}.json`;
  }

  private async getTable<T>(tableName: string): Promise<TableData<T>> {
    if (this.cache.has(tableName)) {
      return this.cache.get(tableName) as TableData<T>;
    }

    const key = this.getTableKey(tableName);
    const result = await this.storage.get(key, { type: "json" as any });

    if (!result || !result.body) {
      const emptyTable: TableData<T> = { rows: [], nextId: 1 };
      this.cache.set(tableName, emptyTable as TableData);
      return emptyTable;
    }

    let data: TableData<T>;
    try {
      const text = await this.readBody(result.body);
      data = JSON.parse(text);
      if (!data.rows) data = { rows: [], nextId: 1 };
      if (!data.nextId) data.nextId = data.rows.length + 1;
    } catch {
      data = { rows: [], nextId: 1 };
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
    const key = this.getTableKey(tableName);
    await this.storage.put(key, JSON.stringify(data), { contentType: "application/json" });
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    // Pre-load all tables
    for (const tableName of TABLES) {
      await this.getTable(tableName);
    }
    this.initialized = true;
  }

  async persist(): Promise<void> {
    // Save all modified tables
    for (const [tableName, data] of this.cache.entries()) {
      await this.saveTable(tableName, data);
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
    
    if (parsed.type === "select") {
      return await this.executeSelect<T>(parsed, params);
    } else if (parsed.type === "insert") {
      return await this.executeInsert<T>(parsed, params);
    } else if (parsed.type === "update") {
      return await this.executeUpdate(parsed, params);
    } else if (parsed.type === "delete") {
      await this.executeDelete(parsed, params);
      return [];
    }

    throw new Error(`Unsupported SQL: ${sql}`);
  }

  private async executeSelect<T>(query: SelectQuery, params: any[]): Promise<T[]> {
    const table = await this.getTable(query.table);
    let rows = [...table.rows] as any[];

    // Apply WHERE conditions
    if (query.where) {
      let paramIndex = 0;
      rows = rows.filter((row) => evaluateCondition(row, query.where!, params, paramIndex));
    }

    // Apply ORDER BY
    if (query.orderBy) {
      const { column, direction } = query.orderBy;
      rows.sort((a, b) => {
        const aVal = a[column];
        const bVal = b[column];
        const cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
        return direction === "DESC" ? -cmp : cmp;
      });
    }

    // Apply LIMIT and OFFSET
    if (query.offset !== undefined) {
      rows = rows.slice(query.offset);
    }
    if (query.limit !== undefined) {
      rows = rows.slice(0, query.limit);
    }

    // Handle COUNT(*)
    if (query.columns.includes("COUNT(*)") || query.columns.some(c => c.includes("COUNT("))) {
      return [{ count: rows.length, total: rows.length } as any];
    }

    // Select columns
    if (query.columns.includes("*")) {
      return rows as T[];
    }

    return rows.map((row) => {
      const selected: any = {};
      for (const col of query.columns) {
        const alias = query.columnAliases?.[col] || col;
        selected[alias] = row[col];
      }
      return selected;
    }) as T[];
  }

  private async executeInsert<T>(query: InsertQuery, params: any[]): Promise<T[]> {
    const table = await this.getTable(query.table);
    
    const newRow: any = {};
    let paramIndex = 0;

    if (query.columns) {
      for (let i = 0; i < query.columns.length; i++) {
        const col = query.columns[i];
        const val = query.values[i];
        if (val === "?") {
          newRow[col] = params[paramIndex++];
        } else if (val === "CURRENT_TIMESTAMP") {
          newRow[col] = new Date().toISOString();
        } else {
          newRow[col] = val;
        }
      }
    }

    // Set default ID if not present
    if (!newRow.id) {
      newRow.id = table.nextId++;
    }

    // Set timestamps if not present
    if (!newRow.created_ts) newRow.created_ts = Math.floor(Date.now() / 1000);
    if (!newRow.updated_ts) newRow.updated_ts = Math.floor(Date.now() / 1000);

    // Handle RETURNING
    if (query.returning) {
      return [newRow] as T[];
    }

    return [] as T[];
  }

  private async executeUpdate(query: UpdateQuery, params: any[]): Promise<void> {
    const table = await this.getTable(query.table);
    let paramIndex = 0;

    for (const row of table.rows as any[]) {
      if (evaluateCondition(row, query.where!, params, paramIndex)) {
        // Apply SET values
        for (const { column, value } of query.set) {
          if (value === "?") {
            row[column] = params[paramIndex++];
          } else if (value.includes("strftime")) {
            row[column] = Math.floor(Date.now() / 1000);
          } else {
            row[column] = value;
          }
        }
        row.updated_ts = Math.floor(Date.now() / 1000);
      }
    }
  }

  private async executeDelete(query: DeleteQuery, params: any[]): Promise<void> {
    const table = await this.getTable(query.table);
    const beforeLength = table.rows.length;
    let paramIndex = 0;

    table.rows = table.rows.filter((row) => {
      return !evaluateCondition(row, query.where!, params, paramIndex);
    });

    if (table.rows.length < beforeLength) {
      // Table modified
    }
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
      created_ts: data.created_ts || Math.floor(Date.now() / 1000),
      updated_ts: data.updated_ts || Math.floor(Date.now() / 1000),
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
      await this.db.persist();
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
      await this.db.persist();
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
    const rows = await this.db.executeQuery<T>(this.sql, this.params);
    await this.db.persist();
    return rows;
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

// SQL Parser (simplified for common patterns)
interface SelectQuery {
  type: "select";
  table: string;
  columns: string[];
  columnAliases?: Record<string, string>;
  where?: Condition;
  orderBy?: { column: string; direction: "ASC" | "DESC" };
  limit?: number;
  offset?: number;
}

interface InsertQuery {
  type: "insert";
  table: string;
  columns?: string[];
  values: any[];
  returning?: boolean;
}

interface UpdateQuery {
  type: "update";
  table: string;
  set: Array<{ column: string; value: string }>;
  where: Condition;
}

interface DeleteQuery {
  type: "delete";
  table: string;
  where: Condition;
}

interface Condition {
  type: "binary" | "logical" | "comparison";
  left?: Condition | string;
  operator?: string;
  right?: Condition | string;
  value?: any;
}

function parseSimpleSQL(sql: string): SelectQuery | InsertQuery | UpdateQuery | DeleteQuery {
  const trimmed = sql.trim();
  const upper = trimmed.toUpperCase();

  if (upper.startsWith("SELECT")) return parseSelect(trimmed);
  if (upper.startsWith("INSERT")) return parseInsert(trimmed);
  if (upper.startsWith("UPDATE")) return parseUpdate(trimmed);
  if (upper.startsWith("DELETE")) return parseDelete(trimmed);

  throw new Error(`Unsupported SQL statement`);
}

function parseSelect(sql: string): SelectQuery {
  // Simplified SELECT parser
  const match = sql.match(
    /SELECT\s+(.+?)\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+?))?(?:\s+ORDER\s+BY\s+(\w+)\s+(ASC|DESC))?(?:\s+LIMIT\s+(\d+))?(?:\s+OFFSET\s+(\d+))?/i
  );

  if (!match) throw new Error("Invalid SELECT syntax");

  const [, colsStr, table, whereStr, orderByCol, orderDir, limit, offset] = match;

  const columns = colsStr.split(",").map((c) => c.trim());

  const query: SelectQuery = {
    type: "select",
    table,
    columns,
  };

  if (whereStr) {
    query.where = parseWhere(whereStr);
  }

  if (orderByCol) {
    query.orderBy = { column: orderByCol, direction: (orderDir as "ASC" | "DESC") || "ASC" };
  }

  if (limit) query.limit = parseInt(limit);
  if (offset) query.offset = parseInt(offset);

  return query;
}

function parseInsert(sql: string): InsertQuery {
  // Simplified INSERT parser
  const match = sql.match(
    /INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)(?:\s+RETURNING\s+(.+))?/i
  );

  if (!match) throw new Error("Invalid INSERT syntax");

  const [, table, colsStr, valsStr, returning] = match;
  const columns = colsStr.split(",").map((c) => c.trim());
  const values = valsStr.split(",").map((v) => v.trim());

  return {
    type: "insert",
    table,
    columns,
    values,
    returning: !!returning,
  };
}

function parseUpdate(sql: string): UpdateQuery {
  // Simplified UPDATE parser
  const match = sql.match(
    /UPDATE\s+(\w+)\s+SET\s+(.+?)\s+WHERE\s+(.+)/i
  );

  if (!match) throw new Error("Invalid UPDATE syntax");

  const [, table, setStr, whereStr] = match;
  const set = setStr.split(",").map((s) => {
    const [col, val] = s.split("=").map((x) => x.trim());
    return { column: col, value: val };
  });

  return {
    type: "update",
    table,
    set,
    where: parseWhere(whereStr),
  };
}

function parseDelete(sql: string): DeleteQuery {
  const match = sql.match(/DELETE\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+))?/i);
  if (!match) throw new Error("Invalid DELETE syntax");

  const [, table, whereStr] = match;

  return {
    type: "delete",
    table,
    where: whereStr ? parseWhere(whereStr) : { type: "logical", operator: "true" },
  };
}

function parseWhere(whereStr: string): Condition {
  // Very simplified WHERE parser - handles basic conditions
  // This is a starting point and may need extension
  
  // Handle OR conditions
  const orParts = whereStr.split(/\s+OR\s+/i);
  if (orParts.length > 1) {
    return {
      type: "logical",
      operator: "OR",
      left: parseWhere(orParts[0]),
      right: parseWhere(orParts.slice(1).join(" OR ")),
    };
  }

  // Handle AND conditions
  const andParts = whereStr.split(/\s+AND\s+/i);
  if (andParts.length > 1) {
    return {
      type: "logical",
      operator: "AND",
      left: parseWhere(andParts[0]),
      right: parseWhere(andParts.slice(1).join(" AND ")),
    };
  }

  // Handle comparison operators
  const compMatch = whereStr.match(/(\w+)\s*(=|!=|<>|>=|<=|>|<)\s*(.+)/);
  if (compMatch) {
    const [, col, op, val] = compMatch;
    let value = val.trim();
    if (value.startsWith("?")) {
      value = "?";
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    } else if (!isNaN(Number(value))) {
      value = Number(value);
    }
    return { type: "comparison", left: col, operator: op, value };
  }

  throw new Error(`Cannot parse condition: ${whereStr}`);
}

function evaluateCondition(row: any, condition: Condition, params: any[], paramIndex: number): boolean {
  if (condition.type === "logical") {
    const left = evaluateCondition(row, condition.left as Condition, params, paramIndex);
    const right = evaluateCondition(row, condition.right as Condition, params, paramIndex);
    if (condition.operator === "AND") return left && right;
    if (condition.operator === "OR") return left || right;
    if (condition.operator === "true") return true;
    return false;
  }

  if (condition.type === "comparison") {
    const col = condition.left as string;
    const op = condition.operator!;
    let expected = condition.value;

    // Handle parameter placeholder
    if (expected === "?") {
      expected = params[paramIndex];
    }

    const actual = row[col];

    switch (op) {
      case "=": return actual === expected;
      case "!=":
      case "<>": return actual !== expected;
      case ">": return actual > expected;
      case "<": return actual < expected;
      case ">=": return actual >= expected;
      case "<=": return actual <= expected;
      default: return false;
    }
  }

  return false;
}

// Factory function
export function createBlobDatabase(storage: StorageProvider): BlobDatabase {
  return new BlobDatabase(storage);
}