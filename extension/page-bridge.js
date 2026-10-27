(() => {
  const lastSent = new Map();

  function readPlayerResponse() {
    const player = document.querySelector("#movie_player");
    const responses = [];

    try {
      if (typeof player?.getPlayerResponse === "function") {
        responses.push(player.getPlayerResponse());
      }
    } catch {
      // The player may be transitioning between videos.
    }

    if (window.ytInitialPlayerResponse) responses.push(window.ytInitialPlayerResponse);

    try {
      const serialized = window.ytplayer?.config?.args?.player_response;
      if (typeof serialized === "string") responses.push(JSON.parse(serialized));
    } catch {
      // Ignore malformed or not-yet-ready player data.
    }

    const currentPath = new URL(location.href).pathname;
    const currentId = new URL(location.href).searchParams.get("v") ||
      currentPath.match(/^\/(?:shorts|live)\/([^/?]+)/)?.[1] || "";

    const matchingResponses = responses.filter((candidate) => {
      const details = candidate?.videoDetails;
      const responseId = details?.videoId || candidate?.microformat?.playerMicroformatRenderer?.externalVideoId;
      return responseId === currentId;
    });

    if (!currentId) return;
    const response = matchingResponses.find((candidate) => {
      const category = candidate?.microformat?.playerMicroformatRenderer?.category;
      return typeof category === "string" && category.trim();
    });
    const videoDetails = response?.videoDetails || {};
    const category = response?.microformat?.playerMicroformatRenderer?.category ||
      document.querySelector('meta[itemprop="genre"]')?.content;
    if (typeof category !== "string" || !category.trim()) return;

    const metadata = {
      category: category.trim(),
      title: typeof videoDetails.title === "string" ? videoDetails.title.slice(0, 200) : "",
      author: typeof videoDetails.author === "string" ? videoDetails.author.slice(0, 120) : "",
      description: typeof videoDetails.shortDescription === "string"
        ? videoDetails.shortDescription.slice(0, 8000)
        : "",
      keywords: Array.isArray(videoDetails.keywords)
        ? videoDetails.keywords.filter((keyword) => typeof keyword === "string").slice(0, 80)
        : []
    };
    const signature = JSON.stringify(metadata);
    const previousSend = lastSent.get(currentId);
    const sentAt = Date.now();
    if (previousSend?.signature === signature && sentAt - previousSend.sentAt < 900) return;
    lastSent.set(currentId, { signature, sentAt });
    if (lastSent.size > 100) lastSent.delete(lastSent.keys().next().value);

    window.postMessage({
      source: "lazy-song-counter",
      type: "video-category",
      videoId: currentId,
      ...metadata
    }, location.origin);
  }

  window.addEventListener("yt-navigate-finish", readPlayerResponse);
  window.addEventListener("yt-page-data-updated", readPlayerResponse);
  window.setInterval(readPlayerResponse, 1000);
  readPlayerResponse();
})();
