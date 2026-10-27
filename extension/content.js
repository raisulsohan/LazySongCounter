(() => {
  const Rules = globalThis.LazySongRules;
  let currentVideoId = "";
  let currentVideo = null;
  let session = null;
  let syncTimer = 0;
  let lastSyncAt = 0;
  let badgeTimer = 0;
  let badgeRequestId = 0;
  // The last count read for the current video; used to redraw the badge without asking again.
  let badgeState = null;
  let audioVideo = null;
  let audioCaptureStream = null;
  let audioContext = null;
  let audioSource = null;
  let audioAnalyser = null;
  let audioSilenceGain = null;
  let audioFrequencyData = null;
  let audioTrack = null;
  let audioCapturedSrc = "";
  let lastCaptureAttemptAt = 0;
  let lastResumeAttemptAt = 0;
  let silentSince = 0;
  let previousBassLevel = 0;
  let lastBeatAt = 0;
  let floatingVisualizer = null;
  const SYNC_THROTTLE_MS = 250;
  const FLOATING_VISUALIZER_ID = "lazy-song-counter-floating-visualizer";
  const metadataByVideoId = new Map();

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (message?.source !== "lazy-song-counter" || message.type !== "video-category") return;
    if (typeof message.videoId !== "string" || typeof message.category !== "string") return;
    const metadata = {
      category: message.category.slice(0, 80),
      title: typeof message.title === "string" ? message.title.slice(0, 200) : "",
      author: typeof message.author === "string" ? message.author.slice(0, 120) : "",
      description: typeof message.description === "string" ? message.description.slice(0, 8000) : "",
      keywords: Array.isArray(message.keywords)
        ? message.keywords.filter((keyword) => typeof keyword === "string").slice(0, 80)
        : []
    };
    metadata.signature = JSON.stringify(metadata);
    const previousMetadata = metadataByVideoId.get(message.videoId);
    metadataByVideoId.set(message.videoId, metadata);
    if (message.videoId === currentVideoId && previousMetadata?.signature !== metadata.signature) scheduleBadgeUpdate();
    if (metadataByVideoId.size > 100) {
      const oldestVideoId = metadataByVideoId.keys().next().value;
      metadataByVideoId.delete(oldestVideoId);
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "history-updated") scheduleBadgeUpdate();
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "lsc-get-visualizer-frame") {
      sendResponse(readVisualizerFrame());
      return false;
    }
    if (message?.type === "lsc-stop-visualizer") {
      if (!floatingVisualizer) releaseAudioCapture();
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === "lsc-toggle-floating-visualizer") {
      toggleFloatingVisualizer();
      sendResponse({ ok: true, visible: Boolean(floatingVisualizer) });
      return false;
    }
  });

  // Chrome keeps an AudioContext suspended until the page has had a user gesture, so any click or
  // key press on the page is a new chance to start it.
  const resumeAudioOnGesture = () => {
    if (audioContext?.state === "suspended") audioContext.resume().catch(() => {});
  };
  window.addEventListener("pointerdown", resumeAudioOnGesture, true);
  window.addEventListener("keydown", resumeAudioOnGesture, true);

  // A content script from before an extension reload can leave its widget on the page.
  document.getElementById(FLOATING_VISUALIZER_ID)?.remove();

  window.addEventListener("online", () => {
    try {
      chrome.runtime.sendMessage({ type: "sync-if-signed-in" }, () => void chrome.runtime.lastError);
    } catch (error) {
      if (!isInvalidatedContext(error)) console.warn("Could not resume cloud sync:", error);
    }
  });

  function getVideoId() {
    const url = new URL(location.href);
    const fromQuery = url.searchParams.get("v");
    if (fromQuery) return fromQuery;

    const match = url.pathname.match(/^\/(?:shorts|live)\/([^/?]+)/);
    return match?.[1] || "";
  }

  function getVideoElement() {
    return document.querySelector("video.html5-main-video") || document.querySelector("video");
  }

  function getTrackDetails(videoId) {
    // The player data for this exact video is the most reliable source. The page heading can still
    // show the previous video for a moment after a navigation.
    const metadata = metadataByVideoId.get(videoId);
    const videoTitle = Rules.cleanTitle(
      metadata?.title ||
      document.querySelector("ytd-watch-metadata h1 yt-formatted-string")?.textContent ||
      document.querySelector('meta[name="title"]')?.content ||
      document.title
    );
    // A full album or jukebox counts as one play under the album's name.
    const title = Rules.isAlbumTitle(videoTitle)
      ? Rules.albumTitleFor(videoTitle, metadata?.description)
      : videoTitle;
    const channel = (metadata?.author ||
      document.querySelector("ytd-watch-metadata ytd-channel-name a")?.textContent ||
      document.querySelector("ytmusic-player-bar .byline a")?.textContent || "")
      .replace(/\s+/g, " ")
      .trim();

    return { title, channel, videoId };
  }

  function isAdPlaying() {
    const player = document.querySelector("#movie_player");
    return Boolean(player?.classList.contains("ad-showing") || player?.classList.contains("ad-interrupting"));
  }

  function readVisualizerFrame() {
    const video = getVideoElement();
    if (!video) {
      releaseAudioCapture();
      return { playing: false, hasSignal: false, bands: [] };
    }
    if (video !== currentVideo) syncPlayer();

    const playing = !video.paused && !video.ended && !isAdPlaying();
    if (!playing) return { playing: false, hasSignal: false, bands: [] };

    ensureAudioCapture(video);
    if (!audioAnalyser || !audioFrequencyData || !audioSource || audioContext?.state === "closed") {
      return { playing: true, hasSignal: false, bands: [] };
    }
    const now = performance.now();
    if (audioContext.state === "suspended" && now - lastResumeAttemptAt > 1000) {
      lastResumeAttemptAt = now;
      audioContext.resume().catch(() => {});
    }
    if (audioContext.state !== "running") return { playing: true, hasSignal: false, bands: [] };

    audioAnalyser.getByteFrequencyData(audioFrequencyData);
    // Log-spaced bands from 50 Hz to 14 kHz: lower bass is felt more than seen, and streamed audio
    // has almost nothing above 14 kHz, so those bars would always be empty.
    const bandCount = 96;
    const bands = [];
    const binHz = audioContext.sampleRate / audioAnalyser.fftSize;
    const lastBin = audioFrequencyData.length - 1;
    for (let index = 0; index < bandCount; index += 1) {
      const lower = 50 * Math.pow(280, index / bandCount) / binHz;
      const upper = 50 * Math.pow(280, (index + 1) / bandCount) / binHz;
      let peak = 0;
      let average = 0;
      if (upper - lower < 1) {
        // Narrower than one FFT bin: read between the two nearest bins, so the bass bars form a
        // curve instead of steps.
        const center = Math.min(lastBin - 1, (lower + upper) / 2);
        const bin = Math.floor(center);
        const fraction = center - bin;
        average = (audioFrequencyData[bin] * (1 - fraction) + audioFrequencyData[bin + 1] * fraction) / 255;
        peak = average;
      } else {
        let total = 0;
        let samples = 0;
        for (let bin = Math.floor(lower); bin < Math.min(Math.ceil(upper), lastBin + 1); bin += 1) {
          const value = audioFrequencyData[bin] / 255;
          total += value;
          peak = Math.max(peak, value);
          samples += 1;
        }
        average = samples ? total / samples : 0;
      }
      // The power curve spreads the levels, so the bars rise and fall with the music instead of
      // sitting near the top. Higher bands carry less energy; a gentle lift keeps them alive.
      const lift = 1 + 0.6 * index / bandCount;
      bands.push(Math.min(1, Math.pow(average * 0.65 + peak * 0.35, 1.8) * lift));
    }

    const bassBandCount = Math.ceil(bandCount * 0.2);
    const bassLevel = bands.slice(0, bassBandCount).reduce((sum, value) => sum + value, 0) / bassBandCount;
    const energy = bands.reduce((sum, value) => sum + value, 0) / bandCount;
    const hasSignal = energy > 0.012;
    // When YouTube swaps the media source (a new video or an ad), the captured track can stay
    // "live" but go silent. A long silence while the video plays starts a fresh capture.
    if (hasSignal) silentSince = 0;
    else if (!silentSince) silentSince = now;
    else if (now - silentSince > 2000) {
      silentSince = 0;
      detachAudioSource();
    }
    const beat = hasSignal && bassLevel > 0.12 && bassLevel > previousBassLevel * 1.22 && now - lastBeatAt > 190;
    previousBassLevel = previousBassLevel * 0.62 + bassLevel * 0.38;
    if (beat) lastBeatAt = now;

    return { playing, hasSignal, bands, bassLevel, beat };
  }

  // The AudioContext lives as long as the visualizer is open; only the captured track is replaced
  // when it ends, the video loads a new source, or the track goes silent. A new context could start suspended, a reused one keeps running.
  function ensureAudioCapture(video) {
    if (audioVideo && audioVideo !== video) releaseAudioCapture();
    if (audioSource && audioTrack?.readyState === "live" && audioCapturedSrc === video.currentSrc) return;
    detachAudioSource();
    if (typeof video.captureStream !== "function") return;
    const now = performance.now();
    if (now - lastCaptureAttemptAt < 400) return;
    lastCaptureAttemptAt = now;

    try {
      const stream = video.captureStream();
      // YouTube adds a new track to the same stream for each media source; the last one is current.
      const track = stream.getAudioTracks().filter((candidate) => candidate.readyState === "live").pop();
      if (!track) {
        stream.getTracks().forEach((candidate) => candidate.stop());
        return;
      }

      if (!audioContext || audioContext.state === "closed") {
        const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextConstructor) {
          stream.getTracks().forEach((candidate) => candidate.stop());
          return;
        }
        audioContext = new AudioContextConstructor();
        audioAnalyser = audioContext.createAnalyser();
        audioAnalyser.fftSize = 4096;
        audioAnalyser.smoothingTimeConstant = 0.42;
        // YouTube audio is loud; the default -100..-30 dB window keeps most bins near the top.
        audioAnalyser.minDecibels = -80;
        audioAnalyser.maxDecibels = -25;
        audioSilenceGain = audioContext.createGain();
        audioSilenceGain.gain.value = 0;
        audioAnalyser.connect(audioSilenceGain);
        audioSilenceGain.connect(audioContext.destination);
        audioFrequencyData = new Uint8Array(audioAnalyser.frequencyBinCount);
      }
      audioVideo = video;
      audioCaptureStream = stream;
      audioTrack = track;
      audioCapturedSrc = video.currentSrc;
      audioSource =audioContext.createMediaStreamSource(new MediaStream([track]));
      audioSource.connect(audioAnalyser);
      silentSince = 0;
    } catch {
      releaseAudioCapture();
    }
  }

  function detachAudioSource() {
    try {
      audioSource?.disconnect();
    } catch {
      // The source may already have been detached.
    }
    audioCaptureStream?.getTracks().forEach((track) => track.stop());
    audioCaptureStream = null;
    audioSource = null;
    audioTrack = null;
    audioCapturedSrc = "";
  }

  function releaseAudioCapture() {
    detachAudioSource();
    try {
      audioAnalyser?.disconnect();
      audioSilenceGain?.disconnect();
    } catch {
      // These nodes may already have been detached.
    }
    if (audioContext && audioContext.state !== "closed") audioContext.close().catch(() => {});
    audioVideo = null;
    audioContext = null;
    audioAnalyser = null;
    audioSilenceGain = null;
    audioFrequencyData = null;
    lastCaptureAttemptAt = 0;
    silentSince = 0;
    previousBassLevel = 0;
    lastBeatAt = 0;
  }

  function closeFloatingVisualizer() {
    if (!floatingVisualizer) return;
    floatingVisualizer.cleanup();
    floatingVisualizer.host.remove();
    floatingVisualizer = null;
    releaseAudioCapture();
  }

  function toggleFloatingVisualizer() {
    if (floatingVisualizer) {
      closeFloatingVisualizer();
      return;
    }

    if (typeof window.LazySongVisualizer !== "function") return;
    document.getElementById(FLOATING_VISUALIZER_ID)?.remove();
    const host = document.createElement("div");
    host.id = FLOATING_VISUALIZER_ID;
    host.setAttribute("aria-label", "Draggable music visualizer");
    Object.assign(host.style, {
      all: "initial",
      display: "block",
      position: "fixed",
      right: "24px",
      bottom: "24px",
      width: "min(440px, calc(100vw - 32px))",
      height: "64px",
      zIndex: "2147483647",
      touchAction: "none",
      userSelect: "none"
    });

    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
      .card {
        position: relative;
        box-sizing: border-box;
        width: 100%;
        height: 100%;
        overflow: hidden;
        border: 1px solid rgba(255, 255, 255, .14);
        border-radius: 20px;
        background:
          linear-gradient(180deg, rgba(255, 255, 255, .09), rgba(255, 255, 255, 0) 46%),
          linear-gradient(115deg, rgba(40, 22, 84, .82), rgba(18, 12, 34, .8) 52%, rgba(8, 30, 48, .8));
        box-shadow:
          0 16px 36px rgba(0, 0, 0, .42),
          0 2px 6px rgba(0, 0, 0, .28),
          inset 0 1px 0 rgba(255, 255, 255, .14);
        backdrop-filter: blur(18px) saturate(170%);
        -webkit-backdrop-filter: blur(18px) saturate(170%);
        cursor: grab;
        touch-action: none;
        user-select: none;
        transition: transform .2s cubic-bezier(.2, .8, .2, 1), box-shadow .2s ease, border-color .2s ease;
      }
      .card:hover { border-color: rgba(214, 186, 255, .3); }
      .card.dragging {
        cursor: grabbing;
        transform: scale(1.035);
        border-color: rgba(214, 186, 255, .42);
        box-shadow:
          0 24px 52px rgba(0, 0, 0, .5),
          0 0 30px rgba(150, 96, 255, .32),
          inset 0 1px 0 rgba(255, 255, 255, .18);
      }
      canvas {
        position: absolute;
        top: 8px;
        left: 18px;
        display: block;
        width: calc(100% - 36px);
        height: calc(100% - 14px);
        pointer-events: none;
      }
      .grip {
        position: absolute;
        top: 50%;
        left: 6px;
        width: 6px;
        height: 16px;
        margin-top: -8px;
        background: radial-gradient(circle, rgba(255, 255, 255, .7) 1px, transparent 1.4px) 0 0 / 3px 4px;
        opacity: 0;
        transition: opacity .2s ease;
        pointer-events: none;
      }
      .close {
        position: absolute;
        top: 7px;
        right: 7px;
        display: grid;
        place-items: center;
        width: 22px;
        height: 22px;
        padding: 0;
        border: 1px solid rgba(255, 255, 255, .16);
        border-radius: 50%;
        background: rgba(12, 8, 24, .62);
        color: rgba(255, 255, 255, .88);
        cursor: pointer;
        opacity: 0;
        transform: scale(.85);
        transition: opacity .18s ease, transform .18s ease, background .18s ease;
      }
      .close svg { width: 10px; height: 10px; }
      .card:hover .grip,
      .card.dragging .grip { opacity: .7; }
      .card:hover .close,
      .close:focus-visible { opacity: 1; transform: scale(1); }
      .card.dragging .close { opacity: 0; }
      .close:hover { background: rgba(255, 255, 255, .2); }
      .close:focus-visible { outline: 2px solid #c9a8ff; outline-offset: 1px; }
    `;
    const card = document.createElement("div");
    card.className = "card";
    const canvas = document.createElement("canvas");
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", "Music beat visualizer. Drag to move.");
    const grip = document.createElement("span");
    grip.className = "grip";
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "close";
    closeButton.title = "Close the visualizer";
    closeButton.setAttribute("aria-label", "Close the visualizer");
    // Built node by node: YouTube enforces Trusted Types, which can reject innerHTML.
    const closeIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    closeIcon.setAttribute("viewBox", "0 0 10 10");
    closeIcon.setAttribute("aria-hidden", "true");
    const closePath = document.createElementNS("http://www.w3.org/2000/svg", "path");
    closePath.setAttribute("d", "M1.5 1.5l7 7M8.5 1.5l-7 7");
    closePath.setAttribute("stroke", "currentColor");
    closePath.setAttribute("stroke-width", "1.6");
    closePath.setAttribute("stroke-linecap", "round");
    closeIcon.append(closePath);
    closeButton.append(closeIcon);
    card.append(canvas, grip, closeButton);
    shadow.append(style, card);
    document.documentElement.append(host);

    const visualizer = new window.LazySongVisualizer(canvas, {
      variant: "floating",
      source: () => {
        // After an extension reload this script can no longer reach the extension; remove the widget.
        if (!chrome.runtime?.id) {
          window.setTimeout(closeFloatingVisualizer);
          return null;
        }
        return readVisualizerFrame();
      }
    });
    const EDGE_GAP = 8;
    let dragOffsetX = 0;
    let dragOffsetY = 0;
    let dragging = false;

    const clampPosition = (left, top) => ({
      left: Math.max(EDGE_GAP, Math.min(window.innerWidth - host.offsetWidth - EDGE_GAP, left)),
      top: Math.max(EDGE_GAP, Math.min(window.innerHeight - host.offsetHeight - EDGE_GAP, top))
    });

    const placeAt = (left, top) => {
      host.style.right = "auto";
      host.style.bottom = "auto";
      host.style.left = `${left}px`;
      host.style.top = `${top}px`;
    };

    // Extension storage is closed to content scripts, so the service worker keeps the position.
    const savePosition = () => {
      const left = parseFloat(host.style.left) || 0;
      const top = parseFloat(host.style.top) || 0;
      sendQuietly({
        type: "set-visualizer-position",
        position: {
          x: window.innerWidth ? left / window.innerWidth : 0.5,
          y: window.innerHeight ? top / window.innerHeight : 0.05
        }
      });
    };

    const restorePosition = () => {
      sendQuietly({ type: "get-visualizer-position" }, (result) => {
        if (floatingVisualizer?.host !== host) return;
        const position = result?.position;
        if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return;
        const { left, top } = clampPosition(position.x * window.innerWidth, position.y * window.innerHeight);
        placeAt(left, top);
      });
    };

    const onPointerDown = (event) => {
      if (event.button !== 0 || event.composedPath().includes(closeButton)) return;
      const rect = host.getBoundingClientRect();
      dragOffsetX = event.clientX - rect.left;
      dragOffsetY = event.clientY - rect.top;
      placeAt(rect.left, rect.top);
      card.classList.add("dragging");
      dragging = true;
      host.setPointerCapture(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
    };

    const onPointerMove = (event) => {
      if (!dragging) return;
      const { left, top } = clampPosition(event.clientX - dragOffsetX, event.clientY - dragOffsetY);
      placeAt(left, top);
      event.stopPropagation();
    };

    const onPointerUp = (event) => {
      if (!dragging) return;
      dragging = false;
      card.classList.remove("dragging");
      if (host.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId);
      savePosition();
      event.stopPropagation();
    };

    const onResize = () => {
      if (host.style.left === "") return;
      const rect = host.getBoundingClientRect();
      const { left, top } = clampPosition(rect.left, rect.top);
      placeAt(left, top);
    };

    const onClose = (event) => {
      event.stopPropagation();
      closeFloatingVisualizer();
    };

    host.addEventListener("pointerdown", onPointerDown);
    host.addEventListener("pointermove", onPointerMove);
    host.addEventListener("pointerup", onPointerUp);
    host.addEventListener("pointercancel", onPointerUp);
    closeButton.addEventListener("click", onClose);
    window.addEventListener("resize", onResize);

    floatingVisualizer = {
      host,
      cleanup() {
        window.removeEventListener("resize", onResize);
        host.removeEventListener("pointerdown", onPointerDown);
        host.removeEventListener("pointermove", onPointerMove);
        host.removeEventListener("pointerup", onPointerUp);
        host.removeEventListener("pointercancel", onPointerUp);
        closeButton.removeEventListener("click", onClose);
        visualizer.destroy();
      }
    };
    restorePosition();
  }

  function removePlayCountBadge() {
    document.querySelectorAll("[data-lsc-play-count-badge]").forEach((badge) => badge.remove());
  }

  function getLikeActionsContainer() {
    return document.querySelector("ytd-watch-metadata #actions #top-level-buttons-computed") ||
      document.querySelector("ytd-watch-metadata #top-level-buttons-computed") ||
      document.querySelector("#top-level-buttons-computed");
  }

  function renderPlayCountBadge(count, title) {
    const container = getLikeActionsContainer();
    if (!container) return;

    let badge = document.getElementById("lsc-play-count-badge");
    if (badge && badge.parentElement !== container) {
      badge.remove();
      badge = null;
    }
    if (!badge) {
      badge = document.createElement("div");
      badge.id = "lsc-play-count-badge";
      badge.dataset.lscPlayCountBadge = "";
      badge.setAttribute("role", "status");
    }

    const countText = `${new Intl.NumberFormat("en-US").format(count)} played`;
    const accessibleLabel = `${count} plays for ${title}`;
    if (badge.dataset.playCount !== String(count) || badge.dataset.trackTitle !== title) {
      const icon = document.createElement("span");
      icon.className = "lsc-play-count-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = "♫";
      const label = document.createElement("span");
      label.textContent = countText;
      badge.replaceChildren(icon, label);
      badge.dataset.playCount = String(count);
      badge.dataset.trackTitle = title;
      badge.title = `Your local play count for ${title}`;
      badge.setAttribute("aria-label", accessibleLabel);
    }

    const likeButton = container.querySelector(
      "ytd-segmented-like-dislike-button-renderer, segmented-like-dislike-button-view-model, #segmented-like-button"
    );
    if (badge.parentElement !== container) {
      if (likeButton?.parentElement === container) container.insertBefore(badge, likeButton);
      else container.prepend(badge);
    } else if (likeButton?.parentElement === container && badge.nextElementSibling !== likeButton) {
      container.insertBefore(badge, likeButton);
    }
  }

  function scheduleBadgeUpdate() {
    window.clearTimeout(badgeTimer);
    badgeTimer = window.setTimeout(updatePlayCountBadge, 150);
  }

  function badgeTrackDetails(videoId) {
    if (!videoId || videoId !== currentVideoId) return null;
    if (Rules.classifyMusicVideo(metadataByVideoId.get(videoId)) !== "music") return null;
    const details = getTrackDetails(videoId);
    if (!details.title || Rules.isClearlyNonSongTitle(details.title)) return null;
    return details;
  }

  function showBadge(videoId, count, title) {
    badgeState = { videoId, count, title };
    renderPlayCountBadge(count, title);
  }

  // Puts the known count back when YouTube re-renders its action bar. Sends no message.
  function restoreBadge() {
    if (!badgeState || badgeState.videoId !== currentVideoId) return;
    const container = getLikeActionsContainer();
    const badge = document.getElementById("lsc-play-count-badge");
    if (container && badge?.parentElement !== container) renderPlayCountBadge(badgeState.count, badgeState.title);
  }

  async function updatePlayCountBadge() {
    const requestId = ++badgeRequestId;
    const videoId = getVideoId();
    const details = badgeTrackDetails(videoId);
    if (!details) {
      badgeState = null;
      removePlayCountBadge();
      return;
    }

    try {
      const result = await chrome.runtime.sendMessage({
        type: "get-play-count",
        title: details.title,
        channel: details.channel
      });
      if (requestId !== badgeRequestId || videoId !== currentVideoId) return;
      if (result?.ok) showBadge(videoId, Number(result.count) || 0, details.title);
    } catch (error) {
      if (!isInvalidatedContext(error)) console.warn("Could not read the local play count:", error);
    }
  }

  function isInvalidatedContext(error) {
    return /extension context invalidated/i.test(String(error?.message || error || ""));
  }

  function sendQuietly(message, callback = () => {}) {
    try {
      chrome.runtime.sendMessage(message, (result) => {
        if (chrome.runtime.lastError) return;
        callback(result);
      });
    } catch (error) {
      if (!isInvalidatedContext(error)) console.warn(`Could not send ${message.type}:`, error);
    }
  }

  function sendListen(details) {
    try {
      chrome.runtime.sendMessage({ type: "record-listen", ...details }, (result) => {
        try {
          const error = chrome.runtime.lastError;
          if (error && !isInvalidatedContext(error)) console.warn("Could not record listen:", error.message);
          if (!error && result?.ok && details.videoId === currentVideoId) {
            showBadge(details.videoId, Number(result.count) || 0, details.title);
          }
        } catch (error) {
          if (!isInvalidatedContext(error)) console.warn("Could not record listen:", error);
        }
      });
    } catch (error) {
      if (!isInvalidatedContext(error)) console.warn("Could not record listen:", error);
    }
  }

  function createSession(lastTime = 0) {
    return {
      playedSeconds: 0,
      counted: false,
      notMusic: false,
      lastTime,
      lastWallTime: performance.now()
    };
  }

  function startNextLoop(currentTime) {
    session = createSession(currentTime);
  }

  function onTimeUpdate() {
    if (!currentVideo || !session) return;

    const now = currentVideo.currentTime;
    if (Rules.isPlaybackWrap(session.lastTime, now, currentVideo.duration)) {
      startNextLoop(now);
      return;
    }

    const observedAt = performance.now();
    const elapsedWallSeconds = Math.max(0, (observedAt - session.lastWallTime) / 1000);
    const delta = now - session.lastTime;
    session.lastTime = now;
    session.lastWallTime = observedAt;

    const playbackRate = Math.max(0.25, Number(currentVideo.playbackRate) || 1);
    const maximumExpectedDelta = Math.max(3, elapsedWallSeconds * playbackRate + 1);
    if (currentVideo.paused || currentVideo.seeking || isAdPlaying() || delta <= 0 || delta > maximumExpectedDelta || session.counted || session.notMusic) return;

    session.playedSeconds += delta;
    if (session.playedSeconds < Rules.playThreshold(currentVideo.duration)) return;

    const metadata = metadataByVideoId.get(currentVideoId);
    const classification = Rules.classifyMusicVideo(metadata);
    if (classification === "unknown") return;
    if (classification !== "music") {
      session.notMusic = true;
      return;
    }

    const details = getTrackDetails(currentVideoId);
    if (!details.title) return;
    if (Rules.isClearlyNonSongTitle(details.title)) {
      session.notMusic = true;
      return;
    }

    session.counted = true;
    sendListen(details);
  }

  function onSeeking() {
    if (!currentVideo || !session) return;
    const now = currentVideo.currentTime;
    if (Rules.isPlaybackWrap(session.lastTime, now, currentVideo.duration)) {
      startNextLoop(now);
      return;
    }
    session.lastTime = now;
    session.lastWallTime = performance.now();
  }

  function onEnded() {
    if (!session) return;
    session = createSession(currentVideo?.currentTime || 0);
  }

  function detachVideo() {
    if (!currentVideo) return;
    currentVideo.removeEventListener("timeupdate", onTimeUpdate);
    currentVideo.removeEventListener("seeking", onSeeking);
    currentVideo.removeEventListener("ended", onEnded);
    currentVideo = null;
  }

  function syncPlayer() {
    const videoId = getVideoId();
    const video = getVideoElement();
    if (!videoId || !video) return;

    const sameTrack = videoId === currentVideoId;
    if (!sameTrack) {
      currentVideoId = videoId;
      session = createSession(video.currentTime || 0);
    }

    if (video === currentVideo) return;
    if (sameTrack && currentVideo && session && Rules.isPlaybackWrap(currentVideo.currentTime, video.currentTime, video.duration)) {
      startNextLoop(video.currentTime || 0);
    }
    detachVideo();
    currentVideo = video;
    if (!session) session = createSession(video.currentTime || 0);
    session.lastTime = video.currentTime || 0;
    session.lastWallTime = performance.now();
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("seeking", onSeeking);
    video.addEventListener("ended", onEnded);
  }

  // YouTube changes its DOM all the time. Syncing at most every SYNC_THROTTLE_MS keeps this cheap,
  // and only a new video asks the service worker for a count.
  function scheduleSync() {
    if (syncTimer) return;
    const wait = Math.max(0, lastSyncAt + SYNC_THROTTLE_MS - performance.now());
    syncTimer = window.setTimeout(runSync, wait);
  }

  function runSync() {
    syncTimer = 0;
    lastSyncAt = performance.now();
    const previousVideoId = currentVideoId;
    syncPlayer();
    if (currentVideoId !== previousVideoId) scheduleBadgeUpdate();
    else if (getVideoId() === currentVideoId) restoreBadge();
    else if (badgeState) {
      badgeState = null;
      removePlayCountBadge();
    }
  }

  function onNavigate() {
    scheduleSync();
    scheduleBadgeUpdate();
  }

  document.addEventListener("yt-navigate-finish", onNavigate);
  document.addEventListener("yt-page-data-updated", onNavigate);
  window.addEventListener("popstate", onNavigate);
  new MutationObserver(scheduleSync).observe(document.documentElement, {
    childList: true,
    subtree: true
  });
  syncPlayer();
  scheduleBadgeUpdate();
})();
