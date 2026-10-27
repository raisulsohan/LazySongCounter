// Listening history layout in chrome.storage.local:
//   lsc:index        { version, months: ["YYYY-MM"], total, clearedAt }
//   lsc:m:YYYY-MM    plays in that UTC month, oldest first
//   lsc:t:0 … lsc:t:f  per-track totals, sharded by key hash
// A play touches one month chunk and one track shard, so its cost does not grow with the history.
// Only the service worker writes; extension pages read.
(function (root) {
  "use strict";

  const INDEX_KEY = "lsc:index";
  const MONTH_PREFIX = "lsc:m:";
  const TRACK_PREFIX = "lsc:t:";
  const TRACK_SHARDS = 16;
  const LEGACY_KEY = "lazySongCounterData";
  const VERSION = 2;

  const trackShardKeys = Array.from({ length: TRACK_SHARDS }, (_, index) => `${TRACK_PREFIX}${index.toString(16)}`);

  function emptyIndex(clearedAt = 0) {
    return { version: VERSION, months: [], total: 0, clearedAt };
  }

  function monthOf(timestamp) {
    const date = new Date(Number(timestamp));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  }

  function monthKey(month) {
    return `${MONTH_PREFIX}${month}`;
  }

  function trackShardKey(trackKey) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < trackKey.length; index += 1) {
      hash ^= trackKey.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return trackShardKeys[(hash >>> 0) % TRACK_SHARDS];
  }

  function isValidListen(item) {
    return Boolean(item && typeof item.id === "string" && item.id &&
      typeof item.trackKey === "string" && Number.isFinite(Number(item.playedAt)));
  }

  async function readIndex(area) {
    const result = await area.get(INDEX_KEY);
    const index = result[INDEX_KEY];
    if (!index || !Array.isArray(index.months)) return emptyIndex();
    return {
      version: VERSION,
      months: index.months.slice(),
      total: Number(index.total) || 0,
      clearedAt: Number(index.clearedAt) || 0
    };
  }

  // Plays with start <= playedAt < end, oldest first.
  async function readListensInRange(area, start = -Infinity, end = Infinity) {
    const index = await readIndex(area);
    const startMonth = Number.isFinite(start) ? monthOf(start) : "";
    const endMonth = Number.isFinite(end) ? monthOf(end) : "9999-99";
    const months = index.months.filter((month) => month >= startMonth && month <= endMonth);
    if (months.length === 0) return [];
    const result = await area.get(months.map(monthKey));
    const listens = [];
    for (const month of months) {
      for (const item of result[monthKey(month)] || []) {
        const playedAt = Number(item.playedAt);
        if (playedAt >= start && playedAt < end) listens.push(item);
      }
    }
    return listens;
  }

  async function readTrackMap(area) {
    const result = await area.get(trackShardKeys);
    return Object.assign({}, ...trackShardKeys.map((key) => result[key] || {}));
  }

  function trackFromListen(item) {
    return {
      key: item.trackKey || item.videoId || item.title,
      title: item.title || "Untitled track",
      channel: item.channel || "",
      videoId: item.videoId || "",
      count: 0,
      lastPlayed: 0
    };
  }

  function touchTrack(track, item) {
    track.count += 1;
    const playedAt = Number(item.playedAt);
    if (playedAt >= track.lastPlayed) {
      track.lastPlayed = playedAt;
      track.title = item.title || track.title;
      track.channel = item.channel || track.channel;
      track.videoId = item.videoId || track.videoId;
    }
  }

  function sortTracks(tracks) {
    return tracks.sort((a, b) => b.count - a.count || b.lastPlayed - a.lastPlayed);
  }

  // Groups plays into tracks, most played first.
  function aggregate(listens) {
    const grouped = new Map();
    for (const item of listens) {
      const key = item.trackKey || item.videoId || item.title;
      const track = grouped.get(key) || trackFromListen(item);
      touchTrack(track, item);
      grouped.set(key, track);
    }
    return sortTracks([...grouped.values()]);
  }

  function tracksFromMap(trackMap) {
    return sortTracks(Object.entries(trackMap)
      .filter(([, track]) => track && track.count > 0)
      .map(([key, track]) => ({
        key,
        title: track.title || "Untitled track",
        channel: track.channel || "",
        videoId: track.videoId || "",
        count: Number(track.count) || 0,
        lastPlayed: Number(track.lastPlayed) || 0
      })));
  }

  function storedTrack(track) {
    return {
      title: track.title,
      channel: track.channel,
      videoId: track.videoId,
      count: track.count,
      lastPlayed: track.lastPlayed
    };
  }

  // Adds plays that are new (by id) and newer than the last clear. Trims the oldest plays above maxListens.
  // Returns the plays that were added.
  async function addListens(area, listens, maxListens = Infinity) {
    const index = await readIndex(area);
    const candidates = listens.filter((item) => isValidListen(item) && Number(item.playedAt) > index.clearedAt);
    if (candidates.length === 0) return [];

    const months = [...new Set(candidates.map((item) => monthOf(item.playedAt)))];
    const shardKeys = [...new Set(candidates.map((item) => trackShardKey(item.trackKey)))];
    const stored = await area.get([...months.map(monthKey), ...shardKeys]);
    const chunks = new Map(months.map((month) => [month, (stored[monthKey(month)] || []).slice()]));
    const shards = new Map(shardKeys.map((key) => [key, { ...(stored[key] || {}) }]));
    const knownIds = new Map(months.map((month) => [month, new Set(chunks.get(month).map((item) => item.id))]));

    const added = [];
    for (const item of candidates) {
      const month = monthOf(item.playedAt);
      if (knownIds.get(month).has(item.id)) continue;
      knownIds.get(month).add(item.id);
      const listen = {
        id: item.id,
        trackKey: item.trackKey,
        title: item.title || "",
        channel: item.channel || "",
        videoId: item.videoId || "",
        playedAt: Number(item.playedAt)
      };
      chunks.get(month).push(listen);
      const shard = shards.get(trackShardKey(listen.trackKey));
      const track = shard[listen.trackKey]
        ? { ...shard[listen.trackKey] }
        : { title: listen.title, channel: listen.channel, videoId: listen.videoId, count: 0, lastPlayed: 0 };
      touchTrack(track, listen);
      shard[listen.trackKey] = storedTrack(track);
      added.push(listen);
    }
    if (added.length === 0) return [];

    index.months = [...new Set([...index.months, ...months])].sort();
    index.total += added.length;
    const update = { [INDEX_KEY]: index };
    for (const [month, chunk] of chunks) {
      update[monthKey(month)] = chunk.sort((a, b) => Number(a.playedAt) - Number(b.playedAt));
    }
    for (const [key, shard] of shards) update[key] = shard;
    await area.set(update);

    if (index.total > maxListens) await trimOldest(area, index.total - maxListens);
    return added;
  }

  async function trimOldest(area, excess) {
    const index = await readIndex(area);
    const removals = [];
    const update = {};
    const emptied = [];
    let remaining = excess;
    for (const month of index.months) {
      if (remaining <= 0) break;
      const chunk = (await area.get(monthKey(month)))[monthKey(month)] || [];
      const dropped = chunk.slice(0, remaining);
      removals.push(...dropped);
      remaining -= dropped.length;
      if (dropped.length === chunk.length) emptied.push(month);
      else update[monthKey(month)] = chunk.slice(dropped.length);
    }

    const shardKeys = [...new Set(removals.map((item) => trackShardKey(item.trackKey)))];
    const stored = await area.get(shardKeys);
    const shards = new Map(shardKeys.map((key) => [key, { ...(stored[key] || {}) }]));
    for (const item of removals) {
      const shard = shards.get(trackShardKey(item.trackKey));
      const track = shard[item.trackKey];
      if (!track) continue;
      if (track.count <= 1) delete shard[item.trackKey];
      else shard[item.trackKey] = { ...track, count: track.count - 1 };
    }
    for (const [key, shard] of shards) update[key] = shard;

    index.months = index.months.filter((month) => !emptied.includes(month));
    index.total = Math.max(0, index.total - removals.length);
    update[INDEX_KEY] = index;
    await area.set(update);
    if (emptied.length) await area.remove(emptied.map(monthKey));
  }

  // Replaces the whole history with the given plays (used by the legacy migration and by clears).
  async function replaceAll(area, listens, clearedAt) {
    const index = await readIndex(area);
    await area.remove([...index.months.map(monthKey), ...trackShardKeys]);
    await area.set({ [INDEX_KEY]: emptyIndex(clearedAt) });
    return addListens(area, listens);
  }

  // Removes every play at or before clearedAt and remembers the boundary.
  async function applyClear(area, clearedAt) {
    const index = await readIndex(area);
    const keep = await readListensInRange(area, clearedAt + 1, Infinity);
    await replaceAll(area, keep, Math.max(clearedAt, index.clearedAt));
  }

  // Moves the clear boundary without removing plays, so plays from a newly connected account can merge in.
  async function setClearedAt(area, clearedAt) {
    const index = await readIndex(area);
    index.clearedAt = clearedAt;
    await area.set({ [INDEX_KEY]: index });
  }

  async function playCount(area, trackKey) {
    const shardKey = trackShardKey(trackKey);
    const result = await area.get(shardKey);
    return Number(result[shardKey]?.[trackKey]?.count) || 0;
  }

  // Converts the version 1 single-array history. rekey() gives each play its current track key.
  async function migrateLegacy(area, rekey) {
    const result = await area.get(LEGACY_KEY);
    const legacy = result[LEGACY_KEY];
    if (!legacy) return false;
    const listens = (Array.isArray(legacy.listens) ? legacy.listens : [])
      .filter((item) => item && item.id && Number.isFinite(Number(item.playedAt)))
      .map((item) => ({ ...item, trackKey: rekey(item) }));
    const current = await readListensInRange(area);
    await replaceAll(area, [...current, ...listens], (await readIndex(area)).clearedAt);
    await area.remove(LEGACY_KEY);
    return true;
  }

  const api = Object.freeze({
    INDEX_KEY,
    LEGACY_KEY,
    monthOf,
    readIndex,
    readListensInRange,
    readTrackMap,
    tracksFromMap,
    aggregate,
    addListens,
    applyClear,
    setClearedAt,
    playCount,
    migrateLegacy
  });

  root.LazySongHistory = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self);
