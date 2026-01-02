import {
  inferOwnerRepo,
  lsGet, lsSet, lsDel,
  ghFetch,
  b64encodeArrayBuffer,
  sanitizeFileName
} from "./common.js";

const TOKEN_KEY = "gh_pat";

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
};

const { owner, repo } = inferOwnerRepo();
els.repoInfo.textContent = `Repo inferred: ${owner}/${repo}`;

let token = lsGet(TOKEN_KEY) || "";
els.token.value = token;

let videosJsonSha = null;      // sha for videos.json (needed for updates)
let videosFolderMap = new Map(); // filename -> { sha, path }
let playlist = [];             // ordered list of filenames

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

async function validateToken() {
  if (!token) { setStatus("Not connected"); return false; }
  try {
    // Minimal check: fetch repo metadata (requires auth only if private)
    await ghFetch(api(`/repos/${owner}/${repo}`), { token });
    setStatus("Connected", "ok");
    return true;
  } catch (e) {
    setStatus("Token invalid / no access", "warn");
    setMessage(`Auth error: ${e.message}`, "warn");
    return false;
  }
}

async function getFileContent(path) {
  requireToken();
  const j = await ghFetch(api(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`), { token });
  // For files, API returns an object with base64 content
  if (!j || j.type !== "file") throw new Error(`Expected file at ${path}`);
  const content = atob((j.content || "").replace(/\n/g, ""));
  return { sha: j.sha, content };
}

async function putFileContent(path, contentText, message) {
  requireToken();
  // Need current sha if updating existing; we keep videosJsonSha for videos.json
  let sha = null;
  try {
    const existing = await ghFetch(api(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`), { token });
    if (existing?.sha) sha = existing.sha;
  } catch {
    // create new file
  }

  const body = {
    message: message || `Update ${path}`,
    content: btoa(unescape(encodeURIComponent(contentText))), // utf-8 safe-ish for JSON text
    ...(sha ? { sha } : {}),
  };

  const j = await ghFetch(api(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`), {
    token,
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return j?.content?.sha || sha || null;
}

async function listVideosFolder() {
  requireToken();
  videosFolderMap.clear();
  // If folder doesn't exist yet, API errors
  let items = [];
  try {
    items = await ghFetch(api(`/repos/${owner}/${repo}/contents/videos`), { token });
  } catch (e) {
    if (e.status === 404) return; // no folder yet
    throw e;
  }

  if (!Array.isArray(items)) return;
  for (const it of items) {
    if (it.type === "file") {
      videosFolderMap.set(it.name, { sha: it.sha, path: it.path });
    }
  }
}

async function loadPlaylistAndShas() {
  setMessage("");
  requireToken();

  // Load videos.json (if missing, start empty)
  try {
    const { sha, content } = await getFileContent("videos.json");
    videosJsonSha = sha;
    playlist = JSON.parse(content);
    if (!Array.isArray(playlist)) playlist = [];
    playlist = playlist.filter(v => typeof v === "string" && v.trim().length > 0);
  } catch (e) {
    if (String(e.message).includes("404")) {
      playlist = [];
      videosJsonSha = null;
    } else {
      throw e;
    }
  }

  // Load folder listing to know what exists / for deletions
  await listVideosFolder();

  // Drop playlist entries that don't exist (optional but helpful)
  playlist = playlist.filter(name => videosFolderMap.has(name));

  // Add any existing videos not in playlist (append at end)
  for (const name of videosFolderMap.keys()) {
    if (!playlist.includes(name)) playlist.push(name);
  }
}

function renderList() {
  els.list.innerHTML = "";

  if (!playlist.length) {
    const li = document.createElement("li");
    li.textContent = "No videos yet. Upload some files.";
    els.list.appendChild(li);
    return;
  }

  playlist.forEach((name, i) => {
    const li = document.createElement("li");
    li.draggable = true;
    li.dataset.index = String(i);

    const handle = document.createElement("span");
    handle.className = "handle";
    handle.textContent = "⠿";

    const nm = document.createElement("span");
    nm.className = "name";
    nm.textContent = name;

    const exists = document.createElement("span");
    exists.className = "pill";
    exists.textContent = videosFolderMap.has(name) ? "in /videos" : "missing";
    if (!videosFolderMap.has(name)) exists.classList.add("warn");

    const del = document.createElement("button");
    del.textContent = "Delete";
    del.addEventListener("click", async () => {
      try {
        await deleteVideo(name);
        playlist = playlist.filter(v => v !== name);
        await saveVideosJson();
        renderList();
        setMessage(`Deleted ${name} and updated videos.json`, "ok");
      } catch (e) {
        setMessage(`Delete failed: ${e.message}`, "warn");
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

    li.addEventListener("dragend", () => {
      li.classList.remove("dragging");
    });

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

async function saveVideosJson() {
  requireToken();
  const body = JSON.stringify(playlist, null, 2) + "\n";

  const payload = {
    message: "Update videos.json playlist order",
    content: btoa(unescape(encodeURIComponent(body))),
    ...(videosJsonSha ? { sha: videosJsonSha } : {}),
  };

  const j = await ghFetch(api(`/repos/${owner}/${repo}/contents/videos.json`), {
    token,
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  videosJsonSha = j?.content?.sha || videosJsonSha;
}

async function uploadOneFile(file) {
  requireToken();
  const original = file.name || "video";
  const safe = sanitizeFileName(original) || "video.mp4";

  // If name conflicts, add suffix
  let name = safe;
  if (videosFolderMap.has(name)) {
    const dot = safe.lastIndexOf(".");
    const base = dot >= 0 ? safe.slice(0, dot) : safe;
    const ext = dot >= 0 ? safe.slice(dot) : "";
    let n = 2;
    while (videosFolderMap.has(`${base}_${n}${ext}`)) n++;
    name = `${base}_${n}${ext}`;
  }

  const buf = await file.arrayBuffer();
  const b64 = b64encodeArrayBuffer(buf);

  const payload = {
    message: `Upload video ${name}`,
    content: b64,
  };

  const j = await ghFetch(api(`/repos/${owner}/${repo}/contents/videos/${encodeURIComponent(name)}`), {
    token,
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  // Update local map
  videosFolderMap.set(name, { sha: j?.content?.sha, path: `videos/${name}` });
  if (!playlist.includes(name)) playlist.push(name);
}

async function deleteVideo(name) {
  requireToken();
  const meta = videosFolderMap.get(name);
  if (!meta?.sha) {
    // refresh map if needed
    await listVideosFolder();
  }
  const meta2 = videosFolderMap.get(name);
  if (!meta2?.sha) throw new Error("Cannot find file sha to delete (refresh and try again)");

  const payload = {
    message: `Delete video ${name}`,
    sha: meta2.sha,
  };

  await ghFetch(api(`/repos/${owner}/${repo}/contents/videos/${encodeURIComponent(name)}`), {
    token,
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  videosFolderMap.delete(name);
}

async function refreshAll() {
  setMessage("");
  const ok = await validateToken();
  if (!ok) return;

  try {
    await loadPlaylistAndShas();
    renderList();
    setMessage("Loaded videos and playlist.", "ok");
  } catch (e) {
    setMessage(`Refresh failed: ${e.message}`, "warn");
  }
}

// UI wiring
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
});

els.refresh.addEventListener("click", refreshAll);

els.saveOrder.addEventListener("click", async () => {
  try {
    requireToken();
    await saveVideosJson();
    setMessage("Saved videos.json order.", "ok");
  } catch (e) {
    setMessage(`Save failed: ${e.message}`, "warn");
  }
});

els.upload.addEventListener("click", async () => {
  try {
    requireToken();
    const files = [...(els.fileInput.files || [])];
    if (!files.length) { setMessage("Choose one or more video files first.", "warn"); return; }

    els.prog.style.display = "";
    els.prog.value = 0;
    els.uploadMsg.textContent = "";

    let done = 0;
    for (const f of files) {
      els.uploadMsg.textContent = `Uploading: ${f.name}`;
      await uploadOneFile(f);
      done++;
      els.prog.value = Math.round((done / files.length) * 100);
    }

    // Persist new playlist including uploads
    await saveVideosJson();
    renderList();

    els.uploadMsg.textContent = `Uploaded ${done} file(s) and updated videos.json.`;
    setMessage("Upload complete.", "ok");
  } catch (e) {
    setMessage(`Upload failed: ${e.message}`, "warn");
  } finally {
    setTimeout(() => { els.prog.style.display = "none"; }, 700);
  }
});

// Initial
(async () => {
  if (token) {
    await refreshAll();
  } else {
    setStatus("Not connected");
    setMessage("Set a PAT to begin.", "muted");
  }
})();
