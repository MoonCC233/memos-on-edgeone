import type { Env } from "./types";

const DEFAULT_APP_VERSION = "1.0.0";

export function getAppVersion(env: Pick<Env, "APP_VERSION">): string {
  return env.APP_VERSION?.trim() || DEFAULT_APP_VERSION;
}
