importScripts("firebase-config.js", "music-rules.js", "history-store.js");

const { cleanText, trackKeyFor } = self.LazySongRules;
const History = self.LazySongHistory;
const area = chrome.storage.local;

const AUTH_KEY = "lazySongCounterAuth";
const CLOUD_STATE_KEY = "lazySongCounterCloudState";
const PENDING_KEY = "lsc:pending";
const VISUALIZER_POSITION_KEY = "lazySongCounterVisualizerPosition";
const MAX_LISTENS = 1000000;
const AUTO_SYNC_INTERVAL_MS = 10 * 60 * 1000;
const FIRESTORE_BATCH_SIZE = 400;
const FIRESTORE_PAGE_SIZE = 1000;
const FIREBASE_CONFIG = self.LSC_FIREBASE_CONFIG || {};

// Messages that only the popup and the library page may send.
const PAGE_MESSAGES = new Set([
  "get-account-state",
  "complete-google-sign-in",
  "sync-cloud-now",
  "sign-out-cloud",
  "clear-listening-history"
]);
// Messages that only the YouTube content script may send.
const YOUTUBE_MESSAGES = new Set([
  "record-listen",
  "get-play-count",
  "get-visualizer-position",
  "set-visualizer-position"
]);

let writeQueue = Promise.resolve();
let cloudQueue = Promise.resolve();
let activeSync = null;
let storageProtectionEnabled = false;

const storageProtectionReady = Promise.resolve().then(() => area.setAccessLevel({
  accessLevel: "TRUSTED_CONTEXTS"
})).then(() => {
  storageProtectionEnabled = true;
}).catch((error) => {
  console.error("Could not restrict extension storage to trusted contexts", error);
});

const historyReady = storageProtectionReady
  .then(() => serializeWrite(() => History.migrateLegacy(area, (item) => trackKeyFor(item.title, item.channel))))
  .then((migrated) => {
    if (migrated) notifyHistoryChanged();
  })
  .catch((error) => {
    console.error("Could not convert the listening history", error);
  });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;

  dispatchMessage(message, sender)
    .then(sendResponse)
    .catch((error) => {
      console.error("Request failed", error);
      sendResponse({ ok: false, error: error.message || "Request failed" });
    });
  return true;
});

chrome.runtime.onStartup.addListener(() => {
  void syncIfSignedIn();
});

chrome.runtime.onInstalled.addListener(() => {
  void syncIfSignedIn();
});

async function dispatchMessage(message, sender) {
  if (sender.id !== chrome.runtime.id) return { ok: false, error: "Invalid sender" };
  if (PAGE_MESSAGES.has(message.type) && !isExtensionPage(sender)) return { ok: false, error: "Invalid sender" };
  if (YOUTUBE_MESSAGES.has(message.type) && !isYouTubeUrl(sender.url || "")) return { ok: false, error: "Invalid sender" };

  switch (message.type) {
    case "record-listen":
      return recordListen(message);
    case "get-play-count":
      return getPlayCount(message);
    case "get-visualizer-position":
      return getVisualizerPosition();
    case "set-visualizer-position":
      return setVisualizerPosition(message.position);
    case "get-account-state":
      return getAccountState();
    case "complete-google-sign-in":
      return completeGoogleSignIn(message.accessToken);
    case "sync-cloud-now":
      return syncCloudNow();
    case "sign-out-cloud":
      return signOutCloud();
    case "clear-listening-history":
      return clearListeningHistory();
    case "sync-if-signed-in":
      return syncIfSignedIn();
    default:
      return { ok: false, error: "Unknown request" };
  }
}

function trackDetails(message) {
  const title = cleanText(message.title, 200);
  const channel = cleanText(message.channel, 120);
  return { title, channel, trackKey: title ? trackKeyFor(title, channel) : "" };
}

async function recordListen(message) {
  const { title, channel, trackKey } = trackDetails(message);
  const videoId = cleanText(message.videoId, 32);
  if (!title || !videoId || !trackKey) return { ok: false, error: "Missing track details" };

  const listen = { id: crypto.randomUUID(), trackKey, title, channel, videoId, playedAt: Date.now() };
  await historyReady;
  const added = await serializeWrite(async () => {
    const result = await History.addListens(area, [listen], MAX_LISTENS);
    if (result.length && await readAuth()) await addPending(result);
    return result;
  });
  if (added.length) {
    notifyHistoryChanged();
    void enqueueCloud(pushPendingQuietly);
  }
  return { ok: true, trackKey, count: await History.playCount(area, trackKey) };
}

