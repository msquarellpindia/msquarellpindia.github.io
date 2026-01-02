import {
  inferOwnerRepo,
  lsGet, lsSet, lsDel,
  ghFetch,
  sanitizeFileName
} from "./common.js";

const TOKEN_KEY = "gh_pat";
const RELEASE_TAG = "signboard-assets"; // Pattern B fixed tag
const RELEASE_NAME = "Signboard Assets"; // shown in GitHub UI if we create it

const els = {
  token: document.getElementById("token"),
  saveToken: document.getElementById("saveToken"),
  clearToken: document.getElementById("clearToken"),
  authStatus: document.getElementById("authStatus"),
  refresh: document.getElementById("refresh"),
  saveOrder: document.getElementById("saveOrder"),
  repoInfo: document.getElementById("repoInfo"),
  fileInput: document.getElementById("fileInput"),
  upload: document.getElementById("upload"),
  prog: document.getElementById("prog"),
  uploadMsg: document.getElementById("uploadMsg"),
  msg: document.getElementById("msg"),
  list: document.getElementById("list"),

  // Actions Status UI
  actionsState: document.getElementById("actionsState"),
  actionsCommit: document.getElementById("actionsCommit"),
  actionsWorkflow: document.getElementById("actionsWorkflow"),
  actionsRun: document.getElementById("actionsRun"),
  actionsRunLink: document.getElementById("actionsRunLink"),
  actionsUpdated: document.getElementById("actionsUpdated"),
  actionsNotes: document.getElementById("actionsNotes"),
};

const { owner, repo } = inferOwnerRepo();
els.repoInfo.textContent = `Repo inferred: ${owner}/${repo}`;

let token = lsGet(TOKEN_KEY) || "";
els.token.value = token;

let videosJsonSha = null;           // sha for videos.json
let playlist = [];                  // array of URLs (Pattern B)
let release = null;                 // release object
let assetsByName = new Map();       // name -> { id, size, url, content_type, download_count }
let assetsByUrl = new Map();        // browser_download_url -> { name, id, ... }

function setStatus(text, cls) {
  els.authStatus.textContent = text;
  els.authStatus.className = `pill ${cls || ""}`.trim();
}
function setMessage(text, cls) {
  els.msg.innerHTML = "";
  if (!text) return;
  const span = document.createElement("span");
  span.textContent = text;
  span.className = cls || "";
  els.msg.appendChild(span);
}
function requireToken() {
  if (!token) throw new Error("No PAT set. Paste a token and click Save.");
}
function api(path) {
  return `https://api.github.com${path}`;
}
function uploads(path) {
  // Release asset uploads use uploads.github.com
  return `https://uploads.github.com${path}`;
}

/** ---------- Actions Status panel helpers ---------- **/

function nowLocalString() {
  return new Date().toLocaleString();
}
function setActionsPanel({
  stateText = "Idle",
  stateKind = "muted",
  commit = "—",
  workflow = "—",
  runText = "—",
  runUrl = null,
  notes = "—",
} = {}) {
  els.actionsState.textContent = stateText;
  els.actionsState.className = `actions-pill ${stateKind}`.trim();

  els.actionsCommit.textContent = commit;
  els.actionsWorkflow.textContent = workflow;
  els.actionsRun.textContent = runText;
  els.actionsUpdated.textContent = nowLocalString();
  els.actionsNotes.textContent = notes;

  if (runUrl) {
    els.actionsRunLink.style.display = "";
    els.actionsRunLink.onclick = () => window.open(runUrl, "_blank", "noreferrer");
  } else {
    els.actionsRunLink.style.display = "none";
    els.actionsRunLink.onclick = null;
  }
}

