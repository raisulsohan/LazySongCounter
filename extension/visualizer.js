(() => {
  const canvas = document.querySelector("#music-visualizer");
  const openButton = document.querySelector("#visualizer-open");
  if (!canvas || !openButton || typeof window.LazySongVisualizer !== "function") return;

  const visualizer = new window.LazySongVisualizer(canvas);
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

      chrome.tabs.sendMessage(activeTabId, { type: "lsc-get-visualizer-frame" }, (frame) => {
        const messageError = chrome.runtime.lastError;
        if (messageError || !frame) {
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

      chrome.tabs.sendMessage(tabId, { type: "lsc-toggle-floating-visualizer" }, (result) => {
        const messageError = chrome.runtime.lastError;
        if (messageError || !result?.ok) {
          openButton.title = "Reload the extension and refresh the YouTube tab, then try again.";
          return;
        }
        window.close();
      });
    });
  }
})();
