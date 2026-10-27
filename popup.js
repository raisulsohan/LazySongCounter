const STORAGE_KEY = "lazySongCounterData";
const PERIODS = {
  daily: { label: "Today", summary: "Listens today" },
  weekly: { label: "This week", summary: "Listens this week" },
  monthly: { label: "This month", summary: "Listens this month" },
  yearly: { label: "This year", summary: "Listens this year" },
  all: { label: "All time", summary: "All-time listens" }
};

const numberFormat = new Intl.NumberFormat("en-US");
let selectedPeriod = "daily";
let allListens = [];
let currentTracks = [];
let toastTimer = 0;

const listElement = document.querySelector("#track-list");
const emptyElement = document.querySelector("#empty-state");

document.querySelectorAll(".periods button").forEach((button) => {
  button.addEventListener("click", () => {
    selectedPeriod = button.dataset.period;
    document.querySelectorAll(".periods button").forEach((item) => {
      item.classList.toggle("active", item === button);
    });
    render();
  });
});

document.querySelector("#refresh").addEventListener("click", loadData);

document.querySelector("#view-all").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("library.html") });
});

document.querySelector("#clear-history").addEventListener("click", async () => {
  const account = await sendBackgroundMessage({ type: "get-account-state" });
  if (!allListens.length && !account?.signedIn) {
    showToast("There is no history to clear.");
    return;
  }
  const confirmation = account?.signedIn
    ? "Clear listening history from this browser and your connected cloud account? This cannot be undone."
    : "Clear this browser's listening history? A cloud copy, if any, will remain in your account. This cannot be undone.";
  if (!confirm(confirmation)) return;
  const result = await sendBackgroundMessage({ type: "clear-listening-history" });
  if (!result?.ok) {
    showToast(result?.error || "Could not clear listening history.");
    return;
  }
  allListens = [];
  render();
  showToast("Listening history cleared.");
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[STORAGE_KEY]) return;
  allListens = changes[STORAGE_KEY].newValue?.listens || [];
  render();
});

async function loadData() {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    allListens = Array.isArray(result[STORAGE_KEY]?.listens) ? result[STORAGE_KEY].listens : [];
    render();
  } catch {
    showToast("Could not load history. Please try again.");
  }
}

function rangeStart(period, now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (period === "daily") return start;
  if (period === "weekly") {
    const daysSinceMonday = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - daysSinceMonday);
    return start;
  }
  if (period === "monthly") return new Date(now.getFullYear(), now.getMonth(), 1);
  if (period === "yearly") return new Date(now.getFullYear(), 0, 1);
  return null;
}

function render() {
  const start = rangeStart(selectedPeriod);
  const listens = allListens.filter((item) => {
    const timestamp = Number(item.playedAt);
    return Number.isFinite(timestamp) && (!start || timestamp >= start.getTime());
  });

  const grouped = new Map();
  listens.forEach((item) => {
    const key = item.trackKey || item.videoId || item.title;
    const current = grouped.get(key) || {
      key,
      title: item.title || "Untitled track",
      channel: item.channel || "",
      videoId: item.videoId || "",
      count: 0,
      lastPlayed: 0
    };
    current.count += 1;
    if (Number(item.playedAt) >= current.lastPlayed) {
      current.lastPlayed = Number(item.playedAt);
      current.title = item.title || current.title;
      current.channel = item.channel || current.channel;
      current.videoId = item.videoId || current.videoId;
    }
    grouped.set(key, current);
  });

  currentTracks = [...grouped.values()].sort((a, b) => b.count - a.count || b.lastPlayed - a.lastPlayed);
  document.querySelector("#summary-period").textContent = PERIODS[selectedPeriod].summary;
  document.querySelector("#period-chip").textContent = PERIODS[selectedPeriod].label;
  document.querySelector("#total-listens").textContent = numberFormat.format(listens.length);
  document.querySelector("#unique-tracks").textContent = numberFormat.format(currentTracks.length);
  listElement.replaceChildren();
  emptyElement.hidden = currentTracks.length > 0;
  listElement.hidden = currentTracks.length === 0;
  document.querySelector("#view-all").hidden = currentTracks.length === 0;

  currentTracks.slice(0, 5).forEach((track, index) => {
    listElement.append(createTrackCard(track, index + 1));
  });
}

function createTrackCard(track, rank) {
  const card = document.createElement("article");
  card.className = "track-card";

  const rankElement = document.createElement("span");
  rankElement.className = "rank";
  rankElement.textContent = numberFormat.format(rank);

  const info = document.createElement("div");
  info.className = "track-info";
  const title = document.createElement("a");
  title.className = "track-title";
  title.textContent = track.title;
  title.title = track.title;
  title.href = track.videoId ? `https://www.youtube.com/watch?v=${encodeURIComponent(track.videoId)}` : "https://www.youtube.com/";
  title.target = "_blank";
  title.rel = "noreferrer";
  const channel = document.createElement("span");
  channel.className = "track-channel";
  channel.textContent = track.channel || "YouTube";
  info.append(title, channel);

  const count = document.createElement("span");
  count.className = "track-count";
  count.append(document.createTextNode(numberFormat.format(track.count)));
  const countLabel = document.createElement("small");
  countLabel.textContent = "plays";
  count.append(countLabel);

  card.append(rankElement, info, count);
  return card;
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.add("visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 2600);
}

function sendBackgroundMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      resolve(error ? { ok: false, error: error.message } : response);
    });
  });
}

loadData();
