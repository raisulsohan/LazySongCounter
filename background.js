const STORAGE_KEY = "lazySongCounterData";
const MAX_LISTENS = 10000;

let writeQueue = Promise.resolve();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "record-listen") return;

  const senderUrl = sender.url || "";
  if (!/^https:\/\/(www\.|music\.)?youtube\.com\//i.test(senderUrl)) {
    sendResponse({ ok: false, error: "Invalid sender" });
    return;
  }

  writeQueue = writeQueue
    .catch(() => undefined)
    .then(async () => {
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      const data = stored[STORAGE_KEY] || { listens: [] };
      const listens = Array.isArray(data.listens) ? data.listens : [];
      const title = cleanText(message.title, 200);
      const videoId = cleanText(message.videoId, 32);

      if (!title || !videoId) {
        sendResponse({ ok: false, error: "Missing track details" });
        return;
      }

      const trackKey = cleanText(message.trackKey, 240) || title.toLocaleLowerCase();
      listens.push({
        id: crypto.randomUUID(),
        trackKey,
        title,
        channel: cleanText(message.channel, 120),
        videoId,
        playedAt: Date.now()
      });

      await chrome.storage.local.set({
        [STORAGE_KEY]: { listens: listens.slice(-MAX_LISTENS) }
      });
      sendResponse({ ok: true });
    })
    .catch((error) => {
      console.error("Could not save listen", error);
      sendResponse({ ok: false, error: "Could not save listen" });
    });

  return true;
});

function cleanText(value, maxLength) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}
