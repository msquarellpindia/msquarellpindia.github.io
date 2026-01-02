import { getBasePath } from "./common.js";

const videoEl = document.getElementById("player");
const overlay = document.getElementById("overlay");

const base = getBasePath(); // for fallback support if videos.json still has filenames
const videosJsonUrl = new URL(`${base}videos.json`, window.location.origin).toString();

let playlist = [];
let idx = 0;

function showOverlay(text) {
  overlay.textContent = text;
  overlay.classList.add("visible");
}
function hideOverlay() {
  overlay.classList.remove("visible");
}

function normalizeEntryToUrl(entry) {
  // Pattern B: entry is already a URL
  if (typeof entry === "string" && /^https?:\/\//i.test(entry.trim())) {
    return entry.trim();
  }

  // Backward compatibility: entry is a filename in /videos/
  if (typeof entry === "string" && entry.trim()) {
    const filename = entry.trim();
    return new URL(`${base}videos/${encodeURIComponent(filename)}`, window.location.origin).toString();
  }

  return null;
}

async function loadPlaylist() {
  const res = await fetch(videosJsonUrl, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load videos.json (${res.status})`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error("videos.json must be an array");

  const urls = data
    .map(normalizeEntryToUrl)
    .filter(u => typeof u === "string" && u.length > 0);

  return urls;
}

function setSource(url) {
  videoEl.src = url;
  videoEl.play().catch(() => {
    videoEl.muted = true;
    videoEl.play().catch(() => {});
  });
}

function next() {
  if (!playlist.length) return;
  idx = (idx + 1) % playlist.length;
  setSource(playlist[idx]);
}

async function start() {
  try {
    showOverlay("Loading playlist…");
    playlist = await loadPlaylist();
    if (!playlist.length) {
      showOverlay("Playlist is empty. Add videos via admin.html");
      return;
    }
    hideOverlay();
    idx = 0;
    setSource(playlist[idx]);
  } catch (e) {
    showOverlay(`Error: ${e.message}`);
  }
}

videoEl.addEventListener("ended", next);
videoEl.addEventListener("error", () => {
  setTimeout(next, 700);
});

// Reload playlist periodically (helpful for signage)
setInterval(async () => {
  try {
    const newList = await loadPlaylist();
    if (JSON.stringify(newList) !== JSON.stringify(playlist)) {
      playlist = newList;
      idx = 0;
      setSource(playlist[idx]);
    }
  } catch {
    // ignore
  }
}, 60_000);

start();
