(() => {
  let currentVideoId = "";
  let currentVideo = null;
  let session = null;
  let syncTimer = 0;
  let badgeTimer = 0;
  let badgeRequestId = 0;
  let audioVideo = null;
  let audioCaptureStream = null;
  let audioContext = null;
  let audioSource = null;
  let audioAnalyser = null;
  let audioSilenceGain = null;
  let audioFrequencyData = null;
  let audioResumeRequested = false;
  let previousBassLevel = 0;
  let lastBeatAt = 0;
  let floatingVisualizer = null;
  const VISUALIZER_POSITION_KEY = "lazySongCounterVisualizerPosition";
  const metadataByVideoId = new Map();

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (message?.source !== "lazy-song-counter" || message.type !== "video-category") return;
    if (typeof message.videoId !== "string" || typeof message.category !== "string") return;
    const metadata = {
      category: message.category.slice(0, 80),
      title: typeof message.title === "string" ? message.title.slice(0, 200) : "",
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

  function cleanTitle(value) {
    return String(value || "")
      .replace(/\s*[-|]\s*YouTube(?: Music)?\s*$/i, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function getTrackDetails(videoId) {
    const title = cleanTitle(
      document.querySelector("ytd-watch-metadata h1 yt-formatted-string")?.textContent ||
      document.querySelector('meta[name="title"]')?.content ||
      document.title
    );
    const channel = (document.querySelector("ytd-watch-metadata ytd-channel-name a")?.textContent ||
      document.querySelector(".ytmusic-player-bar yt-formatted-string")?.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
    const normalizedTitle = title
      .normalize("NFKC")
      .toLocaleLowerCase()
      .replace(/[\[\](){}.,!?\-_:;"'’]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    return {
      title,
      channel,
      videoId,
      trackKey: normalizedTitle || videoId
    };
  }

  function isClearlyNonSongTitle(title) {
    return /\b(?:podcast|reaction|reacts?|review|tutorial|lesson|interview|commentary|analysis|breakdown|documentary|vlog|trailer|teaser|movie scene|deleted scene|full album|playlist|compilation|mixtape|behind the scenes|making of|how to)\b|রিভিউ|রিঅ্যাকশন|টিউটোরিয়াল|সাক্ষাৎকার|পডকাস্ট|বিশ্লেষণ|ডকুমেন্টারি|ভ্লগ/i.test(title);
  }

  function classifyMusicVideo(metadata) {
    if (!metadata?.category) return "unknown";
    const category = metadata.category.trim().toLocaleLowerCase();
    if (category === "music") return "music";
    if (category !== "entertainment" && category !== "people & blogs") return "not-music";

    const title = metadata.title || "";
    const description = metadata.description || "";
    const keywords = Array.isArray(metadata.keywords) ? metadata.keywords : [];
    if (!title || (!description && keywords.length === 0)) return "unknown";
    if (isClearlyNonSongTitle(title)) return "not-music";

    const trackTitleSignal = /\b(?:song|songs|theme|bgm|ost|soundtrack|music video|video song|lyrical video)\b/i.test(title);
    const musicKeywordSignal = keywords.some((keyword) =>
      /\b(?:song|songs|music video|video song|soundtrack|bgm|lyrical video)\b/i.test(keyword)
    );
    const musicMixSignal = /\b(?:lo[\s-]?fi|mashup|slowed\s*(?:&|and)\s*reverb)\b/i.test(title) &&
      /\b(?:songs?|music|melodies|beats?|lo[\s-]?fi|mashup)\b/i.test(description);
    const strongCreditSignal = /\b(?:music credits?|song title|song name|singer|vocals?|lyricist)\s*[-–—:]\s*\S|\b(?:composed|sung)\s+by\b|\b(?:lyrics?|music)\s*(?:by|[-–—:])\s*\S/i.test(description);
    const officialListenLinkSignal = /\blisten to\b[\s\S]{0,240}\b(?:music service|spotify|apple music|amazon music|youtube music)\b/i.test(description);

    return (strongCreditSignal || officialListenLinkSignal || musicMixSignal) &&
      (trackTitleSignal || musicKeywordSignal || musicMixSignal)
      ? "music"
      : "not-music";
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
    if (!audioAnalyser || !audioFrequencyData || audioContext?.state === "closed") {
      return { playing: true, hasSignal: false, bands: [] };
    }
    if (audioContext.state === "suspended" && !audioResumeRequested) {
      audioResumeRequested = true;
      audioContext.resume().catch(() => {});
    }
    if (audioContext.state !== "running") return { playing: true, hasSignal: false, bands: [] };

    audioAnalyser.getByteFrequencyData(audioFrequencyData);
    const bandCount = 96;
    const bands = [];
    for (let index = 0; index < bandCount; index += 1) {
      const lower = Math.max(1, Math.floor(2 * Math.pow(audioFrequencyData.length / 2, index / bandCount)));
      const upper = Math.max(lower + 1, Math.floor(2 * Math.pow(audioFrequencyData.length / 2, (index + 1) / bandCount)));
      let peak = 0;
      let total = 0;
      let samples = 0;
      for (let bin = lower; bin < Math.min(upper, audioFrequencyData.length); bin += 1) {
        const value = audioFrequencyData[bin] / 255;
        total += value;
        peak = Math.max(peak, value);
        samples += 1;
      }
      const average = samples ? total / samples : 0;
      bands.push(Math.min(1, Math.max(0, average * 1.5 + peak * 0.55)));
    }

    const bassBandCount = Math.ceil(bandCount * 0.2);
    const bassLevel = bands.slice(0, bassBandCount).reduce((sum, value) => sum + value, 0) / bassBandCount;
    const energy = bands.reduce((sum, value) => sum + value, 0) / bandCount;
    const hasSignal = energy > 0.012;
    const now = performance.now();
    const beat = hasSignal && bassLevel > 0.12 && bassLevel > previousBassLevel * 1.22 && now - lastBeatAt > 190;
    previousBassLevel = previousBassLevel * 0.62 + bassLevel * 0.38;
    if (beat) lastBeatAt = now;

    return { playing, hasSignal, bands, bassLevel, beat };
  }

  function ensureAudioCapture(video) {
    if (audioVideo === video && audioAnalyser) return;
    releaseAudioCapture();
    if (typeof video.captureStream !== "function") return;

    try {
      const stream = video.captureStream();
      if (!stream.getAudioTracks().length) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextConstructor) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      audioVideo = video;
      audioCaptureStream = stream;
      audioContext = new AudioContextConstructor();
      audioAnalyser = audioContext.createAnalyser();
      audioAnalyser.fftSize = 2048;
      audioAnalyser.smoothingTimeConstant = 0.42;
      audioSource = audioContext.createMediaStreamSource(stream);
      audioSource.connect(audioAnalyser);
      audioSilenceGain = audioContext.createGain();
      audioSilenceGain.gain.value = 0;
      audioAnalyser.connect(audioSilenceGain);
      audioSilenceGain.connect(audioContext.destination);
      audioFrequencyData = new Uint8Array(audioAnalyser.frequencyBinCount);
      audioResumeRequested = false;
    } catch {
      releaseAudioCapture();
    }
  }

  function releaseAudioCapture() {
    try {
      audioSource?.disconnect();
    } catch {
      // The source may already have been detached.
    }
    try {
      audioAnalyser?.disconnect();
      audioSilenceGain?.disconnect();
    } catch {
      // These nodes may already have been detached.
    }
    audioCaptureStream?.getTracks().forEach((track) => track.stop());
    if (audioContext && audioContext.state !== "closed") audioContext.close().catch(() => {});
    audioVideo = null;
    audioCaptureStream = null;
    audioContext = null;
    audioSource = null;
    audioAnalyser = null;
    audioSilenceGain = null;
    audioFrequencyData = null;
    audioResumeRequested = false;
    previousBassLevel = 0;
    lastBeatAt = 0;
  }

  function toggleFloatingVisualizer() {
    if (floatingVisualizer) {
      floatingVisualizer.cleanup();
      floatingVisualizer.host.remove();
      floatingVisualizer = null;
      releaseAudioCapture();
      return;
    }

    if (typeof window.LazySongVisualizer !== "function") return;
    const host = document.createElement("div");
    host.id = "lazy-song-counter-floating-visualizer";
    host.setAttribute("aria-label", "Draggable music visualizer");
    Object.assign(host.style, {
      all: "initial",
      display: "block",
      position: "fixed",
      top: "16px",
      left: "50%",
      transform: "translateX(-50%)",
      width: "min(960px, 86vw)",
      height: "18px",
      zIndex: "2147483647",
      cursor: "grab",
      touchAction: "none",
      userSelect: "none"
    });

    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
      .bar {
        box-sizing: border-box;
        width: 100%;
        height: 100%;
        overflow: hidden;
        border: 1px solid rgba(205, 176, 255, .45);
        border-radius: 999px;
        background: linear-gradient(90deg, rgba(117, 82, 223, .24), rgba(176, 107, 255, .22) 48%, rgba(80, 200, 255, .22));
        box-shadow: 0 3px 14px rgba(0, 0, 0, .3), 0 0 16px rgba(137, 93, 245, .2);
        backdrop-filter: blur(10px);
        cursor: grab;
        touch-action: none;
        user-select: none;
      }
      canvas { display: block; width: 100%; height: 100%; }
    `;
    const bar = document.createElement("div");
    bar.className = "bar";
    const canvas = document.createElement("canvas");
    canvas.width = 960;
    canvas.height = 18;
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", "Music beat visualizer. Drag to move.");
    bar.append(canvas);
    shadow.append(style, bar);
    document.documentElement.append(host);

    const visualizer = new window.LazySongVisualizer(canvas);
    let dragOffsetX = 0;
    let dragOffsetY = 0;
    let dragging = false;

    const clampPosition = (left, top) => ({
      left: Math.max(0, Math.min(window.innerWidth - host.offsetWidth, left)),
      top: Math.max(0, Math.min(window.innerHeight - host.offsetHeight, top))
    });

    const savePosition = () => {
      const left = parseFloat(host.style.left) || 0;
      const top = parseFloat(host.style.top) || 0;
      chrome.storage.local.set({
        [VISUALIZER_POSITION_KEY]: {
          x: window.innerWidth ? left / window.innerWidth : 0.5,
          y: window.innerHeight ? top / window.innerHeight : 0.05
        }
      });
    };

    const restorePosition = () => {
      chrome.storage.local.get(VISUALIZER_POSITION_KEY, (result) => {
        if (floatingVisualizer?.host !== host) return;
        const position = result[VISUALIZER_POSITION_KEY];
        if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return;
        const { left, top } = clampPosition(position.x * window.innerWidth, position.y * window.innerHeight);
        host.style.transform = "none";
        host.style.left = `${left}px`;
        host.style.top = `${top}px`;
      });
    };

    const onPointerDown = (event) => {
      if (event.button !== 0) return;
      const rect = host.getBoundingClientRect();
      dragOffsetX = event.clientX - rect.left;
      dragOffsetY = event.clientY - rect.top;
      host.style.transform = "none";
      host.style.left = `${rect.left}px`;
      host.style.top = `${rect.top}px`;
      bar.style.cursor = "grabbing";
      dragging = true;
      host.setPointerCapture(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
    };

    const onPointerMove = (event) => {
      if (!dragging) return;
      const { left, top } = clampPosition(event.clientX - dragOffsetX, event.clientY - dragOffsetY);
      host.style.left = `${left}px`;
      host.style.top = `${top}px`;
      event.stopPropagation();
    };

    const onPointerUp = (event) => {
      if (!dragging) return;
      dragging = false;
      bar.style.cursor = "grab";
      if (host.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId);
      savePosition();
      event.stopPropagation();
    };

    const onResize = () => {
      const rect = host.getBoundingClientRect();
      const { left, top } = clampPosition(rect.left, rect.top);
      host.style.transform = "none";
      host.style.left = `${left}px`;
      host.style.top = `${top}px`;
      savePosition();
    };

    host.addEventListener("pointerdown", onPointerDown);
    host.addEventListener("pointermove", onPointerMove);
    host.addEventListener("pointerup", onPointerUp);
    host.addEventListener("pointercancel", onPointerUp);
    window.addEventListener("resize", onResize);

    const pollTimer = window.setInterval(() => {
      visualizer.setFrame(readVisualizerFrame());
    }, 55);

    floatingVisualizer = {
      host,
      cleanup() {
        window.clearInterval(pollTimer);
        window.removeEventListener("resize", onResize);
        host.removeEventListener("pointerdown", onPointerDown);
        host.removeEventListener("pointermove", onPointerMove);
        host.removeEventListener("pointerup", onPointerUp);
        host.removeEventListener("pointercancel", onPointerUp);
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

  async function updatePlayCountBadge() {
    const requestId = ++badgeRequestId;
    const videoId = getVideoId();
    if (!videoId || videoId !== currentVideoId) {
      removePlayCountBadge();
      return;
    }

    const metadata = metadataByVideoId.get(videoId);
    if (classifyMusicVideo(metadata) !== "music") {
      removePlayCountBadge();
      return;
    }

    const details = getTrackDetails(videoId);
    if (!details.title || isClearlyNonSongTitle(details.title)) {
      removePlayCountBadge();
      return;
    }

    try {
      const result = await chrome.runtime.sendMessage({ type: "get-play-count", trackKey: details.trackKey });
      if (requestId !== badgeRequestId || videoId !== currentVideoId) return;
      if (result?.ok) renderPlayCountBadge(Number(result.count) || 0, details.title);
    } catch (error) {
      if (!isInvalidatedContext(error)) console.warn("Could not read the local play count:", error);
    }
  }

  function isInvalidatedContext(error) {
    return /extension context invalidated/i.test(String(error?.message || error || ""));
  }

  function sendListen(details) {
    try {
      chrome.runtime.sendMessage({ type: "record-listen", ...details }, (result) => {
        try {
          const error = chrome.runtime.lastError;
          if (error && !isInvalidatedContext(error)) console.warn("Could not record listen:", error.message);
          if (!error && result?.ok) scheduleBadgeUpdate();
        } catch (error) {
          if (!isInvalidatedContext(error)) console.warn("Could not record listen:", error);
        }
      });
    } catch (error) {
      if (!isInvalidatedContext(error)) console.warn("Could not record listen:", error);
    }
  }

  function thresholdFor(video) {
    const duration = Number(video.duration);
    if (!Number.isFinite(duration) || duration <= 0) return 30;
    return Math.max(2, Math.min(30, duration * 0.5));
  }

  function isPlaybackWrap(previousTime, currentTime, video) {
    const duration = Number(video.duration);
    if (!Number.isFinite(duration) || duration <= 0 || currentTime >= previousTime) return false;

    const edgeWindow = Math.min(8, Math.max(2, duration * 0.02));
    return previousTime >= duration - edgeWindow && currentTime <= edgeWindow;
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
    if (isPlaybackWrap(session.lastTime, now, currentVideo)) {
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
    if (session.playedSeconds < thresholdFor(currentVideo)) return;

    const metadata = metadataByVideoId.get(currentVideoId);
    const classification = classifyMusicVideo(metadata);
    if (classification === "unknown") return;
    if (classification !== "music") {
      session.notMusic = true;
      return;
    }

    const details = getTrackDetails(currentVideoId);
    if (!details.title) return;
    if (isClearlyNonSongTitle(details.title)) {
      session.notMusic = true;
      return;
    }

    session.counted = true;
    sendListen(details);
  }

  function onSeeking() {
    if (!currentVideo || !session) return;
    const now = currentVideo.currentTime;
    if (isPlaybackWrap(session.lastTime, now, currentVideo)) {
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
    if (sameTrack && currentVideo && session && isPlaybackWrap(currentVideo.currentTime, video.currentTime, video)) {
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

  function scheduleSync() {
    window.clearTimeout(syncTimer);
    syncTimer = window.setTimeout(() => {
      syncPlayer();
      scheduleBadgeUpdate();
    }, 120);
  }

  document.addEventListener("yt-navigate-finish", scheduleSync);
  document.addEventListener("yt-page-data-updated", scheduleSync);
  window.addEventListener("popstate", scheduleSync);
  new MutationObserver(scheduleSync).observe(document.documentElement, {
    childList: true,
    subtree: true
  });
  syncPlayer();
  scheduleBadgeUpdate();
})();