async function getPlayCount(message) {
  const { trackKey } = trackDetails(message);
  if (!trackKey) return { ok: true, count: 0 };
  await historyReady;
  return { ok: true, trackKey, count: await History.playCount(area, trackKey) };
}

async function getVisualizerPosition() {
  const result = await area.get(VISUALIZER_POSITION_KEY);
  return { ok: true, position: result[VISUALIZER_POSITION_KEY] || null };
}

async function setVisualizerPosition(position) {
  const x = Number(position?.x);
  const y = Number(position?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, error: "Invalid position" };
  await area.set({
    [VISUALIZER_POSITION_KEY]: { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) }
  });
  return { ok: true };
}

async function completeGoogleSignIn(accessToken) {
  await requireStorageProtection();
  assertFirebaseConfigured();
  if (typeof accessToken !== "string" || !accessToken) {
    return { ok: false, error: "Google sign-in did not return an access token." };
  }

  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${encodeURIComponent(FIREBASE_CONFIG.apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        postBody: new URLSearchParams({ access_token: accessToken, providerId: "google.com" }).toString(),
        requestUri: "http://localhost",
        returnIdpCredential: true,
        returnSecureToken: true
      })
    }
  );
  const result = await readJsonResponse(response);
  const auth = {
    uid: result.localId,
    email: cleanText(result.email, 254),
    displayName: cleanText(result.displayName, 120),
    idToken: result.idToken,
    refreshToken: result.refreshToken,
    expiresAt: Date.now() + Number(result.expiresIn || 3600) * 1000
  };
  await area.set({ [AUTH_KEY]: auth });
  // A new sign-in always starts with a full merge of this browser and the account.
  await updateCloudState({ uid: auth.uid, cursor: null });

  try {
    await syncCloudNow();
  } catch (error) {
    await updateCloudState({ status: "error", error: userFacingCloudError(error) });
  }
  return { ok: true, account: { email: auth.email, displayName: auth.displayName }, state: await getAccountState() };
}

async function syncCloudNow() {
  await requireStorageProtection();
  assertFirebaseConfigured();
  if (!activeSync) {
    activeSync = enqueueCloud(syncCore).finally(() => {
      activeSync = null;
    });
  }
  return activeSync;
}

async function syncCore() {
  await historyReady;
  const auth = await readAuth();
  if (!auth) return { ok: false, error: "Sign in with Google to sync your history." };
  await updateCloudState({ status: "syncing", error: "", lastAttemptAt: Date.now() });

  try {
    const currentAuth = await getValidAuth(auth);
    let state = await readCloudState();
    if (state.uid !== currentAuth.uid) state = await updateCloudState({ uid: currentAuth.uid, cursor: null });

    await reconcileClear(currentAuth, state);
    const pulledCount = state.cursor
      ? await pullChanges(currentAuth, state.cursor)
      : await fullReconcile(currentAuth);
    const pushedCount = await flushPending(currentAuth);
    await updateCloudState({ status: "synced", lastSyncedAt: Date.now(), error: "" });
    return { ok: true, pulledCount, pushedCount };
  } catch (error) {
    const message = userFacingCloudError(error);
    await updateCloudState({ status: "error", error: message });
    throw new Error(message);
  }
}

// Applies "Clear history" across devices. The account keeps the time of its last clear in
// users/{uid}/meta/state; plays at or before that time are removed everywhere and never uploaded again.
async function reconcileClear(auth, state) {
  const remoteClearedAt = await readRemoteClearedAt(auth);
  let boundary = remoteClearedAt;
  const pendingClear = state.pendingClear;
  if (pendingClear?.uid === auth.uid && Number(pendingClear.at) >= remoteClearedAt) {
    if (pendingClear.at > remoteClearedAt) await writeRemoteClearedAt(auth, pendingClear.at);
    await deleteRemoteListensUpTo(auth, pendingClear.at);
    boundary = pendingClear.at;
  }
  if (pendingClear) await updateCloudState({ pendingClear: null });

  const index = await History.readIndex(area);
  if (boundary > index.clearedAt) {
    await serializeWrite(async () => {
      await History.applyClear(area, boundary);
      await dropPendingUpTo(boundary);
    });
    notifyHistoryChanged();
  } else if (boundary < index.clearedAt) {
    // This browser was cleared while signed out. The account's older plays may merge back in.
    await serializeWrite(() => History.setClearedAt(area, boundary));
  }
}

