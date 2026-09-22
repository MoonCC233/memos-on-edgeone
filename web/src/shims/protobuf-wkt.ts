export type Timestamp = {
  seconds: bigint | number;
  nanos: number;
};

export type Duration = {
  seconds: bigint | number;
  nanos: number;
};

export type FieldMask = {
  paths: string[];
};

export const EmptySchema = { $type: "google.protobuf.Empty" };
export type EmptySchema = typeof EmptySchema;
export type FieldOptions = {};
export type MethodOptions = {};
export type ServiceOptions = {};
export type MessageOptions = {};
export type FileOptions = {};

export const FieldMaskSchema = { $type: "google.protobuf.FieldMask" };

export const file_google_protobuf_timestamp = {};
export const file_google_protobuf_empty = {};
export const file_google_protobuf_field_mask = {};
export const file_google_protobuf_wrappers = {};
export const file_google_protobuf_duration = {};
export const file_google_protobuf_descriptor = {};

export function timestampDate(ts: Timestamp | { seconds?: number | bigint | string } | undefined): Date {
  if (!ts) return new Date();
  const seconds = typeof ts.seconds === "bigint" ? Number(ts.seconds) : Number(ts.seconds || 0);
  return new Date(seconds * 1000);
}

export function timestampFromDate(date: Date): Timestamp {
  const seconds = Math.floor(date.getTime() / 1000);
  return { seconds, nanos: 0 };
}
