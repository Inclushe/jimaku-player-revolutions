// ==UserScript==
// @name         Jimaku Player Reloaded
// @namespace    https://github.com/mgp25/jimaku-player-reloaded
// @version      3.4.0
// @description  Browse, download, and align Japanese subtitles inside any Vidstack-based player using jimaku.cc. Auto-finds the right file for the current episode.
// @author       mgp25
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @connect      jimaku.cc
// @run-at       document-start
// ==/UserScript==
//
// Based on the original Jimaku Player by sheodox:
// https://github.com/sheodox/jimaku-player
//
/* eslint-disable no-undef */
(function () {
	'use strict';

	const TAG = '[jimaku]';
	const log = (...a) => console.log(TAG, ...a);
	const info = (...a) => console.info(TAG, ...a);
	const warn = (...a) => console.warn(TAG, ...a);

	try { window.addEventListener('error', (e) => warn('uncaught', e.message)); } catch {}

	info('boot', location.href, 'readyState=' + document.readyState);

	const KEYS = {
		apiKey: 'jimaku-api-key',
		preferAss: 'jimaku-prefer-ass',
		entryCache: 'jimaku-entry-cache',
		alignBy: 'jimaku-alignment-by-show',
		fontScale: 'jimaku-font-scale',
		position: 'jimaku-position',
		hideNative: 'jimaku-hide-native-subs',
		autoSub: 'jimaku-auto-sub',
		excludeChinese: 'jimaku-exclude-chinese',
		stickGroup: 'jimaku-stick-group',
		groupByShow: 'jimaku-group-by-show',
		customCss: 'jimaku-custom-css',
	};
	const get = (k, d) => {
		try {
			const raw = localStorage.getItem('jp:' + k);
			return raw == null ? d : JSON.parse(raw);
		} catch {
			return d;
		}
	};
	const set = (k, v) => {
		try {
			localStorage.setItem('jp:' + k, JSON.stringify(v));
		} catch (e) {
			warn('localStorage write failed', e);
		}
	};

	const state = {
		videoTimeMs: 0,
		videoFound: false,
		subtitles: [],
		subtitlesFile: '',
		alignment: 0,
		isEnabled: true,
		history: [],
		currentSubIndex: -1,
		detected: null,
		apiKey: get(KEYS.apiKey, ''),
		preferAss: get(KEYS.preferAss, true),
		fontScale: get(KEYS.fontScale, 1),
		position: get(KEYS.position, 'bottom'),
		hideNative: get(KEYS.hideNative, true),
		autoSub: get(KEYS.autoSub, true),
		excludeChinese: get(KEYS.excludeChinese, true),
		stickGroup: get(KEYS.stickGroup, true),
		customCss: get(KEYS.customCss, ''),
		entryCache: get(KEYS.entryCache, {}),
		alignByShow: get(KEYS.alignBy, {}),
		groupByShow: get(KEYS.groupByShow, {}),
		entries: [],
		selectedEntry: null,
		files: [],
		ui: { panelOpen: false, tab: 'browse', loading: '', error: '' },
	};

	// Vidstack can render either as the <media-player> custom element or as a
	// plain element carrying the data-media-player attribute (the data-* form is
	// what sites using the CSS/default-layout build produce). Match both.
	const PLAYER_SEL = 'media-player, [data-media-player]';
	const PROVIDER_SEL = 'media-provider, [data-media-provider]';
	function findVidstackPlayer() {
		return document.querySelector(PLAYER_SEL);
	}
	function getLocalVideo() {
		const player = findVidstackPlayer();
		if (player) {
			const v = player.querySelector('video');
			if (v) return v;
		}
		return document.querySelector(PROVIDER_SEL + ' video') || document.querySelector('video');
	}
	const seekTo = (timeMs) => {
		const t = Math.max(0, timeMs);
		const v = getLocalVideo();
		if (v) v.currentTime = t / 1000;
	};

	setInterval(() => {
		const v = getLocalVideo();
		if (!v || typeof v.currentTime !== 'number') return;
		state.videoTimeMs = Math.floor(v.currentTime * 1000);
		if (!state.videoFound) {
			state.videoFound = true;
			info('local video connected', v.tagName, 't=' + v.currentTime);
			updateVideoStatus();
		}
	}, 50);

	function applyHideNative() {
		document.documentElement.classList.toggle('jp-hide-native', !!state.hideNative);
		if (!state.hideNative) return;
		const v = getLocalVideo();
		if (v && v.textTracks) {
			for (let i = 0; i < v.textTracks.length; i++) {
				const t = v.textTracks[i];
				if (t.mode !== 'disabled') t.mode = 'disabled';
			}
		}
	}
	applyHideNative();
	setInterval(applyHideNative, 1000);

	const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

	const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

	// The candidate sources we read the show title from, in priority order.
	// Logged on change (see refreshDetection) so it's clear which one is winning.
	function titleSources() {
		const player = findVidstackPlayer();
		return {
			'player[title]': clean(player?.getAttribute('title') || ''),
			'player[aria-label]': clean(player?.getAttribute('aria-label') || ''),
			'og:title': clean(document.querySelector('meta[property="og:title"]')?.content || ''),
			h1: clean(document.querySelector('h1')?.textContent || ''),
			'document.title': clean(document.title || ''),
		};
	}

	// Best-effort show/episode detection from generic page metadata. There is no
	// universal "what am I watching" signal across Vidstack sites, so this only
	// pre-fills the manual search box — the user can always edit it.
	// We deliberately avoid og:title and document.title: on many sites those are
	// the generic site name ("Watch Anime Online - SomeSite"), not the show. The
	// player's own title and the page <h1> track the actual content far better.
	function detectShow() {
		const out = { showTitle: '', showKey: '', episodeNumber: null };

		const player = findVidstackPlayer();
		const candidates = [player?.getAttribute('title'), document.querySelector('h1')?.textContent]
			.filter(Boolean)
			.map(clean);

		// Episode number: from a title candidate, else from the URL (many sites
		// put it in the path/query, e.g. /watch/x/episode-9 or ?ep=9).
		for (const s of candidates) {
			const m = s.match(/(?:Episode|Ep\.?|E|#)\s*(\d+)/i);
			if (m) {
				out.episodeNumber = parseInt(m[1], 10);
				break;
			}
		}
		if (out.episodeNumber == null) {
			const u = location.href.match(/[?&/](?:ep|episode|e)[-_=/]?(\d{1,4})(?:[/?#&]|$)/i);
			if (u) out.episodeNumber = parseInt(u[1], 10);
		}

		// Take the first available title and reduce it to just the show name:
		// strip a leading "Watch ", a trailing site-brand suffix ("… - Vidstack"),
		// and any episode marker plus everything after it ("Frieren - Episode 9 -
		// Self-Awareness" → "Frieren"), so it makes a clean jimaku search query.
		let raw = candidates[0] || '';
		raw = raw.replace(/^\s*watch\s+/i, '');
		const brand = location.hostname.replace(/^www\./, '').split('.')[0] || '';
		if (brand) {
			raw = raw.replace(new RegExp('\\s*[\\-–—|:·]\\s*' + escapeRe(brand) + '.*$', 'i'), '');
		}
		raw = raw.replace(/[\s\-–—|:·]+(?:episode|ep\.?|e|#)\s*\d+.*$/i, '');
		out.showTitle = clean(raw);
		out.showKey = (location.hostname + '|' + out.showTitle).toLowerCase();
		return out;
	}

	function refreshDetection() {
		const prev = state.detected;
		const next = detectShow();
		const changed =
			!prev || prev.showKey !== next.showKey || prev.episodeNumber !== next.episodeNumber;
		if (changed && (!prev || prev.showTitle !== next.showTitle || prev.episodeNumber !== next.episodeNumber)) {
			info('show grabbed:', JSON.stringify(next.showTitle), '· episode:', next.episodeNumber ?? '(none)');
			info('title sources:', titleSources());
		}
		// Genuine episode change (both sides a real number, and different): drop the
		// now-stale subtitles so they don't show over the new episode. Guarded
		// against title flicker to null so we don't wipe subs spuriously.
		const epChanged =
			prev &&
			prev.episodeNumber != null &&
			next.episodeNumber != null &&
			(prev.episodeNumber !== next.episodeNumber || prev.showKey !== next.showKey);
		state.detected = next;
		if (epChanged && state.subtitles.length) {
			state.subtitles = [];
			state.subtitlesFile = '';
			state.history = [];
			state.currentSubIndex = -1;
			updateVideoStatus();
		}
		if (changed) {
			if (next.showKey && typeof state.alignByShow[next.showKey] === 'number') {
				state.alignment = state.alignByShow[next.showKey];
			}
			renderPanel();
		}
		maybeAutoLoad();
	}

	function normalize(text) {
		if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
		return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
	}
	function parseTime(s) {
		if (!s) return 0;
		const c = s.trim().replace(',', '.').replace(/\s+/g, '');
		const parts = c.split(':');
		if (parts.length === 3)
			return Math.round(((parseInt(parts[0]) || 0) * 3600 + (parseInt(parts[1]) || 0) * 60 + (parseFloat(parts[2]) || 0)) * 1000);
		if (parts.length === 2) return Math.round(((parseInt(parts[0]) || 0) * 60 + (parseFloat(parts[1]) || 0)) * 1000);
		return 0;
	}
	const stripAss = (t) =>
		t
			.replace(/\{[^}]*\}/g, '')
			.replace(/\\N/gi, '\n')
			.replace(/\\n/gi, '\n')
			.replace(/\\h/gi, ' ')
			.trim();

	function parseSRT(content) {
		const subs = [];
		const blocks = normalize(content).split(/\n\n+/);
		for (const block of blocks) {
			const lines = block.split('\n');
			let ti = -1;
			for (let i = 0; i < Math.min(3, lines.length); i++) if (lines[i].includes('-->')) ti = i;
			if (ti < 0) continue;
			const arrow = lines[ti].indexOf('-->');
			const startStr = lines[ti].slice(0, arrow).trim();
			let endRaw = lines[ti].slice(arrow + 3).trim();
			const sp = endRaw.indexOf(' ');
			const endStr = sp > 0 ? endRaw.slice(0, sp) : endRaw;
			const start = parseTime(startStr);
			const end = parseTime(endStr);
			const text = lines.slice(ti + 1).join('\n').trim();
			if (text && end > start) subs.push({ start, end, text });
		}
		return subs.sort((a, b) => a.start - b.start);
	}
	function parseVTT(content) {
		let c = normalize(content);
		const headerEnd = c.indexOf('\n\n');
		if (headerEnd > 0) c = c.slice(headerEnd + 2);
		c = c.replace(/^NOTE[^\n]*\n([^\n]*\n)*/gm, '');
		return parseSRT(c);
	}
	function parseASS(content) {
		const subs = [];
		const lines = normalize(content).split('\n');
		let inEvents = false;
		let fields = [];
		for (const raw of lines) {
			const line = raw.trim();
			if (line.toLowerCase() === '[events]') {
				inEvents = true;
				continue;
			}
			if (line.startsWith('[') && line.endsWith(']')) {
				inEvents = false;
				continue;
			}
			if (!inEvents) continue;
			if (line.toLowerCase().startsWith('format:')) {
				fields = line
					.slice(7)
					.split(',')
					.map((f) => f.trim().toLowerCase());
			} else if (line.toLowerCase().startsWith('dialogue:')) {
				const dl = line.slice(9);
				const max = fields.length;
				const vals = [];
				let cur = '';
				let count = 0;
				for (let i = 0; i < dl.length; i++) {
					if (dl[i] === ',' && count < max - 1) {
						vals.push(cur.trim());
						cur = '';
						count++;
					} else cur += dl[i];
				}
				vals.push(cur.trim());
				const si = fields.indexOf('start');
				const ei = fields.indexOf('end');
				const ti = fields.indexOf('text');
				if (si >= 0 && ei >= 0 && ti >= 0) {
					const start = parseTime(vals[si]);
					const end = parseTime(vals[ei]);
					const text = stripAss(vals[ti] || '');
					if (text && end > start) subs.push({ start, end, text });
				}
			}
		}
		return subs.sort((a, b) => a.start - b.start);
	}
	function parseByName(content, filename) {
		const ext = (filename.split('.').pop() || '').toLowerCase();
		if (ext === 'ass' || ext === 'ssa') return parseASS(content);
		if (ext === 'vtt') return parseVTT(content);
		return parseSRT(content);
	}

	const API = 'https://jimaku.cc/api';

	function getXhr() {
		if (typeof GM_xmlhttpRequest === 'function') return GM_xmlhttpRequest;
		if (typeof GM !== 'undefined' && typeof GM.xmlHttpRequest === 'function') return GM.xmlHttpRequest.bind(GM);
		return null;
	}
	function gmReq(opts) {
		const xhr = getXhr();
		if (!xhr) {
			return Promise.reject(
				new Error('Your userscript manager does not expose GM_xmlhttpRequest / GM.xmlHttpRequest; cannot reach jimaku.cc.')
			);
		}
		return new Promise((resolve, reject) => {
			xhr({
				method: opts.method || 'GET',
				url: opts.url,
				headers: opts.auth === false ? {} : { Authorization: state.apiKey },
				responseType: opts.responseType || 'text',
				timeout: 20000,
				onload: (r) => {
					if (r.status >= 200 && r.status < 300) resolve(r.responseText);
					else reject(new Error(`HTTP ${r.status} from jimaku.cc`));
				},
				onerror: () => reject(new Error('Network error contacting jimaku.cc')),
				ontimeout: () => reject(new Error('jimaku.cc request timed out')),
			});
		});
	}
	async function jimakuSearch(query) {
		if (!state.apiKey) throw new Error('Set your jimaku.cc API key in Settings.');
		const text = await gmReq({ url: `${API}/entries/search?anime=true&query=${encodeURIComponent(query)}` });
		return JSON.parse(text);
	}
	async function jimakuFiles(entryId, episode) {
		if (!state.apiKey) throw new Error('Set your jimaku.cc API key in Settings.');
		const ep = typeof episode === 'number' ? `?episode=${episode}` : '';
		const text = await gmReq({ url: `${API}/entries/${entryId}/files${ep}` });
		return JSON.parse(text);
	}
	async function jimakuDownload(url) {
		return await gmReq({ url, auth: false });
	}

	// ---- Auto subtitle selection (anitomy-assisted) -----------------------
	// Lazily build the vendored anitomy parser (only when first needed, so it
	// costs nothing on non-Vidstack pages). See makeAnitomy() at end of file.
	let _anitomy;
	function safeParse(name) {
		try {
			_anitomy = _anitomy || makeAnitomy();
			return _anitomy.parse(name) || null;
		} catch (e) {
			warn('anitomy parse failed', e.message);
			return null;
		}
	}

	const SUB_EXT = /\.(srt|vtt|ass|ssa)$/i;

	// Chinese-subtitle markers in release filenames, e.g. [CHS], [CHT],
	// [CHS,JPN], [JPN,CHS], [CHS&JPN]. Bounded by non-letters so we don't match
	// inside unrelated words. CHS = simplified, CHT = traditional.
	const CHINESE_RE = /(?:^|[^a-z])(?:chs|cht)(?:[^a-z]|$)/i;
	const isChineseSub = (name) => CHINESE_RE.test(name);
	// Drop Chinese-sub files up front (when enabled) so they're excluded from
	// both the browse list and every auto-selection step (incl. group matching).
	const dropChinese = (files) => (state.excludeChinese ? (files || []).filter((f) => !isChineseSub(f.name)) : files || []);

	const normGroup = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
	// Bracketed tokens that are clearly NOT a release group (hashes, resolutions,
	// language tags) so we don't mistake them for one.
	const looksLikeNonGroup = (s) => {
		const t = (s || '').trim();
		return (
			/^[0-9a-f]{8}$/i.test(t) || // CRC32 checksum
			/^\d{3,4}p?$/i.test(t) || // 1080 / 1080p
			/\d{3,4}x\d{3,4}/.test(t) || // 1280x720
			/^(?:chs|cht|jpn|eng|jp|en|sc|tc|gb|big5)(?:[,&+]\s*(?:chs|cht|jpn|eng))*$/i.test(t) // language tags
		);
	};
	// The fansub release group, conventionally the first bracketed token (or a
	// trailing one). anitomy@0.0.35 has its release-group pass stubbed out, so we
	// extract it ourselves and only fall back to anitomy.
	const fileGroup = (name) => {
		const base = String(name || '').replace(/\.[a-z0-9]{1,4}$/i, '');
		let m = base.match(/^[\s_.]*[[(]([^\])]{1,40})[)\]]/);
		if (m && !looksLikeNonGroup(m[1])) return m[1].trim();
		m = base.match(/[[(]([^\])]{1,40})[)\]][\s_.]*$/);
		if (m && !looksLikeNonGroup(m[1])) return m[1].trim();
		const info = safeParse(name);
		return (info && info.release && info.release.group) || '';
	};
	const stickyGroupFor = (showKey) => (state.stickGroup && showKey ? state.groupByShow[showKey] || '' : '');

	// Rank candidate files for a given episode, using anitomy to read the
	// episode number / release info out of each filename.
	function pickBestFile(files, episode) {
		const usable = dropChinese((files || []).filter((f) => SUB_EXT.test(f.name)));
		if (!usable.length) return null;
		const stickyNorm = normGroup(stickyGroupFor(state.detected && state.detected.showKey));
		const scored = usable.map((f) => {
			const info = safeParse(f.name);
			const epNum = info && info.episode && info.episode.number != null ? Number(info.episode.number) : null;
			let score = 0;
			if (episode != null) {
				if (epNum === episode) score += 100;
				else if (epNum != null) score -= 100; // names a different, single episode
				// epNum == null → batch / unnamed: leave neutral, could still contain it
			}
			// Prefer the release group already chosen for this show (sticky). If a
			// candidate has no parseable release group, just ignore it here — it's
			// neither rewarded nor penalised, so it can still win on other merits.
			const fg = normGroup(fileGroup(f.name));
			if (stickyNorm && fg && fg === stickyNorm) score += 50;
			if (state.preferAss && /\.(ass|ssa)$/i.test(f.name)) score += 10;
			const res = (info && info.video && info.video.resolution) || '';
			if (/1080/.test(res)) score += 3;
			else if (/720/.test(res)) score += 1;
			const src = ((info && info.source) || '').toLowerCase();
			if (/web/.test(src) || /web|crunchy|amazon|netflix|cr|subsplease|erai-raws/i.test(f.name)) score += 4;
			if (/\.srt$/i.test(f.name)) score += 1;
			if (/\.(7z|zip|rar)$/i.test(f.name)) score -= 100;
			if (/\.sup(\.|$)/i.test(f.name)) score -= 80;
			return { f, score };
		});
		scored.sort((a, b) => b.score - a.score);
		const top = scored[0];
		return top && top.score >= 0 ? top.f : null;
	}

	// Confidently match a jimaku entry to the detected show without user input.
	// Returns null when genuinely ambiguous, so we don't auto-load the wrong show.
	const normTitle = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
	function confidentEntry(list, det) {
		if (!list || !list.length) return null;
		const cached = det.showKey ? state.entryCache[det.showKey] : null;
		const hit = cached && list.find((e) => e.id === cached);
		if (hit) return hit;
		const q = normTitle(det.showTitle);
		if (!q) return null;
		const namesOf = (e) => [e.name, e.english_name, e.japanese_name].filter(Boolean).map(normTitle);
		// Prefer a verified entry over an unverified one at each confidence level.
		const tiers = [
			(e) => namesOf(e).includes(q), // exact (normalised)
			(e) => namesOf(e).some((n) => n.startsWith(q) || q.startsWith(n)), // prefix
			(e) => namesOf(e).some((n) => n.includes(q) || q.includes(n)), // substring either way
		];
		for (const test of tiers) {
			const m = list.find((e) => !e.flags?.unverified && test(e)) || list.find((e) => test(e));
			if (m) return m;
		}
		return list.length === 1 ? list[0] : null;
	}

	const autoKey = (det) => (det ? det.showKey + '#' + (det.episodeNumber ?? '') : '');
	let autoState = { key: '', running: false };

	// Search jimaku and load the best-matching file for the current episode,
	// fully automatically. Guarded so it runs at most once per show+episode and
	// never clobbers a file the user picked. Triggered on mount / detection change.
	async function maybeAutoLoad() {
		if (!state.autoSub || !state.apiKey) return;
		if (!findVidstackPlayer()) return;
		const det = state.detected;
		if (!det || !det.showTitle || det.episodeNumber == null) return; // need an episode to match
		const key = autoKey(det);
		if (autoState.running || autoState.key === key) return;
		autoState.key = key; // claim before awaiting so concurrent ticks dedupe
		autoState.running = true;
		try {
			info('auto: searching jimaku for', JSON.stringify(det.showTitle), '· ep', det.episodeNumber);
			const list = await jimakuSearch(det.showTitle);
			const entry = confidentEntry(list, det);
			if (!entry) {
				info(
					'auto: no confident entry for',
					JSON.stringify(det.showTitle),
					'· results:',
					(list || []).map((e) => e.name)
				);
				return;
			}
			info('auto: matched entry', JSON.stringify(entry.name), '(id', entry.id + ')');
			state.entries = list || [];
			state.selectedEntry = entry;
			if (det.showKey) {
				state.entryCache[det.showKey] = entry.id;
				set(KEYS.entryCache, state.entryCache);
			}
			const files = await jimakuFiles(entry.id, det.episodeNumber);
			state.files = files || [];
			const best = pickBestFile(state.files, det.episodeNumber);
			if (!best) {
				info('auto: no suitable file for ep', det.episodeNumber, '· files:', state.files.map((f) => f.name));
				return;
			}
			const text = await jimakuDownload(best.url);
			applySubs(parseByName(text, best.name), best.name);
			info('auto: loaded', JSON.stringify(best.name));
			toast(`Auto-loaded ${best.name}`);
			pulseFab();
		} catch (e) {
			warn('auto-load failed', e.message);
			autoState.key = ''; // allow a retry on the next detection tick
		} finally {
			autoState.running = false;
			renderPanel();
		}
	}

	// Only the Vidstack player element counts as a mount target, so the script
	// stays completely idle on every other site (we run on *://*/*).
	function findPlayerContainer() {
		return findVidstackPlayer();
	}

	const STYLES = `
	#jp-overlay {
		position: absolute; left: 0; right: 0; pointer-events: none;
		font-family: "Yu Gothic", "Meiryo", "Noto Sans JP", "Hiragino Sans", sans-serif;
		z-index: 50; text-align: center;
	}
	#jp-overlay.bottom { bottom: 8%; }
	#jp-overlay.top { top: 5%; }
	#jp-overlay-text {
		display: none;
		max-width: 92%; padding: 6px 14px;
		font-size: calc(2.4vw * var(--jp-scale, 1));
		line-height: 1.45; color: #fff; white-space: pre-wrap; text-align: center;
		text-shadow: -2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000, 0 0 10px rgba(0,0,0,.85);
		background: rgba(0,0,0,.35); border-radius: 4px;
		pointer-events: auto; cursor: pointer;
	}

	#jp-fab {
		position: absolute; right: 12px; top: 12px; z-index: 60;
		width: 38px; height: 38px; border-radius: 8px;
		background: rgba(20,20,30,.78); color: #fff;
		display: flex; align-items: center; justify-content: center;
		font-weight: 700; font-size: 14px; cursor: pointer;
		border: 1px solid rgba(255,255,255,.15);
		opacity: 0; transition: opacity .2s, background .2s;
		user-select: none; pointer-events: auto;
		font-family: "Yu Gothic", "Noto Sans JP", sans-serif;
	}
	#jp-host:hover #jp-fab, #jp-fab:focus-visible, #jp-fab.has-active { opacity: 1; }
	#jp-fab:hover { background: #e83450; }
	#jp-fab.has-subs::after {
		content: ''; position: absolute; right: 4px; bottom: 4px;
		width: 8px; height: 8px; background: #4ade80; border-radius: 50%;
	}
	#jp-fab.pulse { animation: jp-fab-pulse .9s ease-out 1; }
	@keyframes jp-fab-pulse {
		0% { box-shadow: 0 0 0 0 rgba(74,222,128,.85); background: #16a34a; }
		60% { box-shadow: 0 0 0 14px rgba(74,222,128,0); background: #16a34a; }
		100% { box-shadow: 0 0 0 0 rgba(74,222,128,0); }
	}

	#jp-panel {
		position: absolute; right: 12px; top: 58px; z-index: 70;
		width: 340px; max-width: calc(100% - 24px);
		max-height: min(70vh, 600px);
		background: rgba(18,18,26,.97); color: #fff;
		border-radius: 10px; box-shadow: 0 10px 40px rgba(0,0,0,.5);
		border: 1px solid rgba(255,255,255,.1);
		display: none; flex-direction: column; overflow: hidden;
		pointer-events: auto;
		font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
	}
	#jp-panel.open { display: flex; }
	#jp-panel header {
		display: flex; align-items: center; gap: 8px;
		padding: 10px 12px; background: linear-gradient(135deg,#e83450,#ff6b6b);
		font-weight: 700;
	}
	#jp-panel header .title { flex: 1; }
	#jp-panel header button { background: transparent; border: 0; color: #fff; cursor: pointer; font-size: 18px; }
	#jp-panel .tabs { display: flex; border-bottom: 1px solid #2c2c3a; }
	#jp-panel .tabs button {
		flex: 1; background: transparent; color: #ccc; border: 0;
		padding: 8px 4px; font-size: 13px; cursor: pointer;
		border-bottom: 2px solid transparent;
	}
	#jp-panel .tabs button.active { color: #fff; border-color: #e83450; }
	#jp-panel .tab-body { padding: 12px; overflow: auto; flex: 1; }
	#jp-panel .row { display: flex; gap: 6px; align-items: center; }
	#jp-panel .row + .row, #jp-panel .stack > * + * { margin-top: 8px; }
	#jp-panel input[type=text], #jp-panel input[type=password], #jp-panel input[type=number], #jp-panel textarea {
		flex: 1; min-width: 0; padding: 6px 8px; border-radius: 5px; border: 1px solid #333a50;
		background: #11141d; color: #fff; font: inherit;
	}
	#jp-panel textarea {
		width: 100%; box-sizing: border-box; resize: vertical;
		font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12px;
	}
	#jp-panel input[type=number] { flex: 0 0 56px; }
	#jp-panel button.btn { white-space: nowrap; flex-shrink: 0; }
	#jp-panel button.btn {
		background: #2a2d3a; color: #fff; border: 0; border-radius: 5px;
		padding: 6px 10px; cursor: pointer; font-size: 13px;
	}
	#jp-panel button.btn:hover { background: #3a3d4d; }
	#jp-panel button.btn.primary { background: #e83450; }
	#jp-panel button.btn.primary:hover { background: #ff4560; }
	#jp-panel .muted { color: #9aa0b4; font-size: 12px; }
	#jp-panel .pill { font-size: 11px; padding: 1px 6px; border-radius: 4px; background: #2a2d3a; }
	#jp-panel .pill.web { background: #14532d; }
	#jp-panel .pill.bd { background: #4c1d95; }
	#jp-panel .pill.ass { background: #1d4ed8; }
	#jp-panel .pill.unverified { background: #6b2728; }
	#jp-panel ul.list { list-style: none; padding: 0; margin: 0; }
	#jp-panel ul.list li {
		padding: 8px; border-radius: 6px; cursor: pointer;
		display: flex; gap: 8px; align-items: center;
	}
	#jp-panel ul.list li:hover { background: #232636; }
	#jp-panel ul.list li .meta { flex: 1; min-width: 0; }
	#jp-panel ul.list li .name {
		overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
	}
	#jp-panel .err { color: #ff8585; font-size: 12px; }
	#jp-panel .ok { color: #65e08c; font-size: 12px; }
	#jp-panel .footer { padding: 8px 12px; border-top: 1px solid #2c2c3a; display: flex; gap: 6px; }
	#jp-panel .footer .muted { font-size: 11px; flex: 1; }
	#jp-panel .align-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
	#jp-panel kbd {
		font-family: ui-monospace, SFMono-Regular, monospace; font-size: 11px;
		background: #2a2d3a; border-radius: 3px; padding: 1px 5px;
	}

	/* Hide Vidstack's native captions overlay when the user opts in */
	html.jp-hide-native media-captions,
	html.jp-hide-native .vds-captions,
	html.jp-hide-native [data-part="cue-display"],
	html.jp-hide-native [data-part="captions"] {
		display: none !important;
		opacity: 0 !important;
		visibility: hidden !important;
	}
	html.jp-hide-native video::cue { opacity: 0 !important; }
	`;


	var host = null;
	var fab = null;
	var panel = null;
	var overlay = null;

	function ensureStyles() {
		if (document.getElementById('jp-styles')) return;
		const s = document.createElement('style');
		s.id = 'jp-styles';
		s.textContent = STYLES;
		document.head.appendChild(s);
	}

	// User-supplied CSS, injected into its own <style> so it can target our
	// overlay/panel or the host page's player. Re-applied whenever it changes.
	function applyCustomCss() {
		const head = document.head || document.documentElement;
		if (!head) return;
		let el = document.getElementById('jp-custom-css');
		if (!el) {
			el = document.createElement('style');
			el.id = 'jp-custom-css';
			head.appendChild(el);
		}
		if (el.textContent !== state.customCss) el.textContent = state.customCss || '';
	}

	function ensureMounted() {
		ensureStyles();
		applyCustomCss();
		const container = findPlayerContainer();
		if (!container) return false;
		if (!host) info('container found, mounting into', container.tagName.toLowerCase(), 'position=' + getComputedStyle(container).position);

		const cs = getComputedStyle(container);
		if (cs.position === 'static') container.style.position = 'relative';

		if (!host || !container.contains(host)) {
			host = document.createElement('div');
			host.id = 'jp-host';
			host.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
			container.appendChild(host);

			overlay = document.createElement('div');
			overlay.id = 'jp-overlay';
			overlay.className = state.position;
			overlay.innerHTML = '<span id="jp-overlay-text"></span>';
			host.appendChild(overlay);

			fab = document.createElement('button');
			fab.id = 'jp-fab';
			fab.type = 'button';
			fab.textContent = '字';
			fab.title = 'Jimaku Player (J)';
			fab.addEventListener('click', (e) => {
				e.stopPropagation();
				togglePanel();
			});
			fab.addEventListener('mousedown', (e) => e.stopPropagation());
			host.appendChild(fab);

			panel = document.createElement('div');
			panel.id = 'jp-panel';
			// Don't let any click/mouse interaction inside the panel reach the
			// player below (Vidstack toggles play/pause on click).
			['click', 'mousedown', 'mouseup', 'dblclick'].forEach((evt) => {
				panel.addEventListener(evt, (e) => e.stopPropagation());
			});
			host.appendChild(panel);

			const subTextEl = overlay.querySelector('#jp-overlay-text');
			subTextEl.addEventListener('mousedown', (e) => e.stopPropagation());
			subTextEl.addEventListener('click', (e) => {
				e.stopPropagation();
				const t = overlay.textContent.trim();
				if (t) window.open('https://jisho.org/search/' + encodeURIComponent(t), '_blank');
			});

			document.documentElement.style.setProperty('--jp-scale', String(state.fontScale));
			renderPanel();
			info('mounted on player container', container.tagName.toLowerCase());
		}
		return true;
	}

	function togglePanel(force) {
		const open = typeof force === 'boolean' ? force : !state.ui.panelOpen;
		state.ui.panelOpen = open;
		if (panel) panel.classList.toggle('open', open);
		if (fab) fab.classList.toggle('has-active', open);
		if (open) renderPanel();
	}

	function setLoading(label) {
		state.ui.loading = label;
		state.ui.error = '';
		renderPanel();
	}
	function setError(msg) {
		state.ui.loading = '';
		state.ui.error = msg;
		renderPanel();
	}
	function clearMessages() {
		state.ui.loading = '';
		state.ui.error = '';
	}

	function updateVideoStatus() {
		if (fab) fab.classList.toggle('has-subs', state.subtitles.length > 0);
	}

	function renderPanel() {
		if (!panel) return;
		const det = state.detected || {};
		const tab = state.ui.tab;
		const hasKey = !!state.apiKey;

		const tabsHtml = `
			<div class="tabs">
				<button data-tab="browse" class="${tab === 'browse' ? 'active' : ''}">Browse</button>
				<button data-tab="file" class="${tab === 'file' ? 'active' : ''}">File</button>
				<button data-tab="sync" class="${tab === 'sync' ? 'active' : ''}">Sync</button>
				<button data-tab="settings" class="${tab === 'settings' ? 'active' : ''}">Settings</button>
			</div>`;

		let body = '';
		if (tab === 'browse') body = renderBrowseTab(det, hasKey);
		else if (tab === 'file') body = renderFileTab();
		else if (tab === 'sync') body = renderSyncTab();
		else if (tab === 'settings') body = renderSettingsTab();

		panel.innerHTML = `
			<header>
				<span class="title">字幕プレーヤー</span>
				<button id="jp-close" title="Close">×</button>
			</header>
			${tabsHtml}
			<div class="tab-body">${body}</div>
			<div class="footer">
				<span class="muted">
					${state.subtitles.length ? `${state.subtitles.length} subs · offset ${(state.alignment / 1000).toFixed(2)}s` : 'No subtitles loaded'}
				</span>
				<span class="muted">${state.videoFound ? '● video' : '○ video'}</span>
			</div>`;

		panel.querySelector('#jp-close').onclick = () => togglePanel(false);
		panel.querySelectorAll('.tabs button').forEach((b) => {
			b.onclick = () => {
				state.ui.tab = b.dataset.tab;
				clearMessages();
				renderPanel();
			};
		});
		bindPanelHandlers(tab);
	}

	function renderBrowseTab(det, hasKey) {
		if (!hasKey) {
			return `
				<div class="stack">
					<p>Add your jimaku.cc API key in <strong>Settings</strong> to browse and download subtitles.</p>
					<p class="muted">Get one at <a target="_blank" rel="noopener noreferrer" href="https://jimaku.cc/profile">jimaku.cc/profile</a>.</p>
				</div>`;
		}
		const detLine = det.showTitle
			? `<p class="muted">Detected: <strong>${escapeHtml(det.showTitle)}</strong>${
					det.episodeNumber ? ` · Ep ${det.episodeNumber}` : ''
				}</p>`
			: `<p class="muted">No show detected from page — type one below.</p>`;

		const savedGroup = det.showKey ? state.groupByShow[det.showKey] : '';
		const groupLine = savedGroup
			? `<p class="muted">Release group: <strong>${escapeHtml(savedGroup)}</strong>${
					state.stickGroup ? ' <span class="pill">sticky</span>' : ''
				}</p>`
			: '';

		const queryDefault = state.ui.queryDraft ?? det.showTitle ?? '';
		const epDefault = state.ui.episodeDraft ?? (det.episodeNumber ?? '');

		const search = `
			<div class="row">
				<input id="jp-query" type="text" value="${escapeAttr(queryDefault)}" placeholder="Show title">
				<input id="jp-ep" type="number" min="0" max="9999" value="${escapeAttr(String(epDefault))}" title="Episode">
				<button class="btn primary" id="jp-search-btn">Search</button>
			</div>`;

		let entries = '';
		if (state.entries.length > 1 && !state.selectedEntry) {
			entries = `<ul class="list">${state.entries
				.map(
					(e) => `<li data-entry-id="${e.id}">
				<div class="meta">
					<div class="name">${escapeHtml(e.name)}</div>
					${e.english_name && e.english_name !== e.name ? `<div class="muted">${escapeHtml(e.english_name)}</div>` : ''}
				</div>
				${e.flags?.unverified ? '<span class="pill unverified">Unverified</span>' : ''}
				${e.flags?.movie ? '<span class="pill">Movie</span>' : ''}
			</li>`
				)
				.join('')}</ul>`;
		}

		let files = '';
		if (state.selectedEntry) {
			const sortedFiles = sortFiles(dropChinese(state.files), state.preferAss);
			files = `
				<div class="row" style="margin-top:8px;">
					<strong style="flex:1">${escapeHtml(state.selectedEntry.name)}</strong>
					<button class="btn" id="jp-change-show">Change</button>
				</div>
				${
					sortedFiles.length
						? `<ul class="list">${sortedFiles
								.map(
									(f, i) => `<li data-file-idx="${i}">
									<div class="meta">
										<div class="name" title="${escapeAttr(f.name)}">${escapeHtml(f.name)}</div>
										<div class="muted">${formatSize(f.size)} · ${formatDate(f.last_modified)}</div>
									</div>
									${tagsForFile(f.name)}
								</li>`
								)
								.join('')}</ul>`
						: `<p class="muted" style="margin-top:6px">No files for episode ${epDefault || '?'}. <button class="btn" id="jp-show-all">Show all</button></p>`
				}
			`;
		}

		return `
			<div class="stack">
				${detLine}
				${groupLine}
				${search}
				${state.ui.loading ? `<p class="muted">${escapeHtml(state.ui.loading)}…</p>` : ''}
				${state.ui.error ? `<p class="err">${escapeHtml(state.ui.error)}</p>` : ''}
				${entries}
				${files}
			</div>`;
	}

	function renderFileTab() {
		return `
			<div class="stack">
				<p>Load a subtitle file from your computer.</p>
				<div class="row">
					<input id="jp-file-input" type="file" accept=".srt,.ass,.ssa,.vtt" style="flex:1">
				</div>
				${state.subtitlesFile ? `<p class="ok">Loaded: ${escapeHtml(state.subtitlesFile)} (${state.subtitles.length} lines)</p>` : ''}
				${state.ui.error ? `<p class="err">${escapeHtml(state.ui.error)}</p>` : ''}
			</div>`;
	}

	function renderSyncTab() {
		const a = (state.alignment / 1000).toFixed(2);
		const help =
			state.alignment === 0
				? 'Subtitles use the video timing.'
				: state.alignment > 0
				? `Subtitles delayed by ${a}s.`
				: `Subtitles hastened by ${(-state.alignment / 1000).toFixed(2)}s.`;

		const subs = state.subtitles;
		let nowBlock = '';
		if (subs.length) {
			const t = state.videoTimeMs + state.alignment;
			const curIdx = findSubIndex(t);
			let nextIdx = curIdx >= 0 ? curIdx + 1 : subs.findIndex((s) => s.start > t);
			if (nextIdx >= subs.length) nextIdx = -1;
			const curText = curIdx >= 0 ? subs[curIdx].text : '— (no subtitle showing)';
			const nextLine =
				nextIdx >= 0
					? `In ${((subs[nextIdx].start - t) / 1000).toFixed(1)}s: ${escapeHtml(subs[nextIdx].text.split('\n')[0]).slice(0, 60)}`
					: '— (end of subtitles)';
			nowBlock = `
				<div class="muted" style="border:1px solid #2a2d3a;border-radius:6px;padding:8px">
					<div style="color:#fff">${escapeHtml(curText.split('\n')[0]).slice(0, 80)}</div>
					<div style="margin-top:4px">${nextLine}</div>
				</div>`;
		}

		return `
			<div class="stack">
				<p class="muted">Current offset: <strong>${a}s</strong> — ${help}</p>
				${nowBlock}
				<button class="btn primary" id="jp-anchor-current" ${subs.length ? '' : 'disabled'}>Anchor sub to NOW <kbd>S</kbd></button>
				<button class="btn" id="jp-anchor-first" ${subs.length ? '' : 'disabled'}>Anchor first sub to NOW</button>
				<p class="muted">
					<strong>Fastest way:</strong> while watching, press <kbd>S</kbd> the instant you hear a line begin. The currently-shown (or next upcoming) subtitle gets snapped to that moment. Press <kbd>B</kbd> right after to rewind and verify. The "first sub" button is for episode starts where no sub is showing yet.
				</p>

				<div class="align-grid">
					<button class="btn" data-shift="-1000">−1.0s (subs earlier)</button>
					<button class="btn" data-shift="1000">+1.0s (subs later)</button>
					<button class="btn" data-shift="-200">−0.2s</button>
					<button class="btn" data-shift="200">+0.2s</button>
				</div>
				<div class="row">
					<button class="btn" id="jp-reset-align">Reset to 0</button>
					<button class="btn" id="jp-rewind">⏪ Rewind to last sub <kbd>B</kbd></button>
				</div>
				<p class="muted">Hotkeys: <kbd>Z</kbd>/<kbd>X</kbd> nudge ±0.2s · with <kbd>Shift</kbd> ±1s.</p>
			</div>`;
	}

	function renderSettingsTab() {
		return `
			<div class="stack">
				<label>jimaku.cc API key</label>
				<div class="row">
					<input id="jp-apikey" type="password" autocomplete="off" placeholder="Paste your API key" value="${escapeAttr(state.apiKey)}">
					<button class="btn primary" id="jp-save-key">Save</button>
				</div>
				<p class="muted">Get one at <a target="_blank" rel="noopener noreferrer" href="https://jimaku.cc/profile">jimaku.cc/profile</a>. Stored locally only.</p>

				<label class="row" style="margin-top:8px"><input type="checkbox" id="jp-auto-sub" ${state.autoSub ? 'checked' : ''}> Automatically find &amp; load subtitles for the current episode</label>
				<p class="muted">Searches jimaku.cc on load and picks the best file using filename parsing. Needs an API key and a detectable episode number.</p>

				<label class="row" style="margin-top:8px"><input type="checkbox" id="jp-exclude-chinese" ${state.excludeChinese ? 'checked' : ''}> Exclude Chinese subtitle files (CHS / CHT)</label>

				<label class="row" style="margin-top:8px"><input type="checkbox" id="jp-stick-group" ${state.stickGroup ? 'checked' : ''}> Stick to the same release group across episodes</label>

				<label class="row" style="margin-top:8px"><input type="checkbox" id="jp-prefer-ass" ${state.preferAss ? 'checked' : ''}> Prefer ASS files when available</label>

				<label>Subtitle font scale (${Math.round(state.fontScale * 100)}%)</label>
				<input id="jp-scale" type="range" min="0.6" max="2.5" step="0.1" value="${state.fontScale}">

				<label>Position</label>
				<div class="row">
					<button class="btn" data-pos="bottom" ${state.position === 'bottom' ? 'style="background:#e83450"' : ''}>Bottom</button>
					<button class="btn" data-pos="top" ${state.position === 'top' ? 'style="background:#e83450"' : ''}>Top</button>
				</div>

				<label style="margin-top:8px">Custom CSS</label>
				<textarea id="jp-custom-css" rows="5" spellcheck="false" placeholder="/* Injected into the page. Style #jp-overlay, #jp-panel, the player, etc. */">${escapeHtml(state.ui.cssDraft ?? state.customCss)}</textarea>
				<div class="row">
					<button class="btn primary" id="jp-save-css">Apply CSS</button>
					<span class="muted" style="flex:1">Applied live and saved locally.</span>
				</div>

				<p class="muted">Hotkeys: <kbd>S</kbd> sync · <kbd>B</kbd> rewind to last sub · <kbd>J</kbd> open panel · <kbd>H</kbd> hide subs · <kbd>I</kbd> flip position · <kbd>Z</kbd>/<kbd>X</kbd> nudge ±0.2s (Shift = ±1s).</p>
			</div>`;
	}

	function bindPanelHandlers(tab) {
		if (tab === 'browse') {
			const q = panel.querySelector('#jp-query');
			const e = panel.querySelector('#jp-ep');
			if (q) q.addEventListener('input', () => (state.ui.queryDraft = q.value));
			if (e)
				e.addEventListener('input', () => (state.ui.episodeDraft = e.value ? parseInt(e.value, 10) : ''));
			panel.querySelector('#jp-search-btn')?.addEventListener('click', doSearch);
			q?.addEventListener('keydown', (ev) => ev.key === 'Enter' && doSearch());
			panel.querySelectorAll('[data-entry-id]').forEach((li) => {
				li.onclick = () => pickEntry(parseInt(li.dataset.entryId, 10));
			});
			panel.querySelector('#jp-change-show')?.addEventListener('click', () => {
				state.selectedEntry = null;
				state.files = [];
				if (state.detected?.showKey) {
					delete state.entryCache[state.detected.showKey];
					set(KEYS.entryCache, state.entryCache);
				}
				renderPanel();
			});
			panel.querySelector('#jp-show-all')?.addEventListener('click', () => loadFiles(undefined));
			panel.querySelectorAll('[data-file-idx]').forEach((li) => {
				li.onclick = () => loadFileFromList(parseInt(li.dataset.fileIdx, 10));
			});
		} else if (tab === 'file') {
			panel.querySelector('#jp-file-input')?.addEventListener('change', onFileChosen);
		} else if (tab === 'sync') {
			panel.querySelectorAll('[data-shift]').forEach((b) => {
				b.onclick = () => adjustAlignment(parseInt(b.dataset.shift, 10));
			});
			panel.querySelector('#jp-reset-align')?.addEventListener('click', () => {
				state.alignment = 0;
				persistAlignment();
				renderPanel();
			});
			panel.querySelector('#jp-rewind')?.addEventListener('click', rewindToLastSub);
			panel.querySelector('#jp-anchor-first')?.addEventListener('click', anchorFirstSub);
			panel.querySelector('#jp-anchor-current')?.addEventListener('click', anchorCurrentSub);
		} else if (tab === 'settings') {
			panel.querySelector('#jp-save-key')?.addEventListener('click', () => {
				state.apiKey = panel.querySelector('#jp-apikey').value.trim();
				set(KEYS.apiKey, state.apiKey);
				toast('API key saved');
				renderPanel();
				maybeAutoLoad();
			});
			panel.querySelector('#jp-auto-sub')?.addEventListener('change', (ev) => {
				state.autoSub = ev.target.checked;
				set(KEYS.autoSub, state.autoSub);
				if (state.autoSub) {
					autoState.key = ''; // let it attempt now
					maybeAutoLoad();
				}
				renderPanel();
			});
			panel.querySelector('#jp-exclude-chinese')?.addEventListener('change', (ev) => {
				state.excludeChinese = ev.target.checked;
				set(KEYS.excludeChinese, state.excludeChinese);
				renderPanel();
			});
			panel.querySelector('#jp-stick-group')?.addEventListener('change', (ev) => {
				state.stickGroup = ev.target.checked;
				set(KEYS.stickGroup, state.stickGroup);
				renderPanel();
			});
			panel.querySelector('#jp-prefer-ass')?.addEventListener('change', (ev) => {
				state.preferAss = ev.target.checked;
				set(KEYS.preferAss, state.preferAss);
				renderPanel();
			});
			const cssBox = panel.querySelector('#jp-custom-css');
			cssBox?.addEventListener('input', () => (state.ui.cssDraft = cssBox.value));
			panel.querySelector('#jp-save-css')?.addEventListener('click', () => {
				state.customCss = (state.ui.cssDraft ?? cssBox?.value ?? '').trim();
				state.ui.cssDraft = undefined;
				set(KEYS.customCss, state.customCss);
				applyCustomCss();
				toast('Custom CSS applied');
			});
			panel.querySelector('#jp-scale')?.addEventListener('input', (ev) => {
				state.fontScale = parseFloat(ev.target.value);
				document.documentElement.style.setProperty('--jp-scale', String(state.fontScale));
				set(KEYS.fontScale, state.fontScale);
				renderPanel();
			});
			panel.querySelectorAll('[data-pos]').forEach((b) => {
				b.onclick = () => {
					state.position = b.dataset.pos;
					set(KEYS.position, state.position);
					if (overlay) overlay.className = state.position;
					renderPanel();
				};
			});
		}
	}

	async function doSearch() {
		const det = state.detected || {};
		const query = (state.ui.queryDraft ?? det.showTitle ?? '').trim();
		if (!query) {
			setError('Type a show title to search.');
			return;
		}
		state.entries = [];
		state.selectedEntry = null;
		state.files = [];
		setLoading('Searching jimaku.cc');
		try {
			const list = await jimakuSearch(query);
			state.entries = list || [];
			clearMessages();

			if (state.entries.length === 0) {
				setError(`No matches for "${query}".`);
				return;
			}
			const cached = det.showKey ? state.entryCache[det.showKey] : null;
			const cacheHit = cached ? state.entries.find((e) => e.id === cached) : null;
			const exact =
				!cacheHit &&
				state.entries.find(
					(e) => !e.flags?.unverified && (e.name === query || e.english_name === query)
				);
			const auto = cacheHit || exact || (state.entries.length === 1 ? state.entries[0] : null);
			if (auto) await pickEntry(auto.id);
			else renderPanel();
		} catch (e) {
			setError(e.message);
		}
	}
	async function pickEntry(entryId) {
		const entry = state.entries.find((x) => x.id === entryId);
		if (!entry) return;
		state.selectedEntry = entry;
		if (state.detected?.showKey) {
			state.entryCache[state.detected.showKey] = entry.id;
			set(KEYS.entryCache, state.entryCache);
		}
		const ep = state.ui.episodeDraft ?? state.detected?.episodeNumber;
		await loadFiles(typeof ep === 'number' ? ep : undefined);
	}
	async function loadFiles(episode) {
		if (!state.selectedEntry) return;
		setLoading('Loading files');
		try {
			state.files = await jimakuFiles(state.selectedEntry.id, episode);
			clearMessages();
			renderPanel();
		} catch (e) {
			setError(e.message);
		}
	}
	async function loadFileFromList(idx) {
		// Must mirror the list rendered in renderBrowseTab so indices line up.
		const sorted = sortFiles(dropChinese(state.files), state.preferAss);
		const f = sorted[idx];
		if (!f) return;
		const ext = (f.name.split('.').pop() || '').toLowerCase();
		if (!['srt', 'vtt', 'ass', 'ssa'].includes(ext)) {
			setError(`Unsupported file: .${ext}`);
			return;
		}
		setLoading(`Downloading ${f.name}`);
		try {
			const text = await jimakuDownload(f.url);
			applySubs(parseByName(text, f.name), f.name);
			toast(`Loaded ${f.name}`);
			togglePanel(false);
		} catch (e) {
			setError(e.message);
		}
	}
	function onFileChosen(ev) {
		const file = ev.target.files?.[0];
		if (!file) return;
		const reader = new FileReader();
		reader.onload = () => {
			const subs = parseByName(reader.result, file.name);
			applySubs(subs, file.name);
			toast(`Loaded ${file.name}`);
			togglePanel(false);
		};
		reader.onerror = () => setError('Failed to read file');
		reader.readAsText(file, 'UTF-8');
	}

	function applySubs(subs, filename) {
		state.subtitles = subs;
		state.subtitlesFile = filename;
		state.history = [];
		state.currentSubIndex = -1;
		// Mark this show+episode as handled so auto-load won't override a choice.
		autoState.key = autoKey(state.detected);
		// Remember this file's release group for the show, so other episodes can
		// stick to the same group when auto-selecting. Manual picks update it too.
		const key = state.detected?.showKey;
		if (key) {
			const g = fileGroup(filename);
			if (g && state.groupByShow[key] !== g) {
				state.groupByShow[key] = g;
				set(KEYS.groupByShow, state.groupByShow);
				info('release group for show set to', JSON.stringify(g));
			}
		}
		updateVideoStatus();
		renderPanel();
	}

	function adjustAlignment(deltaMs) {
		state.alignment += deltaMs;
		persistAlignment();
		renderPanel();
	}
	function persistAlignment() {
		const key = state.detected?.showKey;
		if (key) {
			state.alignByShow[key] = state.alignment;
			set(KEYS.alignBy, state.alignByShow);
		}
	}

	function rewindToLastSub() {
		const last = state.history[0];
		if (last) seekTo(last.start - state.alignment);
	}

	function pulseFab() {
		if (!fab) return;
		fab.classList.remove('pulse');
		void fab.offsetWidth;
		fab.classList.add('pulse');
	}

	function anchorFirstSub() {
		if (!state.subtitles.length) {
			toast('No subtitles loaded');
			return;
		}
		state.alignment = state.subtitles[0].start - state.videoTimeMs;
		persistAlignment();
		const preview = state.subtitles[0].text.split('\n')[0].slice(0, 40);
		toast(`✓ First sub anchored: "${preview}"`);
		pulseFab();
		renderPanel();
	}
	function anchorCurrentSub() {
		if (!state.subtitles.length) {
			toast('No subtitles loaded');
			return;
		}
		const t = state.videoTimeMs + state.alignment;
		let idx = findSubIndex(t);
		if (idx < 0) {
			idx = state.subtitles.findIndex((s) => s.start > t);
			if (idx < 0) idx = state.subtitles.length - 1;
		}
		const target = state.subtitles[idx];
		state.alignment = target.start - state.videoTimeMs;
		persistAlignment();
		const preview = target.text.split('\n')[0].slice(0, 40);
		toast(`✓ Anchored: "${preview}"`);
		pulseFab();
		renderPanel();
	}

	function sortFiles(list, preferAss) {
		const score = (f) => {
			const n = f.name.toLowerCase();
			let s = 0;
			if (preferAss && /\.(ass|ssa)$/.test(n)) s += 5;
			if (/web|crunchy|amazon|netflix|subsplease|erai-raws/.test(n)) s += 3;
			if (/\.srt$/.test(n)) s += 1;
			if (/\.7z$|\.zip$|\.rar$/.test(n)) s -= 10;
			if (/\.sup(\.|$)/.test(n)) s -= 8;
			return s;
		};
		return [...list].sort((a, b) => score(b) - score(a));
	}
	function tagsForFile(name) {
		const out = [];
		if (/\.(ass|ssa)$/i.test(name)) out.push('<span class="pill ass">ASS</span>');
		if (/web|crunchy|amazon|netflix/i.test(name)) out.push('<span class="pill web">WEB</span>');
		if (/bd|bluray|blu-ray/i.test(name)) out.push('<span class="pill bd">BD</span>');
		return out.join('');
	}
	const formatSize = (b) =>
		b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(2)} MB`;
	const formatDate = (s) => {
		try {
			return new Date(s).toLocaleDateString();
		} catch {
			return s;
		}
	};
	function escapeHtml(s) {
		return String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
	}
	const escapeAttr = escapeHtml;

	function tick() {
		if (!overlay) return;
		const el = overlay.querySelector('#jp-overlay-text');
		if (!state.isEnabled || state.subtitles.length === 0) {
			if (el) {
				el.textContent = '';
				el.style.display = 'none';
			}
			return;
		}
		const t = state.videoTimeMs + state.alignment;
		const active = findActiveSubs(t);
		if (active.length) {
			// Multiple lines can be active at once (e.g. .ass lines that share a
			// starting timestamp) — show them all, one per row.
			const text = active.map((i) => state.subtitles[i].text).join('\n');
			if (el && el.textContent !== text) el.textContent = text;
			if (el) el.style.display = 'inline-block';
			const idx = active[0];
			if (idx !== state.currentSubIndex) {
				state.currentSubIndex = idx;
				const fresh = active.map((i) => state.subtitles[i]);
				state.history = [...fresh.reverse(), ...state.history].slice(0, 10);
			}
		} else {
			if (el) {
				el.textContent = '';
				el.style.display = 'none';
			}
			state.currentSubIndex = -1;
		}
	}
	function findSubIndex(t) {
		const a = state.subtitles;
		let lo = 0;
		let hi = a.length - 1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			const s = a[mid];
			if (t < s.start) hi = mid - 1;
			else if (t > s.end) lo = mid + 1;
			else return mid;
		}
		return -1;
	}
	// All subtitles active at time t, in array order. Subtitles are sorted by
	// start, so every active line lives in the prefix where start <= t; we walk
	// that prefix back from the last such entry and keep the ones still on-screen.
	function findActiveSubs(t) {
		const a = state.subtitles;
		// Rightmost index whose start <= t.
		let lo = 0;
		let hi = a.length - 1;
		let last = -1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			if (a[mid].start <= t) {
				last = mid;
				lo = mid + 1;
			} else {
				hi = mid - 1;
			}
		}
		const out = [];
		// No subtitle realistically lasts longer than this, so we can stop walking
		// back once a line started more than the window before t.
		const WINDOW_MS = 60000;
		for (let i = last; i >= 0 && a[i].start >= t - WINDOW_MS; i--) {
			if (a[i].end >= t) out.unshift(i);
		}
		return out;
	}

	let toastEl;
	function toast(msg) {
		if (!toastEl) {
			toastEl = document.createElement('div');
			toastEl.style.cssText =
				'position:fixed;left:50%;top:24px;transform:translateX(-50%);background:#222;color:#fff;padding:8px 14px;border-radius:6px;font:13px sans-serif;z-index:2147483647;opacity:0;transition:opacity .2s;pointer-events:none;';
			document.body.appendChild(toastEl);
		}
		toastEl.textContent = msg;
		toastEl.style.opacity = '1';
		clearTimeout(toast._t);
		toast._t = setTimeout(() => (toastEl.style.opacity = '0'), 1800);
	}

	document.addEventListener('keydown', (e) => {
		if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
		if (e.metaKey || e.ctrlKey || e.altKey) return;
		const k = e.key.toLowerCase();
		if ('jshibzx'.includes(k)) {
			info('key', k, 'player=' + document.querySelectorAll(PLAYER_SEL).length, 'mounted=' + !!host);
		}
		if (k === 'j') {
			ensureMounted();
			togglePanel();
		} else if (k === 's') {
			anchorCurrentSub();
		} else if (k === 'h') {
			state.isEnabled = !state.isEnabled;
			toast(state.isEnabled ? 'Subs on' : 'Subs off');
		} else if (k === 'i') {
			state.position = state.position === 'bottom' ? 'top' : 'bottom';
			set(KEYS.position, state.position);
			if (overlay) overlay.className = state.position;
		} else if (k === 'b') {
			rewindToLastSub();
		} else if (k === 'z') {
			adjustAlignment(e.shiftKey ? -1000 : -200);
		} else if (k === 'x') {
			adjustAlignment(e.shiftKey ? 1000 : 200);
		}
	});

	// Single watcher driving everything. Vidstack often mounts late, and SPA
	// sites swap the player / change the URL between episodes without a reload —
	// none of which fire a reliable single DOM event. So we re-check on DOM
	// mutations, on history events, and on a 1s heartbeat. Each concern is
	// idempotent and guarded, so re-running is cheap:
	//   - ensureMounted(): mounts when the player appears, remounts if swapped.
	//   - refreshDetection(): re-reads title/episode (also catches async-populated
	//     titles and SPA navigation) and fires maybeAutoLoad() when ready.
	let _lastDiag = 0;
	let lastHref = '';
	let lastPlayerSeen = false;
	function watch() {
		ensureMounted();
		refreshDetection();

		const hasPlayer = !!findVidstackPlayer();
		if (hasPlayer !== lastPlayerSeen) {
			lastPlayerSeen = hasPlayer;
			info(hasPlayer ? 'vidstack player detected' : 'vidstack player gone');
			if (hasPlayer) state.videoFound = false; // bind the new instance's <video>
		}
		if (location.href !== lastHref) {
			if (lastHref) info('navigation', location.href);
			lastHref = location.href;
			state.videoFound = false; // SPA episode change: <video> likely replaced
		}

		const now = Date.now();
		if (now - _lastDiag > 3000) {
			_lastDiag = now;
			const mp = document.querySelectorAll(PLAYER_SEL).length;
			const mpv = document.querySelectorAll(PROVIDER_SEL).length;
			const vid = document.querySelectorAll('video').length;
			// Only chatter while something player-ish is around, or until we mount.
			if (mp || mpv || vid || host) {
				info('scan', 'media-player=' + mp, 'media-provider=' + mpv, 'video=' + vid, 'mounted=' + !!host);
			}
		}
	}
	// Coalesce mutation bursts (SPA pages churn the DOM heavily) to one run/frame.
	let _watchScheduled = false;
	function scheduleWatch() {
		if (_watchScheduled) return;
		_watchScheduled = true;
		requestAnimationFrame(() => {
			_watchScheduled = false;
			watch();
		});
	}
	// Watch structural changes AND the places we read the title from — the
	// player's `title` attribute, the `<title>` element text, and the og:title
	// `content` attribute — so when the title source updates (typically right
	// after a remount) we re-detect and use the new title immediately rather than
	// waiting on the heartbeat. rAF coalescing keeps this cheap despite the churn.
	new MutationObserver(scheduleWatch).observe(document.documentElement, {
		childList: true,
		subtree: true,
		characterData: true,
		attributes: true,
		attributeFilter: ['title', 'content'],
	});
	window.addEventListener('popstate', watch);
	window.addEventListener('hashchange', watch);
	watch();
	setInterval(watch, 1000);
	setInterval(tick, 50);

	/* ===================================================================
	 * Vendored: anitomy@0.0.35 — native JS port of Anitomy. Parses anime
	 * release filenames. Copyright (c) 2024 XLor. MIT licence:
	 * https://github.com/yjl9903/anitomy/blob/main/LICENSE
	 * Wrapped in a CommonJS shim; lazily instantiated via makeAnitomy() below.
	 * =================================================================== */
	function makeAnitomy() {
		const module = { exports: {} };
		const exports = module.exports;
'use strict';

function inRange(list, idx) {
  return 0 <= idx && idx < list.length;
}
function isNumericString(text) {
  return /^\d+(\.\d)?$/.test(text);
}
function trim(text, removal) {
  let start = 0, end = text.length - 1;
  while (start <= end && removal.includes(text[start])) {
    start++;
  }
  while (end >= start && removal.includes(text[end])) {
    end--;
  }
  return text.slice(start, end + 1);
}
function mergeResult(source, income = {}) {
  return {
    ...source,
    ...income
  };
}

var ElementCategory = /* @__PURE__ */ ((ElementCategory2) => {
  ElementCategory2["AnimeSeason"] = "season";
  ElementCategory2["AnimeSeasonPrefix"] = "prefix.season";
  ElementCategory2["AnimeTitle"] = "title";
  ElementCategory2["AnimeType"] = "type";
  ElementCategory2["AnimeYear"] = "year";
  ElementCategory2["AnimeMonth"] = "month";
  ElementCategory2["DeviceCompatibility"] = "DeviceCompatibility";
  ElementCategory2["Source"] = "source";
  ElementCategory2["EpisodeNumber"] = "episode.number";
  ElementCategory2["EpisodeNumberAlt"] = "episode.numberAlt";
  ElementCategory2["EpisodePrefix"] = "prefix.episode";
  ElementCategory2["EpisodeTitle"] = "episode.title";
  ElementCategory2["FileChecksum"] = "checksum";
  ElementCategory2["FileExtension"] = "extension";
  ElementCategory2["FileName"] = "filename";
  ElementCategory2["Language"] = "language";
  ElementCategory2["Subtitles"] = "subtitles";
  ElementCategory2["AudioTerm"] = "audio.term";
  ElementCategory2["VideoResolution"] = "video.resolution";
  ElementCategory2["VideoTerm"] = "video.term";
  ElementCategory2["VolumeNumber"] = "volume";
  ElementCategory2["VolumePrefix"] = "prefix.volume";
  ElementCategory2["ReleaseGroup"] = "release.group";
  ElementCategory2["ReleaseInformation"] = "release.information";
  ElementCategory2["ReleaseVersion"] = "release.version";
  ElementCategory2["Unknown"] = "unknown";
  ElementCategory2["Other"] = "other";
  return ElementCategory2;
})(ElementCategory || {});

var __defProp$2 = Object.defineProperty;
var __defNormalProp$2 = (obj, key, value) => key in obj ? __defProp$2(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField$2 = (obj, key, value) => {
  __defNormalProp$2(obj, typeof key !== "symbol" ? key + "" : key, value);
  return value;
};
const keys = /* @__PURE__ */ new Map();
const extensions = /* @__PURE__ */ new Map();
class KeywordManager {
  static normalize(text) {
    return text.toLocaleUpperCase();
  }
  static contains(category, keyword) {
    const map = this.container(category);
    const value = map.get(keyword);
    return value && value.category === category;
  }
  static container(category) {
    return category === "extension" ? this.extensions : this.keys;
  }
  static find(keyword, category) {
    const map = this.container(category);
    if (!map.has(keyword)) {
      return void 0;
    }
    const entry = map.get(keyword);
    if (category !== "unknown" && entry.category !== category) {
      return void 0;
    }
    return entry;
  }
  static peek(range) {
    const search = range.toString();
    const result = {};
    const predefined = [];
    for (const { category, list } of this.peekEntries) {
      for (const key of list) {
        const foundIdx = search.indexOf(key);
        if (foundIdx === -1)
          continue;
        result[category] = key;
        predefined.push(range.fork(foundIdx + range.offset, key.length));
      }
    }
    return { result, predefined };
  }
}
__publicField$2(KeywordManager, "keys", keys);
__publicField$2(KeywordManager, "extensions", extensions);
__publicField$2(KeywordManager, "peekEntries", [
  { category: ElementCategory.AudioTerm, list: ["Dual Audio"] },
  { category: ElementCategory.VideoTerm, list: ["H264", "H.264", "h264", "h.264"] },
  {
    category: ElementCategory.VideoResolution,
    list: ["480p", "480P", "720p", "720P", "1080p", "1080P"]
  },
  { category: ElementCategory.Source, list: ["Blu-Ray"] }
]);
(() => {
  const optionsDefault = { identifiable: true, searchable: true, valid: true };
  const optionsInvalid = { identifiable: false, searchable: false, valid: false };
  const optionsUnidentifiable = {
    identifiable: false,
    searchable: true,
    valid: true
  };
  const optionsUnidentifiableInvalid = {
    identifiable: false,
    searchable: true,
    valid: false
  };
  const optionsUnidentifiableUnsearchable = {
    identifiable: false,
    searchable: false,
    valid: true
  };
  add(ElementCategory.AnimeSeasonPrefix, optionsUnidentifiable, ["SAISON", "SEASON"]);
  add(ElementCategory.AnimeType, optionsUnidentifiable, [
    "GEKIJOUBAN",
    "MOVIE",
    "OAD",
    "OAV",
    "ONA",
    "OVA",
    "SPECIAL",
    "SPECIALS",
    "TV",
    "\u7279\u522B\u7BC7",
    "\u7279\u5225\u7BC7",
    "\u7279\u5225\u7DE8",
    "\u7279\u522B\u8BDD",
    "\u7279\u5225\u8BDD",
    "\u7279\u5225\u8A71",
    "\u756A\u5916\u7BC7",
    "\u756A\u5916\u7DE8"
  ]);
  add(ElementCategory.AnimeType, optionsUnidentifiableUnsearchable, ["SP"]);
  add(ElementCategory.AnimeType, optionsUnidentifiableInvalid, [
    "ED",
    "ENDING",
    "NCED",
    "NCOP",
    "OP",
    "OPENING",
    "PREVIEW",
    "PV"
  ]);
  add(ElementCategory.AudioTerm, optionsDefault, [
    // Audio channels
    "2.0CH",
    "2CH",
    "5.1",
    "5.1CH",
    "DTS",
    "DTS-ES",
    "DTS5.1",
    "TRUEHD5.1",
    // Audio codec
    "AAC",
    "AACX2",
    "AACX3",
    "AACX4",
    "AC3",
    "EAC3",
    "E-AC-3",
    "FLAC",
    "FLACX2",
    "FLACX3",
    "FLACX4",
    "LOSSLESS",
    "MP3",
    "OGG",
    "VORBIS",
    // Audio language
    "DUALAUDIO",
    "DUAL AUDIO"
  ]);
  add(ElementCategory.VideoTerm, optionsDefault, [
    // Frame rate
    "23.976FPS",
    "24FPS",
    "29.97FPS",
    "30FPS",
    "60FPS",
    "120FPS",
    // Video codec
    "8BIT",
    "8-BIT",
    "10BIT",
    "10BITS",
    "10-BIT",
    "10-BITS",
    "HI10",
    "HI10P",
    "HI444",
    "HI444P",
    "HI444PP",
    "H264",
    "H265",
    "H.264",
    "H.265",
    "X264",
    "X265",
    "X.264",
    "AVC",
    "HEVC",
    "HEVC2",
    "HEVC-10BIT",
    "DIVX",
    "DIVX5",
    "DIVX6",
    "XVID",
    // Video format
    "AVI",
    "RMVB",
    "WMV",
    "WMV3",
    "WMV9",
    // Video quality
    "HQ",
    "LQ",
    // Video resolution
    "HD",
    "SD"
  ]);
  add(ElementCategory.Source, optionsDefault, [
    "BD",
    "BDRIP",
    "BLURAY",
    "BLU-RAY",
    "DVD",
    "DVD5",
    "DVD9",
    "DVD-R2J",
    "DVDRIP",
    "DVD-RIP",
    "R2DVD",
    "R2J",
    "R2JDVD",
    "R2JDVDRIP",
    "HDTV",
    "HDTVRIP",
    "TVRIP",
    "TV-RIP",
    "WEBCAST",
    "WEBDL",
    "WEB-DL",
    "WEBRIP",
    "WEB-RIP"
  ]);
  add(ElementCategory.Language, optionsDefault, [
    "ENG",
    "ENGLISH",
    "ESPANO",
    "JAP",
    "PT-BR",
    "SPANISH",
    "VOSTFR",
    // feat: chinese
    "CHT",
    "CHS",
    "\u7B80\u4E2D",
    "\u7E41\u4E2D",
    "\u7B80\u4F53",
    "\u7E41\u9AD4"
  ]);
  add(ElementCategory.Language, optionsUnidentifiable, ["ESP", "ITA"]);
  add(ElementCategory.Subtitles, optionsDefault, [
    "ASS",
    "GB",
    // feat: 简体字幕
    "BIG5",
    "DUB",
    "DUBBED",
    "HARDSUB",
    "HARDSUBS",
    "RAW",
    "SOFTSUB",
    "SOFTSUBS",
    "SUB",
    "SUBBED",
    "SUBTITLED"
  ]);
  add(ElementCategory.EpisodePrefix, optionsDefault, [
    "EP",
    "EP.",
    "EPS",
    "EPS.",
    "EPISODE",
    "EPISODE.",
    "EPISODES",
    "CAPITULO",
    "EPISODIO",
    "FOLGE"
  ]);
  add(ElementCategory.EpisodePrefix, optionsInvalid, ["E", "\\x7B2C"]);
  add(ElementCategory.VolumePrefix, optionsDefault, ["VOL", "VOL.", "VOLUME"]);
  add(ElementCategory.ReleaseGroup, optionsDefault, ["Baha", "THORA"]);
  add(ElementCategory.ReleaseInformation, optionsDefault, [
    "BATCH",
    "COMPLETE",
    "PATCH",
    "REMUX"
  ]);
  add(ElementCategory.ReleaseInformation, optionsUnidentifiable, ["END", "FINAL"]);
  add(ElementCategory.ReleaseVersion, optionsDefault, [
    "V0",
    "V1",
    "V2",
    "V3",
    "V4",
    "V5",
    "V6",
    "V7",
    "V8",
    "V9"
  ]);
  add(ElementCategory.Other, optionsDefault, [
    "REMASTER",
    "REMASTERED",
    "UNCENSORED",
    "UNCUT",
    "TS",
    "VFR",
    "WIDESCREEN",
    "WS"
  ]);
  add(ElementCategory.FileExtension, optionsDefault, [
    "3GP",
    "AVI",
    "DIVX",
    "FLV",
    "M2TS",
    "MKV",
    "MOV",
    "MP4",
    "MPG",
    "OGM",
    "RM",
    "RMVB",
    "TS",
    "WEBM",
    "WMV"
  ]);
  add(ElementCategory.FileExtension, optionsInvalid, [
    "AAC",
    "AIFF",
    "FLAC",
    "M4A",
    "MP3",
    "MKA",
    "OGG",
    "WAV",
    "WMA",
    "7Z",
    "RAR",
    "ZIP",
    "ASS",
    "SRT"
  ]);
  function add(category, options, input) {
    const map = category === "extension" ? extensions : keys;
    for (const key of input) {
      if (!map.has(key)) {
        map.set(key, { category, ...options });
      }
    }
  }
})();
const Fansubs = /* @__PURE__ */ new Set([
  "\u730E\u6237\u53D1\u5E03\u7EC4",
  "\u730E\u6237\u624B\u6284\u90E8",
  "\u5317\u5B87\u6CBB\u5B57\u5E55\u7EC4",
  "\u5317\u5B87\u6CBBAnarchism\u5B57\u5E55\u7EC4",
  "\u52D5\u6F2B\u82B1\u5712",
  "\u62E8\u96EA\u5BFB\u6625",
  "NC-Raws",
  "\u55B5\u840C\u5976\u8336\u5C4B",
  "Lilith-Raws",
  "\u9B54\u661F\u5B57\u5E55\u56E2",
  "\u685C\u90FD\u5B57\u5E55\u7EC4",
  "\u5929\u6708\u52D5\u6F2B&\u767C\u4F48\u7D44",
  "\u6781\u5F71\u5B57\u5E55\u793E",
  "LoliHouse",
  "\u60A0\u54C8C9\u5B57\u5E55\u793E",
  "\u5E7B\u6708\u5B57\u5E55\u7EC4",
  "\u5929\u4F7F\u52A8\u6F2B\u8BBA\u575B",
  "\u52A8\u6F2B\u56FD\u5B57\u5E55\u7EC4",
  "\u5E7B\u6A31\u5B57\u5E55\u7EC4",
  "\u7231\u604B\u5B57\u5E55\u793E",
  "DBD\u5236\u4F5C\u7EC4",
  "c.c\u52A8\u6F2B",
  "\u841D\u8389\u793E\u6D3B\u52A8\u5BA4",
  "\u5343\u590F\u5B57\u5E55\u7EC4",
  "IET\u5B57\u5E55\u7D44",
  "\u8BF8\u795Ekamigami\u5B57\u5E55\u7EC4",
  "\u971C\u5EAD\u4E91\u82B1Sub",
  "GMTeam",
  "\u98CE\u8F66\u5B57\u5E55\u7EC4",
  // '雪飄工作室(FLsnow)',
  "MCE\u6C49\u5316\u7EC4",
  "\u4E38\u5B50\u5BB6\u65CF",
  "\u661F\u7A7A\u5B57\u5E55\u7EC4",
  "\u68A6\u84DD\u5B57\u5E55\u7EC4",
  "LoveEcho!",
  "SweetSub",
  "\u67AB\u53F6\u5B57\u5E55\u7EC4",
  "Little Subbers!",
  "\u8F7B\u4E4B\u56FD\u5EA6",
  "\u4E91\u5149\u5B57\u5E55\u7EC4",
  "\u8C4C\u8C46\u5B57\u5E55\u7EC4",
  "\u9A6F\u517D\u5E08\u8054\u76DF",
  "\u4E2D\u80AF\u5B57\u5E55\u7D44",
  "SW\u5B57\u5E55\u7EC4",
  "\u94F6\u8272\u5B50\u5F39\u5B57\u5E55\u7EC4",
  "\u98CE\u4E4B\u5723\u6BBF",
  "YWCN\u5B57\u5E55\u7EC4",
  "KRL\u5B57\u5E55\u7EC4",
  "\u534E\u76DF\u5B57\u5E55\u793E",
  "\u6CE2\u6D1B\u5496\u5561\u5385",
  "\u52A8\u97F3\u6F2B\u5F71",
  "VCB-Studio",
  "DHR\u52D5\u7814\u5B57\u5E55\u7D44",
  "80v08",
  "\u80A5\u732B\u538B\u5236",
  "Little\u5B57\u5E55\u7EC4",
  "AI-Raws",
  "\u79BB\u8C31Sub",
  "\u8679\u54B2\u5B66\u56ED\u70E4\u8089\u540C\u597D\u4F1A",
  "ARIA\u5427\u6C49\u5316\u7EC4",
  "\u67EF\u5357\u4E8B\u52A1\u6240",
  "\u767E\u51AC\u7DF4\u7FD2\u7D44",
  "\u51B7\u756A\u8865\u5B8C\u5B57\u5E55\u7EC4",
  "\u7231\u5495\u5B57\u5E55\u7EC4",
  "\u6975\u5F69\u5B57\u5E55\u7EC4",
  "AQUA\u5DE5\u4F5C\u5BA4",
  "\u672A\u592E\u9601\u8054\u76DF",
  "\u5C4A\u604B\u5B57\u5E55\u7EC4",
  "\u591C\u83BA\u5BB6\u65CF",
  "TD-RAWS",
  "\u5922\u5E7B\u6200\u6AFB",
  "WBX-SUB",
  "Liella!\u306E\u70E7\u70E4\u644A",
  "Amor\u5B57\u5E55\u7EC4",
  "MingYSub",
  "\u5C0F\u767DGM",
  "Sakura",
  "EMe",
  "Alchemist",
  "\u9ED1\u5CA9\u5C04\u624B\u5427\u5B57\u5E55\u7EC4",
  "ANi",
  "MSB\u5236\u4F5C\u7D44"
]);

var __defProp$1 = Object.defineProperty;
var __defNormalProp$1 = (obj, key, value) => key in obj ? __defProp$1(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField$1 = (obj, key, value) => {
  __defNormalProp$1(obj, typeof key !== "symbol" ? key + "" : key, value);
  return value;
};
class TextRange {
  constructor(text, offset, size) {
    __publicField$1(this, "text");
    __publicField$1(this, "offset");
    __publicField$1(this, "size");
    this.text = text;
    this.offset = offset;
    this.size = size;
  }
  fork(offset, size) {
    return new TextRange(this.text, offset, size);
  }
  toString() {
    return this.text.slice(this.offset, this.offset + this.size);
  }
}
var TokenCategory = /* @__PURE__ */ ((TokenCategory2) => {
  TokenCategory2["Unknown"] = "Unknown";
  TokenCategory2["Bracket"] = "Bracket";
  TokenCategory2["Delimiter"] = "Delimiter";
  TokenCategory2["Identifier"] = "Identifier";
  TokenCategory2["Invalid"] = "Invalid";
  return TokenCategory2;
})(TokenCategory || {});
var TokenFlag = /* @__PURE__ */ ((TokenFlag2) => {
  TokenFlag2[TokenFlag2["None"] = 0] = "None";
  TokenFlag2[TokenFlag2["Bracket"] = 1] = "Bracket";
  TokenFlag2[TokenFlag2["NotBracket"] = 2] = "NotBracket";
  TokenFlag2[TokenFlag2["Delimiter"] = 3] = "Delimiter";
  TokenFlag2[TokenFlag2["NotDelimiter"] = 4] = "NotDelimiter";
  TokenFlag2[TokenFlag2["Identifier"] = 5] = "Identifier";
  TokenFlag2[TokenFlag2["NotIdentifier"] = 6] = "NotIdentifier";
  TokenFlag2[TokenFlag2["Unknown"] = 7] = "Unknown";
  TokenFlag2[TokenFlag2["NotUnknown"] = 8] = "NotUnknown";
  TokenFlag2[TokenFlag2["Valid"] = 9] = "Valid";
  TokenFlag2[TokenFlag2["NotValid"] = 10] = "NotValid";
  TokenFlag2[TokenFlag2["Enclosed"] = 11] = "Enclosed";
  TokenFlag2[TokenFlag2["NotEnclosed"] = 12] = "NotEnclosed";
  return TokenFlag2;
})(TokenFlag || {});
function checkTokenFlags(token, flags) {
  if (flags.some((f) => f === 11 /* Enclosed */ || f === 12 /* NotEnclosed */)) {
    const success = flags.includes(11 /* Enclosed */) === token.enclosed;
    if (!success)
      return false;
  }
  if (!flags.some((f) => 1 /* Bracket */ <= f && f <= 10 /* NotValid */)) {
    return true;
  }
  const tasks = [
    [1 /* Bracket */, 2 /* NotBracket */, "Bracket" /* Bracket */],
    [3 /* Delimiter */, 4 /* NotDelimiter */, "Delimiter" /* Delimiter */],
    [5 /* Identifier */, 6 /* NotIdentifier */, "Identifier" /* Identifier */],
    [7 /* Unknown */, 8 /* NotUnknown */, "Unknown" /* Unknown */],
    [10 /* NotValid */, 9 /* Valid */, "Invalid" /* Invalid */]
  ];
  for (const [fe, fn, c] of tasks) {
    const success = flags.includes(fe) ? token.category === c : flags.includes(fn) && token.category !== c;
    if (success)
      return true;
  }
  return false;
}
function findNextToken(tokens, position, ...flags) {
  for (let i = position + 1; i < tokens.length; i++) {
    if (tokens[i] && checkTokenFlags(tokens[i], flags)) {
      return i;
    }
  }
  return tokens.length;
}
function findPrevToken(tokens, position, ...flags) {
  for (let i = position - 1; i >= 0; i--) {
    if (tokens[i] && checkTokenFlags(tokens[i], flags)) {
      return i;
    }
  }
  return -1;
}
function findToken(tokens, start, end, ...flags) {
  for (let i = start; i < end; i++) {
    if (tokens[i] && checkTokenFlags(tokens[i], flags)) {
      return i;
    }
  }
  return -1;
}

function isCRC32(str) {
  return /^[0-9a-fA-F]{8}$/.test(str);
}
function isResolution(str) {
  return /^\d{3,4}([pP]|[xX\u00D7]\d{3,4})/.test(str);
}
const SearchableElementCategories = /* @__PURE__ */ new Set([
  ElementCategory.AnimeSeasonPrefix,
  ElementCategory.AnimeType,
  ElementCategory.AudioTerm,
  ElementCategory.DeviceCompatibility,
  ElementCategory.EpisodePrefix,
  ElementCategory.FileChecksum,
  ElementCategory.FileExtension,
  ElementCategory.Language,
  ElementCategory.Other,
  ElementCategory.ReleaseGroup,
  ElementCategory.ReleaseInformation,
  ElementCategory.ReleaseVersion,
  ElementCategory.Source,
  ElementCategory.Subtitles,
  ElementCategory.VideoResolution,
  ElementCategory.VideoTerm,
  ElementCategory.VolumePrefix
]);
function isElementCategorySearchable(category) {
  return SearchableElementCategories.has(category);
}
const SingularElementCategories = /* @__PURE__ */ new Set([
  ElementCategory.AnimeSeason,
  ElementCategory.AnimeType,
  ElementCategory.AudioTerm,
  ElementCategory.DeviceCompatibility,
  ElementCategory.EpisodeNumber,
  ElementCategory.Language,
  ElementCategory.Other,
  ElementCategory.ReleaseInformation,
  ElementCategory.Source,
  ElementCategory.VideoTerm
]);
function isElementCategorySingular(category) {
  return !SingularElementCategories.has(category);
}
const Ordinals = /* @__PURE__ */ new Map([
  ["1st", "1"],
  ["First", "1"],
  ["2nd", "2"],
  ["Second", "2"],
  ["3rd", "3"],
  ["Third", "3"],
  ["4th", "4"],
  ["Fourth", "4"],
  ["5th", "5"],
  ["Fifth", "5"],
  ["6th", "6"],
  ["Sixth", "6"],
  ["7th", "7"],
  ["Seventh", "7"],
  ["8th", "8"],
  ["Eighth", "8"],
  ["9th", "9"],
  ["Ninth", "9"]
]);
function getNumberFromOrdinal(str) {
  return Ordinals.has(str) ? Ordinals.get(str) : void 0;
}
function isMatchTokenCategory(category, token) {
  return token?.category === category;
}
const Dashes = "-\u2010\u2011\u2012\u2013\u2014\u2015";
function isDashCharacter(c) {
  return c.length === 1 && Dashes.includes(c);
}
function isLatinChar(c) {
  return c[0] <= "\u024F";
}
function isMostlyLatinString(str) {
  if (str.length === 0)
    return false;
  return str.split("").filter(isLatinChar).length / str.length >= 0.6;
}

function setResult(context, category, word) {
  context.result[category] = word;
}
function hasResult(context, category) {
  const value = context.result[category];
  return value !== void 0 && value !== null && value !== "";
}
function getResult(context, category) {
  return context.result[category];
}

function matchVolumePatterns(context, word, token) {
  return true;
}

function searchForEpisodePatterns(context, tokens) {
  for (const it of tokens) {
    const token = context.tokens[it];
    const numericFront = token.content.length > 0 && /0-9/.test(token.content[0]);
    if (!numericFront) {
      if (numberComesAfterPrefix(context, ElementCategory.EpisodePrefix, token)) {
        return true;
      }
      if (numberComesAfterPrefix(context, ElementCategory.VolumePrefix, token)) {
        return true;
      }
    } else {
      if (numberComesBeforeAnotherNumber(context, it)) {
        return true;
      }
    }
    if (matchEpisodePatterns(context, token.content, token)) {
      return true;
    }
  }
  return false;
}
function numberComesAfterPrefix(context, category, token) {
  const numberBegin = indexOfDigit(token.content);
  const prefix = KeywordManager.normalize(token.content.slice(0, numberBegin));
  if (!KeywordManager.contains(category, prefix))
    return false;
  const num = token.content.slice(numberBegin);
  switch (category) {
    case ElementCategory.EpisodePrefix:
      if (!matchEpisodePatterns(context, num, token)) {
        setEpisodeNumber(context, num, token, false);
      }
      return true;
    case ElementCategory.VolumePrefix:
      return true;
  }
  return false;
}
function numberComesBeforeAnotherNumber(context, position) {
  const separatorToken = findPrevToken(context.tokens, position, TokenFlag.NotDelimiter);
  if (!inRange(context.tokens, separatorToken))
    return false;
  const separators = [
    ["&", true],
    ["of", false]
  ];
  for (const sep of separators) {
    if (context.tokens[separatorToken].content !== sep[0])
      continue;
    const otherToken = findNextToken(context.tokens, separatorToken, TokenFlag.NotDelimiter);
    if (!inRange(context.tokens, otherToken) || !isNumericString(context.tokens[otherToken].content)) {
      continue;
    }
    setEpisodeNumber(context, context.tokens[position].content, context.tokens[position], false);
    if (sep[1]) {
      setEpisodeNumber(
        context,
        context.tokens[otherToken].content,
        context.tokens[otherToken],
        false
      );
    }
    context.tokens[separatorToken].category = TokenCategory.Identifier;
    context.tokens[otherToken].category = TokenCategory.Identifier;
    return true;
  }
  return false;
}
function matchEpisodePatterns(context, word, token) {
  if (isNumericString(word))
    return false;
  word = trim(word, [" ", "-"]);
  const numericFront = isDigit(word[0]);
  const numericBack = isDigit(word[word.length - 1]);
  if (numericFront && numericBack) {
    if (matchSingleEpisodePattern(context, word, token)) {
      return true;
    }
  }
  if (numericFront) {
    if (matchMultiEpisodePattern(context, word, token)) {
      return true;
    }
  }
  if (numericBack) {
    if (matchSeasonAndEpisodePattern(context, word, token)) {
      return true;
    }
    if (matchNumberSignPattern(context, word, token)) {
      return true;
    }
  }
  if (!numericFront && matchTypeAndEpisodePattern(context, word, token)) {
    return true;
  }
  if (numericFront && !numericBack && matchPartialEpisodePattern(context, word, token)) {
    return true;
  }
  if (matchJapaneseCounterPattern(context, word, token)) {
    return true;
  }
  return false;
}
function matchSingleEpisodePattern(context, word, token) {
  const RE = /^(\d{1,3})[vV](\d)$/;
  const match = RE.exec(word);
  if (match) {
    setEpisodeNumber(context, match[1], token, false);
    setResult(context, ElementCategory.ReleaseVersion, match[2]);
    return true;
  } else {
    return false;
  }
}
function matchMultiEpisodePattern(context, word, token) {
  const RE = /^(\d{1,3})(?:[vV](\d))?[-~&+](\d{1,3})(?:[vV](\d)|[Ff][Ii][Nn]|[Ee][Nn][Dd]|合集)?$/;
  const match = RE.exec(word);
  if (!match)
    return false;
  const lowerBound = match[1];
  const upperBound = match[3];
  if (+lowerBound <= +upperBound) {
    if (setEpisodeNumber(context, lowerBound, token, true)) {
      setEpisodeNumber(context, upperBound, token, true);
      if (match[2]) {
        setResult(context, ElementCategory.ReleaseVersion, match[2]);
      }
      if (match[4]) {
        setResult(context, ElementCategory.ReleaseVersion, match[4]);
      }
      return true;
    }
  }
  return false;
}
function matchSeasonAndEpisodePattern(context, word, token) {
  const RE = /^S?(\d{1,2})(?:-S?(\d{1,2}))?(?:x|[ ._-x]?E)(\d{1,3})(?:-E?(\d{1,3}))?$/;
  const match = RE.exec(word);
  if (!match)
    return false;
  setResult(context, ElementCategory.AnimeSeason, match[1]);
  if (match[2]) {
    setResult(context, ElementCategory.AnimeSeason, match[2]);
  }
  setEpisodeNumber(context, match[3], token, false);
  if (match[4]) {
    setEpisodeNumber(context, match[4], token, false);
  }
  return true;
}
function matchNumberSignPattern(context, word, token) {
  if (word[0] !== "#")
    word = "";
  const RE = /^#(\d{1,3})(?:[-~&+](\d{1,3}))?(?:[vV](\d))?$/;
  const match = RE.exec(word);
  if (!match)
    return false;
  if (!setEpisodeNumber(context, match[1], token, true))
    return false;
  if (match[2]) {
    setEpisodeNumber(context, match[2], token, false);
  }
  if (match[3]) {
    setResult(context, ElementCategory.ReleaseVersion, match[3]);
  }
  return true;
}
function matchTypeAndEpisodePattern(context, word, token) {
  const numberBegin = indexOfDigit(word);
  const prefix = word.slice(0, numberBegin);
  const entry = KeywordManager.find(KeywordManager.normalize(prefix), ElementCategory.AnimeType);
  if (entry) {
    setResult(context, entry.category, prefix);
    const num = word.slice(numberBegin);
    if (matchEpisodePatterns(context, num, token) || setEpisodeNumber(context, num, token, true)) {
      const foundIdx = context.tokens.indexOf(token);
      if (foundIdx !== -1) {
        token.content = num;
        context.tokens.splice(foundIdx, 0, {
          category: entry.identifiable ? TokenCategory.Identifier : TokenCategory.Unknown,
          content: prefix,
          enclosed: token.enclosed
        });
      }
      return true;
    }
  }
  return false;
}
function matchPartialEpisodePattern(context, word, token) {
  if (!word)
    return false;
  let foundIdx = word.length;
  for (let i = 0; i < word.length; i++) {
    if (!isDigit(word[i])) {
      foundIdx = i;
      break;
    }
  }
  const suffix = word.slice(foundIdx);
  const valid = ["a", "b", "c", "fin", "end"];
  return valid.includes(suffix.toLocaleLowerCase()) && setEpisodeNumber(context, word, token, true);
}
function matchJapaneseCounterPattern(context, word, token) {
  const hua = ["\u8A71", "\u8BDD", "\u96C6"];
  if (word.length > 0 && hua.includes(word.at(-1))) {
    const RE = /^第?(\d{1,4})(?:-(\d{1,4}))?(?:[vV](\d))?(?:話|话|集)$/;
    const match = RE.exec(word);
    if (!match)
      return false;
    setEpisodeNumber(context, match[1], token, false);
    if (match[2]) {
      setEpisodeNumber(context, match[2], token, false);
    }
    if (match[3]) {
      setResult(context, ElementCategory.ReleaseVersion, match[3]);
    }
    return true;
  }
  return false;
}
function setEpisodeNumber(context, num, token, validate) {
  if (validate && !isValidEpisodeNumber(num))
    return false;
  token.category = TokenCategory.Identifier;
  if (hasResult(context, ElementCategory.EpisodeNumber)) {
    const oldEp = getResult(context, ElementCategory.EpisodeNumber);
    const diff = +num - +oldEp;
    if (diff > 0) {
      setResult(context, ElementCategory.EpisodeNumberAlt, num);
      return true;
    } else if (diff < 0) {
      setResult(context, ElementCategory.EpisodeNumber, num);
      setResult(context, ElementCategory.EpisodeNumberAlt, oldEp);
      return true;
    } else {
      return false;
    }
  } else {
    setResult(context, ElementCategory.EpisodeNumber, num);
    return true;
  }
}

function checkAndSetAnimeSeasonKeyword(context, position) {
  const tokens = context.tokens;
  const token = tokens[position];
  const prevToken = findPrevToken(tokens, position, TokenFlag.NotDelimiter);
  if (inRange(tokens, prevToken)) {
    const num = getNumberFromOrdinal(tokens[prevToken].content);
    if (num) {
      setAnimeSeason(tokens[prevToken], token, num);
      return;
    }
  }
  const nextToken = findNextToken(tokens, position, TokenFlag.NotDelimiter);
  if (!inRange(tokens, nextToken) || !isNumericString(tokens[nextToken].content)) {
    return void 0;
  }
  return setAnimeSeason(token, tokens[nextToken], tokens[nextToken].content);
  function setAnimeSeason(first, second, content) {
    first.category = TokenCategory.Identifier;
    second.category = TokenCategory.Identifier;
    setResult(context, ElementCategory.AnimeSeason, content);
  }
}
function checkAndSetAnimeSeason(context, position) {
  const token = context.tokens[position];
  if (matchPrefixS()) {
    return true;
  }
  if (matchPrefixChinese()) {
    return true;
  }
  if (matchFullChinese()) {
    return true;
  }
  return false;
  function matchPrefixS() {
    const RE = /^S-?(\d{1,3})$/;
    const match = RE.exec(token.content);
    if (!match)
      return false;
    setResult(context, ElementCategory.AnimeSeason, match[1]);
    return true;
  }
  function matchPrefixChinese() {
    const RE = /^第(\d+)季$/;
    const match = RE.exec(token.content);
    if (!match)
      return false;
    setResult(context, ElementCategory.AnimeSeason, match[1]);
    return true;
  }
  function matchFullChinese() {
    const RE = /^第(十?[零一二三四五六七八九十])季$/;
    const match = RE.exec(token.content);
    if (!match)
      return false;
    setResult(context, ElementCategory.AnimeSeason, extractNumber(match[1]));
    return true;
    function extractNumber(word) {
      const DICT = {
        \u96F6: "0",
        \u4E00: "1",
        \u4E8C: "2",
        \u4E09: "3",
        \u56DB: "4",
        \u4E94: "5",
        \u516D: "6",
        \u4E03: "7",
        \u516B: "8",
        \u4E5D: "9",
        \u5341: "10"
      };
      if (word.length === 1) {
        return DICT[word[0]];
      } else {
        return "1" + DICT[word[1]];
      }
    }
  }
}
function checkAndSetAnimeMonth(context, position) {
  const word = trim(context.tokens[position].content, ["\u2605"]);
  const RE = /^(\d{1,2})月新番$/;
  const match = RE.exec(word);
  if (!match)
    return false;
  context.tokens[position].category = TokenCategory.Identifier;
  setResult(context, ElementCategory.AnimeMonth, match[1]);
  return true;
}
function checkAndSetReleaseGroup(context, position) {
  const list = context.tokens[position].content.split(/&/);
  const ok = list.every(
    (f) => Fansubs.has(f) || f.endsWith("\u5B57\u5E55\u7EC4") || f.endsWith("\u5B57\u5E55\u7D44") || f.endsWith("\u5B57\u5E55\u793E")
  );
  if (ok) {
    context.tokens[position].category = TokenCategory.Identifier;
    setResult(context, ElementCategory.ReleaseGroup, context.tokens[position].content);
    return true;
  }
  return false;
}
function checkExtentKeyword(context, category, position) {
  const tokens = context.tokens;
  const token = tokens[position];
  const nextToken = findNextToken(tokens, position, TokenFlag.NotDelimiter);
  if (!isMatchTokenCategory(TokenCategory.Unknown, tokens[nextToken])) {
    return false;
  }
  if (indexOfDigit(tokens[nextToken].content) !== 0) {
    return false;
  }
  switch (category) {
    case ElementCategory.EpisodeNumber:
      if (!matchEpisodePatterns(context, tokens[nextToken].content, tokens[nextToken])) {
        setEpisodeNumber(context, tokens[nextToken].content, tokens[nextToken], false);
      }
      break;
    case ElementCategory.VolumeNumber:
      if (!matchVolumePatterns(context, tokens[nextToken].content, tokens[nextToken])) ;
      break;
  }
  token.category = TokenCategory.Identifier;
  return true;
}
function buildElement(context, category, keepDelimiters, tokens) {
  const element = [];
  for (const token of tokens) {
    switch (token.category) {
      case TokenCategory.Unknown:
        element.push(token.content);
        token.category = TokenCategory.Identifier;
        break;
      case TokenCategory.Bracket:
        element.push(token.content);
        break;
      case TokenCategory.Delimiter:
        const delimiter = token.content[0] ?? "";
        if (keepDelimiters) {
          element.push(delimiter);
        } else {
          switch (delimiter) {
            case ",":
            case "&":
              element.push(delimiter);
              break;
            default:
              element.push(" ");
              break;
          }
        }
        break;
    }
  }
  if (!keepDelimiters) {
    const t = trim(element.join(""), " -\u2010\u2011\u2012\u2013\u2014\u2015".split(""));
    element.splice(0, element.length, t);
  }
  const title = element.join("");
  if (title) {
    setResult(context, category, title);
  }
}
function isTokenIsolated(context, position) {
  const prevToken = findPrevToken(context.tokens, position, TokenFlag.NotDelimiter);
  if (!isMatchTokenCategory(TokenCategory.Bracket, context.tokens[prevToken]))
    return false;
  const nextToken = findNextToken(context.tokens, position, TokenFlag.NotDelimiter);
  return isMatchTokenCategory(TokenCategory.Bracket, context.tokens[nextToken]);
}

const AnimeYearMin = 1900;
const AnimeYearMax = 2100;
const EpisodeNumberMax = AnimeYearMax - 1;
function indexOfDigit(str) {
  for (let i = 0; i < str.length; i++) {
    if (isDigit(str[i])) {
      return i;
    }
  }
  return -1;
}
function isDigit(str) {
  return /^[0-9]$/.test(str);
}
function searchForEquivalentNumbers(context, tokens) {
  for (const it of tokens) {
    if (isTokenIsolated(context, it) || !isValidEpisodeNumber(context.tokens[it].content)) {
      continue;
    }
    let nextToken = findNextToken(context.tokens, it, TokenFlag.NotDelimiter);
    if (isMatchTokenCategory(TokenCategory.Bracket, context.tokens[nextToken])) {
      nextToken = findNextToken(
        context.tokens,
        nextToken,
        TokenFlag.Enclosed,
        TokenFlag.NotDelimiter
      );
      if (isMatchTokenCategory(TokenCategory.Unknown, context.tokens[nextToken])) {
        if (isTokenIsolated(context, nextToken) && isNumericString(context.tokens[nextToken].content) && isValidEpisodeNumber(context.tokens[nextToken].content)) {
          setEpisodeNumber(
            context,
            context.tokens[nextToken].content,
            context.tokens[nextToken],
            true
          );
          return true;
        }
      }
    }
  }
  return false;
}
function searchForSeparatedNumbers(context, tokens) {
  for (const it of tokens) {
    const prevToken = findPrevToken(context.tokens, it, TokenFlag.NotDelimiter);
    if (isMatchTokenCategory(TokenCategory.Unknown, context.tokens[prevToken]) && isDashCharacter(context.tokens[prevToken].content[0])) {
      if (setEpisodeNumber(context, context.tokens[it].content, context.tokens[it], true)) {
        context.tokens[prevToken].category = TokenCategory.Identifier;
        return true;
      }
    }
  }
  return false;
}
function searchForIsolatedEpisodeNumber(context, tokens) {
  {
    const isolated = tokens.filter(
      (it) => context.tokens[it].enclosed && isTokenIsolated(context, it)
    );
    for (const it of isolated.reverse()) {
      if (setEpisodeNumber(context, context.tokens[it].content, context.tokens[it], true)) {
        return true;
      }
    }
  }
  {
    const isolated = tokens.filter((it) => context.tokens[it].enclosed);
    for (const it of isolated.reverse()) {
      const prevToken = findPrevToken(context.tokens, it, TokenFlag.NotDelimiter);
      if (!isMatchTokenCategory(TokenCategory.Bracket, context.tokens[prevToken]))
        continue;
      const nextToken = findNextToken(context.tokens, it, TokenFlag.NotDelimiter);
      const nextnextToken = findNextToken(context.tokens, nextToken, TokenFlag.NotDelimiter);
      if (!isMatchTokenCategory(TokenCategory.Bracket, context.tokens[nextnextToken]))
        continue;
      if (setEpisodeNumber(context, context.tokens[it].content, context.tokens[it], true)) {
        return true;
      }
    }
  }
  return false;
}
function searchForEpisodeNumberWithVersion(context, tokens) {
  const enclosed = tokens.filter((it) => context.tokens[it].enclosed);
  for (const it of enclosed) {
    const nextToken = findNextToken(context.tokens, it, TokenFlag.NotDelimiter);
    const nextContent = context.tokens[nextToken].content;
    if (/^[vV]\d+$/.test(nextContent)) {
      if (setEpisodeNumber(context, context.tokens[it].content, context.tokens[it], true)) {
        context.tokens[it].category = TokenCategory.Identifier;
        return true;
      }
    }
  }
  return false;
}
function searchForLastNumber(context, tokens) {
  for (const it of tokens) {
    if (it === 0)
      continue;
    if (context.tokens[it].enclosed)
      continue;
    if (context.tokens.slice(0, it).every((t) => t.enclosed || t.category === TokenCategory.Delimiter)) {
      continue;
    }
    const prevToken = findPrevToken(context.tokens, it, TokenFlag.NotDelimiter);
    if (isMatchTokenCategory(TokenCategory.Unknown, context.tokens[prevToken])) {
      const prevContent = context.tokens[prevToken].content;
      if (prevContent === "Movie" || prevContent === "Part") {
        continue;
      }
    }
    if (matchFractionalEpisodePattern(context, context.tokens[it].content, context.tokens[it])) {
      return true;
    }
    if (setEpisodeNumber(context, context.tokens[it].content, context.tokens[it], true)) {
      return true;
    }
  }
  return false;
}
function isValidEpisodeNumber(num) {
  const temp = [];
  for (let i = 0; i < num.length && /[0-9\.]/.test(num[i]); i++) {
    temp.push(num[i]);
  }
  return temp.length > 0 && parseFloat(temp.join("")) <= EpisodeNumberMax;
}
function matchFractionalEpisodePattern(context, word, token) {
  const RE = /^\d+\.5$/;
  const match = RE.exec(word);
  return match && setEpisodeNumber(context, word, token, true);
}

function parse$1(result, tokens, options) {
  const context = {
    tokens,
    options,
    result,
    isEpisodeKeywordsFound: false
  };
  searchForKeywords(context);
  searchForIsolatedNumbers(context);
  if (options.parseEpisodeNumber) {
    searchForEpisodeNumber(context);
  }
  searchForAnimeTitle(context);
  if (options.parseReleaseGroup && !hasResult(context, ElementCategory.ReleaseGroup)) ;
  if (options.parseEpisodeTitle && hasResult(context, ElementCategory.EpisodeNumber)) ;
  return {
    ok: hasResult(context, ElementCategory.AnimeTitle),
    result: context.result
  };
}
function searchForKeywords(context) {
  const tokens = context.tokens;
  const options = context.options;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.category !== TokenCategory.Unknown)
      continue;
    let word = trim(token.content, [" ", "-"]);
    if (word === "")
      continue;
    if (word.length !== 8 && isNumericString(word))
      continue;
    let category = ElementCategory.Unknown;
    const keyword = KeywordManager.normalize(word);
    const found = KeywordManager.find(keyword, ElementCategory.Unknown);
    if (found) {
      category = found.category;
      if (!options.parseReleaseGroup && category === ElementCategory.ReleaseGroup) {
        continue;
      }
      if (!isElementCategorySearchable(category) || !found.searchable) {
        continue;
      }
      if (isElementCategorySingular(category) && hasResult(context, category)) {
        continue;
      }
      switch (found.category) {
        case ElementCategory.AnimeSeasonPrefix:
          checkAndSetAnimeSeasonKeyword(context, i);
          continue;
        case ElementCategory.EpisodePrefix:
          if (found.valid) {
            checkExtentKeyword(context, ElementCategory.EpisodeNumber, i);
          }
          continue;
        case ElementCategory.ReleaseVersion:
          word = word.slice(1);
          break;
        case ElementCategory.VolumePrefix:
          checkExtentKeyword(context, ElementCategory.VolumeNumber, i);
          continue;
      }
    } else {
      if (checkAndSetAnimeSeason(context, i)) {
        continue;
      }
      if (checkAndSetAnimeMonth(context, i)) {
        continue;
      }
      if (checkAndSetReleaseGroup(context, i)) {
        continue;
      }
      if (!hasResult(context, ElementCategory.FileChecksum) && isCRC32(word)) {
        category = ElementCategory.FileChecksum;
      } else if (!hasResult(context, ElementCategory.VideoResolution) && isResolution(word)) {
        category = ElementCategory.VideoResolution;
      }
      {
        const found2 = KeywordManager.find(keyword, ElementCategory.FileExtension);
        if (found2) {
          category = found2.category;
        }
      }
    }
    if (category !== ElementCategory.Unknown) {
      setResult(context, category, word);
      if (!found || found.identifiable) {
        token.category = TokenCategory.Identifier;
      }
    }
  }
}
function searchForIsolatedNumbers(context) {
  for (let i = 0; i < context.tokens.length; i++) {
    const token = context.tokens[i];
    if (token.category !== TokenCategory.Unknown || !isNumericString(token.content) || !isTokenIsolated(context, i)) {
      continue;
    }
    const num = +token.content;
    if (AnimeYearMin <= num && num <= AnimeYearMax) {
      if (!hasResult(context, ElementCategory.AnimeYear)) {
        setResult(context, ElementCategory.AnimeYear, token.content);
        token.category = TokenCategory.Identifier;
        continue;
      }
    }
    if (num !== 480 && num !== 720 && num !== 1080)
      continue;
    if (hasResult(context, ElementCategory.VideoResolution))
      continue;
    setResult(context, ElementCategory.VideoResolution, token.content);
    token.category = TokenCategory.Identifier;
  }
}
function searchForEpisodeNumber(context) {
  const tokens = context.tokens.map((token, idx) => [token, idx]).filter(
    // fix: only use Unknown token and it must have digit char
    ([token]) => token.category === TokenCategory.Unknown && indexOfDigit(token.content) !== -1
  ).map(([_token, idx]) => idx);
  if (tokens.length === 0)
    return;
  context.isEpisodeKeywordsFound = hasResult(context, ElementCategory.EpisodeNumber);
  if (searchForEpisodePatterns(context, tokens))
    return;
  context.isEpisodeKeywordsFound = hasResult(context, ElementCategory.EpisodeNumber);
  if (context.isEpisodeKeywordsFound)
    return;
  tokens.splice(
    0,
    tokens.length,
    ...tokens.filter((t) => isNumericString(context.tokens[t].content))
  );
  if (searchForEquivalentNumbers(context, tokens))
    return;
  if (searchForSeparatedNumbers(context, tokens))
    return;
  if (searchForIsolatedEpisodeNumber(context, tokens))
    return;
  if (searchForEpisodeNumberWithVersion(context, tokens))
    return;
  searchForLastNumber(context, tokens);
}
function searchForAnimeTitle(context) {
  let enclosedTitle = false;
  let tokenBegin = findToken(
    context.tokens,
    0,
    context.tokens.length,
    TokenFlag.NotEnclosed,
    TokenFlag.Unknown
  );
  if (!inRange(context.tokens, tokenBegin)) {
    tokenBegin = 0;
    enclosedTitle = true;
    do {
      tokenBegin = findToken(context.tokens, tokenBegin, context.tokens.length, TokenFlag.Unknown);
      if (!inRange(context.tokens, tokenBegin))
        break;
      if (!isMostlyLatinString(context.tokens[tokenBegin].content)) {
        break;
      }
      tokenBegin = findToken(context.tokens, tokenBegin, context.tokens.length, TokenFlag.Bracket);
      if (!inRange(context.tokens, tokenBegin))
        break;
      tokenBegin = findToken(context.tokens, tokenBegin, context.tokens.length, TokenFlag.Unknown);
    } while (inRange(context.tokens, tokenBegin));
  }
  if (!inRange(context.tokens, tokenBegin))
    return;
  let tokenEnd = findToken(
    context.tokens,
    tokenBegin,
    context.tokens.length,
    TokenFlag.Identifier,
    enclosedTitle ? TokenFlag.Bracket : TokenFlag.None
  );
  if (!enclosedTitle) {
    let lastBracket = tokenEnd;
    let bracketOpen = false;
    for (let i = tokenBegin; i < tokenEnd; i++) {
      if (context.tokens[i].category === TokenCategory.Bracket) {
        lastBracket = i;
        bracketOpen = !bracketOpen;
      }
    }
    if (bracketOpen)
      tokenEnd = lastBracket;
  }
  if (!enclosedTitle) {
    let token = findPrevToken(context.tokens, tokenEnd, TokenFlag.NotDelimiter);
    while (isMatchTokenCategory(TokenCategory.Bracket, context.tokens[token]) && context.tokens[token].content[0] != ")") {
      token = findPrevToken(context.tokens, token, TokenFlag.Bracket);
      if (inRange(context.tokens, token)) {
        tokenEnd = token;
        token = findPrevToken(context.tokens, tokenEnd, TokenFlag.NotDelimiter);
      }
    }
  }
  buildElement(
    context,
    ElementCategory.AnimeTitle,
    false,
    context.tokens.slice(tokenBegin, tokenEnd)
  );
}

const Brackets = [
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
  ["\u300C", "\u300D"],
  ["\u300E", "\u300F"],
  ["\u3010", "\u3011"],
  ["\uFF08", "\uFF09"]
];
function tokenize(filename, options) {
  let result = {};
  const tokens = [];
  tokenizeByBrackets();
  return { ok: tokens.length > 0, result, tokens };
  function addToken(category, enclosed, range) {
    tokens.push({
      category,
      content: range.toString(),
      enclosed
    });
  }
  function tokenizeByBrackets() {
    let isBracketOpen = false;
    let matchingBracket = void 0;
    for (let i = 0; i < filename.length; ) {
      const foundIdx = !isBracketOpen || !matchingBracket ? findFirstBracket(i, filename.length) : filename.indexOf(matchingBracket, i);
      const range = new TextRange(filename, i, foundIdx === -1 ? filename.length : foundIdx - i);
      if (range.size > 0) {
        tokenizeByPreidentified(isBracketOpen, range);
      }
      if (foundIdx !== -1) {
        addToken(TokenCategory.Bracket, true, range.fork(range.offset + range.size, 1));
        isBracketOpen = !isBracketOpen;
        i = foundIdx + 1;
      } else {
        break;
      }
    }
    function findFirstBracket(start, end) {
      for (let i = start; i < end; i++) {
        for (const [left, right] of Brackets) {
          if (filename[i] === left) {
            matchingBracket = right;
            return i;
          }
        }
      }
      return -1;
    }
  }
  function tokenizeByPreidentified(enclosed, range) {
    const { result: _result, predefined } = KeywordManager.peek(range);
    result = mergeResult(result, _result);
    let offset = range.offset;
    let subRange = range.fork(range.offset, 0);
    while (offset < range.offset + range.size) {
      for (const predefToken of predefined) {
        if (offset !== predefToken.offset)
          continue;
        if (subRange.size > 0) {
          tokenizeByDelimiters(enclosed, subRange);
        }
        addToken(TokenCategory.Identifier, enclosed, predefToken);
        subRange.offset = predefToken.offset + predefToken.size;
        offset = subRange.offset - 1;
      }
      subRange.size = ++offset - subRange.offset;
    }
    if (subRange.size > 0) {
      tokenizeByDelimiters(enclosed, subRange);
    }
  }
  function tokenizeByDelimiters(enclosed, range) {
    const delimiters = getDelimiters(range);
    if (delimiters.size === 0) {
      addToken(TokenCategory.Unknown, enclosed, range);
      return;
    }
    for (let i = range.offset, end = range.offset + range.size; i < end; ) {
      let found = end;
      for (let j = i; j < end && j < range.text.length; j++) {
        if (delimiters.has(range.text[j])) {
          found = j;
          break;
        }
      }
      const subRange = range.fork(i, found - i);
      if (subRange.size > 0) {
        addToken(TokenCategory.Unknown, enclosed, subRange);
      }
      if (found !== end) {
        addToken(
          TokenCategory.Delimiter,
          enclosed,
          subRange.fork(subRange.offset + subRange.size, 1)
        );
        i = found + 1;
      } else {
        break;
      }
    }
    validateDelimiterTokens();
  }
  function getDelimiters(range) {
    const delimiters = /* @__PURE__ */ new Set();
    for (let i = range.offset; i < range.offset + range.size; i++) {
      if (options.delimiters.includes(range.text[i])) {
        delimiters.add(range.text[i]);
      }
    }
    return delimiters;
  }
  function validateDelimiterTokens() {
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.category !== TokenCategory.Delimiter) {
        if (token.content === "\u6211\u63A8\u7684\u5B69\u5B50") {
          if (tokens[i - 1]?.content === "\u3010" && tokens[i + 1]?.content === "\u3011") {
            tokens[i - 1].category = TokenCategory.Invalid;
            tokens[i].content = "\u3010\u6211\u63A8\u7684\u5B69\u5B50\u3011";
            tokens[i].enclosed = false;
            tokens[i + 1].category = TokenCategory.Invalid;
          }
        }
        continue;
      }
      const delimiter = token.content[0];
      const prevToken = findPrevToken(tokens, i, TokenFlag.Valid);
      let nextToken = findNextToken(tokens, i, TokenFlag.Valid);
      if (![" ", "_"].includes(delimiter)) {
        if (isSingleCharacterToken(prevToken)) {
          appendTokenTo(token, tokens[prevToken]);
          while (isUnknownToken(nextToken)) {
            appendTokenTo(tokens[nextToken], tokens[prevToken]);
            nextToken = findNextToken(tokens, i, TokenFlag.Valid);
            if (!isDelimiterToken(nextToken) || tokens[nextToken].content[0] !== delimiter)
              continue;
            appendTokenTo(tokens[nextToken], tokens[prevToken]);
            nextToken = findNextToken(tokens, nextToken, TokenFlag.Valid);
          }
          continue;
        }
        if (isSingleCharacterToken(nextToken)) {
          appendTokenTo(token, tokens[prevToken]);
          appendTokenTo(tokens[nextToken], tokens[prevToken]);
          continue;
        }
      }
      if (isUnknownToken(prevToken) && isDelimiterToken(nextToken)) {
        const nextDelimiter = tokens[nextToken].content[0];
        if (delimiter !== nextDelimiter && delimiter !== ",") {
          if (delimiter === " " || nextDelimiter === "_") {
            appendTokenTo(token, tokens[prevToken]);
          }
        }
      } else if (isDelimiterToken(prevToken) && isDelimiterToken(nextToken)) {
        const prevDelimiter = tokens[prevToken].content[0];
        const nextDelimiter = tokens[nextToken].content[0];
        if (prevDelimiter === nextDelimiter && prevDelimiter != delimiter) {
          token.category = TokenCategory.Unknown;
        }
      }
      if (!["&", "+"].includes(delimiter))
        continue;
      if (!isUnknownToken(prevToken) || !isUnknownToken(nextToken))
        continue;
      if (!isNumericString(tokens[prevToken].content) || !isNumericString(tokens[nextToken].content)) {
        continue;
      }
      appendTokenTo(token, tokens[prevToken]);
      appendTokenTo(tokens[nextToken], tokens[prevToken]);
    }
    tokens.splice(0, tokens.length, ...tokens.filter((t) => t.category !== TokenCategory.Invalid));
    function isDelimiterToken(idx) {
      return inRange(tokens, idx) && tokens[idx].category === TokenCategory.Delimiter;
    }
    function isUnknownToken(idx) {
      return inRange(tokens, idx) && tokens[idx].category === TokenCategory.Unknown;
    }
    function isSingleCharacterToken(idx) {
      if (!inRange(tokens, idx))
        return false;
      const content = tokens[idx].content;
      return isUnknownToken(idx) && content.length === 1 && content !== "-";
    }
    function appendTokenTo(src, dst) {
      dst.content += src.content;
      src.category = TokenCategory.Invalid;
    }
  }
}

var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => {
  __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
  return value;
};
class Parser {
  constructor(options = {}) {
    __publicField(this, "options");
    __publicField(this, "cache", /* @__PURE__ */ new Map());
    this.options = resolveOptions(options);
  }
  parse(filename, force = false) {
    if (!force && this.cache.has(filename)) {
      const result = this.cache.get(filename);
      return result ? result : void 0;
    } else {
      const result = parse(filename, this.options);
      if (result) {
        this.cache.set(filename, result);
      } else {
        this.cache.set(filename, null);
      }
      return result;
    }
  }
}
function parse(filename, _options = {}) {
  if (filename === "")
    return void 0;
  let result = {};
  const options = resolveOptions(_options);
  result.filename = filename;
  if (options.parseFileExtension) {
    const ext = removeExtension(filename);
    if (ext) {
      result.filename = filename;
      result.extension = ext.extension;
    }
  }
  const tokenized = tokenize(result.filename, options);
  result = mergeResult(result, tokenized.result);
  if (!tokenized.ok) {
    return resolveResult(result);
  }
  const parsed = parse$1(result, tokenized.tokens, options);
  result = parsed.result;
  return resolveResult(result);
}
function resolveOptions(options) {
  return {
    delimiters: " _.&+,|",
    parseEpisodeNumber: true,
    parseEpisodeTitle: true,
    parseFileExtension: true,
    parseReleaseGroup: true,
    ...options
  };
}
function resolveResult(result) {
  const resolved = {
    title: result["title"],
    type: result["type"],
    season: normalizeSeason(result["season"]),
    year: normalizeNumber(result["year"]),
    month: normalizeNumber(result["month"]),
    language: result["language"],
    subtitles: result["subtitles"],
    source: result["source"],
    episode: {
      number: normalizeNumber(result["episode.number"]),
      numberAlt: normalizeNumber(result["episode.numberAlt"]),
      title: result["episode.title"]
    },
    volume: {
      number: normalizeNumber(result["volume"])
    },
    video: {
      term: result["video.term"],
      resolution: result["video.resolution"]
    },
    audio: {
      term: result["audio.term"]
    },
    release: {
      version: normalizeNumber(result["release.version"]),
      group: result["release.group"]
    },
    file: {
      name: result["filename"],
      extension: result["extension"],
      checksum: result["checksum"]
    }
  };
  return resolved;
  function normalizeSeason(num) {
    if (num !== void 0 && num !== null) {
      return /^\d+$/.test(num) ? String(+num) : num;
    } else {
      return void 0;
    }
  }
  function normalizeNumber(num) {
    try {
      if (num !== void 0 && num !== null) {
        const n = parseFloat(num);
        return !Number.isNaN(n) ? n : void 0;
      }
    } catch {
    }
    return void 0;
  }
}
function removeExtension(filename) {
  const position = filename.lastIndexOf(".");
  if (position === -1)
    return void 0;
  const extension = filename.slice(position + 1);
  if (extension.length > 4 || !/^[a-zA-Z0-0]+$/.test(extension)) {
    return void 0;
  }
  if (!KeywordManager.contains(ElementCategory.FileExtension, extension)) {
    return void 0;
  }
  return {
    filename: filename.slice(0, position),
    extension
  };
}

exports.Parser = Parser;
exports.parse = parse;
exports.resolveOptions = resolveOptions;

		return module.exports;
	}

})();
