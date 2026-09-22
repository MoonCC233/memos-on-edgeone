/**
 * D1Database Compatibility Wrapper
 * Provides D1Database interface using Turso DatabaseProvider
 */

import { DatabaseProvider, QueryResult } from "./index";

export class D1DatabaseWrapper {
  private db: DatabaseProvider;

  constructor(db: DatabaseProvider) {
    this.db = db;
  }

  prepare(query: string): D1PreparedStatementWrapper {
    return new D1PreparedStatementWrapper(this.db, query);
  }

  async dump(): Promise<ArrayBuffer> {
    // Not implemented for Turso
    throw new Error("dump() not supported");
  }

  async batch<T = unknown>(statements: D1PreparedStatementWrapper[]): Promise<D1Result<T>[]> {
    const batchStatements = statements.map(s => ({ 
      sql: s.query, 
      params: s.params 
    }));
    const results = await this.db.executeBatch(batchStatements);
    return results.map(r => ({
      results: r.rows as T[],
      success: true,
      meta: {
        duration: 0,
        rows_read: r.rows.length,
        rows_written: r.rowsAffected
      }
    }));
  }

  async exec(query: string): Promise<D1ExecResult> {
    const result = await this.db.execute(query);
    return {
      count: result.rowsAffected,
      duration: 0
    };
  }
}

export class D1PreparedStatementWrapper {
  private params: any[] = [];

  constructor(
    private db: DatabaseProvider,
    public query: string
  ) {}

  bind(...values: unknown[]): this {
    this.params = values;
    return this;
  }

  async first<T = unknown>(colName?: string): Promise<T | null> {
    const result = await this.db.execute(this.query, this.params);
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    if (colName && colName in row) {
      return row[colName] as T;
    }
    return row as T;
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    const result = await this.db.execute(this.query, this.params);
    return {
      results: result.rows as T[],
      success: true,
      meta: {
        duration: 0,
        rows_read: result.rows.length,
        rows_written: result.rowsAffected
      }
    };
  }

  async run(): Promise<D1Result<unknown>> {
    const result = await this.db.execute(this.query, this.params);
    return {
      results: [],
      success: true,
      meta: {
        duration: 0,
        rows_read: 0,
        rows_written: result.rowsAffected
      }
    };
  }

  async raw<T = unknown>(): Promise<T[]> {
    const result = await this.db.execute(this.query, this.params);
    return result.rows as T[];
  }
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  dump(): Promise<ArrayBuffer>;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<D1ExecResult>;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run(): Promise<D1Result<unknown>>;
  raw<T = unknown>(): Promise<T[]>;
}

export interface D1Result<T = unknown> {
  results: T[];
  success: boolean;
  error?: string;
  meta: {
    duration: number;
    rows_read: number;
    rows_written: number;
  };
}

export interface D1ExecResult {
  count: number;
  duration: number;
}