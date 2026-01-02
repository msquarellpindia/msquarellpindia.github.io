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

let defaultBranch = "main";       // fetched from repo metadata
let videosJsonSha = null;         // sha for videos.json (needed for updates)
let videosFolderMap = new Map();  // filename -> { sha, path }
let playlist = [];                // ordered list of filenames

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

/** ---------- Actions Status panel helpers ---------- **/

function nowLocalString() {
  return new Date().toLocaleString();
}
function setActionsPanel({
  stateText = "Idle",
  stateKind = "muted", // "muted" | "ok" | "warn"
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

/** ---------- GitHub Actions polling ---------- **/

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
      notes: "No commit SHA returned by API.",
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
    notes: "If Actions is disabled or your token lacks Actions: Read, polling will fail gracefully.",
  });

  let run = null;

  while (Date.now() - start < timeoutMs) {
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
        notes: "Deployment/build succeeded.",
      });
    } else {
      setActionsPanel({
        stateText: "Completed",
        stateKind: "warn",
        commit: shortSha,
        workflow: String(wfName),
        runText: pretty,
        runUrl: url,
        notes: "Workflow finished but not successful — open the run for logs.",
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
    notes: "Timed out waiting for a workflow run. You can check Actions manually.",
  });
}

/** ---------- Git Database API (used directly for uploads) ---------- **/

