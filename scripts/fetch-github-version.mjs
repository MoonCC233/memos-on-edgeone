import { appendFileSync } from "node:fs";

const fallbackVersion = process.env.npm_package_version || "1.0.0";

const headers = {
  "User-Agent": "cfmemos-version-sync",
  "Accept": "application/vnd.github+json",
};

if (process.env.GITHUB_TOKEN) {
  headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
}
const owner = process.env.GITHUB_VERSION_OWNER || "jkjoy";
const repo = process.env.GITHUB_VERSION_REPO || "memos-on-cloudflare";

function normalizeVersion(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().replace(/^refs\/tags\//, "");
}

async function fetchJSON(url) {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} for ${url}`);
  }

  return response.json();
}

async function resolveVersion() {
  try {
    const latestRelease = await fetchJSON(`https://api.github.com/repos/${owner}/${repo}/releases/latest`);
    const version = normalizeVersion(latestRelease.tag_name || latestRelease.name);
    if (version) {
      return version;
    }
  } catch (error) {
    console.warn(`Failed to resolve latest release for ${owner}/${repo}:`, error.message);
  }

  try {
    const tags = await fetchJSON(`https://api.github.com/repos/${owner}/${repo}/tags?per_page=1`);
    const version = normalizeVersion(tags?.[0]?.name);
    if (version) {
      return version;
    }
  } catch (error) {
    console.warn(`Failed to resolve latest tag for ${owner}/${repo}:`, error.message);
  }

  return fallbackVersion;
}

const version = await resolveVersion();

console.log(`Resolved app version: ${version}`);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
}
