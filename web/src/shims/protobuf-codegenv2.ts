export function fileDesc(..._args: any[]): any {
  return {};
}

export function messageDesc(..._args: any[]): any {
  return { $type: "message" };
}

export function enumDesc(..._args: any[]): any {
  return { $type: "enum" };
}

export function serviceDesc(..._args: any[]): any {
  return { $type: "service" };
}

export function extDesc(..._args: any[]): any {
  return { $type: "extension" };
}

export type GenFile = unknown;
export type GenMessage<T> = { $type: string; readonly _t?: T };
export type GenEnum<T> = { $type: string; readonly _t?: T };
export type GenService<_T = unknown> = { $type: string };
export type GenExtension<T = unknown, _U = unknown> = { $type: string; readonly _t?: T };
