export const IDENTITY_PROVIDER_NAME_PREFIX = "identity-providers/";
export const LEGACY_IDENTITY_PROVIDER_NAME_PREFIX = "identityProviders/";

export interface IdpRow {
  id?: number;
  uid: string;
  name: string;
  type: string | number;
  identifier_filter: string;
  config: string;
}

export interface StoredFieldMapping {
  identifier: string;
  displayName: string;
  email: string;
  avatarUrl: string;
}

export interface StoredOAuth2Config {
  clientId: string;
  clientSecret: string;
  authUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  scopes: string[];
  fieldMapping: StoredFieldMapping;
}

export function buildIdentityProviderName(uid: string): string {
  return `${IDENTITY_PROVIDER_NAME_PREFIX}${uid}`;
}

export function extractIdentityProviderUid(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  const trimmed = value.trim();
  if (trimmed.startsWith(IDENTITY_PROVIDER_NAME_PREFIX)) {
    return trimmed.slice(IDENTITY_PROVIDER_NAME_PREFIX.length);
  }
  if (trimmed.startsWith(LEGACY_IDENTITY_PROVIDER_NAME_PREFIX)) {
    return trimmed.slice(LEGACY_IDENTITY_PROVIDER_NAME_PREFIX.length);
  }
  return trimmed;
}

export function normalizeIdentityProviderType(value: unknown): string {
  if (typeof value === "string") {
    const lowered = value.toLowerCase();
    if (lowered === "oauth2") {
      return "oauth2";
    }
  }
  if (typeof value === "number" && value === 1) {
    return "oauth2";
  }
  return "oauth2";
}

export function normalizeIdentityProviderTypeEnum(value: unknown): number {
  return normalizeIdentityProviderType(value) === "oauth2" ? 1 : 0;
}

export function normalizeStoredOAuth2Config(value: unknown): StoredOAuth2Config {
  const raw = unwrapStoredOAuth2Config(value);
  const fieldMapping = raw?.fieldMapping ?? raw?.field_mapping ?? {};

  return {
    clientId: asString(raw?.clientId ?? raw?.client_id),
    clientSecret: asString(raw?.clientSecret ?? raw?.client_secret),
    authUrl: asString(raw?.authUrl ?? raw?.auth_url),
    tokenUrl: asString(raw?.tokenUrl ?? raw?.token_url),
    userInfoUrl: asString(raw?.userInfoUrl ?? raw?.user_info_url),
    scopes: Array.isArray(raw?.scopes) ? raw.scopes.map((scope) => String(scope)).filter(Boolean) : [],
    fieldMapping: {
      identifier: asString(fieldMapping.identifier),
      displayName: asString(fieldMapping.displayName ?? fieldMapping.display_name),
      email: asString(fieldMapping.email),
      avatarUrl: asString(fieldMapping.avatarUrl ?? fieldMapping.avatar_url),
    },
  };
}

export function hasStoredOAuth2Config(config: StoredOAuth2Config): boolean {
  return Boolean(
    config.clientId ||
      config.clientSecret ||
      config.authUrl ||
      config.tokenUrl ||
      config.userInfoUrl ||
      config.scopes.length > 0 ||
      config.fieldMapping.identifier ||
      config.fieldMapping.displayName ||
      config.fieldMapping.email ||
      config.fieldMapping.avatarUrl,
  );
}

export function serializeIdentityProvider(
  row: Pick<IdpRow, "uid" | "name" | "type" | "identifier_filter" | "config">,
  options: { includeClientSecret?: boolean } = {},
) {
  const oauth2Config = normalizeStoredOAuth2Config(row.config);
  const serializedOAuth2Config = options.includeClientSecret
    ? oauth2Config
    : {
        ...oauth2Config,
        clientSecret: "",
      };

  return {
    name: buildIdentityProviderName(row.uid),
    title: row.name || row.uid,
    type: normalizeIdentityProviderTypeEnum(row.type),
    identifierFilter: row.identifier_filter || "",
    config: hasStoredOAuth2Config(oauth2Config)
      ? {
          config: {
            case: "oauth2Config" as const,
            value: serializedOAuth2Config,
          },
        }
      : {
          config: {
            case: undefined,
            value: undefined,
          },
        },
  };
}

function unwrapStoredOAuth2Config(value: unknown): Record<string, any> | undefined {
  const parsed = parseMaybeJson(value);
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }
  const parsedRecord = parsed as Record<string, any>;

  if (parsedRecord.config && typeof parsedRecord.config === "object") {
    const oneof = parsedRecord.config as Record<string, any>;
    if (oneof.case === "oauth2Config" && oneof.value && typeof oneof.value === "object") {
      return oneof.value as Record<string, any>;
    }
  }

  if (parsedRecord.case === "oauth2Config" && parsedRecord.value && typeof parsedRecord.value === "object") {
    return parsedRecord.value as Record<string, any>;
  }

  return parsedRecord;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
