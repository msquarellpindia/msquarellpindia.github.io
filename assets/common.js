export function getBasePath() {
  // For project pages: https://user.github.io/repo/...
  // For user/org pages: https://user.github.io/...
  const { hostname, pathname } = window.location;
  if (!hostname.endsWith("github.io")) return "/"; // best effort for custom domains too
  const parts = pathname.split("/").filter(Boolean);
  // If first segment is repo (project pages), base path is /repo/
  // If no segment, base path is /
  return parts.length >= 1 ? `/${parts[0]}/` : "/";
}

export function inferOwnerRepo() {
  // Handles:
  // - Project Pages: owner from subdomain, repo from first path segment
  // - User Pages: repo = <owner>.github.io, path has no repo segment
  const { hostname, pathname } = window.location;
  const hostParts = hostname.split(".");
  const owner = hostParts[0]; // <owner>.github.io
  const pathParts = pathname.split("/").filter(Boolean);

  let repo;
  if (pathParts.length === 0) {
    repo = `${owner}.github.io`; // user/org pages repository naming convention
  } else {
    repo = pathParts[0]; // project pages repo
  }
  return { owner, repo };
}

export function lsGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
export function lsSet(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}
export function lsDel(key) {
  try { localStorage.removeItem(key); } catch {}
}

export async function ghFetch(url, { token, method = "GET", headers = {}, body } = {}) {
  const h = new Headers(headers);
  h.set("Accept", "application/vnd.github+json");
  h.set("X-GitHub-Api-Version", "2022-11-28");
  if (token) h.set("Authorization", `token ${token}`);

  const res = await fetch(url, { method, headers: h, body });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }

  if (!res.ok) {
    const msg = json?.message || text || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.details = json;
    throw err;
  }
  return json;
}

export function b64encodeArrayBuffer(buffer) {
  // chunked base64 to avoid call stack issues
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function sanitizeFileName(name) {
  // Keep it conservative
  return name
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9._-]/g, "")
    .replace(/_+/g, "_")
    .slice(0, 180);
}
