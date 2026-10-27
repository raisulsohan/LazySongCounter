# Lazy Song Counter

A Manifest V3 Chrome extension that tracks listening activity on YouTube and YouTube Music. The popup ranks your most-played tracks for today, this week, this month, this year, or all time.

The popup shows the top 5 tracks for a quick view. Click **View full list** to open the searchable, paginated Song Library in a separate tab. The library opens to **Today** by default.

## Counting rules

- Only videos marked with YouTube's `Music` category are counted. Videos with no category metadata are skipped.
- Titles that clearly indicate podcasts, reactions, reviews, tutorials, interviews, playlists, or full albums are skipped.
- Videos with the same normalized title are grouped together.
- A play counts after 30 seconds. Videos shorter than 60 seconds count after half their duration.
- Pausing and resuming does not create another play. Replaying or looping a song starts a new play session.
- Listening history stays in `chrome.storage.local`; the latest 10,000 plays are kept.

## Load in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select this folder.
4. Play a song on YouTube, then open the extension popup to view your stats.
