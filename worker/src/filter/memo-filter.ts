import { findUserByUsername } from "../db/user";

export type MemoFilterParam = string | number;

export interface MemoFilterWhere {
  sql: string;
  params: MemoFilterParam[];
}

export class MemoFilterError extends Error {
  constructor(message: string, readonly position?: number) {
    super(position === undefined ? message : `${message} at ${position}`);
    this.name = "MemoFilterError";
  }
}

type TokenType = "identifier" | "string" | "number" | "symbol" | "eof";

interface Token {
  type: TokenType;
  value: string;
  position: number;
}

type LiteralValue = string | number | boolean;

type AstNode =
  | { type: "literal"; value: LiteralValue }
  | { type: "identifier"; name: string }
  | { type: "array"; items: AstNode[] }
  | { type: "member"; object: AstNode; property: string }
  | { type: "call"; callee: AstNode; args: AstNode[] }
  | { type: "unary"; op: "!" | "-"; expr: AstNode }
  | { type: "binary"; op: string; left: AstNode; right: AstNode };

interface OperandSql {
  kind: "sql";
  sql: string;
  params: MemoFilterParam[];
  field?: string;
}

interface OperandValue {
  kind: "value";
  value: LiteralValue | LiteralValue[];
}

type Operand = OperandSql | OperandValue;

interface CompileContext {
  db: D1Database;
  nowSeconds: number;
}

const BOOLEAN_FIELD_SQL: Record<string, string> = {
  pinned: "memo.pinned",
  has_link: "COALESCE(json_extract(memo.payload, '$.property.hasLink'), 0)",
  has_task_list: "COALESCE(json_extract(memo.payload, '$.property.hasTaskList'), 0)",
  has_code: "COALESCE(json_extract(memo.payload, '$.property.hasCode'), 0)",
  has_incomplete_task: "COALESCE(json_extract(memo.payload, '$.property.hasIncompleteTask'), 0)",
  has_incomplete_tasks: "COALESCE(json_extract(memo.payload, '$.property.hasIncompleteTask'), 0)",
};

const SCALAR_FIELD_SQL: Record<string, string> = {
  content: "memo.content",
  creator_id: "memo.creator_id",
  created_ts: "memo.created_ts",
  updated_ts: "memo.updated_ts",
  visibility: "memo.visibility",
  ...BOOLEAN_FIELD_SQL,
};

const VISIBILITY_VALUES = new Set(["PUBLIC", "PROTECTED", "PRIVATE"]);

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  const push = (type: TokenType, value: string, position: number) => tokens.push({ type, value, position });

  while (index < input.length) {
    const ch = input[index];
    const position = index;

    if (/\s/.test(ch)) {
      index += 1;
      continue;
    }

    if (ch === "\"" || ch === "'") {
      const quote = ch;
      index += 1;
      let value = "";
      while (index < input.length) {
        const current = input[index];
        if (current === quote) {
          index += 1;
          push("string", value, position);
          break;
        }
        if (current === "\\") {
          index += 1;
          if (index >= input.length) {
            throw new MemoFilterError("Unterminated string escape", position);
          }
          const escaped = input[index];
          switch (escaped) {
            case "n":
              value += "\n";
              break;
            case "r":
              value += "\r";
              break;
            case "t":
              value += "\t";
              break;
            default:
              value += escaped;
          }
          index += 1;
          continue;
        }
        value += current;
        index += 1;
      }
      if (tokens[tokens.length - 1]?.position !== position) {
        throw new MemoFilterError("Unterminated string", position);
      }
      continue;
    }

    if (/[0-9]/.test(ch)) {
      index += 1;
      while (index < input.length && /[0-9]/.test(input[index])) {
        index += 1;
      }
      if (input[index] === ".") {
        index += 1;
        while (index < input.length && /[0-9]/.test(input[index])) {
          index += 1;
        }
      }
      push("number", input.slice(position, index), position);
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      index += 1;
      while (index < input.length && /[A-Za-z0-9_]/.test(input[index])) {
        index += 1;
      }
      push("identifier", input.slice(position, index), position);
      continue;
    }

    const twoChar = input.slice(index, index + 2);
    if (["&&", "||", "==", "!=", "<=", ">="].includes(twoChar)) {
      push("symbol", twoChar, position);
      index += 2;
      continue;
    }

    if ("()[],.!<>+-*/".includes(ch)) {
      push("symbol", ch, position);
      index += 1;
      continue;
    }

    throw new MemoFilterError(`Unexpected character '${ch}'`, position);
  }

  push("eof", "", input.length);
  return tokens;
}

