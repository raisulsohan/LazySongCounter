const test = require("node:test");
const assert = require("node:assert/strict");
const History = require("../extension/history-store.js");

// In-memory stand-in for chrome.storage.local. Values are copied like the real API does.
function createArea(initial = {}) {
  const data = structuredClone(initial);
  const writes = [];
  return {
    data,
    writes,
    async get(keys) {
      const list = keys == null ? Object.keys(data) : Array.isArray(keys) ? keys : [keys];
      const result = {};
      for (const key of list) if (key in data) result[key] = structuredClone(data[key]);
      return result;
    },
    async set(items) {
      writes.push(Object.keys(items));
      Object.assign(data, structuredClone(items));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    }
  };
}

let nextId = 0;
function listen(trackKey, playedAt, extra = {}) {
  nextId += 1;
  return { id: `id-${nextId}`, trackKey, title: trackKey.toUpperCase(), channel: "", videoId: `v${nextId}`, playedAt, ...extra };
}

const OCT_1 = Date.UTC(2026, 9, 1);
const SEP_15 = Date.UTC(2026, 8, 15);
const DAY = 24 * 60 * 60 * 1000;

test("a play writes only the index, its month and one track shard", async () => {
  const area = createArea();
  await History.addListens(area, [listen("a", SEP_15)]);
  area.writes.length = 0;
  await History.addListens(area, [listen("b", OCT_1)]);
  assert.equal(area.writes.length, 1);
  const keys = area.writes[0].sort();
  assert.equal(keys.length, 3);
  assert.ok(keys.includes("lsc:index"));
  assert.ok(keys.includes("lsc:m:2026-10"));
  assert.ok(keys.some((key) => key.startsWith("lsc:t:")));
});

test("plays are grouped by month and counted per track", async () => {
  const area = createArea();
  await History.addListens(area, [listen("a", SEP_15), listen("a", OCT_1), listen("b", OCT_1 + DAY)]);
  const index = await History.readIndex(area);
  assert.deepEqual(index.months, ["2026-09", "2026-10"]);
  assert.equal(index.total, 3);
  assert.equal(await History.playCount(area, "a"), 2);
  assert.equal(await History.playCount(area, "b"), 1);

  const october = await History.readListensInRange(area, OCT_1);
  assert.equal(october.length, 2);
  const top = History.aggregate(october);
  assert.deepEqual(top.map((track) => [track.key, track.count]), [["b", 1], ["a", 1]]);

  const allTime = History.tracksFromMap(await History.readTrackMap(area));
  assert.deepEqual(allTime.map((track) => [track.key, track.count]), [["a", 2], ["b", 1]]);
});

test("the same play id is never stored twice", async () => {
  const area = createArea();
  const play = listen("a", OCT_1);
  await History.addListens(area, [play]);
  const added = await History.addListens(area, [play, { ...play }]);
  assert.equal(added.length, 0);
  assert.equal((await History.readIndex(area)).total, 1);
});

test("the oldest plays are trimmed above the cap", async () => {
  const area = createArea();
  await History.addListens(area, [listen("old", SEP_15), listen("old", SEP_15 + 1), listen("new", OCT_1)], 2);
  const index = await History.readIndex(area);
  assert.equal(index.total, 2);
  assert.equal(await History.playCount(area, "old"), 1);

  await History.addListens(area, [listen("new", OCT_1 + 1)], 2);
  const trimmed = await History.readIndex(area);
  assert.deepEqual(trimmed.months, ["2026-10"]);
  assert.equal(await History.playCount(area, "old"), 0);
  assert.equal(area.data["lsc:m:2026-09"], undefined);
});

test("a clear removes older plays and blocks them from coming back", async () => {
  const area = createArea();
  const old = listen("a", SEP_15);
  const recent = listen("b", OCT_1 + DAY);
  await History.addListens(area, [old, recent]);
  await History.applyClear(area, OCT_1);

  assert.equal((await History.readIndex(area)).total, 1);
  assert.equal(await History.playCount(area, "a"), 0);
  assert.equal(await History.playCount(area, "b"), 1);
  assert.deepEqual(await History.addListens(area, [old]), []);

  // Moving the boundary back lets the account's older plays merge in again.
  await History.setClearedAt(area, 0);
  assert.equal((await History.addListens(area, [old])).length, 1);
});

test("the version 1 history is converted and re-keyed", async () => {
  const area = createArea({
    lazySongCounterData: {
      listens: [
        { id: "x1", trackKey: "song official video", title: "Song (Official Video)", channel: "Band", videoId: "a", playedAt: SEP_15 },
        { id: "x2", trackKey: "song", title: "Song", channel: "Band - Topic", videoId: "b", playedAt: OCT_1 },
        { id: "", trackKey: "broken", title: "Broken", playedAt: OCT_1 }
      ]
    }
  });
  const rekey = (item) => `band ${item.title.replace(/\s*\(.*\)/, "").toLowerCase()}`;
  assert.equal(await History.migrateLegacy(area, rekey), true);
  assert.equal(area.data.lazySongCounterData, undefined);
  assert.equal((await History.readIndex(area)).total, 2);
  assert.equal(await History.playCount(area, "band song"), 2);
  assert.equal(await History.migrateLegacy(area, rekey), false);
});