/** ---------- GitHub Actions polling (triggered mainly by videos.json updates) ---------- **/

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
function formatRun(run) {
  const s = run?.status || "unknown";
  const c = run?.conclusion ? ` / ${run.conclusion}` : "";
  return `${s}${c}`;
}
async function findRunForCommit(commitSha) {
  const runs = await ghFetch(api(`/repos/${owner}/${repo}/actions/runs?per_page=20`), { token });
  const arr = runs?.workflow_runs || [];
  return arr.find(r => r.head_sha === commitSha) || null;
}
async function pollActionsForCommit(commitSha, { timeoutMs = 180000, intervalMs = 3000 } = {}) {
  if (!commitSha) {
    setActionsPanel({
      stateText: "Idle",
      stateKind: "muted",
      commit: "—",
      workflow: "—",
      runText: "—",
      runUrl: null,
      notes: "No commit SHA to poll.",
    });
    return;
  }

  const shortSha = commitSha.slice(0, 7);
  const start = Date.now();

  setActionsPanel({
    stateText: "Polling…",
    stateKind: "muted",
    commit: shortSha,
    workflow: "Searching…",
    runText: "Waiting for run to appear…",
    runUrl: null,
    notes: "If token lacks Actions: Read, polling may show Unavailable.",
  });

  while (Date.now() - start < timeoutMs) {
    let run = null;
    try {
      run = await findRunForCommit(commitSha);
    } catch (e) {
      setActionsPanel({
        stateText: "Unavailable",
        stateKind: "warn",
        commit: shortSha,
        workflow: "—",
        runText: "—",
        runUrl: null,
        notes: `Actions polling unavailable: ${e.message}`,
      });
      return;
    }

    if (!run) {
      setActionsPanel({
        stateText: "Polling…",
        stateKind: "muted",
        commit: shortSha,
        workflow: "Searching…",
        runText: "No run yet — retrying…",
        runUrl: null,
        notes: "GitHub may take a few seconds to register the workflow run.",
      });
      await sleep(intervalMs);
      continue;
    }

    const pretty = formatRun(run);
    const url = run?.html_url || null;
    const wfName = run?.name || run?.workflow_id || "Workflow";

    if (run.status !== "completed") {
      setActionsPanel({
        stateText: "Running",
        stateKind: "muted",
        commit: shortSha,
        workflow: String(wfName),
        runText: pretty,
        runUrl: url,
        notes: "Workflow still in progress…",
      });
      await sleep(intervalMs);
      continue;
    }

    if (run.conclusion === "success") {
      setActionsPanel({
        stateText: "Completed",
        stateKind: "ok",
        commit: shortSha,
        workflow: String(wfName),
        runText: pretty,
        runUrl: url,
        notes: "Workflow succeeded.",
      });
    } else {
      setActionsPanel({
        stateText: "Completed",
        stateKind: "warn",
        commit: shortSha,
        workflow: String(wfName),
        runText: pretty,
        runUrl: url,
        notes: "Workflow not successful — open the run for logs.",
      });
    }
    return;
  }

  setActionsPanel({
    stateText: "Timed out",
    stateKind: "warn",
    commit: shortSha,
    workflow: "—",
    runText: "—",
    runUrl: null,
    notes: "Timed out waiting for workflow run.",
  });
}

/** ---------- Filename normalization ---------- **/

function normalizeFileName(originalName) {
  // Use your existing sanitize, then apply stronger normalization for stability
  const raw = sanitizeFileName(originalName || "video") || "video";

  // Separate extension
  const dot = raw.lastIndexOf(".");
  let base = dot >= 0 ? raw.slice(0, dot) : raw;
  let ext = dot >= 0 ? raw.slice(dot) : "";

  // Lowercase, collapse underscores, trim
  base = base.toLowerCase().replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  ext = ext.toLowerCase();

  // Avoid empty basename
  if (!base) base = "video";

  // Avoid weird trailing dots
  const out = `${base}${ext}`.replace(/\.+$/g, "");

  // Keep it short-ish
  return out.slice(0, 180);
}

/** ---------- Release helpers ---------- **/

function stableDownloadUrl(assetName) {
  // Pattern B stable URL (no API needed in player)
  return `https://github.com/${owner}/${repo}/releases/download/${RELEASE_TAG}/${encodeURIComponent(assetName)}`;
}