class Parser {
  private index = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): AstNode {
    const expr = this.parseOr();
    if (!this.check("eof")) {
      throw new MemoFilterError(`Unexpected token '${this.current().value}'`, this.current().position);
    }
    return expr;
  }

  private parseOr(): AstNode {
    let node = this.parseAnd();
    while (this.matchSymbol("||")) {
      node = { type: "binary", op: "||", left: node, right: this.parseAnd() };
    }
    return node;
  }

  private parseAnd(): AstNode {
    let node = this.parseNot();
    while (this.matchSymbol("&&")) {
      node = { type: "binary", op: "&&", left: node, right: this.parseNot() };
    }
    return node;
  }

  private parseNot(): AstNode {
    if (this.matchSymbol("!")) {
      return { type: "unary", op: "!", expr: this.parseNot() };
    }
    return this.parseComparison();
  }

  private parseComparison(): AstNode {
    let node = this.parseAdditive();
    const token = this.current();
    if (token.type === "symbol" && ["==", "!=", "<", "<=", ">", ">="].includes(token.value)) {
      this.index += 1;
      node = { type: "binary", op: token.value, left: node, right: this.parseAdditive() };
    } else if (token.type === "identifier" && token.value === "in") {
      this.index += 1;
      node = { type: "binary", op: "in", left: node, right: this.parseAdditive() };
    }
    return node;
  }

  private parseAdditive(): AstNode {
    let node = this.parseMultiplicative();
    while (this.matchSymbol("+") || this.matchSymbol("-")) {
      const op = this.previous().value;
      node = { type: "binary", op, left: node, right: this.parseMultiplicative() };
    }
    return node;
  }

  private parseMultiplicative(): AstNode {
    let node = this.parseUnaryNumber();
    while (this.matchSymbol("*") || this.matchSymbol("/")) {
      const op = this.previous().value;
      node = { type: "binary", op, left: node, right: this.parseUnaryNumber() };
    }
    return node;
  }

  private parseUnaryNumber(): AstNode {
    if (this.matchSymbol("-")) {
      return { type: "unary", op: "-", expr: this.parseUnaryNumber() };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): AstNode {
    let node = this.parsePrimary();
    while (true) {
      if (this.matchSymbol(".")) {
        const property = this.consumeIdentifier("Expected member name after '.'");
        node = { type: "member", object: node, property };
        continue;
      }
      if (this.matchSymbol("(")) {
        const args: AstNode[] = [];
        if (!this.checkSymbol(")")) {
          do {
            args.push(this.parseOr());
          } while (this.matchSymbol(","));
        }
        this.consumeSymbol(")", "Expected ')' after arguments");
        node = { type: "call", callee: node, args };
        continue;
      }
      return node;
    }
  }

  private parsePrimary(): AstNode {
    const token = this.current();
    if (this.matchSymbol("(")) {
      const expr = this.parseOr();
      this.consumeSymbol(")", "Expected ')' after expression");
      return expr;
    }
    if (this.matchSymbol("[")) {
      const items: AstNode[] = [];
      if (!this.checkSymbol("]")) {
        do {
          items.push(this.parseOr());
        } while (this.matchSymbol(","));
      }
      this.consumeSymbol("]", "Expected ']' after list");
      return { type: "array", items };
    }
    if (token.type === "string") {
      this.index += 1;
      return { type: "literal", value: token.value };
    }
    if (token.type === "number") {
      this.index += 1;
      return { type: "literal", value: Number(token.value) };
    }
    if (token.type === "identifier") {
      this.index += 1;
      if (token.value === "true" || token.value === "false") {
        return { type: "literal", value: token.value === "true" };
      }
      return { type: "identifier", name: token.value };
    }
    throw new MemoFilterError(`Unexpected token '${token.value}'`, token.position);
  }

  private matchSymbol(value: string): boolean {
    if (!this.checkSymbol(value)) {
      return false;
    }
    this.index += 1;
    return true;
  }

  private checkSymbol(value: string): boolean {
    const token = this.current();
    return token.type === "symbol" && token.value === value;
  }

  private check(type: TokenType): boolean {
    return this.current().type === type;
  }

  private consumeSymbol(value: string, message: string) {
    if (!this.matchSymbol(value)) {
      throw new MemoFilterError(message, this.current().position);
    }
  }

  private consumeIdentifier(message: string): string {
    const token = this.current();
    if (token.type !== "identifier") {
      throw new MemoFilterError(message, token.position);
    }
    this.index += 1;
    return token.value;
  }

  private current(): Token {
    return this.tokens[this.index];
  }

  private previous(): Token {
    return this.tokens[this.index - 1];
  }
}

