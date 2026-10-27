(() => {
  const statusElement = document.querySelector("#cloud-status");
  const detailsElement = document.querySelector("#cloud-details");
  const signInButton = document.querySelector("#cloud-sign-in");
  const syncButton = document.querySelector("#cloud-sync");
  const signOutButton = document.querySelector("#cloud-sign-out");
  if (!statusElement || !detailsElement || !signInButton || !syncButton || !signOutButton) return;

  let latestState = null;
  let busy = false;

  signInButton.addEventListener("click", signIn);
  syncButton.addEventListener("click", syncNow);
  signOutButton.addEventListener("click", signOut);
  window.addEventListener("focus", refreshState);
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && (changes.lazySongCounterAuth || changes.lazySongCounterCloudState)) {
      void refreshState();
    }
  });

  async function send(type, payload = {}) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type, ...payload }, (response) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(response || { ok: false, error: "No response from the extension." });
      });
    });
  }

  async function getGoogleAccessToken() {
    return new Promise((resolve, reject) => {
      chrome.identity.getAuthToken({ interactive: true }, (result) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        const token = typeof result === "string" ? result : result?.token;
        if (!token) reject(new Error("Google did not return an access token."));
        else resolve(token);
      });
    });
  }

  async function signIn() {
    if (!latestState?.configured) {
      renderState({ ...latestState, signedIn: false, configured: false });
      return;
    }
    setBusy(true, "Opening Google sign-in…");
    try {
      const accessToken = await getGoogleAccessToken();
      const result = await send("complete-google-sign-in", { accessToken });
      if (!result.ok) throw new Error(result.error || "Google sign-in failed.");
      latestState = result.state;
      renderState(latestState);
    } catch (error) {
      setMessage(error.message || "Google sign-in failed.");
    } finally {
      setBusy(false);
    }
  }

  async function syncNow() {
    setBusy(true, "Syncing listening history…");
    try {
      const result = await send("sync-cloud-now");
      if (!result.ok) throw new Error(result.error || "Cloud sync failed.");
      await refreshState();
    } catch (error) {
      setMessage(error.message || "Cloud sync failed.");
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true, "Signing out…");
    try {
      await send("sign-out-cloud");
      await chrome.identity.clearAllCachedAuthTokens();
      await refreshState();
    } catch (error) {
      setMessage(error.message || "Could not sign out.");
    } finally {
      setBusy(false);
    }
  }

  async function refreshState() {
    try {
      const state = await send("get-account-state");
      latestState = state;
      renderState(state);
    } catch (error) {
      setMessage(error.message || "Could not read cloud backup status.");
    }
  }

  function renderState(state) {
    if (!state?.configured && !state?.signedIn) {
      statusElement.textContent = "Cloud backup setup needed";
      detailsElement.textContent = "Add Firebase values and a Chrome OAuth client ID; see README.";
      signInButton.hidden = false;
      signInButton.disabled = true;
      syncButton.hidden = true;
      signOutButton.hidden = true;
      return;
    }

    if (!state?.configured) {
      statusElement.textContent = "Cloud setup incomplete";
      detailsElement.textContent = state.email || "Update Firebase and OAuth settings in the extension files.";
      signInButton.hidden = true;
      syncButton.hidden = false;
      syncButton.disabled = true;
      signOutButton.hidden = false;
      signOutButton.disabled = busy;
      return;
    }

    signInButton.disabled = busy;
    signInButton.hidden = Boolean(state?.signedIn);
    syncButton.hidden = !state?.signedIn;
    signOutButton.hidden = !state?.signedIn;
    syncButton.disabled = busy || state?.status === "syncing";
    signOutButton.disabled = busy;

    if (!state?.signedIn) {
      statusElement.textContent = "Local history only";
      detailsElement.textContent = "Connect Google to back up and sync your history.";
      return;
    }

    const email = state.email || "Google account";
    if (state.status === "syncing") {
      statusElement.textContent = "Syncing cloud history…";
      detailsElement.textContent = email;
    } else if (state.status === "error") {
      statusElement.textContent = "Cloud sync needs attention";
      detailsElement.textContent = state.error || email;
    } else if (state.lastSyncedAt) {
      statusElement.textContent = "Cloud backup is on";
      detailsElement.textContent = `${email} · Last synced ${new Intl.DateTimeFormat("en-US", { dateStyle: "short", timeStyle: "short" }).format(state.lastSyncedAt)}`;
    } else {
      statusElement.textContent = "Google account connected";
      detailsElement.textContent = email;
    }
  }

  function setBusy(value, message) {
    busy = value;
    if (latestState) renderState(latestState);
    signInButton.disabled = value || !latestState?.configured;
    syncButton.disabled = value;
    signOutButton.disabled = value;
    if (message) setMessage(message);
  }

  function setMessage(message) {
    detailsElement.textContent = message;
  }

  void refreshState();
})();