async function ensureRelease() {
  requireToken();

  // Try get by tag
  try {
    release = await ghFetch(api(`/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(RELEASE_TAG)}`), { token });
    return release;
  } catch (e) {
    if (e.status !== 404) throw e;
  }

  // Create release
  release = await ghFetch(api(`/repos/${owner}/${repo}/releases`), {
    token,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tag_name: RELEASE_TAG,
      name: RELEASE_NAME,
      body: "Assets for signboard playback (managed by admin UI).",
      draft: false,
      prerelease: false,
      make_latest: false
    })
  });

  return release;
}

async function loadReleaseAssets() {
  requireToken();
  await ensureRelease();

  // List assets
  const arr = await ghFetch(api(`/repos/${owner}/${repo}/releases/${release.id}/assets?per_page=100`), { token });
  assetsByName.clear();
  assetsByUrl.clear();

  if (Array.isArray(arr)) {
    for (const a of arr) {
      const meta = {
        id: a.id,
        name: a.name,
        size: a.size,
        browser_download_url: a.browser_download_url,
        content_type: a.content_type,
        download_count: a.download_count,
      };
      assetsByName.set(a.name, meta);
      assetsByUrl.set(a.browser_download_url, meta);
    }
  }
}

/** ---------- videos.json read/write ---------- **/

async function getFileContent(path) {
  requireToken();
  const j = await ghFetch(api(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`), { token });
  if (!j || j.type !== "file") throw new Error(`Expected file at ${path}`);
  const content = atob((j.content || "").replace(/\n/g, ""));
  return { sha: j.sha, content };
}

async function loadPlaylist() {
  requireToken();

  try {
    const { sha, content } = await getFileContent("videos.json");
    videosJsonSha = sha;
    const data = JSON.parse(content);
    playlist = Array.isArray(data) ? data.filter(x => typeof x === "string" && x.trim()) : [];
  } catch (e) {
    if (String(e.message).includes("404")) {
      playlist = [];
      videosJsonSha = null;
    } else {
      throw e;
    }
  }
}

async function saveVideosJson() {
  requireToken();
  const bodyText = JSON.stringify(playlist, null, 2) + "\n";

  const payload = {
    message: "Update videos.json playlist order",
    content: btoa(unescape(encodeURIComponent(bodyText))),
    ...(videosJsonSha ? { sha: videosJsonSha } : {}),
  };

  const j = await ghFetch(api(`/repos/${owner}/${repo}/contents/videos.json`), {
    token,
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  videosJsonSha = j?.content?.sha || videosJsonSha;
  return j?.commit?.sha || null;
}

/** ---------- Upload release asset with XHR + progress ---------- **/

function uploadReleaseAssetXhr({ releaseId, name, file }) {
  return new Promise((resolve, reject) => {
    const url = uploads(`/repos/${owner}/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);

    xhr.setRequestHeader("Accept", "application/vnd.github+json");
    xhr.setRequestHeader("X-GitHub-Api-Version", "2022-11-28");
    xhr.setRequestHeader("Authorization", `Bearer ${String(token).trim()}`);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        els.prog.value = pct;
      }
    };

    xhr.onerror = () => reject(new Error("Network error while uploading asset"));
    xhr.onload = () => {
      const status = xhr.status;
      const text = xhr.responseText || "";
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch {}

      if (status >= 200 && status < 300) {
        resolve(json);
      } else {
        const msg = json?.message || text || `HTTP ${status}`;
        const err = new Error(msg);
        err.status = status;
        err.details = json;
        reject(err);
      }
    };

    xhr.send(file);
  });
}

async function deleteReleaseAsset(assetId) {
  requireToken();
  await ghFetch(api(`/repos/${owner}/${repo}/releases/assets/${assetId}`), {
    token,
    method: "DELETE",
  });
}

/** ---------- UI rendering ---------- **/

