// Runs background.js in two isolated "browsers" that share one fake Firestore,
// to check that plays and clears reach every browser.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..", "extension");
const PROJECT = "test-project";
const DB = `projects/${PROJECT}/databases/(default)/documents`;
const UID = "user-1";

function createFirestore() {
  const docs = new Map();
  const stats = { reads: 0 };
  let lastTime = "";

  function commitTime() {
    let time = new Date().toISOString();
    if (time < lastTime) time = lastTime;
    lastTime = time;
    return time;
  }

  function toDocument(doc) {
    const fields = { ...doc.fields };
    if (doc.uploadedAt) fields.uploadedAt = { timestampValue: doc.uploadedAt };
    return { name: doc.name, fields };
  }

  function json(body, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", date: new Date().toUTCString() }
    });
  }

  function runQuery(uid, query) {
    let list = [...docs.values()].filter((doc) => doc.name.startsWith(`${DB}/users/${uid}/listens/`));
    const filter = query.where?.fieldFilter;
    if (filter?.field.fieldPath === "uploadedAt") {
      list = list.filter((doc) => doc.uploadedAt && doc.uploadedAt >= filter.value.timestampValue);
    }
    if (filter?.field.fieldPath === "playedAt") {
      list = list.filter((doc) => Number(doc.fields.playedAt.integerValue) <= Number(filter.value.integerValue));
    }
    if (query.orderBy) {
      list.sort((a, b) => (a.uploadedAt < b.uploadedAt ? -1 : a.uploadedAt > b.uploadedAt ? 1 : a.name < b.name ? -1 : 1));
    }
    if (query.startAt) {
      const [time, ref] = query.startAt.values.map((value) => value.timestampValue || value.referenceValue);
      list = list.filter((doc) => doc.uploadedAt > time || (doc.uploadedAt === time && doc.name > ref));
    }
    list = list.slice(0, query.limit || list.length);
    stats.reads += Math.max(1, list.length);
    return json(list.map((doc) => ({ document: toDocument(doc), readTime: new Date().toISOString() })));
  }

  async function fetch(url, options = {}) {
    const { pathname, searchParams } = new URL(url);
    const rest = decodeURIComponent(pathname).replace(`/v1/${DB}`, "");
    const body = options.body ? JSON.parse(options.body) : null;

    if (rest === ":commit") {
      const time = commitTime();
      for (const write of body.writes) {
        if (write.delete) {
          docs.delete(write.delete);
          continue;
        }
        assert.ok(write.update.name.startsWith(DB), `bad document name ${write.update.name}`);
        const transform = write.updateTransforms?.find((item) => item.fieldPath === "uploadedAt");
        docs.set(write.update.name, {
          name: write.update.name,
          fields: write.update.fields,
          uploadedAt: transform ? time : undefined
        });
      }
      return json({ commitTime: time });
    }

    let match = rest.match(/^\/users\/([^/]+):runQuery$/);
    if (match) return runQuery(match[1], body.structuredQuery);

    match = rest.match(/^\/users\/([^/]+)\/meta\/state$/);
    if (match) {
      stats.reads += 1;
      const doc = docs.get(`${DB}/users/${match[1]}/meta/state`);
      return doc ? json(toDocument(doc)) : json({ error: { code: 404, status: "NOT_FOUND" } }, 404);
    }

    match = rest.match(/^\/users\/([^/]+)\/listens$/);
    if (match) {
      const list = [...docs.values()].filter((doc) => doc.name.startsWith(`${DB}/users/${match[1]}/listens/`));
      const start = Number(searchParams.get("pageToken") || 0);
      const size = Number(searchParams.get("pageSize"));
      const page = list.slice(start, start + size);
      stats.reads += Math.max(1, page.length);
      return json({
        documents: page.map(toDocument),
        ...(start + size < list.length ? { nextPageToken: String(start + size) } : {})
      });
    }

    throw new Error(`Unexpected request ${options.method || "GET"} ${url}`);
  }

  return { docs, stats, fetch };
}

