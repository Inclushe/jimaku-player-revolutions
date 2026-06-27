// ==UserScript==
// @name         Jimaku Player Reloaded
// @namespace    https://github.com/mgp25/jimaku-player-reloaded
// @version      3.0.0
// @description  Browse, download, and align Japanese subtitles inside any Vidstack-based player using jimaku.cc.
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
		entryCache: get(KEYS.entryCache, {}),
		alignByShow: get(KEYS.alignBy, {}),
		entries: [],
		selectedEntry: null,
		files: [],
		ui: { panelOpen: false, tab: 'browse', loading: '', error: '' },
	};

	function findVidstackPlayer() {
		return document.querySelector('media-player');
	}
	function getLocalVideo() {
		const player = findVidstackPlayer();
		if (player) {
			const v = player.querySelector('video');
			if (v) return v;
		}
		return document.querySelector('media-provider video') || document.querySelector('video');
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

	// Best-effort show/episode detection from generic page metadata. There is no
	// universal "what am I watching" signal across Vidstack sites, so this only
	// pre-fills the manual search box — the user can always edit it.
	function detectShow() {
		const out = { showTitle: '', showKey: '', episodeNumber: null };

		const player = findVidstackPlayer();
		const candidates = [
			player?.getAttribute('title'),
			document.querySelector('meta[property="og:title"]')?.content,
			document.querySelector('h1')?.textContent,
			document.title,
		]
			.filter(Boolean)
			.map(clean);

		for (const s of candidates) {
			const m = s.match(/(?:Episode|Ep\.?|E|#)\s*(\d+)/i);
			if (m) {
				out.episodeNumber = parseInt(m[1], 10);
				break;
			}
		}

		// Take the first available title and strip a trailing site-brand suffix
		// (e.g. "My Show - Vidstack") plus a leading "Watch ".
		let raw = candidates[0] || '';
		const brand = location.hostname.replace(/^www\./, '').split('.')[0] || '';
		if (brand) {
			raw = raw.replace(new RegExp('\\s*[\\-–—|:·]\\s*' + escapeRe(brand) + '.*$', 'i'), '');
		}
		out.showTitle = clean(raw.replace(/^watch\s+/i, ''));
		out.showKey = (location.hostname + '|' + out.showTitle).toLowerCase();
		return out;
	}

	function refreshDetection() {
		const next = detectShow();
		const changed =
			!state.detected ||
			state.detected.showKey !== next.showKey ||
			state.detected.episodeNumber !== next.episodeNumber;
		state.detected = next;
		if (changed) {
			if (next.showKey && typeof state.alignByShow[next.showKey] === 'number') {
				state.alignment = state.alignByShow[next.showKey];
			}
			renderPanel();
		}
	}

	new MutationObserver(refreshDetection).observe(document.documentElement, { subtree: true, childList: true });
	refreshDetection();

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
		line-height: 1.45; color: #fff; white-space: pre-wrap;
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
	#jp-panel input[type=text], #jp-panel input[type=password], #jp-panel input[type=number] {
		flex: 1; min-width: 0; padding: 6px 8px; border-radius: 5px; border: 1px solid #333a50;
		background: #11141d; color: #fff; font: inherit;
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

	function ensureMounted() {
		ensureStyles();
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
			const sortedFiles = sortFiles(state.files, state.preferAss);
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

				<label class="row" style="margin-top:8px"><input type="checkbox" id="jp-prefer-ass" ${state.preferAss ? 'checked' : ''}> Prefer ASS files when available</label>

				<label>Subtitle font scale (${Math.round(state.fontScale * 100)}%)</label>
				<input id="jp-scale" type="range" min="0.6" max="2.5" step="0.1" value="${state.fontScale}">

				<label>Position</label>
				<div class="row">
					<button class="btn" data-pos="bottom" ${state.position === 'bottom' ? 'style="background:#e83450"' : ''}>Bottom</button>
					<button class="btn" data-pos="top" ${state.position === 'top' ? 'style="background:#e83450"' : ''}>Top</button>
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
			});
			panel.querySelector('#jp-prefer-ass')?.addEventListener('change', (ev) => {
				state.preferAss = ev.target.checked;
				set(KEYS.preferAss, state.preferAss);
				renderPanel();
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
		const sorted = sortFiles(state.files, state.preferAss);
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
		const idx = findSubIndex(t);
		if (idx >= 0) {
			const sub = state.subtitles[idx];
			if (el && el.textContent !== sub.text) el.textContent = sub.text;
			if (el) el.style.display = 'inline-block';
			if (idx !== state.currentSubIndex) {
				state.currentSubIndex = idx;
				state.history = [sub, ...state.history.slice(0, 9)];
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
			info('key', k, 'mediaPlayer=' + document.querySelectorAll('media-player').length, 'mounted=' + !!host);
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

	let _lastDiag = 0;
	function bootstrap() {
		ensureMounted();
		const now = Date.now();
		if (now - _lastDiag > 3000) {
			_lastDiag = now;
			const mp = document.querySelectorAll('media-player').length;
			const mpv = document.querySelectorAll('media-provider').length;
			const vid = document.querySelectorAll('video').length;
			// Only chatter while something player-ish is around, or until we mount.
			if (mp || mpv || vid || host) {
				info('scan', 'media-player=' + mp, 'media-provider=' + mpv, 'video=' + vid, 'mounted=' + !!host);
			}
		}
	}
	new MutationObserver(bootstrap).observe(document.documentElement, { childList: true, subtree: true });
	bootstrap();
	setInterval(bootstrap, 1000);
	setInterval(tick, 50);
})();