function renderList() {
  els.list.innerHTML = "";

  if (!playlist.length) {
    const li = document.createElement("li");
    li.textContent = "No videos yet. Upload some files.";
    els.list.appendChild(li);
    return;
  }

  playlist.forEach((url, i) => {
    const li = document.createElement("li");
    li.draggable = true;
    li.dataset.index = String(i);

    const handle = document.createElement("span");
    handle.className = "handle";
    handle.textContent = "⠿";

    const nm = document.createElement("span");
    nm.className = "name";
    nm.textContent = url;

    const asset = assetsByUrl.get(url);
    const exists = document.createElement("span");
    exists.className = "pill";
    exists.textContent = asset ? `asset (${Math.round(asset.size / 1024 / 1024)} MB)` : "missing";
    if (!asset) exists.classList.add("warn");

    const del = document.createElement("button");
    del.textContent = "Delete";
    del.addEventListener("click", async () => {
      try {
        setMessage("Deleting…", "muted");
        setActionsPanel({ notes: "Deleting asset + updating videos.json…" });

        const a = assetsByUrl.get(url);
        if (a?.id) {
          await deleteReleaseAsset(a.id);
        }

        // Remove from playlist
        playlist = playlist.filter(x => x !== url);

        // Refresh assets and save playlist
        await loadReleaseAssets();
        const commitSha = await saveVideosJson();
        renderList();

        setMessage("Deleted and updated videos.json.", "ok");
        await pollActionsForCommit(commitSha);
      } catch (e) {
        setMessage(`Delete failed: ${e.message}`, "warn");
        setActionsPanel({ stateText: "Error", stateKind: "warn", notes: e.message });
      }
    });

    li.append(handle, nm, exists, del);
    els.list.appendChild(li);
  });

  wireDragAndDrop();
}

function wireDragAndDrop() {
  const items = [...els.list.querySelectorAll("li")];
  let dragIndex = null;

  items.forEach(li => {
    li.addEventListener("dragstart", (e) => {
      dragIndex = Number(li.dataset.index);
      li.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
    });

    li.addEventListener("dragend", () => li.classList.remove("dragging"));

    li.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    });

    li.addEventListener("drop", (e) => {
      e.preventDefault();
      const dropIndex = Number(li.dataset.index);
      if (Number.isNaN(dragIndex) || Number.isNaN(dropIndex) || dragIndex === dropIndex) return;

      const moved = playlist.splice(dragIndex, 1)[0];
      playlist.splice(dropIndex, 0, moved);
      renderList();
    });
  });
}

/** ---------- Auth / refresh ---------- **/

async function validateToken() {
  if (!token) { setStatus("Not connected"); return false; }
  try {
    await ghFetch(api(`/repos/${owner}/${repo}`), { token });
    setStatus("Connected", "ok");
    return true;
  } catch (e) {
    setStatus("Token invalid / no access", "warn");
    setMessage(`Auth error: ${e.message}`, "warn");
    return false;
  }
}

async function refreshAll() {
  setMessage("");
  const ok = await validateToken();
  if (!ok) return;

  try {
    await ensureRelease();
    await loadReleaseAssets();
    await loadPlaylist();

    // Reconcile:
    // - drop playlist URLs that don't correspond to existing assets (optional)
    playlist = playlist.filter(u => assetsByUrl.has(u));

    // - append assets not in playlist (optional)
    for (const [name, meta] of assetsByName.entries()) {
      const stable = stableDownloadUrl(name);
      if (!playlist.includes(stable)) playlist.push(stable);
    }

    renderList();
    setMessage(`Loaded release assets + playlist (${RELEASE_TAG}).`, "ok");

    setActionsPanel({
      stateText: "Idle",
      stateKind: "muted",
      commit: "—",
      workflow: "—",
      runText: "—",
      runUrl: null,
      notes: "No recent operation.",
    });
  } catch (e) {
    setMessage(`Refresh failed: ${e.message}`, "warn");
    setActionsPanel({ stateText: "Error", stateKind: "warn", notes: e.message });
  }
}

/** ---------- Upload flow ---------- **/

