const test = require("node:test");
const assert = require("node:assert/strict");
const Rules = require("../extension/music-rules.js");

test("upload labels do not split one song into several tracks", () => {
  const key = Rules.trackKeyFor("Adele - Hello (Official Music Video)", "AdeleVEVO");
  assert.equal(Rules.trackKeyFor("Adele - Hello [Lyrics]", "Some Lyrics Channel"), key);
  assert.equal(Rules.trackKeyFor("Adele - Hello | Official Audio", "Adele"), key);
  assert.equal(Rules.trackKeyFor("Hello", "Adele - Topic"), key);
});

test("songs with the same title by different artists stay apart", () => {
  assert.notEqual(Rules.trackKeyFor("Hello", "Adele - Topic"), Rules.trackKeyFor("Hello", "Lionel Richie - Topic"));
});

test("featured artists do not change the track", () => {
  assert.equal(
    Rules.trackKeyFor("Artist - Song (feat. Guest) (Official Video)", "ArtistVEVO"),
    Rules.trackKeyFor("Artist - Song ft. Guest", "Fan Uploads")
  );
});

test("a channel that repeats the title is ignored", () => {
  assert.equal(Rules.trackKeyFor("Tumi Robe Nirobe", "Tumi Robe Nirobe"), "tumi robe nirobe");
});

test("version words that change the recording are kept", () => {
  assert.notEqual(Rules.trackKeyFor("Artist - Song (Live)", ""), Rules.trackKeyFor("Artist - Song", ""));
  assert.notEqual(Rules.trackKeyFor("Artist - Song (Remix)", ""), Rules.trackKeyFor("Artist - Song", ""));
});

test("YouTube suffixes are removed from page titles", () => {
  assert.equal(Rules.cleanTitle("Song name - YouTube Music"), "Song name");
  assert.equal(Rules.cleanTitle("Song name | YouTube"), "Song name");
});

test("music category always counts", () => {
  assert.equal(Rules.classifyMusicVideo({ category: "Music", title: "Anything" }), "music");
});

test("missing category is unknown", () => {
  assert.equal(Rules.classifyMusicVideo(undefined), "unknown");
  assert.equal(Rules.classifyMusicVideo({ category: "" }), "unknown");
});

test("entertainment counts only with clear music signals", () => {
  const song = {
    category: "Entertainment",
    title: "Moner Manush Video Song",
    description: "Singer: Someone\nLyrics by Another",
    keywords: []
  };
  assert.equal(Rules.classifyMusicVideo(song), "music");
  assert.equal(Rules.classifyMusicVideo({ ...song, title: "Moner Manush Trailer" }), "not-music");
  assert.equal(Rules.classifyMusicVideo({ ...song, description: "Watch the full episode." }), "not-music");
  assert.equal(Rules.classifyMusicVideo({ ...song, description: "", keywords: [] }), "unknown");
});

test("lo-fi mixes count when the description talks about music", () => {
  assert.equal(Rules.classifyMusicVideo({
    category: "People & Blogs",
    title: "Night drive lofi mix",
    description: "Relaxing lo-fi beats for study",
    keywords: []
  }), "music");
});

test("other categories never count", () => {
  assert.equal(Rules.classifyMusicVideo({ category: "Gaming", title: "Song", description: "Singer: X" }), "not-music");
});

test("non-song titles are detected in English and Bangla", () => {
  assert.ok(Rules.isClearlyNonSongTitle("Song Reaction"));
  assert.ok(Rules.isClearlyNonSongTitle("গানের রিভিউ"));
  assert.ok(!Rules.isClearlyNonSongTitle("Artist - Song"));
});

test("play threshold is 30 seconds, or half of a short video", () => {
  assert.equal(Rules.playThreshold(240), 30);
  assert.equal(Rules.playThreshold(40), 20);
  assert.equal(Rules.playThreshold(2), 2);
  assert.equal(Rules.playThreshold(NaN), 30);
});

test("a jump from the end back to the start is a loop", () => {
  assert.ok(Rules.isPlaybackWrap(238, 0.5, 240));
  assert.ok(!Rules.isPlaybackWrap(120, 0.5, 240));
  assert.ok(!Rules.isPlaybackWrap(238, 60, 240));
  assert.ok(!Rules.isPlaybackWrap(10, 20, 240));
  assert.ok(!Rules.isPlaybackWrap(238, 0.5, NaN));
});