// First sync after sign-in: reads every document once, merges both sides,
// and queues local plays that the account does not have yet.
async function fullReconcile(auth) {
  const { documents, serverTime } = await listAllRemoteListens(auth);
  const remote = documents.map(remoteListen).filter(Boolean);
  const added = await serializeWrite(() => History.addListens(area, remote, MAX_LISTENS));

  const remoteIds = new Set(remote.map((item) => item.id));
  const local = await History.readListensInRange(area);
  const missing = local.filter((item) => !remoteIds.has(item.id));
  if (missing.length) await serializeWrite(() => addPending(missing));

  // Uploads that land while the list is read are caught by the next pull; the overlap covers them.
  const cursorTime = new Date((serverTime || Date.now()) - 2 * 60 * 1000).toISOString();
  await updateCloudState({ cursor: { time: cursorTime, name: "" } });
  if (added.length) notifyHistoryChanged();
  return added.length;
}

// Later syncs: reads only documents uploaded after the cursor.
async function pullChanges(auth, cursor) {
  let current = cursor;
  let pulledCount = 0;
  for (;;) {
    const query = {
      from: [{ collectionId: "listens" }],
      where: {
        fieldFilter: {
          field: { fieldPath: "uploadedAt" },
          op: "GREATER_THAN_OR_EQUAL",
          value: { timestampValue: current.time }
        }
      },
      orderBy: [
        { field: { fieldPath: "uploadedAt" }, direction: "ASCENDING" },
        { field: { fieldPath: "__name__" }, direction: "ASCENDING" }
      ],
      limit: FIRESTORE_PAGE_SIZE
    };
    if (current.name) {
      query.startAt = {
        values: [{ timestampValue: current.time }, { referenceValue: current.name }],
        before: false
      };
    }

    const documents = await runQuery(auth, query);
    if (documents.length === 0) break;
    const listens = documents.map(remoteListen).filter(Boolean);
    const added = await serializeWrite(() => History.addListens(area, listens, MAX_LISTENS));
    pulledCount += added.length;

    const last = documents[documents.length - 1];
    current = { time: last.fields?.uploadedAt?.timestampValue || current.time, name: last.name };
    await updateCloudState({ cursor: current });
    if (documents.length < FIRESTORE_PAGE_SIZE) break;
  }
  if (pulledCount) notifyHistoryChanged();
  return pulledCount;
}

async function flushPending(auth) {
  const [pending, index] = await Promise.all([readPending(), History.readIndex(area)]);
  const stale = pending.filter((item) => Number(item.playedAt) <= index.clearedAt);
  if (stale.length) await removePending(stale.map((item) => item.id));

  const uploads = pending.filter((item) => Number(item.playedAt) > index.clearedAt);
  for (let start = 0; start < uploads.length; start += FIRESTORE_BATCH_SIZE) {
    const batch = uploads.slice(start, start + FIRESTORE_BATCH_SIZE);
    await commitFirestoreWrites(auth, batch.map((item) => listenWrite(auth.uid, item)));
    await removePending(batch.map((item) => item.id));
  }
  return uploads.length;
}

async function pushPendingQuietly() {
  try {
    const auth = await readAuth();
    if (!auth) return;
    const currentAuth = await getValidAuth(auth);
    await flushPending(currentAuth);
    const state = await readCloudState();
    // A failed full sync stays visible until a full sync succeeds.
    if (state.status !== "error") await updateCloudState({ status: "synced", lastSyncedAt: Date.now(), error: "" });
  } catch (error) {
    await updateCloudState({ status: "error", error: userFacingCloudError(error) });
  }
}

