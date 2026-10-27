(() => {
  const canvas = document.querySelector("#music-visualizer");
  const openButton = document.querySelector("#visualizer-open");
  if (!canvas || !openButton || typeof window.LazySongVisualizer !== "function") return;

  const visualizer = new window.LazySongVisualizer(canvas);
  const injectedTabs = new Set();
  let activeTabId = null;
  let polling = false;

  openButton.addEventListener("click", openFloatingVisualizer);
  window.setInterval(pollActiveTab, 70);
  pollActiveTab();

  window.addEventListener("pagehide", () => {
    visualizer.destroy();
    if (activeTabId == null) return;
    chrome.tabs.sendMessage(activeTabId, { type: "lsc-stop-visualizer" }, () => void chrome.runtime.lastError);
  });

  // A YouTube tab that was open before the extension was installed, reloaded or updated has no
  // live content script. Inject the scripts from the manifest once, then ask again.
  function sendToTab(tabId, message, callback) {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const messageError = chrome.runtime.lastError;
      if (!messageError) {
        callback(response);
        return;
      }
      if (injectedTabs.has(tabId) || !/receiving end does not exist/i.test(messageError.message || "")) {
        callback(null);
        return;
      }
      injectedTabs.add(tabId);
      injectContentScripts(tabId).then((injected) => {
        if (!injected) {
          callback(null);
          return;
        }
        chrome.tabs.sendMessage(tabId, message, (retryResponse) => {
          callback(chrome.runtime.lastError ? null : retryResponse);
        });
      });
    });
  }

  async function injectContentScripts(tabId) {
    if (!chrome.scripting) return false;
    try {
      for (const script of chrome.runtime.getManifest().content_scripts || []) {
        const target = { tabId };
        if (script.css?.length) await chrome.scripting.insertCSS({ target, files: script.css });
        if (script.js?.length) {
          await chrome.scripting.executeScript({
            target,
            files: script.js,
            world: script.world === "MAIN" ? "MAIN" : "ISOLATED"
          });
        }
      }
      return true;
    } catch {
      // Not a YouTube page, or the page is still loading.
      return false;
    }
  }

  function pollActiveTab() {
    if (polling) return;
    polling = true;
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const queryError = chrome.runtime.lastError;
      const tabId = !queryError ? tabs?.[0]?.id : null;
      if (activeTabId != null && tabId !== activeTabId) {
        chrome.tabs.sendMessage(activeTabId, { type: "lsc-stop-visualizer" }, () => void chrome.runtime.lastError);
      }
      activeTabId = tabId ?? null;
      if (activeTabId == null) {
        visualizer.setFrame({ playing: false, hasSignal: false, bands: [] });
        updateLabel(false, false);
        polling = false;
        return;
      }

      sendToTab(activeTabId, { type: "lsc-get-visualizer-frame" }, (frame) => {
        if (!frame) {
          visualizer.setFrame({ playing: false, hasSignal: false, bands: [] });
          updateLabel(false, false);
        } else {
          visualizer.setFrame(frame);
          updateLabel(Boolean(frame.playing), Boolean(frame.hasSignal));
        }
        polling = false;
      });
    });
  }

  function updateLabel(playing, hasSignal) {
    const label = hasSignal
      ? "Open the draggable music visualizer; it is reacting to YouTube audio."
      : playing
        ? "Open the draggable music visualizer; rhythmic animation is active."
        : "Open the draggable music visualizer on the current YouTube tab.";
    openButton.title = label;
    openButton.setAttribute("aria-label", label);
  }

  function openFloatingVisualizer() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const queryError = chrome.runtime.lastError;
      const tabId = !queryError ? tabs?.[0]?.id : null;
      if (tabId == null) {
        openButton.title = "Open a YouTube tab first, then click the visualizer.";
        return;
      }

      sendToTab(tabId, { type: "lsc-toggle-floating-visualizer" }, (result) => {
        if (!result?.ok) {
          openButton.title = "Open a YouTube video, then click the visualizer again.";
          return;
        }
        window.close();
      });
    });
  }
})();
