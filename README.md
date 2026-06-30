# Jimaku Player Reloaded
## 字幕プレーヤー・リローデッド

<p align="center">
  <img src="assets/screenshot.png" alt="Jimaku Player Reloaded rendering a Japanese subtitle over a video">
</p>

A userscript that adds a Japanese-subtitle layer to **any site that uses [Vidstack Player](https://vidstack.io)**. It browses [jimaku.cc](https://jimaku.cc), downloads `.srt` / `.ass` / `.vtt` files for the show you're watching, and renders them on top of the video — synced with one keypress.

Built for studying Japanese with anime.

## What it does

- Activates automatically whenever a Vidstack `<media-player>` is present on the page.
- **Auto-finds and loads the right subtitle file for the current episode** (on by default) — searches jimaku.cc on load and picks the best match by parsing each result's filename. Toggle in Settings.
  - Excludes Chinese subtitle files (`[CHS]` / `[CHT]`) by default.
  - Sticks to the release group you first used for a show, so later episodes match it automatically (shown under Browse).
- **Style controls** (Settings → Style): font size, outline thickness (scales with the font), background opacity, and font family (presets or your own). Plus **custom CSS** to restyle the overlay, panel, or the page's player.
- Pre-fills a search box from the page title (best-effort), or you type the show yourself.
- Searches [jimaku.cc](https://jimaku.cc) for matching Japanese subtitle files.
- Lists the files with WEB / BD / ASS tags so you can pick the one closest to your stream.
- Renders the subtitles directly over the video. Click a line to open it in [jisho.org](https://jisho.org).
- Sync them to the audio with a single keypress.
- Remembers your alignment per show + site, so episodes 2..N inherit it.

## Install

Works in any major userscript manager:

- **Chrome / Firefox / Edge:** [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/).
- **Safari:** [Userscripts](https://apps.apple.com/app/userscripts/id1463298887) (free, open-source).

Then install the script from `jimaku-player-reloaded.user.js` (open the file → your manager will prompt you to install). Or paste the file contents into a new script in the manager dashboard.

The script runs on every site (`@match *://*/*`) but stays completely idle until it detects a Vidstack `<media-player>` on the page, at which point the **字** button appears on the player.

## Setup (one time)

1. Open <https://jimaku.cc> and create an account.
2. Go to <https://jimaku.cc/account> and copy your API key.
3. On any page with a Vidstack player, hover the player → click the small **字** button at the top-right → **Settings** tab → paste the key → **Save**.

Stored locally only. Never sent anywhere except jimaku.cc itself.

## Use

1. Open an episode on any site that uses Vidstack Player.
2. With **auto-load** on (the default), the script searches jimaku.cc and loads the best file for the detected episode automatically — you may not need to do anything. A toast confirms what was loaded.
3. To choose manually: hover the player (top right corner) → click **字** (or press **`J`**) → **Browse** tab. The search box is pre-filled from the page title when possible; otherwise type the show name and episode. Pick a file from the list (WEB-tagged ones tend to align best with streaming sources).
4. Subtitles appear at the bottom of the video.

Auto-load needs an API key and a detectable episode number; when it can't confidently match the show or episode, it stays out of the way and waits for you to pick. Manually loading a file always wins over auto-load for that episode.

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

### Review what you pick up

<a href="https://apps.apple.com/es/app/meku/id6759989326?l=en-GB"><img src="https://is1-ssl.mzstatic.com/image/thumb/Purple221/v4/4f/02/52/4f02526b-c1c1-b7fe-46da-b18fbe2f7718/AppIcon-0-0-1x_U007epad-0-1-85-220.png/512x512bb.jpg" width="96" align="right" alt="Meku app icon"></a>

Looking words up mid-episode is only half the loop — the other half is actually retaining them. [**Meku**](https://apps.apple.com/es/app/meku/id6759989326?l=en-GB) (iOS) is a flashcards app built for exactly this: drop in the vocab and sentences you find while watching, and review them later. Pairs naturally with this script — encounter a word while watching, look it up on jisho, drill it on Meku.

<p align="center">
  <a href="https://apps.apple.com/es/app/meku/id6759989326?l=en-GB">
    <img src="https://is1-ssl.mzstatic.com/image/thumb/PurpleSource221/v4/8e/e7/25/8ee72521-c6b0-92a9-48b8-c9872adc28e9/ios_1_1.png/600x1300bb.png" width="200" alt="Meku — Study with spaced repetitions">
  </a>
</p>

## Limitations

- **Burned-in subtitles can't be removed.** If a site ships hard-subbed video, those stay. The script can hide Vidstack's own caption track (Settings → it disables the player's native captions), or you can move our subtitles to the top (Settings → Position).
- **ASS positioning / styling is partially supported;** complex karaoke effects render plainly. Lines that overlap in time (including `.ass` lines sharing a start timestamp) are stacked and shown together.
- **Auto-detection is best-effort.** The show name is guessed from the page title (`og:title` / `<h1>` / `<title>` / the player's `title` attribute), so on many sites you'll need to type the show + episode into the search box yourself.
- **Provider must expose a `<video>` element.** HTML / HLS / DASH providers work; YouTube / Vimeo iframe providers don't expose a readable `<video>`, so time-sync won't work there.
- **jimaku.cc rate limit:** 25 requests / minute per key. Plenty for normal use; if you hammer the search box you'll get throttled briefly.

## Development

The userscript is a single self-contained file at `jimaku-player-reloaded.user.js`. No build step. Edit it, save, refresh.

It runs on every page (`@match *://*/*`) but does nothing until a Vidstack `<media-player>` is found. A single `watch()` loop — driven by a `MutationObserver`, history events (`popstate`/`hashchange`), and a 1s heartbeat — handles late-loading players and SPA sites that swap the player or change the URL between episodes without a reload. When a player appears (or a new episode is detected), it:

- Mounts the UI (overlay, **字** button, panel) inside the `<media-player>` element.
- Polls the underlying `<video>` element for the current time and to seek — this is the most reliable, sandbox-safe time source across providers.
- Hides Vidstack's native captions (when enabled) by disabling the `<video>`'s text tracks and CSS-hiding the caption elements (`media-captions`, `[data-part="cue-display"]`).
- Talks to the jimaku.cc API via `GM_xmlhttpRequest`.

State is stored in `localStorage` (`jp:*` keys) so it works in userscript managers that don't expose `GM_setValue` (notably Userscripts.app on Safari). Per-show data (alignment, chosen entry) is keyed on `hostname + show title`.

The native [anitomy](https://github.com/yjl9903/anitomy) filename parser is vendored verbatim at the bottom of the file (`makeAnitomy()`), wrapped in a CommonJS shim and instantiated lazily on first use. It powers auto-load's per-episode file matching — no WASM, no network, fully synchronous. To update it, replace that block with a fresh build of `anitomy`'s `dist/index.cjs`.

## Credits

- **[sheodox/jimaku-player](https://github.com/sheodox/jimaku-player)** — original userscript and the SRT/ASS parser logic. Read the original for VRV nostalgia.
- **[jimaku.cc](https://jimaku.cc)** — the Japanese-subtitle archive and API this script depends on.
- **[jisho.org](https://jisho.org)** — Japanese-English dictionary used for word lookups.
- **[yjl9903/anitomy](https://github.com/yjl9903/anitomy)** — native JavaScript port of Anitomy (MIT), vendored into the script to parse release filenames for auto-loading.

## License

ISC
