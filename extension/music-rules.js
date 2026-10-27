// Pure rules shared by the content script, the service worker and the unit tests.
(function (root) {
  "use strict";

  const NON_SONG_TITLE = /\b(?:podcast|reaction|reacts?|review|tutorial|lesson|interview|commentary|analysis|breakdown|documentary|vlog|trailer|teaser|movie scene|deleted scene|playlist|compilation|mixtape|behind the scenes|making of|how to)\b|রিভিউ|রিঅ্যাকশন|টিউটোরিয়াল|সাক্ষাৎকার|পডকাস্ট|বিশ্লেষণ|ডকুমেন্টারি|ভ্লগ/i;

  // Upload labels that do not change which song it is: "(Official Video)", "[Lyrics]", "(Audio)" and so on.
  const LABEL_WORDS = String.raw`(?:official\s*)?(?:music\s*|lyrics?\s*|lyrical\s*|hd\s*|4k\s*)?(?:video|audio|visuali[sz]er|mv)(?:\s*song)?|official|lyrics?|lyrical|audio(?:\s*only)?|video\s*song|hd|hq|4k|full\s*(?:video|song|audio)|explicit|clean\s*version|remaster(?:ed)?(?:\s*\d{4})?|\d{4}\s*remaster(?:ed)?`;
  const BRACKETED_LABEL = new RegExp(String.raw`[\[(（【]\s*(?:${LABEL_WORDS})\s*[\])）】]`, "gi");
  const TRAILING_LABEL = new RegExp(String.raw`\s*[|｜]\s*(?:${LABEL_WORDS})\s*$`, "i");
  const BRACKETED_FEATURE = /[\[(（]\s*(?:feat|ft|featuring)\.?\s[^\])）]*[\])）]/gi;
  const TRAILING_FEATURE = /\s+(?:feat|ft|featuring)\.?\s+[^-–—|]*$/i;
  const ARTIST_SEPARATOR = /\s[-–—]\s/;
  // Full albums and jukeboxes count as one play of the album.
  const ALBUM_LABEL = /[\[(（]?\s*\b(?:full\s*(?:audio\s*)?album|(?:audio|video|mp3)?\s*jukebox)\b\s*[\])）]?/gi;
  const ALBUM_CREDIT = /^\s*album(?:\s*name)?\s*[:：\-–—]\s*(.+?)\s*$/im;

  function cleanText(value, maxLength) {
    return String(value || "")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maxLength);
  }

  function cleanTitle(value) {
    return String(value || "")
      .replace(/\s*[-|]\s*YouTube(?: Music)?\s*$/i, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeText(value) {
    return String(value || "")
      .normalize("NFKC")
      .toLocaleLowerCase()
      .replace(/[\[\](){}（）【】.,!?\-–—_:;"'’|｜]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function stripTitleLabels(title) {
    let result = String(title || "").normalize("NFKC");
    let previous;
    do {
      previous = result;
      result = result
        .replace(BRACKETED_LABEL, " ")
        .replace(BRACKETED_FEATURE, " ")
        .replace(TRAILING_LABEL, "")
        .replace(TRAILING_FEATURE, "")
        .replace(/\s+/g, " ")
        .trim();
    } while (result !== previous);
    return result;
  }

  function artistFromChannel(channel, title) {
    const name = String(channel || "")
      .normalize("NFKC")
      .replace(/\s*-\s*Topic\s*$/i, "")
      .replace(/\s*VEVO\s*$/i, "")
      .trim();
    // Older YouTube Music builds stored the song title as the channel; ignore that value.
    if (!name || normalizeText(name) === normalizeText(title)) return "";
    return name;
  }

  // Plays of the same song share one key: labels are removed and the artist is added
  // when the title does not already name it ("Artist - Song").
  function trackKeyFor(title, channel) {
    const songTitle = stripTitleLabels(title) || String(title || "");
    const artist = ARTIST_SEPARATOR.test(songTitle) ? "" : artistFromChannel(channel, title);
    const key = normalizeText(artist ? `${artist} - ${songTitle}` : songTitle);
    return key.slice(0, 240);
  }

  function isAlbumTitle(title) {
    ALBUM_LABEL.lastIndex = 0;
    const result = ALBUM_LABEL.test(String(title || ""));
    ALBUM_LABEL.lastIndex = 0;
    return result;
  }

  // "Ekhon Ami | Sumon & Anila | Full Album | Audio Jukebox" -> "Ekhon Ami (Album)".
  // An "Album: …" credit in the description wins over the title.
  function albumTitleFor(title, description = "") {
    const credit = String(description || "").match(ALBUM_CREDIT)?.[1];
    const fromTitle = String(title || "")
      .split(/\s*[|｜]\s*/)
      .map((part) => part.replace(ALBUM_LABEL, " ").replace(/\s+/g, " ").replace(/^[\s\-–—:]+|[\s\-–—:]+$/g, ""))
      .find(Boolean);
    const name = cleanText(credit || fromTitle || title, 180);
    return name ? `${name} (Album)` : "";
  }

  function isClearlyNonSongTitle(title) {
    return NON_SONG_TITLE.test(String(title || ""));
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

  function playThreshold(duration) {
    const seconds = Number(duration);
    if (!Number.isFinite(seconds) || seconds <= 0) return 30;
    return Math.max(2, Math.min(30, seconds * 0.5));
  }

  function isPlaybackWrap(previousTime, currentTime, duration) {
    const seconds = Number(duration);
    if (!Number.isFinite(seconds) || seconds <= 0 || currentTime >= previousTime) return false;

    const edgeWindow = Math.min(8, Math.max(2, seconds * 0.02));
    return previousTime >= seconds - edgeWindow && currentTime <= edgeWindow;
  }

  const api = Object.freeze({
    cleanText,
    cleanTitle,
    normalizeText,
    stripTitleLabels,
    trackKeyFor,
    isAlbumTitle,
    albumTitleFor,
    isClearlyNonSongTitle,
    classifyMusicVideo,
    playThreshold,
    isPlaybackWrap
  });

  root.LazySongRules = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self);
