const STORAGE_KEY = "lazySongCounterData";
const PAGE_SIZE = 25;
const PERIODS = {
  daily: { label: "Today", summary: "Listens today" },
  weekly: { label: "This week", summary: "Listens this week" },
  monthly: { label: "This month", summary: "Listens this month" },
  yearly: { label: "This year", summary: "Listens this year" },
  all: { label: "All time", summary: "All-time listens" }
};

const numberFormat = new Intl.NumberFormat("en-US");
const dateFormat = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short"
});
let selectedPeriod = "daily";
let allListens = [];
let page = 0;

const listElement = document.querySelector("#track-list");
const emptyElement = document.querySelector("#empty-state");
const searchElement = document.querySelector("#search");

document.querySelectorAll(".periods button").forEach((button) => {
  button.addEventListener("click", () => {
    selectedPeriod = button.dataset.period;
    page = 0;
    document.querySelectorAll(".periods button").forEach((item) => {
      item.classList.toggle("active", item === button);
    });
    render();
  });
});

searchElement.addEventListener("input", () => {
  page = 0;
  render();
});

document.querySelector("#previous-page").addEventListener("click", () => {
  if (page === 0) return;
  page -= 1;
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
});

document.querySelector("#next-page").addEventListener("click", () => {
  const totalPages = Math.max(1, Math.ceil(getVisibleTracks().length / PAGE_SIZE));
  if (page >= totalPages - 1) return;
  page += 1;
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
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
    document.querySelector("#empty-title").textContent = "Could not load history";
    document.querySelector("#empty-description").textContent = "Reload this page and try again.";
    emptyElement.hidden = false;
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

function getVisibleTracks(applySearch = true) {
  const start = rangeStart(selectedPeriod);
  const query = searchElement.value.trim().toLocaleLowerCase();
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

  return [...grouped.values()]
    .filter((track) => !applySearch || !query || `${track.title} ${track.channel}`.toLocaleLowerCase().includes(query))
    .sort((a, b) => b.count - a.count || b.lastPlayed - a.lastPlayed);
}

function render() {
  const start = rangeStart(selectedPeriod);
  const listensInPeriod = allListens.filter((item) => {
    const timestamp = Number(item.playedAt);
    return Number.isFinite(timestamp) && (!start || timestamp >= start.getTime());
  });
  const tracks = getVisibleTracks();
  const totalPages = Math.max(1, Math.ceil(tracks.length / PAGE_SIZE));
  page = Math.min(page, totalPages - 1);
  const firstIndex = page * PAGE_SIZE;
  const pageTracks = tracks.slice(firstIndex, firstIndex + PAGE_SIZE);

  document.querySelector("#period-chip").textContent = PERIODS[selectedPeriod].label;
  document.querySelector("#summary-period").textContent = PERIODS[selectedPeriod].summary;
  document.querySelector("#total-listens").textContent = numberFormat.format(listensInPeriod.length);
  document.querySelector("#unique-tracks").textContent = numberFormat.format(getVisibleTracks(false).length);
  document.querySelector("#result-count").textContent = `${numberFormat.format(tracks.length)} ${tracks.length === 1 ? "track" : "tracks"}`;
  document.querySelector("#range-label").textContent = tracks.length
    ? `Sorted by most played · ${PERIODS[selectedPeriod].label}`
    : "No tracks found";
  document.querySelector("#page-range").textContent = tracks.length
    ? `Showing ${numberFormat.format(firstIndex + 1)}–${numberFormat.format(Math.min(firstIndex + PAGE_SIZE, tracks.length))} of ${numberFormat.format(tracks.length)} tracks`
    : "Showing 0 tracks";
  document.querySelector("#page-number").textContent = `Page ${numberFormat.format(page + 1)} of ${numberFormat.format(totalPages)}`;
  document.querySelector("#previous-page").disabled = page === 0;
  document.querySelector("#next-page").disabled = page >= totalPages - 1;
  document.querySelector(".table-heading").hidden = tracks.length === 0;
  document.querySelector(".pagination").hidden = tracks.length === 0;
  listElement.replaceChildren();
  emptyElement.hidden = tracks.length > 0;
  listElement.hidden = tracks.length === 0;

  if (tracks.length === 0) {
    const hasSearch = Boolean(searchElement.value.trim());
    document.querySelector("#empty-title").textContent = hasSearch ? "No matching tracks" : "No tracks in this period";
    document.querySelector("#empty-description").textContent = hasSearch
      ? "Try a different title or channel name."
      : "Listen to a song on YouTube and it will appear here.";
  }

  pageTracks.forEach((track, index) => {
    listElement.append(createTrackRow(track, firstIndex + index + 1));
  });
}

function createTrackRow(track, rank) {
  const row = document.createElement("article");
  row.className = "track-row";

  const rankElement = document.createElement("span");
  rankElement.className = "rank";
  rankElement.textContent = numberFormat.format(rank);

  const info = document.createElement("div");
  info.className = "track-info";
  const title = document.createElement("a");
  title.className = "track-title";
  title.textContent = track.title;
  title.title = track.title;
  title.href = track.videoId
    ? `https://www.youtube.com/watch?v=${encodeURIComponent(track.videoId)}`
    : "https://www.youtube.com/";
  title.target = "_blank";
  title.rel = "noreferrer";
  const channel = document.createElement("span");
  channel.className = "track-channel";
  channel.textContent = track.channel || "YouTube";
  info.append(title, channel);

  const count = document.createElement("span");
  count.className = "row-count";
  count.textContent = numberFormat.format(track.count);

  const lastPlayed = document.createElement("time");
  lastPlayed.className = "last-played";
  lastPlayed.dateTime = new Date(track.lastPlayed).toISOString();
  lastPlayed.textContent = dateFormat.format(track.lastPlayed);

  row.append(rankElement, info, count, lastPlayed);
  return row;
}

loadData();
