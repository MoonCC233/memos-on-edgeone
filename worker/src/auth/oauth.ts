import { normalizeStoredOAuth2Config, type IdpRow } from "../idp";

export interface OAuthUserInfo {
  identifier: string;
  displayName: string;
  email: string;
  avatarUrl: string;
}

export async function getIdpByUid(db: D1Database, uid: string): Promise<IdpRow | null> {
  return db.prepare("SELECT * FROM idp WHERE uid = ?").bind(uid).first<IdpRow>();
}

export async function exchangeOAuthCode(
  db: D1Database,
  idpUid: string,
  code: string,
  redirectUri: string,
  codeVerifier?: string,
): Promise<OAuthUserInfo> {
  const idp = await getIdpByUid(db, idpUid);
  if (!idp) throw new Error("Identity provider not found");

  const config = normalizeStoredOAuth2Config(idp.config);
  if (!config.clientId || !config.tokenUrl || !config.userInfoUrl) {
    throw new Error("Identity provider configuration is incomplete");
  }

  const tokenParams: Record<string, string> = {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  };
  if (codeVerifier) {
    tokenParams.code_verifier = codeVerifier;
  }

  const tokenResp = await fetch(config.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(tokenParams).toString(),
  });

  if (!tokenResp.ok) {
    const errText = await tokenResp.text();
    throw new Error(`Token exchange failed: ${tokenResp.status} ${errText}`);
  }

  const tokenData = await tokenResp.json<{ access_token?: string; error?: string; error_description?: string }>();
  if (tokenData.error) {
    throw new Error(`OAuth error: ${tokenData.error} - ${tokenData.error_description || ""}`);
  }
  if (!tokenData.access_token) {
    throw new Error("No access_token in token response");
  }

  const userInfoResp = await fetch(config.userInfoUrl, {
    headers: buildUserInfoHeaders(config.userInfoUrl, tokenData.access_token),
  });

  if (!userInfoResp.ok) {
    const errText = await userInfoResp.text();
    throw new Error(`User info request failed: ${userInfoResp.status}${errText ? ` ${truncateErrorText(errText)}` : ""}`);
  }

  const userInfo = await userInfoResp.json<Record<string, any>>();
  const mapping = config.fieldMapping || { identifier: "id", displayName: "name", email: "email", avatarUrl: "avatar_url" };

  const identifier = String(getNestedValue(userInfo, mapping.identifier) || "");
  if (!identifier) {
    throw new Error("Could not extract user identifier from OAuth provider response");
  }

  if (idp.identifier_filter) {
    const regex = new RegExp(idp.identifier_filter);
    if (!regex.test(identifier)) {
      throw new Error(`User identifier "${identifier}" does not match the allowed pattern`);
    }
  }

  return {
    identifier,
    displayName: String(getNestedValue(userInfo, mapping.displayName) || ""),
    email: String(getNestedValue(userInfo, mapping.email) || ""),
    avatarUrl: String(getNestedValue(userInfo, mapping.avatarUrl) || ""),
  };
}

function getNestedValue(obj: Record<string, any>, path: string): any {
  if (!path) return undefined;
  const parts = path.split(".");
  let current: any = obj;
  for (const part of parts) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}

function buildUserInfoHeaders(userInfoUrl: string, accessToken: string): HeadersInit {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "User-Agent": "memos-on-cloudflare",
  };

  if (isGitHubApiUrl(userInfoUrl)) {
    headers.Accept = "application/vnd.github+json";
    headers["X-GitHub-Api-Version"] = "2022-11-28";
  }

  return headers;
}

function isGitHubApiUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "api.github.com" || parsed.pathname.startsWith("/api/v3/");
  } catch {
    return false;
  }
}

function truncateErrorText(value: string, maxLength = 240): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength - 1)}…`;
}
