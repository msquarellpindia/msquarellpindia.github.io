export function getBasePath() {
  const { hostname, pathname } = window.location;

  // For custom domains, just assume root.
  if (!hostname.endsWith("github.io")) return "/";

  const parts = pathname.split("/").filter(Boolean);

  // If first segment looks like a file (admin.html, index.html, etc), base is root.
  if (parts.length === 0) return "/";
  if (parts[0].includes(".")) return "/";

  // Otherwise, this is project pages, base is /<repo>/
  return `/${parts[0]}/`;
}

export function inferOwnerRepo() {
  const { hostname, pathname } = window.location;

  // Expected GitHub Pages host: <owner>.github.io
  const hostParts = hostname.split(".");
  const owner = hostParts[0];

  const pathParts = pathname.split("/").filter(Boolean);

  const isGithubIo = hostname.endsWith("github.io");

  // User/Org Pages:
  // - repo is <owner>.github.io
  // - URL looks like https://<owner>.github.io/admin.html (no repo segment)
  //
  // Project Pages:
  // - repo is first path segment
  // - URL looks like https://<owner>.github.io/<repo>/admin.html
  const looksLikeProjectPages =
    isGithubIo &&
    pathParts.length > 0 &&
    // first segment is NOT a file-like thing (admin.html) and not assets-like
    !pathParts[0].includes(".") &&
    // and it's not a known top-level dir you might use on user pages
    !["assets", "videos"].includes(pathParts[0]);

  const repo = looksLikeProjectPages ? pathParts[0] : `${owner}.github.io`;

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

/**
 * Base64 encode an ArrayBuffer with optional progress callback.
 * Progress is based on encoding work (not network upload).
 * @param {ArrayBuffer} buffer
 * @param {(pct:number)=>void} [onProgress]
 */
export function b64encodeArrayBuffer(buffer, onProgress) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;

  const total = bytes.length;
  if (onProgress) onProgress(0);

  for (let i = 0; i < total; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    if (onProgress) {
      const pct = Math.min(99, Math.floor(((i + chunkSize) / total) * 100));
      onProgress(pct);
    }
  }

  const out = btoa(binary);
  if (onProgress) onProgress(100);
  return out;
}

export function sanitizeFileName(name) {
  return name
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9._-]/g, "")
    .replace(/_+/g, "_")
    .slice(0, 180);
}