async function syncIfSignedIn() {
  const auth = await readAuth();
  if (!auth || !isCloudConfigured()) return { ok: true, skipped: true };
  const cloudState = await readCloudState();
  const syncedRecently = cloudState.status === "synced" &&
    Date.now() - Number(cloudState.lastSyncedAt || 0) < AUTO_SYNC_INTERVAL_MS;
  if (syncedRecently) return { ok: true, skipped: true };
  try {
    return await syncCloudNow();
  } catch {
    return { ok: false, error: (await readCloudState()).error };
  }
}

async function signOutCloud() {
  await area.remove(AUTH_KEY);
  // Plays not yet uploaded stay in this browser; the next sign-in merges them into that account.
  await serializeWrite(() => area.set({ [PENDING_KEY]: [] }));
  await area.set({
    [CLOUD_STATE_KEY]: { status: "signed_out", lastSyncedAt: 0, error: "", uid: "", cursor: null, pendingClear: null }
  });
  return { ok: true, state: await getAccountState() };
}

async function clearListeningHistory() {
  await historyReady;
  const clearedAt = Date.now();
  const auth = await readAuth();
  await serializeWrite(async () => {
    await History.applyClear(area, clearedAt);
    await area.set({ [PENDING_KEY]: [] });
  });
  notifyHistoryChanged();
  if (!auth) return { ok: true };

  await updateCloudState({ pendingClear: { uid: auth.uid, at: clearedAt } });
  try {
    // A sync that started before the clear does not carry it, so wait for it and start a new one.
    await activeSync?.catch(() => undefined);
    await syncCloudNow();
    return { ok: true };
  } catch (error) {
    return {
      ok: true,
      warning: `History was cleared in this browser. The cloud copy will be cleared at the next sync. ${userFacingCloudError(error)}`
    };
  }
}

async function getAccountState() {
  const [auth, cloudState] = await Promise.all([readAuth(), readCloudState()]);
  return {
    ok: true,
    configured: isCloudConfigured(),
    signedIn: Boolean(auth),
    email: auth?.email || "",
    displayName: auth?.displayName || "",
    status: cloudState.status,
    lastSyncedAt: cloudState.lastSyncedAt || 0,
    error: cloudState.error || ""
  };
}

