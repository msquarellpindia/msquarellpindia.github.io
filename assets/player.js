import { getBasePath } from "./common.js";

const videoEl = document.getElementById("player");
const overlay = document.getElementById("overlay");

const base = getBasePath(); // e.g. "/myrepo/" or "/"
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

async function loadPlaylist() {
  const res = await fetch(videosJsonUrl, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load videos.json (${res.status})`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error("videos.json must be an array of filenames");
  // Remove empty or non-string entries
  return data.filter(v => typeof v === "string" && v.trim().length > 0);
}

function setSource(filename) {
  const url = new URL(`${base}videos/${encodeURIComponent(filename)}`, window.location.origin).toString();
  videoEl.src = url;
  // Attempt play (autoplay policies can block if not muted)
  videoEl.play().catch(() => {
    // If it fails, keep muted and retry
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
  // Skip broken entries after a short pause
  setTimeout(next, 700);
});

// Optional: reload playlist periodically (helps if admin updates while player runs)
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
