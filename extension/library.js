const History = globalThis.LazySongHistory;
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
const dayFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });
let selectedPeriod = "daily";
let periodTracks = [];
let periodTotal = 0;
let page = 0;
let loadRequestId = 0;

const listElement = document.querySelector("#track-list");
const emptyElement = document.querySelector("#empty-state");
const searchElement = document.querySelector("#search");
const dateElement = document.querySelector("#history-date");
const clearDateButton = document.querySelector("#clear-date");
dateElement.max = localDateValue(new Date());

document.querySelectorAll(".periods button").forEach((button) => {
  button.addEventListener("click", () => {
    selectedPeriod = button.dataset.period;
    dateElement.value = "";
    updateDateControls();
    page = 0;
    document.querySelectorAll(".periods button").forEach((item) => {
      item.classList.toggle("active", item === button);
    });
    loadData();
  });
});

dateElement.addEventListener("change", () => {
  page = 0;
  updateDateControls();
  loadData();
});

clearDateButton.addEventListener("click", () => {
  dateElement.value = "";
  page = 0;
  updateDateControls();
  loadData();
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
  if (areaName === "local" && changes[History.INDEX_KEY]) loadData();
});

// "All time" comes from the per-track totals; a period or a date reads only its months.
async function loadData() {
  const requestId = ++loadRequestId;
  try {
    const selectedDate = selectedDateRange();
    const start = selectedDate ? selectedDate.start : rangeStart(selectedPeriod)?.getTime();
    let tracks;
    let total;
    if (start !== undefined) {
      const listens = await History.readListensInRange(chrome.storage.local, start, selectedDate ? selectedDate.end : Infinity);
      tracks = History.aggregate(listens);
      total = listens.length;
    } else {
      const [trackMap, index] = await Promise.all([
        History.readTrackMap(chrome.storage.local),
        History.readIndex(chrome.storage.local)
      ]);
      tracks = History.tracksFromMap(trackMap);
      total = index.total;
    }
    if (requestId !== loadRequestId) return;
    periodTracks = tracks;
    periodTotal = total;
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

function localDateValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function selectedDateRange() {
  if (!dateElement.value) return null;
  const [year, month, day] = dateElement.value.split("-").map(Number);
  const start = new Date(year, month - 1, day);
  const end = new Date(year, month - 1, day + 1);
  return { start: start.getTime(), end: end.getTime(), label: dayFormat.format(start) };
}

function updateDateControls() {
  const hasDate = Boolean(dateElement.value);
  clearDateButton.hidden = !hasDate;
  document.querySelectorAll(".periods button").forEach((button) => {
    button.classList.toggle("active", !hasDate && button.dataset.period === selectedPeriod);
  });
}

function getVisibleTracks() {
  const query = searchElement.value.trim().toLocaleLowerCase();
  if (!query) return periodTracks;
  return periodTracks.filter((track) => `${track.title} ${track.channel}`.toLocaleLowerCase().includes(query));
}

function render() {
  const selectedDate = selectedDateRange();
  const tracks = getVisibleTracks();
  const totalPages = Math.max(1, Math.ceil(tracks.length / PAGE_SIZE));
  page = Math.min(page, totalPages - 1);
  const firstIndex = page * PAGE_SIZE;
  const pageTracks = tracks.slice(firstIndex, firstIndex + PAGE_SIZE);

  document.querySelector("#period-chip").textContent = selectedDate ? selectedDate.label : PERIODS[selectedPeriod].label;
  document.querySelector("#summary-period").textContent = selectedDate
    ? `Listens on ${selectedDate.label}`
    : PERIODS[selectedPeriod].summary;
  document.querySelector("#total-listens").textContent = numberFormat.format(periodTotal);
  document.querySelector("#unique-tracks").textContent = numberFormat.format(periodTracks.length);
  document.querySelector("#result-count").textContent = `${numberFormat.format(tracks.length)} ${tracks.length === 1 ? "track" : "tracks"}`;
  document.querySelector("#range-label").textContent = tracks.length
    ? `Sorted by most played · ${selectedDate ? selectedDate.label : PERIODS[selectedPeriod].label}`
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
    document.querySelector("#empty-title").textContent = hasSearch
      ? "No matching tracks"
      : selectedDate
        ? `No tracks on ${selectedDate.label}`
        : "No tracks in this period";
    document.querySelector("#empty-description").textContent = hasSearch
      ? "Try a different title or channel name."
      : selectedDate
        ? "No listens were recorded on this date."
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