async function getValidAuth(auth) {
  await requireStorageProtection();
  if (Number(auth.expiresAt) > Date.now() + 60000) return auth;

  const response = await fetch(
    `https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(FIREBASE_CONFIG.apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: auth.refreshToken })
    }
  );
  const tokenResult = await readJsonResponse(response);
  const refreshedAuth = {
    ...auth,
    uid: tokenResult.user_id || auth.uid,
    idToken: tokenResult.id_token,
    refreshToken: tokenResult.refresh_token || auth.refreshToken,
    expiresAt: Date.now() + Number(tokenResult.expires_in || 3600) * 1000
  };
  await area.set({ [AUTH_KEY]: refreshedAuth });
  return refreshedAuth;
}

function databasePath() {
  return `projects/${encodeURIComponent(FIREBASE_CONFIG.projectId)}/databases/(default)`;
}

function documentsUrl() {
  return `https://firestore.googleapis.com/v1/${databasePath()}/documents`;
}

function userPath(uid) {
  return `users/${encodeURIComponent(uid)}`;
}

function listenName(uid, id) {
  return `${databasePath()}/documents/${userPath(uid)}/listens/${encodeURIComponent(id)}`;
}

function metaName(uid) {
  return `${databasePath()}/documents/${userPath(uid)}/meta/state`;
}

function authHeaders(auth, extra = {}) {
  return { Authorization: `Bearer ${auth.idToken}`, ...extra };
}

async function listAllRemoteListens(auth) {
  const documents = [];
  let serverTime = 0;
  let pageToken = "";
  do {
    const query = new URLSearchParams({ pageSize: String(FIRESTORE_PAGE_SIZE) });
    if (pageToken) query.set("pageToken", pageToken);
    const response = await fetch(`${documentsUrl()}/${userPath(auth.uid)}/listens?${query}`, {
      headers: authHeaders(auth)
    });
    if (!serverTime) serverTime = Date.parse(response.headers.get("date") || "") || 0;
    const result = await readJsonResponse(response);
    documents.push(...(result.documents || []));
    pageToken = result.nextPageToken || "";
  } while (pageToken);
  return { documents, serverTime };
}

async function runQuery(auth, structuredQuery) {
  const response = await fetch(`${documentsUrl()}/${userPath(auth.uid)}:runQuery`, {
    method: "POST",
    headers: authHeaders(auth, { "Content-Type": "application/json" }),
    body: JSON.stringify({ structuredQuery })
  });
  const result = await readJsonResponse(response);
  return (Array.isArray(result) ? result : []).map((item) => item.document).filter(Boolean);
}

async function readRemoteClearedAt(auth) {
  const response = await fetch(`${documentsUrl()}/${userPath(auth.uid)}/meta/state`, {
    headers: authHeaders(auth)
  });
  if (response.status === 404) return 0;
  const result = await readJsonResponse(response);
  return Number(result.fields?.clearedAt?.integerValue || 0);
}

async function writeRemoteClearedAt(auth, clearedAt) {
  await commitFirestoreWrites(auth, [{
    update: {
      name: metaName(auth.uid),
      fields: { clearedAt: { integerValue: String(Math.trunc(clearedAt)) } }
    }
  }]);
}

async function deleteRemoteListensUpTo(auth, clearedAt) {
  for (;;) {
    const documents = await runQuery(auth, {
      from: [{ collectionId: "listens" }],
      select: { fields: [{ fieldPath: "__name__" }] },
      where: {
        fieldFilter: {
          field: { fieldPath: "playedAt" },
          op: "LESS_THAN_OR_EQUAL",
          value: { integerValue: String(Math.trunc(clearedAt)) }
        }
      },
      limit: FIRESTORE_BATCH_SIZE
    });
    if (documents.length === 0) return;
    await commitFirestoreWrites(auth, documents.map((document) => ({ delete: document.name })));
    if (documents.length < FIRESTORE_BATCH_SIZE) return;
  }
}

async function commitFirestoreWrites(auth, writes) {
  if (writes.length === 0) return;
  const response = await fetch(`${documentsUrl()}:commit`, {
    method: "POST",
    headers: authHeaders(auth, { "Content-Type": "application/json" }),
    body: JSON.stringify({ writes })
  });
  await readJsonResponse(response);
}

function listenWrite(uid, item) {
  return {
    update: {
      name: listenName(uid, item.id),
      fields: {
        trackKey: { stringValue: cleanText(item.trackKey, 240) },
        title: { stringValue: cleanText(item.title, 200) },
        channel: { stringValue: cleanText(item.channel, 120) },
        videoId: { stringValue: cleanText(item.videoId, 32) },
        playedAt: { integerValue: String(Math.trunc(Number(item.playedAt))) }
      }
    },
    // Other browsers pull new plays by upload time, so a play recorded offline is not missed.
    updateTransforms: [{ fieldPath: "uploadedAt", setToServerValue: "REQUEST_TIME" }]
  };
}

function remoteListen(document) {
  const fields = document.fields || {};
  const id = decodeURIComponent(String(document.name || "").split("/").pop() || "");
  const title = fields.title?.stringValue || "";
  const channel = fields.channel?.stringValue || "";
  const playedAt = Number(fields.playedAt?.integerValue || fields.playedAt?.doubleValue || 0);
  if (!id || !title || !Number.isFinite(playedAt) || playedAt <= 0) return null;
  // Track keys are recomputed so plays saved by older versions group with new ones.
  return {
    id,
    trackKey: trackKeyFor(title, channel),
    title,
    channel,
    videoId: fields.videoId?.stringValue || "",
    playedAt
  };
}

async function readJsonResponse(response) {
  let result = {};
  try {
    result = await response.json();
  } catch {
    result = {};
  }
  if (!response.ok) {
    const error = Array.isArray(result) ? result[0]?.error : result.error;
    const detail = error?.message || error?.errors?.[0]?.message || error?.status || `HTTP ${response.status}`;
    throw new Error(detail);
  }
  return result;
}

function assertFirebaseConfigured() {
  if (isCloudConfigured()) return;
  throw new Error("Add your Firebase API key and project ID to firebase-config.js, and your Chrome OAuth client ID to manifest.json.");
}

function isCloudConfigured() {
  const apiKey = String(FIREBASE_CONFIG.apiKey || "");
  const projectId = String(FIREBASE_CONFIG.projectId || "");
  const clientId = String(chrome.runtime.getManifest().oauth2?.client_id || "");
  return Boolean(apiKey && projectId && clientId && !/YOUR_|REPLACE_ME/i.test(apiKey + projectId + clientId));
}

function userFacingCloudError(error) {
  const message = String(error?.message || error || "");
  if (/PERMISSION_DENIED|Missing or insufficient permissions/i.test(message)) {
    return "Cloud access was denied. Publish the latest firestore.rules in the Firebase console, then sync again.";
  }
  if (/OPERATION_NOT_ALLOWED|CONFIGURATION_NOT_FOUND/i.test(message)) {
    return "Google sign-in is not enabled in Firebase Authentication.";
  }
  if (/API key not valid|INVALID_API_KEY|API_KEY_INVALID/i.test(message)) {
    return "Firebase API key is invalid. Check firebase-config.js.";
  }
  if (/API_KEY_SERVICE_BLOCKED|API_KEY_\w*_BLOCKED|are blocked/i.test(message)) {
    return "The Firebase API key restrictions block this request. Allow Identity Toolkit, Token Service and Cloud Firestore for the key.";
  }
  if (/TOKEN_EXPIRED|INVALID_REFRESH_TOKEN|USER_NOT_FOUND|USER_DISABLED/i.test(message)) {
    return "Your Google session has expired. Sign out, then connect again.";
  }
  if (/Failed to fetch|NetworkError/i.test(message)) {
    return "Could not reach Firebase. Check your internet connection and project setup.";
  }
  return message || "Cloud sync failed. Check the Firebase setup and try again.";
}

async function readPending() {
  const result = await area.get(PENDING_KEY);
  return Array.isArray(result[PENDING_KEY]) ? result[PENDING_KEY] : [];
}

// Call inside serializeWrite.
async function addPending(listens) {
  const pending = await readPending();
  const known = new Set(pending.map((item) => item.id));
  await area.set({ [PENDING_KEY]: [...pending, ...listens.filter((item) => !known.has(item.id))] });
}

function removePending(ids) {
  const removed = new Set(ids);
  return serializeWrite(async () => {
    const pending = await readPending();
    await area.set({ [PENDING_KEY]: pending.filter((item) => !removed.has(item.id)) });
  });
}

// Call inside serializeWrite.
async function dropPendingUpTo(clearedAt) {
  const pending = await readPending();
  await area.set({ [PENDING_KEY]: pending.filter((item) => Number(item.playedAt) > clearedAt) });
}

async function readAuth() {
  await storageProtectionReady;
  const result = await area.get(AUTH_KEY);
  return result[AUTH_KEY] || null;
}

async function readCloudState() {
  await storageProtectionReady;
  const result = await area.get(CLOUD_STATE_KEY);
  return {
    status: "signed_out",
    lastSyncedAt: 0,
    error: "",
    uid: "",
    cursor: null,
    pendingClear: null,
    ...(result[CLOUD_STATE_KEY] || {})
  };
}

async function updateCloudState(update) {
  const next = { ...(await readCloudState()), ...update };
  await area.set({ [CLOUD_STATE_KEY]: next });
  return next;
}

async function requireStorageProtection() {
  await storageProtectionReady;
  if (!storageProtectionEnabled) {
    throw new Error("Secure local storage is unavailable. Update Chrome and reload the extension.");
  }
}

// Every change to the local history runs through this queue. Cloud work runs in its own queue
// and calls this one only for short local steps, so the two queues never wait on each other in a loop.
function serializeWrite(task) {
  const pending = writeQueue.catch(() => undefined).then(task);
  writeQueue = pending.catch(() => undefined);
  return pending;
}

function enqueueCloud(task) {
  const pending = cloudQueue.catch(() => undefined).then(task);
  cloudQueue = pending.catch(() => undefined);
  return pending;
}

function notifyHistoryChanged() {
  chrome.tabs.query({ url: ["https://www.youtube.com/*", "https://music.youtube.com/*"] }, (tabs) => {
    for (const tab of tabs) {
      if (!tab.id) continue;
      chrome.tabs.sendMessage(tab.id, { type: "history-updated" }, () => void chrome.runtime.lastError);
    }
  });
}

function isExtensionPage(sender) {
  return (sender.url || "").startsWith(chrome.runtime.getURL(""));
}

function isYouTubeUrl(value) {
  return /^https:\/\/(www\.|music\.)?youtube\.com\//i.test(value);
}
