export type Message<T extends string = string> = {
  $typeName?: T;
  [key: string]: unknown;
};

export type GenMessage<T> = { $type: string; readonly _t?: T };
export type GenEnum<T> = { $type: string; readonly _t?: T };
export type GenService = { $type: string };
export type GenFile = unknown;

export function create<T>(schema: GenMessage<T>, data?: Record<string, unknown> | unknown): T {
  void schema;
  return ((data as Record<string, unknown> | undefined) || {}) as T;
}
