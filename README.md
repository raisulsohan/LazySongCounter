# Lazy Song Counter

A Manifest V3 Chrome extension that tracks listening activity on YouTube and YouTube Music. The popup ranks your most-played tracks for today, this week, this month, this year, or all time.

The popup shows the top 5 tracks for a quick view. Click **View full list** to open the searchable, paginated Song Library in a separate tab. The library opens to **Today** by default. On eligible YouTube watch pages, a local `N played` badge appears beside the Like control.

## Counting rules

- Only videos marked with YouTube's `Music` category are counted. Videos with no category metadata are skipped.
- Titles that clearly indicate podcasts, reactions, reviews, tutorials, interviews, playlists, or full albums are skipped.
- Videos with the same normalized title are grouped together.
- A play counts after 30 seconds. Videos shorter than 60 seconds count after half their duration.
- Pausing and resuming does not create another play. Replaying or looping a song starts a new play session.
- The browser keeps the latest 10,000 plays locally. With Google cloud backup enabled, history is merged with your Firestore account and synced across Chrome profiles.

## Set up Google cloud backup

Cloud backup uses Firebase Authentication, Cloud Firestore, and Chrome's Google sign-in. This build is configured for Firebase project `lazy-song-counter`; each signed-in Google account gets its own UID-scoped history. The Chrome Extension OAuth client is bound to unpacked extension ID `oaomgimboekepjcjnaaappfkinddmdgg`. A fork or a Chrome Web Store build with a different extension ID needs its own OAuth client. Firebase Web app values and OAuth client IDs are public identifiers; no service account key or private OAuth secret belongs in this extension.

1. For a separate deployment, create a project in the [Firebase Console](https://console.firebase.google.com/) and register a Web app. Copy its **Web API key** and **Project ID** into `firebase-config.js`.
2. In Firebase Authentication, enable the **Google** provider.
3. Create a **Cloud Firestore** database. Open **Firestore Database → Rules**, replace the rules with the contents of `firestore.rules`, and publish them.
4. Load the extension in Chrome using the steps below. Then open `chrome://extensions`, turn on **Developer mode**, and copy the extension ID shown for Lazy Song Counter.
5. In Google Cloud Console, create an OAuth client ID with application type **Chrome Extension** and register that extension ID. Copy the client ID into `manifest.json`, replacing `YOUR_CHROME_EXTENSION_OAUTH_CLIENT_ID.apps.googleusercontent.com`.
6. Reload the extension in `chrome://extensions`, refresh open YouTube tabs, then click **Connect** in the extension and choose your Google account.

On the first sign-in, existing local plays are merged with that account's cloud history. The latest 10,000 plays are kept in both the browser and cloud. New plays sync in the background; a full sync runs at sign-in, on **Sync now**, and at most once every eight hours when Chrome starts. Signing out leaves the cloud copy in place. **Clear history** removes history from both the browser and the connected account.

`firebase-config.js` contains public Web app identifiers. Do not put a service account JSON file, private key, or OAuth client secret in the extension or this repository.

## Load in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select this folder.
4. Play a song on YouTube, then open the extension popup to view your stats.
5. After reloading the extension, refresh any YouTube tabs that were already open.