function createBrowser(firestore) {
  const storage = {};
  const listeners = {};
  let online = true;
  const event = (name) => ({ addListener: (fn) => { listeners[name] = fn; } });

  const chrome = {
    runtime: {
      id: "ext",
      lastError: undefined,
      getURL: (file) => `chrome-extension://ext/${file}`,
      getManifest: () => ({ oauth2: { client_id: "client.apps.googleusercontent.com" } }),
      onMessage: event("message"),
      onStartup: event("startup"),
      onInstalled: event("installed")
    },
    storage: {
      local: {
        setAccessLevel: async () => {},
        get: async (keys) => {
          const list = keys == null ? Object.keys(storage) : Array.isArray(keys) ? keys : [keys];
          const result = {};
          for (const key of list) if (key in storage) result[key] = structuredClone(storage[key]);
          return result;
        },
        set: async (items) => {
          Object.assign(storage, structuredClone(items));
        },
        remove: async (keys) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key];
        }
      }
    },
    tabs: { query: (_query, callback) => callback([]), sendMessage: () => {} }
  };

  const context = vm.createContext({
    chrome,
    console,
    crypto,
    structuredClone,
    URL,
    URLSearchParams,
    setTimeout,
    fetch: (...args) => (online ? firestore.fetch(...args) : Promise.reject(new TypeError("Failed to fetch"))),
    importScripts: (...files) => {
      for (const file of files) {
        if (file === "firebase-config.js") {
          context.LSC_FIREBASE_CONFIG = { apiKey: "key", projectId: PROJECT };
          continue;
        }
        vm.runInContext(fs.readFileSync(path.join(ROOT, file), "utf8"), context, { filename: file });
      }
    }
  });
  context.self = context;
  vm.runInContext(fs.readFileSync(path.join(ROOT, "background.js"), "utf8"), context, { filename: "background.js" });

  function send(message, url = "https://www.youtube.com/watch?v=x") {
    return new Promise((resolve) => listeners.message(message, { id: "ext", url }, resolve));
  }

  return {
    storage,
    send,
    setOnline(value) {
      online = value;
    },
    async signIn() {
      await chrome.storage.local.set({
        lazySongCounterAuth: { uid: UID, email: "a@example.com", idToken: "t", refreshToken: "r", expiresAt: Date.now() + 3600000 }
      });
    },
    play(title, channel = "Artist - Topic") {
      return send({ type: "record-listen", title, channel, videoId: title.slice(0, 11) });
    },
    count(title, channel = "Artist - Topic") {
      return send({ type: "get-play-count", title, channel });
    },
    sync() {
      return send({ type: "sync-cloud-now" }, "chrome-extension://ext/popup.html");
    },
    clear() {
      return send({ type: "clear-listening-history" }, "chrome-extension://ext/popup.html");
    },
    async total() {
      return storage["lsc:index"]?.total || 0;
    },
    async idle() {
      // Lets queued cloud uploads finish.
      for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 5));

test("plays and clears reach every browser", async () => {
  const firestore = createFirestore();
  const a = createBrowser(firestore);
  const b = createBrowser(firestore);

  await a.signIn();
  assert.equal((await a.sync()).ok, true);
  await a.play("Song One");
  await a.play("Song One");
  await a.idle();
  assert.equal(firestore.docs.size, 2, "plays upload right after they are recorded");

  await b.signIn();
  const first = await b.sync();
  assert.equal(first.ok, true, first.error);
  assert.equal(await b.total(), 2, "a new browser gets the full history");
  assert.equal((await b.count("Song One")).count, 2);
  // The first pull after a full sync reads a two-minute overlap once.
  assert.equal((await b.sync()).ok, true);
  assert.equal(await b.total(), 2);

  await a.play("Song Two");
  await a.idle();
  const readsBefore = firestore.stats.reads;
  assert.equal((await b.sync()).ok, true);
  assert.equal(await b.total(), 3, "the next sync pulls the new play");
  // One read for the clear marker, one for the new play.
  assert.equal(firestore.stats.reads - readsBefore, 2, "the next sync reads only new documents");

  // B plays while offline; the play waits in the queue.
  b.setOnline(false);
  await b.play("Offline Song");
  await b.idle();
  b.setOnline(true);
  await pause();

  // A clears after that play, so the clear must remove it everywhere.
  const cleared = await a.clear();
  assert.equal(cleared.ok, true);
  assert.equal(cleared.warning, undefined, cleared.warning);
  assert.equal(await a.total(), 0);
  assert.equal([...firestore.docs.keys()].filter((name) => name.includes("/listens/")).length, 0);

  assert.equal((await b.sync()).ok, true);
  assert.equal(await b.total(), 0, "the clear reaches the other browser");
  assert.equal([...firestore.docs.keys()].filter((name) => name.includes("/listens/")).length, 0,
    "the offline play from before the clear is not uploaded");

  await pause();
  await b.play("After Clear");
  await b.idle();
  assert.equal((await a.sync()).ok, true);
  assert.equal(await a.total(), 1, "new plays after the clear still sync");
});

test("a clear while offline reaches the cloud at the next sync", async () => {
  const firestore = createFirestore();
  const a = createBrowser(firestore);
  await a.signIn();
  await a.sync();
  await a.play("Song One");
  await a.idle();

  a.setOnline(false);
  await pause();
  const cleared = await a.clear();
  assert.equal(cleared.ok, true);
  assert.match(cleared.warning, /next sync/);
  a.setOnline(true);

  assert.equal((await a.sync()).ok, true);
  assert.equal([...firestore.docs.keys()].filter((name) => name.includes("/listens/")).length, 0);
});

test("a clear while signed out keeps the cloud copy", async () => {
  const firestore = createFirestore();
  const a = createBrowser(firestore);
  await a.signIn();
  await a.sync();
  await a.play("Song One");
  await a.idle();

  delete a.storage.lazySongCounterAuth;
  await pause();
  await a.clear();
  assert.equal(await a.total(), 0);

  await a.signIn();
  a.storage.lazySongCounterCloudState.cursor = null;
  assert.equal((await a.sync()).ok, true);
  assert.equal(await a.total(), 1, "the cloud history merges back after sign-in");
});

test("youtube pages cannot call account actions", async () => {
  const a = createBrowser(createFirestore());
  await a.play("Song One");
  const result = await a.send({ type: "clear-listening-history" }, "https://www.youtube.com/watch?v=x");
  assert.equal(result.ok, false);
  assert.equal(await a.total(), 1);
  const fromPage = await a.send({ type: "record-listen", title: "X", videoId: "x" }, "chrome-extension://ext/popup.html");
  assert.equal(fromPage.ok, false);
});
