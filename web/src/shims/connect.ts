export class ConnectError extends Error {
  code: number;

  constructor(message: string, code?: number) {
    super(message);
    this.name = "ConnectError";
    this.code = code ?? 2;
  }
}

export const Code = {
  OK: 0,
  Canceled: 1,
  Unknown: 2,
  InvalidArgument: 3,
  DeadlineExceeded: 4,
  NotFound: 5,
  AlreadyExists: 6,
  PermissionDenied: 7,
  ResourceExhausted: 8,
  FailedPrecondition: 9,
  Aborted: 10,
  OutOfRange: 11,
  Unimplemented: 12,
  Internal: 13,
  Unavailable: 14,
  DataLoss: 15,
  Unauthenticated: 16,
} as const;

export type Interceptor = (next: any) => (req: any) => Promise<any>;

export function createClient(_service: any, _transport: any): any {
  return {};
}
