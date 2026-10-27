(() => {
  let currentVideoId = "";
  let currentVideo = null;
  let session = null;
  let syncTimer = 0;
  const categoriesByVideoId = new Map();

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (message?.source !== "lazy-song-counter" || message.type !== "video-category") return;
    if (typeof message.videoId !== "string" || typeof message.category !== "string") return;
    categoriesByVideoId.set(message.videoId, message.category);
    if (categoriesByVideoId.size > 100) {
      const oldestVideoId = categoriesByVideoId.keys().next().value;
      categoriesByVideoId.delete(oldestVideoId);
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
    return /\b(?:podcast|reaction|reacts?|review|tutorial|lesson|interview|commentary|analysis|breakdown|documentary|vlog|full album|playlist|compilation|mixtape|behind the scenes|making of|how to)\b|রিভিউ|রিঅ্যাকশন|টিউটোরিয়াল|সাক্ষাৎকার|পডকাস্ট|বিশ্লেষণ|ডকুমেন্টারি|ভ্লগ/i.test(title);
  }

  function isAdPlaying() {
    const player = document.querySelector("#movie_player");
    return Boolean(player?.classList.contains("ad-showing") || player?.classList.contains("ad-interrupting"));
  }

  function isInvalidatedContext(error) {
    return /extension context invalidated/i.test(String(error?.message || error || ""));
  }

  function sendListen(details) {
    try {
      chrome.runtime.sendMessage({ type: "record-listen", ...details }, () => {
        try {
          const error = chrome.runtime.lastError;
          if (error && !isInvalidatedContext(error)) console.warn("Could not record listen:", error.message);
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

    const category = categoriesByVideoId.get(currentVideoId);
    if (!category) return;
    if (category.trim().toLocaleLowerCase() !== "music") {
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
    syncTimer = window.setTimeout(syncPlayer, 120);
  }

  document.addEventListener("yt-navigate-finish", scheduleSync);
  document.addEventListener("yt-page-data-updated", scheduleSync);
  window.addEventListener("popstate", scheduleSync);
  new MutationObserver(scheduleSync).observe(document.documentElement, {
    childList: true,
    subtree: true
  });
  syncPlayer();
})();