async function uploadOneFile(file) {
  requireToken();
  await ensureRelease();

  // Normalize filename
  const normalized = normalizeFileName(file.name);
  let name = normalized;

  // Avoid collisions: if asset with same name exists, add suffix
  if (assetsByName.has(name)) {
    const dot = name.lastIndexOf(".");
    const base = dot >= 0 ? name.slice(0, dot) : name;
    const ext = dot >= 0 ? name.slice(dot) : "";
    let n = 2;
    while (assetsByName.has(`${base}_${n}${ext}`)) n++;
    name = `${base}_${n}${ext}`;
  }

  els.prog.style.display = "";
  els.prog.max = 100;
  els.prog.value = 0;
  els.uploadMsg.textContent = `Uploading asset: ${name}`;

  // Upload binary to release assets (XHR progress)
  const asset = await uploadReleaseAssetXhr({
    releaseId: release.id,
    name,
    file
  });

  // Update local maps
  await loadReleaseAssets();

  // Add stable URL to playlist if not present
  const stable = stableDownloadUrl(name);
  if (!playlist.includes(stable)) playlist.push(stable);

  return stable;
}

/** ---------- UI wiring ---------- **/

els.saveToken.addEventListener("click", async () => {
  token = (els.token.value || "").trim();
  if (!token) {
    setMessage("Paste a PAT first.", "warn");
    return;
  }
  lsSet(TOKEN_KEY, token);
  await refreshAll();
});

els.clearToken.addEventListener("click", () => {
  lsDel(TOKEN_KEY);
  token = "";
  els.token.value = "";
  setStatus("Not connected");
  setMessage("Token cleared.", "muted");

  setActionsPanel({
    stateText: "Idle",
    stateKind: "muted",
    commit: "—",
    workflow: "—",
    runText: "—",
    runUrl: null,
    notes: "Token cleared; operations disabled.",
  });
});

els.refresh.addEventListener("click", refreshAll);

els.saveOrder.addEventListener("click", async () => {
  try {
    requireToken();
    setMessage("Saving videos.json…", "muted");
    setActionsPanel({ notes: "Saving…" });

    const commitSha = await saveVideosJson();
    setMessage("Saved videos.json order.", "ok");
    await pollActionsForCommit(commitSha);
  } catch (e) {
    setMessage(`Save failed: ${e.message}`, "warn");
    setActionsPanel({ stateText: "Error", stateKind: "warn", notes: e.message });
  }
});

els.upload.addEventListener("click", async () => {
  try {
    requireToken();
    const files = [...(els.fileInput.files || [])];
    if (!files.length) { setMessage("Choose one or more video files first.", "warn"); return; }

    setMessage("Starting upload…", "muted");
    setActionsPanel({
      stateText: "Idle",
      stateKind: "muted",
      commit: "—",
      workflow: "—",
      runText: "—",
      runUrl: null,
      notes: "Uploading assets… videos.json update will trigger workflow polling.",
    });

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      setMessage(`Uploading ${i + 1}/${files.length}: ${f.name}`, "muted");
      await uploadOneFile(f);
    }

    // Persist playlist URLs
    setMessage("Updating videos.json…", "muted");
    const commitSha = await saveVideosJson();

    renderList();
    els.uploadMsg.textContent = `Uploaded ${files.length} file(s) and updated videos.json.`;
    setMessage("Upload complete.", "ok");

    await pollActionsForCommit(commitSha);

  } catch (e) {
    setMessage(`Upload failed: ${e.message}`, "warn");
    setActionsPanel({ stateText: "Error", stateKind: "warn", notes: e.message });
  } finally {
    setTimeout(() => {
      els.prog.style.display = "none";
      els.uploadMsg.textContent = "";
      els.prog.value = 0;
      els.prog.max = 100;
    }, 1200);
  }
});

// Initial
(async () => {
  setActionsPanel({
    stateText: "Idle",
    stateKind: "muted",
    commit: "—",
    workflow: "—",
    runText: "—",
    runUrl: null,
    notes: `Using release tag: ${RELEASE_TAG}`,
  });

  if (token) {
    await refreshAll();
  } else {
    setStatus("Not connected");
    setMessage("Set a PAT to begin.", "muted");
  }
})();
