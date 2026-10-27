importScripts("firebase-config.js");

const STORAGE_KEY = "lazySongCounterData";
const AUTH_KEY = "lazySongCounterAuth";
const CLOUD_STATE_KEY = "lazySongCounterCloudState";
const MAX_LISTENS = 10000;
const FIREBASE_CONFIG = self.LSC_FIREBASE_CONFIG || {};

let writeQueue = Promise.resolve();
let cloudQueue = Promise.resolve();
let activeFullSync = null;
let storageProtectionEnabled = false;

const storageProtectionReady = Promise.resolve().then(() => chrome.storage.local.setAccessLevel({
  accessLevel: "TRUSTED_CONTEXTS"
})).then(() => {
  storageProtectionEnabled = true;
}).catch((error) => {
  console.error("Could not restrict extension storage to trusted contexts", error);
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

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[STORAGE_KEY]) notifyHistoryChanged();
});

chrome.runtime.onStartup.addListener(() => {
  void syncIfSignedIn();
});

chrome.runtime.onInstalled.addListener(() => {
  void syncIfSignedIn();
});

async function dispatchMessage(message, sender) {
  switch (message.type) {
    case "record-listen":
      return recordListen(message, sender);
    case "get-play-count":
      return getPlayCount(message, sender);
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

async function recordListen(message, sender) {
  const senderUrl = sender.url || "";
  if (!isYouTubeUrl(senderUrl)) return { ok: false, error: "Invalid sender" };

  return serializeWrite(async () => {
    const title = cleanText(message.title, 200);
    const videoId = cleanText(message.videoId, 32);
    if (!title || !videoId) return { ok: false, error: "Missing track details" };

    const trackKey = cleanText(message.trackKey, 240) || title.toLocaleLowerCase();
    const listen = {
      id: crypto.randomUUID(),
      trackKey,
      title,
      channel: cleanText(message.channel, 120),
      videoId,
      playedAt: Date.now()
    };

    const listens = await readHistory();
    listens.push(listen);
    await writeHistory(listens.slice(-MAX_LISTENS));

    void enqueueCloud(async () => {
      try {
        const auth = await readAuth();
        if (!auth) return;
        const cloudState = await readCloudState();
        if (cloudState.status === "error") return;
        const currentAuth = await getValidAuth(auth);
        await writeFirestoreDocuments(currentAuth, [listen]);
        await updateCloudState({ status: "synced", lastSyncedAt: Date.now(), error: "" });
      } catch (error) {
        await updateCloudState({ status: "error", error: userFacingCloudError(error) });
      }
    });

    return { ok: true };
  });
}

async function getPlayCount(message, sender) {
  if (!isYouTubeUrl(sender.url || "")) return { ok: false, error: "Invalid sender" };
  const trackKey = cleanText(message.trackKey, 240);
  if (!trackKey) return { ok: true, count: 0 };
  const listens = await readHistory();
  return { ok: true, count: listens.reduce((count, item) => count + (item.trackKey === trackKey ? 1 : 0), 0) };
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
  await chrome.storage.local.set({ [AUTH_KEY]: auth });

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
  if (activeFullSync) return activeFullSync;

  activeFullSync = serializeWrite(() => enqueueCloud(fullSyncCore)).finally(() => {
    activeFullSync = null;
  });
  return activeFullSync;
}

async function fullSyncCore() {
  const auth = await readAuth();
  if (!auth) return { ok: false, error: "Sign in with Google to sync your history." };
  await updateCloudState({ status: "syncing", error: "", lastAttemptAt: Date.now() });

  try {
    const currentAuth = await getValidAuth(auth);
    const remoteListens = await listFirestoreDocuments(currentAuth);
    const localListens = await readHistory();
    const merged = new Map();
    remoteListens.forEach((item) => merged.set(item.id, item));
    localListens.forEach((item) => merged.set(item.id, item));

    const allListens = [...merged.values()]
      .filter((item) => item.id && Number.isFinite(Number(item.playedAt)))
      .sort((a, b) => Number(a.playedAt) - Number(b.playedAt));
    const remoteIds = new Set(remoteListens.map((item) => item.id));
    const retainedLocal = allListens.slice(-MAX_LISTENS);
    const retainedIds = new Set(retainedLocal.map((item) => item.id));
    const missingRemote = retainedLocal.filter((item) => !remoteIds.has(item.id));
    const expiredRemote = remoteListens.filter((item) => !retainedIds.has(item.id));

    await writeHistory(retainedLocal);
    for (let index = 0; index < missingRemote.length; index += 400) {
      await writeFirestoreDocuments(currentAuth, missingRemote.slice(index, index + 400));
    }
    const collection = firestoreCollectionPath(currentAuth.uid);
    const deleteWrites = expiredRemote.map((item) => ({
      delete: `${collection}/${encodeURIComponent(item.id)}`
    }));
    for (let index = 0; index < deleteWrites.length; index += 400) {
      await commitFirestoreWrites(currentAuth, deleteWrites.slice(index, index + 400));
    }
    await updateCloudState({ status: "synced", lastSyncedAt: Date.now(), error: "" });
    return { ok: true, syncedCount: missingRemote.length, historyCount: retainedLocal.length };
  } catch (error) {
    const message = userFacingCloudError(error);
    await updateCloudState({ status: "error", error: message });
    throw new Error(message);
  }
}

async function syncIfSignedIn() {
  const auth = await readAuth();
  if (!auth) return { ok: true, skipped: true };
  const cloudState = await readCloudState();
  const syncedRecently = cloudState.status === "synced" && Date.now() - Number(cloudState.lastSyncedAt || 0) < 8 * 60 * 60 * 1000;
  if (syncedRecently) return { ok: true, skipped: true };
  try {
    return await syncCloudNow();
  } catch {
    return { ok: false, error: (await readCloudState()).error };
  }
}

async function signOutCloud() {
  await chrome.storage.local.remove(AUTH_KEY);
  await chrome.storage.local.set({
    [CLOUD_STATE_KEY]: { status: "signed_out", lastSyncedAt: 0, error: "" }
  });
  return { ok: true, state: await getAccountState() };
}

async function clearListeningHistory() {
  return serializeWrite(async () => enqueueCloud(async () => {
    const auth = await readAuth();
    if (auth) {
      await requireStorageProtection();
      assertFirebaseConfigured();
      const currentAuth = await getValidAuth(auth);
      const remoteListens = await listFirestoreDocuments(currentAuth);
      const database = firestoreCollectionPath(currentAuth.uid);
      const writes = remoteListens.map((item) => ({
        delete: `${database}/${encodeURIComponent(item.id)}`
      }));
      for (let index = 0; index < writes.length; index += 400) {
        await commitFirestoreWrites(currentAuth, writes.slice(index, index + 400));
      }
    }

    await writeHistory([]);
    await updateCloudState({ status: auth ? "synced" : "signed_out", lastSyncedAt: auth ? Date.now() : 0, error: "" });
    return { ok: true };
  }));
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
  await chrome.storage.local.set({ [AUTH_KEY]: refreshedAuth });
  return refreshedAuth;
}

async function listFirestoreDocuments(auth) {
  const documents = [];
  let pageToken = "";
  do {
    const query = new URLSearchParams({ pageSize: "1000" });
    if (pageToken) query.set("pageToken", pageToken);
    const response = await fetch(`${firestoreCollectionPath(auth.uid)}?${query}`, {
      headers: { Authorization: `Bearer ${auth.idToken}` }
    });
    const result = await readJsonResponse(response);
    for (const document of result.documents || []) documents.push(parseFirestoreDocument(document));
    pageToken = result.nextPageToken || "";
  } while (pageToken);
  return documents;
}

async function writeFirestoreDocuments(auth, listens) {
  const database = firestoreCollectionPath(auth.uid);
  const writes = listens.map((item) => ({
    update: {
      name: `${database}/${encodeURIComponent(item.id)}`,
      fields: toFirestoreFields(item)
    }
  }));
  for (let index = 0; index < writes.length; index += 400) {
    await commitFirestoreWrites(auth, writes.slice(index, index + 400));
  }
}

async function commitFirestoreWrites(auth, writes) {
  if (writes.length === 0) return;
  const database = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(FIREBASE_CONFIG.projectId)}/databases/(default)/documents:commit`;
  const response = await fetch(database, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${auth.idToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ writes })
  });
  await readJsonResponse(response);
}

function firestoreCollectionPath(uid) {
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(FIREBASE_CONFIG.projectId)}/databases/(default)/documents/users/${encodeURIComponent(uid)}/listens`;
}

function toFirestoreFields(item) {
  return {
    trackKey: { stringValue: cleanText(item.trackKey, 240) },
    title: { stringValue: cleanText(item.title, 200) },
    channel: { stringValue: cleanText(item.channel, 120) },
    videoId: { stringValue: cleanText(item.videoId, 32) },
    playedAt: { integerValue: String(Math.trunc(Number(item.playedAt))) }
  };
}

function parseFirestoreDocument(document) {
  const fields = document.fields || {};
  const name = String(document.name || "");
  const id = decodeURIComponent(name.split("/").pop() || "");
  return {
    id,
    trackKey: fields.trackKey?.stringValue || "",
    title: fields.title?.stringValue || "",
    channel: fields.channel?.stringValue || "",
    videoId: fields.videoId?.stringValue || "",
    playedAt: Number(fields.playedAt?.integerValue || fields.playedAt?.doubleValue || 0)
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
    const detail = result.error?.message || result.error?.errors?.[0]?.message || `HTTP ${response.status}`;
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
    return "Cloud access was denied. Check that Firestore is enabled and firestore.rules is published.";
  }
  if (/OPERATION_NOT_ALLOWED|PASSWORD_LOGIN_DISABLED|Google/i.test(message)) {
    return "Google sign-in is not enabled in Firebase Authentication.";
  }
  if (/API key not valid|INVALID_API_KEY/i.test(message)) {
    return "Firebase API key is invalid. Check firebase-config.js.";
  }
  if (/Failed to fetch|NetworkError/i.test(message)) {
    return "Could not reach Firebase. Check your internet connection and project setup.";
  }
  return message || "Cloud sync failed. Check the Firebase setup and try again.";
}

async function readHistory() {
  await storageProtectionReady;
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const listens = result[STORAGE_KEY]?.listens;
  return Array.isArray(listens) ? listens : [];
}

async function writeHistory(listens) {
  await storageProtectionReady;
  await chrome.storage.local.set({ [STORAGE_KEY]: { listens } });
}

async function readAuth() {
  await storageProtectionReady;
  const result = await chrome.storage.local.get(AUTH_KEY);
  return result[AUTH_KEY] || null;
}

async function readCloudState() {
  await storageProtectionReady;
  const result = await chrome.storage.local.get(CLOUD_STATE_KEY);
  return result[CLOUD_STATE_KEY] || { status: "signed_out", lastSyncedAt: 0, error: "" };
}

async function updateCloudState(update) {
  const current = await readCloudState();
  await chrome.storage.local.set({ [CLOUD_STATE_KEY]: { ...current, ...update } });
}

async function requireStorageProtection() {
  await storageProtectionReady;
  if (!storageProtectionEnabled) {
    throw new Error("Secure local storage is unavailable. Update Chrome and reload the extension.");
  }
}

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

function isYouTubeUrl(value) {
  return /^https:\/\/(www\.|music\.)?youtube\.com\//i.test(value);
}

function cleanText(value, maxLength) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}