function escapeLike(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function parenthesize(fragment: MemoFilterWhere): MemoFilterWhere {
  return { sql: `(${fragment.sql})`, params: fragment.params };
}

function mergeBinary(left: MemoFilterWhere, op: "AND" | "OR", right: MemoFilterWhere): MemoFilterWhere {
  return {
    sql: `(${left.sql}) ${op} (${right.sql})`,
    params: [...left.params, ...right.params],
  };
}

function normalizeFieldName(field: string): string {
  switch (field) {
    case "property.hasLink":
      return "has_link";
    case "property.hasTaskList":
      return "has_task_list";
    case "property.hasCode":
      return "has_code";
    case "property.hasIncompleteTask":
    case "property.hasIncompleteTasks":
      return "has_incomplete_tasks";
    default:
      if (field === "has_incomplete_task") {
        return "has_incomplete_tasks";
      }
      return field;
  }
}

function getFieldName(node: AstNode): string | undefined {
  if (node.type === "identifier") {
    return normalizeFieldName(node.name);
  }
  if (node.type === "member") {
    const objectName = getFieldName(node.object);
    if (!objectName) {
      return undefined;
    }
    return normalizeFieldName(`${objectName}.${node.property}`);
  }
  return undefined;
}

function getCallName(node: AstNode): string | undefined {
  if (node.type === "identifier") {
    return node.name;
  }
  if (node.type === "member") {
    const objectName = getCallName(node.object);
    return objectName ? `${objectName}.${node.property}` : undefined;
  }
  return undefined;
}

function getStringLiteral(node: AstNode, ctx: CompileContext): string {
  const value = evaluateStatic(node, ctx);
  if (typeof value !== "string") {
    throw new MemoFilterError("Expected string literal");
  }
  return value;
}

function getLiteralArray(node: AstNode, ctx: CompileContext): LiteralValue[] {
  const value = evaluateStatic(node, ctx);
  if (!Array.isArray(value)) {
    throw new MemoFilterError("Expected list literal");
  }
  return value;
}

function evaluateStatic(node: AstNode, ctx: CompileContext): LiteralValue | LiteralValue[] {
  switch (node.type) {
    case "literal":
      return node.value;
    case "identifier":
      if (VISIBILITY_VALUES.has(node.name)) {
        return node.name;
      }
      throw new MemoFilterError(`Unknown value '${node.name}'`);
    case "array":
      return node.items.map((item) => {
        const value = evaluateStatic(item, ctx);
        if (Array.isArray(value)) {
          throw new MemoFilterError("Nested lists are not supported");
        }
        return value;
      });
    case "call": {
      const name = getCallName(node.callee);
      if (name === "now" && node.args.length === 0) {
        return ctx.nowSeconds;
      }
      throw new MemoFilterError(`Unsupported function '${name || "unknown"}'`);
    }
    case "unary": {
      if (node.op !== "-") {
        throw new MemoFilterError("Unsupported static unary expression");
      }
      const value = evaluateStatic(node.expr, ctx);
      if (typeof value !== "number") {
        throw new MemoFilterError("Unary '-' expects a number");
      }
      return -value;
    }
    case "binary": {
      if (!["+", "-", "*", "/"].includes(node.op)) {
        throw new MemoFilterError("Unsupported static expression");
      }
      const left = evaluateStatic(node.left, ctx);
      const right = evaluateStatic(node.right, ctx);
      if (typeof left !== "number" || typeof right !== "number") {
        throw new MemoFilterError("Arithmetic expressions must use numbers");
      }
      switch (node.op) {
        case "+":
          return left + right;
        case "-":
          return left - right;
        case "*":
          return left * right;
        case "/":
          if (right === 0) {
            throw new MemoFilterError("Division by zero");
          }
          return left / right;
      }
    }
  }
  throw new MemoFilterError("Unsupported static expression");
}

function literalToParam(value: LiteralValue): MemoFilterParam {
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  return value;
}

function compareStaticValues(left: LiteralValue, op: string, right: LiteralValue): boolean {
  switch (op) {
    case "==":
      return left === right;
    case "!=":
      return left !== right;
    case "<":
      return left < right;
    case "<=":
      return left <= right;
    case ">":
      return left > right;
    case ">=":
      return left >= right;
    default:
      throw new MemoFilterError(`Unsupported comparison '${op}'`);
  }
}

function swapComparisonOperator(op: string): string {
  switch (op) {
    case "<":
      return ">";
    case "<=":
      return ">=";
    case ">":
      return "<";
    case ">=":
      return "<=";
    default:
      return op;
  }
}

function compileTagTreeMatch(values: string[]): MemoFilterWhere {
  if (values.length === 0) {
    return { sql: "0 = 1", params: [] };
  }

  const parts: string[] = [];
  const params: MemoFilterParam[] = [];
  for (const value of values) {
    parts.push("(tag_item.value = ? OR tag_item.value LIKE ? ESCAPE '\\')");
    params.push(value, `${escapeLike(value)}/%`);
  }

  return {
    sql: `EXISTS (SELECT 1 FROM json_each(memo.payload, '$.tags') AS tag_item WHERE ${parts.join(" OR ")})`,
    params,
  };
}

function compileExactTagMatch(value: string): MemoFilterWhere {
  return {
    sql: "EXISTS (SELECT 1 FROM json_each(memo.payload, '$.tags') AS tag_item WHERE tag_item.value = ?)",
    params: [value],
  };
}

function compileTagsExists(node: AstNode, ctx: CompileContext): MemoFilterWhere {
  if (node.type !== "call") {
    throw new MemoFilterError("Expected tags.exists call");
  }
  const name = getCallName(node.callee);
  if (name !== "tags.exists") {
    throw new MemoFilterError(`Unsupported function '${name || "unknown"}'`);
  }
  if (node.args.length !== 2 || node.args[0].type !== "identifier") {
    throw new MemoFilterError("tags.exists expects a variable and predicate");
  }

  const variableName = node.args[0].name;
  const predicate = node.args[1];
  if (predicate.type !== "call" || predicate.callee.type !== "member") {
    throw new MemoFilterError("tags.exists predicate must call startsWith, endsWith, or contains");
  }
  const receiver = getFieldName(predicate.callee.object);
  if (receiver !== variableName) {
    throw new MemoFilterError("tags.exists predicate must use the declared variable");
  }
  if (predicate.args.length !== 1) {
    throw new MemoFilterError("Tag predicate expects one string argument");
  }

  const needle = getStringLiteral(predicate.args[0], ctx);
  const escaped = escapeLike(needle);
  let pattern: string;
  switch (predicate.callee.property) {
    case "startsWith":
      pattern = `${escaped}%`;
      break;
    case "endsWith":
      pattern = `%${escaped}`;
      break;
    case "contains":
      pattern = `%${escaped}%`;
      break;
    default:
      throw new MemoFilterError(`Unsupported tag predicate '${predicate.callee.property}'`);
  }

  return {
    sql: "EXISTS (SELECT 1 FROM json_each(memo.payload, '$.tags') AS tag_item WHERE tag_item.value LIKE ? ESCAPE '\\')",
    params: [pattern],
  };
}

async function resolveCreatorId(db: D1Database, value: string): Promise<number | undefined> {
  const username = value.startsWith("users/") ? value.slice("users/".length) : value;
  if (!username) {
    return undefined;
  }
  const user = await findUserByUsername(db, username);
  return user?.id;
}

class SqlCompiler {
  async compile(node: AstNode, ctx: CompileContext): Promise<MemoFilterWhere> {
    return parenthesize(await this.compileBoolean(node, ctx));
  }

  private async compileBoolean(node: AstNode, ctx: CompileContext): Promise<MemoFilterWhere> {
    if (node.type === "binary") {
      if (node.op === "&&") {
        return mergeBinary(await this.compileBoolean(node.left, ctx), "AND", await this.compileBoolean(node.right, ctx));
      }
      if (node.op === "||") {
        return mergeBinary(await this.compileBoolean(node.left, ctx), "OR", await this.compileBoolean(node.right, ctx));
      }
      if (node.op === "in") {
        return this.compileIn(node.left, node.right, ctx);
      }
      if (["==", "!=", "<", "<=", ">", ">="].includes(node.op)) {
        return this.compileComparison(node.left, node.op, node.right, ctx);
      }
    }

    if (node.type === "unary" && node.op === "!") {
      const expr = await this.compileBoolean(node.expr, ctx);
      return { sql: `NOT (${expr.sql})`, params: expr.params };
    }

    if (node.type === "literal" && typeof node.value === "boolean") {
      return { sql: node.value ? "1 = 1" : "0 = 1", params: [] };
    }

    const field = getFieldName(node);
    if (field && BOOLEAN_FIELD_SQL[field]) {
      return { sql: `${BOOLEAN_FIELD_SQL[field]} = 1`, params: [] };
    }

    if (node.type === "call") {
      const name = getCallName(node.callee);
      if (name === "content.contains") {
        if (node.args.length !== 1) {
          throw new MemoFilterError("content.contains expects one argument");
        }
        return {
          sql: "memo.content LIKE ? ESCAPE '\\'",
          params: [`%${escapeLike(getStringLiteral(node.args[0], ctx))}%`],
        };
      }
      if (name === "tags.exists") {
        return compileTagsExists(node, ctx);
      }
    }

    throw new MemoFilterError("Expression must evaluate to a boolean");
  }

  private async compileComparison(leftNode: AstNode, op: string, rightNode: AstNode, ctx: CompileContext): Promise<MemoFilterWhere> {
    const leftField = getFieldName(leftNode);
    const rightField = getFieldName(rightNode);

    if (leftField === "creator") {
      return this.compileCreatorComparison(op, rightNode, ctx, false);
    }
    if (rightField === "creator") {
      return this.compileCreatorComparison(swapComparisonOperator(op), leftNode, ctx, true);
    }
    if (leftField === "tag" && (op === "==" || op === "!=")) {
      return this.compileTagComparison(op, rightNode, ctx);
    }
    if (rightField === "tag" && (op === "==" || op === "!=")) {
      return this.compileTagComparison(op, leftNode, ctx);
    }

    const left = await this.resolveOperand(leftNode, ctx);
    const right = await this.resolveOperand(rightNode, ctx);

    if (left.kind === "value" && right.kind === "value") {
      if (Array.isArray(left.value) || Array.isArray(right.value)) {
        throw new MemoFilterError("Lists can only be used with 'in'");
      }
      return { sql: compareStaticValues(left.value, op, right.value) ? "1 = 1" : "0 = 1", params: [] };
    }

    if (left.kind === "sql" && right.kind === "sql") {
      return {
        sql: `${left.sql} ${op} ${right.sql}`,
        params: [...left.params, ...right.params],
      };
    }

    if (left.kind === "sql" && right.kind === "value") {
      if (Array.isArray(right.value)) {
        throw new MemoFilterError("Lists can only be used with 'in'");
      }
      return {
        sql: `${left.sql} ${op} ?`,
        params: [...left.params, literalToParam(right.value)],
      };
    }

    if (left.kind === "value" && right.kind === "sql") {
      if (Array.isArray(left.value)) {
        throw new MemoFilterError("Lists can only be used with 'in'");
      }
      return {
        sql: `? ${op} ${right.sql}`,
        params: [literalToParam(left.value), ...right.params],
      };
    }

    throw new MemoFilterError("Unsupported comparison");
  }

  private compileTagComparison(op: string, valueNode: AstNode, ctx: CompileContext): MemoFilterWhere {
    const value = evaluateStatic(valueNode, ctx);
    if (typeof value !== "string") {
      throw new MemoFilterError("tag comparisons expect a string value");
    }
    const match = compileTagTreeMatch([value]);
    if (op === "!=") {
      return { sql: `NOT (${match.sql})`, params: match.params };
    }
    return match;
  }

  private async compileCreatorComparison(op: string, valueNode: AstNode, ctx: CompileContext, swapped: boolean): Promise<MemoFilterWhere> {
    const value = evaluateStatic(valueNode, ctx);
    if (typeof value !== "string") {
      throw new MemoFilterError("creator comparisons expect a user resource string");
    }
    if (op !== "==" && op !== "!=") {
      throw new MemoFilterError("creator only supports == and !=");
    }

    const creatorId = await resolveCreatorId(ctx.db, value);
    if (creatorId === undefined) {
      return { sql: op === "==" ? "0 = 1" : "1 = 1", params: [] };
    }
    const effectiveOp = swapped ? swapComparisonOperator(op) : op;
    return { sql: `memo.creator_id ${effectiveOp} ?`, params: [creatorId] };
  }

  private async compileIn(leftNode: AstNode, rightNode: AstNode, ctx: CompileContext): Promise<MemoFilterWhere> {
    const leftField = getFieldName(leftNode);
    const rightField = getFieldName(rightNode);

    if (leftField === "tag") {
      const values = getLiteralArray(rightNode, ctx);
      if (!values.every((value) => typeof value === "string")) {
        throw new MemoFilterError("tag in [...] expects string values");
      }
      return compileTagTreeMatch(values as string[]);
    }

    if (rightField === "tags") {
      const value = evaluateStatic(leftNode, ctx);
      if (typeof value !== "string") {
        throw new MemoFilterError("'value in tags' expects a string value");
      }
      return compileExactTagMatch(value);
    }

    const left = await this.resolveOperand(leftNode, ctx);
    const right = evaluateStatic(rightNode, ctx);
    if (left.kind !== "sql" || !Array.isArray(right)) {
      throw new MemoFilterError("'in' expects a field and list");
    }
    if (right.length === 0) {
      return { sql: "0 = 1", params: [] };
    }
    const placeholders = right.map(() => "?").join(", ");
    return {
      sql: `${left.sql} IN (${placeholders})`,
      params: [...left.params, ...right.map(literalToParam)],
    };
  }

  private async resolveOperand(node: AstNode, ctx: CompileContext): Promise<Operand> {
    const field = getFieldName(node);
    if (field && SCALAR_FIELD_SQL[field]) {
      return { kind: "sql", sql: SCALAR_FIELD_SQL[field], params: [], field };
    }

    if (node.type === "call") {
      const name = getCallName(node.callee);
      if (name === "size") {
        if (node.args.length !== 1 || getFieldName(node.args[0]) !== "tags") {
          throw new MemoFilterError("size() currently supports tags only");
        }
        return {
          kind: "sql",
          sql: "COALESCE(json_array_length(json_extract(memo.payload, '$.tags')), 0)",
          params: [],
          field: "size(tags)",
        };
      }
    }

    return { kind: "value", value: evaluateStatic(node, ctx) };
  }
}

export async function buildMemoFilterWhere(db: D1Database, filter: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<MemoFilterWhere> {
  const trimmedFilter = filter.trim();
  if (!trimmedFilter) {
    return { sql: "1 = 1", params: [] };
  }

  const parser = new Parser(tokenize(trimmedFilter));
  const ast = parser.parse();
  return new SqlCompiler().compile(ast, { db, nowSeconds });
}