async function getHeadCommitSha(branch) {
  const ref = await ghFetch(api(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`), { token });
  return ref?.object?.sha;
}
async function getCommit(commitSha) {
  return ghFetch(api(`/repos/${owner}/${repo}/git/commits/${commitSha}`), { token });
}
async function createBlobBase64(b64) {
  return ghFetch(api(`/repos/${owner}/${repo}/git/blobs`), {
    token,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: b64, encoding: "base64" })
  });
}
async function createTreeWithFile({ baseTreeSha, path, blobSha }) {
  return ghFetch(api(`/repos/${owner}/${repo}/git/trees`), {
    token,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      base_tree: baseTreeSha,
      tree: [{
        path,
        mode: "100644",
        type: "blob",
        sha: blobSha
      }]
    })
  });
}
async function createCommit({ message, treeSha, parentSha }) {
  return ghFetch(api(`/repos/${owner}/${repo}/git/commits`), {
    token,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      tree: treeSha,
      parents: [parentSha]
    })
  });
}
async function updateBranchRef({ branch, newCommitSha }) {
  return ghFetch(api(`/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`), {
    token,
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sha: newCommitSha, force: false })
  });
}

/**
 * Upload/create/overwrite a single file via Git Data API.
 * Shows stage-style progress (not true network upload progress).
 */
async function uploadViaGitData({ repoPath, base64Content, message, onStage }) {
  requireToken();

  const stage = (pct, text) => {
    if (typeof onStage === "function") onStage(pct, text);
  };

  stage(5, "Resolving branch head…");
  const headSha = await getHeadCommitSha(defaultBranch);
  if (!headSha) throw new Error(`Could not resolve head for branch ${defaultBranch}`);

  stage(15, "Reading head commit…");
  const headCommit = await getCommit(headSha);
  const baseTreeSha = headCommit?.tree?.sha;
  if (!baseTreeSha) throw new Error("Could not resolve base tree");

  stage(40, "Creating blob…");
  const blob = await createBlobBase64(base64Content);
  const blobSha = blob?.sha;
  if (!blobSha) throw new Error("Failed to create blob");

  stage(65, "Creating tree…");
  const tree = await createTreeWithFile({ baseTreeSha, path: repoPath, blobSha });
  const treeSha = tree?.sha;
  if (!treeSha) throw new Error("Failed to create tree");

  stage(82, "Creating commit…");
  const commit = await createCommit({ message, treeSha, parentSha: headSha });
  const newCommitSha = commit?.sha;
  if (!newCommitSha) throw new Error("Failed to create commit");

  stage(95, "Updating branch ref…");
  await updateBranchRef({ branch: defaultBranch, newCommitSha });

  stage(100, "Done");
  return newCommitSha;
}

/** ---------- Auth & repo ---------- **/

async function validateToken() {
  if (!token) { setStatus("Not connected"); return false; }
  try {
    const meta = await ghFetch(api(`/repos/${owner}/${repo}`), { token });
    defaultBranch = meta?.default_branch || defaultBranch;
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
  if (!j || j.type !== "file") throw new Error(`Expected file at ${path}`);
  const content = atob((j.content || "").replace(/\n/g, ""));
  return { sha: j.sha, content };
}

async function listVideosFolder() {
  requireToken();
  videosFolderMap.clear();
  let items = [];
  try {
    items = await ghFetch(api(`/repos/${owner}/${repo}/contents/videos`), { token });
  } catch (e) {
    if (e.status === 404) return;
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

  await listVideosFolder();

  playlist = playlist.filter(name => videosFolderMap.has(name));
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
        setMessage(`Deleting ${name}…`, "muted");
        setActionsPanel({ notes: "Waiting for change to be saved…" });

        const commitSha = await deleteVideo(name);
        playlist = playlist.filter(v => v !== name);

        setMessage(`Updating videos.json…`, "muted");
        const jsonCommit = await saveVideosJson();

        renderList();
        setMessage(`Deleted ${name}.`, "ok");

        await pollActionsForCommit(jsonCommit || commitSha);
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

/** ---------- videos.json write (returns commit sha) ---------- **/

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

/** ---------- Upload & delete ---------- **/

async function uploadOneFile(file) {
  requireToken();

  const original = file.name || "video";
  const safe = sanitizeFileName(original) || "video.mp4";

  let name = safe;
  if (videosFolderMap.has(name)) {
    const dot = safe.lastIndexOf(".");
    const base = dot >= 0 ? safe.slice(0, dot) : safe;
    const ext = dot >= 0 ? safe.slice(dot) : "";
    let n = 2;
    while (videosFolderMap.has(`${base}_${n}${ext}`)) n++;
    name = `${base}_${n}${ext}`;
  }

  // Phase 1: encoding progress (deterministic)
  els.prog.style.display = "";
  els.prog.max = 100;
  els.prog.value = 0;
  els.uploadMsg.textContent = `Encoding: ${file.name}`;

  const buf = await file.arrayBuffer();
  const b64 = b64encodeArrayBuffer(buf, (pct) => {
    els.prog.value = pct;
  });

  // Phase 2: Git Data stages
  els.prog.value = 0;
  els.uploadMsg.textContent = `Uploading (Git Data API): ${name}`;

  const commitSha = await uploadViaGitData({
    repoPath: `videos/${name}`,
    base64Content: b64,
    message: `Upload video ${name}`,
    onStage: (pct, text) => {
      els.prog.value = pct;
      els.uploadMsg.textContent = `${text}`;
    }
  });

  // Refresh folder map so delete works later
  await listVideosFolder();
  if (!playlist.includes(name)) playlist.push(name);

  return commitSha;
}

async function deleteVideo(name) {
  requireToken();
  const meta = videosFolderMap.get(name);
  if (!meta?.sha) {
    await listVideosFolder();
  }
  const meta2 = videosFolderMap.get(name);
  if (!meta2?.sha) throw new Error("Cannot find file sha to delete (refresh and try again)");

  const payload = {
    message: `Delete video ${name}`,
    sha: meta2.sha,
  };

  const j = await ghFetch(api(`/repos/${owner}/${repo}/contents/videos/${encodeURIComponent(name)}`), {
    token,
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  videosFolderMap.delete(name);
  return j?.commit?.sha || null;
}

/** ---------- Refresh ---------- **/

async function refreshAll() {
  setMessage("");
  const ok = await validateToken();
  if (!ok) return;

  try {
    await loadPlaylistAndShas();
    renderList();
    setMessage("Loaded videos and playlist.", "ok");

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
  }
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
    notes: "Token cleared; Actions polling disabled.",
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

    els.prog.style.display = "";
    els.prog.max = 100;
    els.prog.value = 0;
    els.uploadMsg.textContent = "";
    setMessage("Starting upload…", "muted");

    setActionsPanel({
      stateText: "Idle",
      stateKind: "muted",
      commit: "—",
      workflow: "—",
      runText: "—",
      runUrl: null,
      notes: "Uploading… workflow polling will start after commit is created.",
    });

    let lastCommitSha = null;

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      setMessage(`Uploading ${i + 1}/${files.length}: ${f.name}`, "muted");
      lastCommitSha = await uploadOneFile(f);
    }

    setMessage("Updating videos.json…", "muted");
    const jsonCommit = await saveVideosJson();

    renderList();

    els.uploadMsg.textContent = `Uploaded ${files.length} file(s) and updated videos.json.`;
    setMessage("Upload complete.", "ok");

    await pollActionsForCommit(jsonCommit || lastCommitSha);

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
    notes: "Waiting for an operation…",
  });

  if (token) {
    await refreshAll();
  } else {
    setStatus("Not connected");
    setMessage("Set a PAT to begin.", "muted");
  }
})();
