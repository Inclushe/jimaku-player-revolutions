# Jimaku Player Reloaded
## 字幕プレーヤー・リローデッド

A userscript that adds a Japanese-subtitle layer to the Crunchyroll player. It browses [jimaku.cc](https://jimaku.cc), downloads `.srt` / `.ass` / `.vtt` files for the show you're watching, and renders them on top of the video — synced with one keypress.

Built for studying Japanese with anime.

## What it does

- Detects the show + episode from the Crunchyroll URL/page automatically.
- Searches [jimaku.cc](https://jimaku.cc) for matching Japanese subtitle files.
- Lists the files with WEB / BD / ASS tags so you can pick the one closest to Crunchyroll's stream.
- Renders the subtitles directly over the video. Click a line to open it in [jisho.org](https://jisho.org).
- Sync them to the audio with a single keypress.
- Remembers your alignment per show, so episodes 2..N inherit it.

## Install

Works in any major userscript manager:

- **Chrome / Firefox / Edge:** [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/).
- **Safari:** [Userscripts](https://apps.apple.com/app/userscripts/id1463298887) (free, open-source).

Then install the script from `dist/jimaku-player.user.js` (open the file → your manager will prompt you to install). Or paste the file contents into a new script in the manager dashboard.

## Setup (one time)

1. Open <https://jimaku.cc> and create an account.
2. Go to <https://jimaku.cc/profile> and copy your API key.
3. On any Crunchyroll watch page, hover the player → click the small **字** button at the top-right → **Settings** tab → paste the key → **Save**.

Stored locally only. Never sent anywhere except jimaku.cc itself.

## Use

1. Open any episode on Crunchyroll.
2. Hover the player (top right corner) → click **字** (or press **`J`**).
3. **Browse** tab — the show + episode are pre-filled. Pick a file from the list (WEB-tagged ones tend to align best with Crunchyroll).
4. Subtitles appear at the bottom of the video.

### Sync in one keypress

If timing is off:

- The instant a line of dialogue is spoken, press **`S`**.
- The active (or next upcoming) subtitle is snapped to that moment. The whole file shifts with it.
- Press **`B`** to rewind to that subtitle and verify.
- If still slightly off, **`Z`** / **`X`** nudge by ±0.2s (hold **Shift** for ±1s).

That's the whole flow. Once a show is anchored, every subsequent episode loads with the same offset.

### Hotkeys

| Key | Action |
|-----|--------|
| `J` | Open / close the panel |
| `S` | Snap the current/upcoming subtitle to the video's current time |
| `B` | Rewind to the most recently-shown subtitle |
| `H` | Hide / show subtitles |
| `I` | Flip subtitles top / bottom |
| `Z` | Subtitles earlier (−0.2s, Shift = −1s) |
| `X` | Subtitles later (+0.2s, Shift = +1s) |

### Click a line

Clicking a rendered subtitle opens [jisho.org](https://jisho.org) for that text. Useful for looking up unknown words mid-episode.

## Limitations

- **Burned-in subtitles can't be removed.** Crunchyroll does not allow to disable their own subtitles
**Japanese** for a cleaner stream, or move our subtitles to the top (Settings → Position).
- **One subtitle per visible cue.** ASS positioning / styling is partially supported; complex karaoke effects render plainly.
- **Crunchyroll DOM changes.** Show / episode auto-detection uses the page's series-link DOM; if Crunchyroll reorganises the page, the script falls back to a manual search box in the panel.
- **jimaku.cc rate limit:** 25 requests / minute per key. Plenty for normal use; if you hammer the search box you'll get throttled briefly.

## Development

The userscript is a single self-contained file at `jimaku-player-reloaded.js`. No build step. Edit it, save, refresh.

It runs twice per Crunchyroll page:

- On `www.crunchyroll.com/watch/...` it mounts the UI inside the Bitmovin player container, polls the `<video>` element for current time, and talks to the jimaku.cc API via `GM_xmlhttpRequest`.
- On `static.crunchyroll.com/...` (the legacy iframe path, kept for fallback) it relays video-time and seek messages via `postMessage`.

State is stored in `localStorage` (`jp:*` keys) so it works in userscript managers that don't expose `GM_setValue` (notably Userscripts.app on Safari).

## Credits

- **[sheodox/jimaku-player](https://github.com/sheodox/jimaku-player)** — original userscript and the SRT/ASS parser logic. Read the original for VRV nostalgia.
- **[jimaku.cc](https://jimaku.cc)** — the Japanese-subtitle archive and API this script depends on.
- **[jisho.org](https://jisho.org)** — Japanese-English dictionary used for word lookups.

## License

ISC
