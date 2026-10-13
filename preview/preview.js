/* ‘Quick Look’ for LINKS — preview engine. Runs inside the sealed extension frame.
   Decides how to show a link (live page, reader, media, PDF, summary…), fetches
   only after the user pressed Space, and never with cookies unless the user
   allowed that site. Talks to the content script over a private MessagePort. */
(() => {
  'use strict';

  const L = globalThis.QLLinks;
  const X = globalThis.QLExtract;
  const sid = location.hash.slice(1);
  const stage = document.getElementById('stage');
  const layers = document.getElementById('layers');

  let port = null;
  let current = null;            // the active 'show' message
  let currentResult = null;
  let currentMode = null;
  let inflight = null;           // AbortController for the active fetch
  const cache = new Map();       // url -> result (LRU, per tab, per session)
  const CACHE_MAX = 40;
  const liveFrames = new Map();  // url -> { iframe, loaded, revealed }
  const forced = new Set();      // links the user chose to preview anyway
  const statSent = new Set();

  const ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8';
  const HTML_CAP = 5 * 1024 * 1024;
  const TEXT_CAP = 512 * 1024;
  const IMAGE_CAP = 40 * 1024 * 1024;
  const PDF_CAP = 100 * 1024 * 1024;

  /* ---------------- Port handshake ---------------- */
  let claiming = false;
  addEventListener('message', async (e) => {
    if (port || claiming) return;
    const d = e.data;
    if (!d || d.ql !== 'init' || d.sid !== sid || !e.ports || !e.ports[0]) return;
    claiming = true;
    // Only accept instructions if the extension's own content script vouched for this
    // frame, in this tab. A web page that embeds preview.html can't pass this.
    let ok = false;
    try { ok = !!(await chrome.runtime.sendMessage({ type: 'ql:claim-frame', sid })).ok; } catch (err) { ok = false; }
    if (!ok) { claiming = false; return; }
    port = e.ports[0];
    port.onmessage = (ev) => onMessage(ev.data);
    post({ type: 'ready' });
  });

  function post(msg) { if (port) port.postMessage(msg); }

  function onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'show': show(msg); break;
      case 'mode': if (current && msg.id === current.id && currentResult) renderResult(currentResult, msg.mode, { userSwitch: true }); break;
      case 'hide': hideAll(); break;
      case 'scroll': scrollStage(msg.key); break;
      case 'theme': setTheme(msg.theme, msg.readerFont); break;
    }
  }

  function setTheme(theme, font) {
    if (theme) document.documentElement.dataset.theme = theme;
    if (font) document.documentElement.dataset.font = font;
  }

  /* ---------------- Keyboard inside the frame ---------------- */
  addEventListener('keydown', (e) => {
    // Hidden (panel closed): never hold on to keys meant for the page.
    if (!port || !current) return;
    const t = e.target;
    if (t && t.closest && t.closest('input, textarea, select, [contenteditable="true"]')) return;
    const k = e.key;
    const mod = e.metaKey || e.ctrlKey;
    if ((k === 'PageDown' || k === 'PageUp' || k === 'Home' || k === 'End') && !mod) {
      e.preventDefault(); scrollStage(k); return;
    }
    let forward = false;
    if (k === 'Escape' || k === ' ' || e.code === 'Space' || k === 'Enter' || k.startsWith('Arrow')) forward = true;
    if (!mod && !e.altKey && /^[fFrR]$/.test(k)) forward = true;
    if (mod && (k === 'c' || k === 'C') && !String(getSelection() || '')) forward = true;
    if (k.startsWith('Arrow') && (mod || e.altKey)) forward = false;
    if (k === 'Enter' && t && t.closest && t.closest('button, a')) forward = false;
    if (!forward) return;
    e.preventDefault();
    post({ type: 'key', key: k, code: e.code, altKey: e.altKey, shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey, repeat: e.repeat });
  }, true);

  function scrollStage(key) {
    const el = stage;
    const page = Math.max(80, el.clientHeight - 60);
    const opts = { behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' };
    if (key === 'PageDown') el.scrollBy(Object.assign({ top: page }, opts));
    else if (key === 'PageUp') el.scrollBy(Object.assign({ top: -page }, opts));
    else if (key === 'Home') el.scrollTo(Object.assign({ top: 0 }, opts));
    else if (key === 'End') el.scrollTo(Object.assign({ top: el.scrollHeight }, opts));
  }

  /* Links inside reader/summary views open in tabs instead of navigating the frame. */
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    e.preventDefault();
    if (a.dataset.anchor) {
      let target = null;
      try { target = stage.querySelector('#' + CSS.escape('g-' + decodeURIComponent(a.dataset.anchor))); } catch (err) { target = null; }
      if (target) { target.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    }
    const url = a.href;
    if (!/^https?:/i.test(url)) return;
    post({ type: 'open', url, active: !(e.metaKey || e.ctrlKey || e.button === 1), newWindow: e.shiftKey });
  });
  document.addEventListener('auxclick', (e) => {
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a || e.button !== 1) return;
    e.preventDefault();
    post({ type: 'open', url: a.href, active: false });
  });

  /* ---------------- DOM helpers ---------------- */
  function h(tag, attrs, children) {
    const el = document.createElement(tag);
    if (attrs) for (const k of Object.keys(attrs)) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    if (children) for (const c of children) if (c != null && c !== false) el.append(c);
    return el;
  }
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function icon(paths, vb) {
    const s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('viewBox', vb || '0 0 24 24');
    s.setAttribute('fill', 'none');
    for (const d of paths) {
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', d);
      p.setAttribute('stroke', 'currentColor');
      p.setAttribute('stroke-width', '1.8');
      p.setAttribute('stroke-linecap', 'round');
      p.setAttribute('stroke-linejoin', 'round');
      s.append(p);
    }
    return s;
  }
  const GLYPH = {
    shield: () => icon(['M12 3l7 3v5c0 4.4-3 8.4-7 10-4-1.6-7-5.6-7-10V6l7-3z', 'M12 8v4.5', 'M12 15.8v.2']),
    cloudOff: () => icon(['M3 3l18 18', 'M7.5 7.6A5 5 0 0 0 6.5 17H17', 'M10 5.3A6 6 0 0 1 18 10a4 4 0 0 1 2.2 6.8']),
    clock: () => icon(['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2']),
    key: () => icon(['M6 11h12v9.5H6z', 'M8.5 11V8a3.5 3.5 0 0 1 7 0v3', 'M12 15v2']),
    lockdoc: () => icon(['M6 3h8l4 4v14H6z', 'M14 3v4h4', 'M9 13h6', 'M9 17h4']),
    music: () => icon(['M9 18V5l11-2v13', 'M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M17 19a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'])
  };

  function toast(text) {
    const t = h('div', { class: 'frame-toast', text });
    document.body.append(t);
    setTimeout(() => t.remove(), 3400);
  }

  /* ---------------- Meta to the title bar ---------------- */
  function sendMeta(extra) {
    if (!current) return;
    post(Object.assign({ type: 'meta', id: current.id }, extra));
  }

  function contentShown(mode, cached) {
    if (!current || statSent.has(current.id)) return;
    statSent.add(current.id);
    post({ type: 'stat', id: current.id, mode, cached: !!cached });
  }

  /* ---------------- Show ---------------- */
  let showToken = 0;
  let idleRelease = 0;
  async function show(msg) {
    const token = ++showToken;
    // Privacy-relevant options come from storage, never from the message.
    const st = await QLSettings.get();
    if (token !== showToken) return;
    const host = L.hostLabel(msg.url);
    msg = Object.assign({}, msg, {
      // Never send cookies for a destination read out of a button's script, or
      // when the page forced the extension into a credentialless frame.
      cookies: !msg.fromAction && !msg.noCookies && QLSettings.hostMatches(host, st.cookieSites),
      refuseRisky: st.refuseRisky !== false,
      timeoutSec: Math.min(60, Math.max(3, Number(msg.timeoutSec) || st.timeoutSec || 8)),
      preferMode: st.preferMode,
      forceLive: st.forceLive !== false
    });
    current = msg;
    sendFavicon(msg);
    currentResult = null;
    currentMode = null;
    setTheme(msg.theme, msg.readerFont);
    if (inflight) { try { inflight.abort('superseded'); } catch (e) { /* ignore */ } }
    inflight = null;
    concealLayers();
    const url = msg.url;
    const id = msg.id;

    if (msg.refuseRisky && !forced.has(url)) {
      const verdict = L.assess(url, { text: msg.text, method: msg.method });
      if (!verdict.ok) {
        if (verdict.kind === 'scheme' || verdict.kind === 'invalid') return renderResult({ kind: 'refused', url, verdict, noForce: true });
        return renderResult({ kind: 'refused', url, verdict });
      }
    }

    const ckey = cacheKey(msg);
    const hit = cache.get(ckey);
    if (hit) {
      cache.delete(ckey); cache.set(ckey, hit);
      return renderResult(hit, hit.kind === 'page' ? defaultMode(hit, msg) : null, { cached: true });
    }

    showLoading(url);
    const ctl = new AbortController();
    inflight = ctl;
    let result;
    try {
      result = await resolve(msg, ctl);
    } catch (err) {
      if (!current || current.id !== id) return;
      result = errorResult(url, err, ctl);
    }
    if (!current || current.id !== id) return;
    inflight = null;
    if (result.cacheable !== false) remember(ckey, result);
    renderResult(result);
  }

  function cacheKey(msg) { return (msg.cookies ? 'c|' : '') + (msg.forceLive ? 'f|' : '') + msg.url; }

  function defaultMode(res, msg) {
    if (msg.preferMode === 'reader' && res.modes.includes('reader')) return 'reader';
    if (res.modes.includes('live')) return 'live';
    return res.modes.includes('reader') ? 'reader' : res.modes[0];
  }

  /* Session cache: 40 entries, and blob-backed entries (PDFs, images) capped
     at 120 MB in total. Blobs are released when the panel closes. */
  const BLOB_BUDGET = 120 * 1024 * 1024;
  function remember(key, result) {
    cache.set(key, result);
    let bytes = 0;
    for (const v of cache.values()) if (v.blobUrl) bytes += v.size || 0;
    for (const [k, v] of Array.from(cache.entries())) {
      if (cache.size <= CACHE_MAX && bytes <= BLOB_BUDGET) break;
      if (k === key) continue;
      if (cache.size > CACHE_MAX || v.blobUrl) {
        cache.delete(k);
        if (v.blobUrl) { bytes -= v.size || 0; URL.revokeObjectURL(v.blobUrl); }
      }
    }
  }

  function releaseBlobs() {
    for (const [k, v] of Array.from(cache.entries())) {
      if (v.blobUrl) { URL.revokeObjectURL(v.blobUrl); cache.delete(k); }
    }
  }

  /* The title bar's favicon comes from the browser's own favicon cache (no
     network), handed over as a data URL so the page never sees an extension URL. */
  async function sendFavicon(msg) {
    try {
      const r = await fetch(chrome.runtime.getURL('/_favicon/') + '?pageUrl=' + encodeURIComponent(msg.url) + '&size=32');
      const blob = await r.blob();
      if (!blob.size || blob.size > 64 * 1024) return;
      const data = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob); });
      if (current && current.id === msg.id) post({ type: 'favicon', id: msg.id, data });
    } catch (e) { /* no favicon */ }
  }

  function errorResult(url, err, ctl) {
    const reason = ctl && ctl.signal.reason;
    if (reason === 'timeout') return { kind: 'timeout', url, cacheable: false };
    if (err && err.ql) return Object.assign({ url, cacheable: false }, err.ql);
    return { kind: 'error', url, title: 'Couldn’t reach ' + L.hostLabel(url), message: 'The site didn’t answer. You might be offline, the address may be wrong, or another extension blocked the request.', cacheable: false };
  }

  function showLoading(url) {
    sendMeta({ mode: 'loading', modes: [], loading: true });
    const bar = h('div', { class: 'progress hidden' }, [h('div')]);
    const label = h('div', { class: 'progress-label' });
    stage.classList.remove('hidden');
    stage.replaceChildren(h('div', { class: 'loading-view' }, [h('div', null, [
      h('div', { class: 'host', text: L.hostLabel(url) }),
      bar, label
    ])]));
    stage.scrollTop = 0;
  }

  function setProgress(done, total) {
    const bar = stage.querySelector('.progress');
    const label = stage.querySelector('.progress-label');
    if (!bar) return;
    bar.classList.remove('hidden');
    if (total) bar.firstChild.style.width = Math.min(100, (done / total) * 100).toFixed(1) + '%';
    if (label) label.textContent = X.formatBytes(done) + (total ? ' of ' + X.formatBytes(total) : '');
  }

  /* ---------------- Network ---------------- */
  async function hasAccess(url) {
    try {
      const u = new URL(url);
      return await chrome.permissions.contains({ origins: [u.protocol + '//' + u.hostname + '/*'] });
    } catch (e) { return false; }
  }

  function needAccess(url) {
    const u = new URL(url);
    const e = new Error('permission');
    e.ql = { kind: 'permission', origin: u.protocol + '//' + u.hostname + '/*', host: u.hostname };
    return e;
  }

  async function probe(url, msg, ctl, extra) {
    const timeoutMs = Math.max(3, msg.timeoutSec || 8) * 1000;
    const timer = setTimeout(() => ctl.abort('timeout'), timeoutMs);
    try {
      const res = await fetch(url, Object.assign({
        method: 'GET',
        credentials: msg.cookies ? 'include' : 'omit',
        redirect: 'follow',
        cache: 'default',
        referrerPolicy: 'no-referrer',
        signal: ctl.signal,
        headers: { Accept: ACCEPT }
      }, extra || {}));
      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  async function readBody(res, cap, ctl, onProgress, timeoutMs, asBlob) {
    if (!res.body) return new Uint8Array(await res.arrayBuffer());
    const reader = res.body.getReader();
    const total = parseInt(res.headers.get('content-length') || '0', 10) || 0;
    const chunks = [];
    let size = 0, truncated = false;
    let timer = 0;
    if (timeoutMs) timer = setTimeout(() => ctl.abort('timeout'), timeoutMs);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        size += value.byteLength;
        if (onProgress) onProgress(size, total);
        if (size >= cap) { truncated = true; try { await reader.cancel(); } catch (e) { /* ignore */ } break; }
      }
    } finally { if (timer) clearTimeout(timer); }
    if (asBlob) { const b = new Blob(chunks, { type: asBlob }); b.truncated = truncated; return b; }
    const out = new Uint8Array(size);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.byteLength; }
    out.truncated = truncated;
    return out;
  }

  function cancelBody(res) { try { res.body && res.body.cancel(); } catch (e) { /* ignore */ } }

  function fileNameFrom(res, url) {
    const cd = res && res.headers.get('content-disposition');
    if (cd) {
      const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(cd);
      if (star) { try { return decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')); } catch (e) { /* ignore */ } }
      const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(cd);
      if (plain) return plain[1].trim();
    }
    try {
      const p = new URL(url).pathname.split('/').filter(Boolean).pop();
      return p ? decodeURIComponent(p) : L.hostLabel(url);
    } catch (e) { return url; }
  }

  /* ---------------- Resolve: decide what this link is ---------------- */
  async function resolve(msg, ctl) {
    const url = msg.url;

    const yt = L.youtube(url);
    if (yt) return resolveYouTube(url, yt);
    if (!(await hasAccess(url))) throw needAccess(url);
    const vm = L.vimeo(url);
    if (vm) return { kind: 'video', provider: 'vimeo', url, embed: 'https://player.vimeo.com/video/' + vm.id + '?autoplay=1&dnt=1' + (vm.hash ? '&h=' + vm.hash : ''), title: 'Vimeo video', site: 'Vimeo' };

    const ek = L.extKind(url);
    if (ek === 'image') return { kind: 'image', url, src: url, site: L.hostLabel(url), title: fileNameFrom(null, url) };
    if (ek === 'video' || ek === 'audio') return { kind: ek === 'video' ? 'media-video' : 'media-audio', url, src: url, site: L.hostLabel(url), title: fileNameFrom(null, url) };

    const tw = L.tweet(url);
    if (tw) { const r = await resolveTweet(url, ctl).catch(() => null); if (r) return r; }
    const rd = L.reddit(url);
    if (rd) { const r = await resolveReddit(url, rd, msg, ctl).catch(() => null); if (r) return r; }
    const gh = L.github(url);
    if (gh && gh.kind === 'blob' && !/\.(md|markdown|mdx|rst|ipynb)$/i.test(gh.path)) {
      const raw = 'https://raw.githubusercontent.com/' + gh.owner + '/' + gh.repo + '/' + gh.ref + '/' + gh.path;
      if (L.extKind(raw) !== 'image' && L.extKind(raw) !== 'pdf') {
        const r = await resolveGeneric(raw, msg, ctl).catch(() => null);
        if (r && r.kind === 'text') return Object.assign(r, { url, title: gh.path.split('/').pop(), site: gh.owner + '/' + gh.repo, openUrl: url });
      }
    }
    if (msg.download || ek === 'file') return resolveFile(url, msg, ctl);
    return resolveGeneric(url, msg, ctl);
  }

  async function resolveYouTube(url, yt) {
    const embedHost = 'https://www.youtube-nocookie.com/';
    if (!(await hasAccess(embedHost))) throw needAccess(embedHost);
    let embed;
    if (yt.playlist && !yt.id) embed = embedHost + 'embed/videoseries?list=' + encodeURIComponent(yt.playlist) + '&autoplay=1';
    else embed = embedHost + 'embed/' + yt.id + '?autoplay=1&rel=0&playsinline=1&enablejsapi=1' + (yt.start ? '&start=' + yt.start : '') + (yt.list ? '&list=' + encodeURIComponent(yt.list) : '');
    embed += '&enablejsapi=1&origin=' + encodeURIComponent(location.origin);
    // Title and errors arrive from the player itself over its postMessage API,
    // so there's no separate request to YouTube for metadata.
    return { kind: 'video', provider: 'youtube', url, embed, videoId: yt.id || null, vertical: !!yt.shorts, title: 'YouTube video', site: 'YouTube' };
  }

  async function resolveTweet(url, ctl) {
    const api = 'https://publish.twitter.com/oembed?omit_script=1&dnt=true&url=' + encodeURIComponent(url);
    if (!(await hasAccess(api))) return null;
    const r = await fetch(api, { credentials: 'omit', signal: ctl.signal, referrerPolicy: 'no-referrer' });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j.html) return null;
    return { kind: 'post', provider: 'x', url, title: (j.author_name || 'Post') + ' on X', site: 'X', author: j.author_name, authorUrl: j.author_url, html: j.html };
  }

  async function resolveReddit(url, rd, msg, ctl) {
    const api = 'https://www.reddit.com' + rd.path + '.json?limit=8&depth=1&raw_json=1&sort=top';
    const r = await probe(api, msg, ctl, { headers: { Accept: 'application/json' } });
    if (!r.ok) return null;
    const j = await r.json();
    const post = j && j[0] && j[0].data && j[0].data.children && j[0].data.children[0] && j[0].data.children[0].data;
    if (!post) return null;
    const comments = ((j[1] && j[1].data && j[1].data.children) || [])
      .filter((c) => c.kind === 't1' && c.data && c.data.body_html && !c.data.stickied)
      .slice(0, 6).map((c) => ({ author: c.data.author, score: c.data.score, html: c.data.body_html }));
    let image = null;
    try { image = post.preview.images[0].source.url; } catch (e) { /* none */ }
    if (!image && /\.(jpe?g|png|gif|webp)$/i.test(post.url || '')) image = post.url;
    return {
      kind: 'post', provider: 'reddit', url, title: post.title, site: post.subreddit_name_prefixed || 'Reddit',
      author: 'u/' + post.author, html: post.selftext_html || '', link: post.is_self ? null : post.url, image,
      score: post.score, comments: post.num_comments, created: post.created_utc ? new Date(post.created_utc * 1000) : null, top: comments
    };
  }

  async function resolveFile(url, msg, ctl) {
    let res = null;
    try { res = await probe(url, msg, ctl, { method: 'HEAD' }); } catch (e) { if (ctl.signal.reason === 'timeout') throw e; }
    return {
      kind: 'file', url, title: fileNameFrom(res, url), site: L.hostLabel(url),
      size: res ? parseInt(res.headers.get('content-length') || '0', 10) : 0,
      type: res ? (res.headers.get('content-type') || '').split(';')[0] : ''
    };
  }

  async function resolveGeneric(url, msg, ctl) {
    const res = await probe(url, msg, ctl);
    const finalUrl = res.url || url;
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const type = ct.split(';')[0].trim();
    const site = L.hostLabel(finalUrl);
    let frame = X.frameability(res.headers);
    // With "show live pages even when a site blocks embedding" on, the extension's
    // network rule drops that refusal for its own sandboxed, logged-out frame.
    if (!frame.ok && msg.forceLive && !msg.cookies && !L.loginWalled(finalUrl) && (await hasAccess(finalUrl))) {
      frame = { ok: true, forced: true, reason: frame.reason, detail: frame.detail };
    }

    if (type.startsWith('image/')) {
      const blob = await readBody(res, IMAGE_CAP, ctl, null, 30000, type);
      if (blob.truncated) return { kind: 'image', url, src: finalUrl, site, title: fileNameFrom(res, finalUrl) };
      const blobUrl = URL.createObjectURL(blob);
      return { kind: 'image', url, finalUrl, src: blobUrl, blobUrl, site, title: fileNameFrom(res, finalUrl), size: blob.size, type };
    }
    if (type === 'application/pdf' || (type === 'application/octet-stream' && /\.pdf($|\?)/i.test(finalUrl))) {
      const total = parseInt(res.headers.get('content-length') || '0', 10);
      // Always show the downloaded bytes, never a second request in a frame:
      // the server could answer that one with a script-running page instead.
      const blob = await readBody(res, PDF_CAP, ctl, (d, t) => { if (current && current.url === url) setProgress(d, t); }, 0, 'application/pdf');
      if (blob.truncated) return { kind: 'file', url, title: fileNameFrom(res, finalUrl), site, size: total, type, note: 'This PDF is too large to preview. Open it in a tab instead.', cacheable: false };
      const blobUrl = URL.createObjectURL(blob);
      return { kind: 'pdf', url, finalUrl, src: blobUrl, blobUrl, site, title: fileNameFrom(res, finalUrl), size: blob.size };
    }
    if (type.startsWith('video/') || type.startsWith('audio/')) {
      cancelBody(res);
      return { kind: type.startsWith('video/') ? 'media-video' : 'media-audio', url, src: finalUrl, site, title: fileNameFrom(res, finalUrl) };
    }
    const isHtml = !type || type === 'text/html' || type === 'application/xhtml+xml';
    const isText = /^text\//.test(type) || /(json|xml|javascript|ecmascript|yaml|toml|csv|x-sh|x-python)/.test(type);
    if (!isHtml && !isText) {
      cancelBody(res);
      return { kind: 'file', url, finalUrl, title: fileNameFrom(res, finalUrl), site, size: parseInt(res.headers.get('content-length') || '0', 10), type };
    }
    if (!isHtml) {
      const bytes = await readBody(res, TEXT_CAP, ctl, null, 20000);
      return { kind: 'text', url, finalUrl, site, title: fileNameFrom(res, finalUrl), text: X.decode(bytes, ct), type, truncated: !!bytes.truncated, status: res.status };
    }

    const bytes = await readBody(res, HTML_CAP, ctl, null, 20000);
    const html = X.decode(bytes, ct);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    X.setBase(doc, finalUrl);
    const meta = X.extractMeta(doc, finalUrl, res.headers);
    const challenged = res.headers.get('cf-mitigated') === 'challenge' ||
      ((res.status === 403 || res.status === 503 || res.status === 429) && /just a moment|attention required|access denied|are you a robot|captcha|verify you are human|checking your browser/i.test(meta.title + ' ' + (doc.body ? doc.body.textContent.slice(0, 2000) : '')));
    if (challenged) {
      return { kind: 'error', url, finalUrl, frame, title: L.hostLabel(finalUrl) + ' asked for a human check', message: 'This site shows logged-out visitors a challenge page, so a private preview can’t get through. Open it in a tab instead.', status: res.status, cacheable: false };
    }
    if (res.status >= 400) {
      return {
        kind: 'error', url, finalUrl, frame, meta,
        title: 'The site answered ' + res.status + (res.statusText ? ' ' + res.statusText : ''),
        message: res.status === 404 ? 'That page doesn’t exist (anymore). The link may be broken or the page moved.'
          : res.status === 401 || res.status === 403 ? 'This page is only for signed-in visitors. Previews load logged out, unless you allow cookies for this site in Settings.'
            : 'The server couldn’t return the page right now.',
        status: res.status, cacheable: false
      };
    }
    const reader = X.extractReader(doc, finalUrl, meta);
    let readerData = null;
    if (reader) {
      const frag = X.tidy(X.sanitize(reader.contentEl, document, reader.base), reader.title, reader.byline);
      const holder = document.createElement('div');
      holder.append(frag);
      readerData = { title: reader.title, byline: reader.byline, words: reader.words, minutes: reader.minutes, label: reader.label, extras: reader.extras || [], node: holder };
    }
    const modes = [];
    if (frame.ok) modes.push('live');
    if (readerData) modes.push('reader');
    modes.push('summary');
    let mode = 'summary';
    if (msg.preferMode === 'reader' && readerData) mode = 'reader';
    else if (frame.ok) mode = 'live';
    else if (readerData) mode = 'reader';
    return { kind: 'page', url, finalUrl, frame, meta, reader: readerData, modes, mode, status: res.status, cookies: !!msg.cookies, hash: safeHash(url) };
  }

  function safeHash(url) { try { return new URL(url).hash; } catch (e) { return ''; } }

  /* ---------------- Render ---------------- */
  const cleanups = [];
  function concealLayers() {
    while (cleanups.length) { try { cleanups.pop()(); } catch (e) { /* ignore */ } }
    while (rescuedBlobs.length) URL.revokeObjectURL(rescuedBlobs.pop());
    for (const [k, f] of Array.from(liveFrames.entries())) {
      f.iframe.classList.remove('showing');
      // A page you clicked into may be playing something: don't keep it running hidden.
      if (f.interacted) { f.iframe.remove(); liveFrames.delete(k); }
    }
    for (const el of Array.from(layers.children)) {
      if (el.classList.contains('live-frame')) { el.style.visibility = 'hidden'; continue; }
      el.remove(); // embeds, PDFs, video: stop playback when leaving
    }
  }

  /* Clicking into a live page sends the keyboard to that site, which the extension
     can't read. Say how to get the preview's keys back, once per page. */
  let trapHintShown = false;
  addEventListener('blur', () => setTimeout(() => {
    const a = document.activeElement;
    if (!a || !a.classList || !a.classList.contains('live-frame')) return;
    for (const [, f] of liveFrames) if (f.iframe === a) f.interacted = true;
    if (!trapHintShown) {
      trapHintShown = true;
      toast('Keys now go to this page. Click the preview’s title bar to use ← → and Esc again.');
    }
  }, 0));

  function hideAll() {
    showToken++;
    // Let go of keyboard focus so it returns to the page.
    try { if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); } catch (e) { /* ignore */ }
    while (rescuedBlobs.length) URL.revokeObjectURL(rescuedBlobs.pop());
    clearTimeout(idleRelease);
    // Large blobs (PDFs, images) don't outlive the panel for long.
    idleRelease = setTimeout(releaseBlobs, 60000);
    if (inflight) { try { inflight.abort('closed'); } catch (e) { /* ignore */ } }
    inflight = null;
    current = null;
    currentResult = null;
    for (const [, f] of liveFrames) f.iframe.remove();
    liveFrames.clear();
    layers.replaceChildren();
    stage.replaceChildren();
  }

  function renderResult(res, mode, opts) {
    opts = opts || {};
    if (!current) return;
    currentResult = res;
    concealLayers();
    stage.classList.remove('hidden');
    stage.scrollTop = 0;
    const site = (res.meta && res.meta.site) || res.site || L.hostLabel(res.finalUrl || res.url);
    const base = { finalUrl: res.openUrl || res.finalUrl || res.url, site, loading: false };

    switch (res.kind) {
      case 'page': {
        mode = mode || res.mode;
        if (!res.modes.includes(mode)) mode = res.modes[0];
        currentMode = mode;
        const title = (mode === 'reader' && res.reader && res.reader.title) || res.meta.title || L.hostLabel(res.finalUrl);
        const info = mode === 'reader' && res.reader ? res.reader.minutes + ' min read' : (mode === 'live' ? (res.frame && res.frame.forced ? 'Loaded logged out · this site normally blocks embedding' : 'Loaded logged out') : '');
        sendMeta(Object.assign(base, { title, mode, modes: res.modes, info, loading: mode === 'live' }));
        if (mode === 'live') renderLive(res, opts);
        else if (mode === 'reader') { renderReader(res); contentShown('reader', opts.cached); }
        else { renderSummary(res); contentShown('summary', opts.cached); }
        if (opts.userSwitch) post({ type: 'settings-hint', mode });
        return;
      }
      case 'image': return renderImage(res, base, opts);
      case 'video': return renderEmbed(res, base, opts);
      case 'media-video': case 'media-audio': return renderMedia(res, base, opts);
      case 'pdf': return renderPdf(res, base, opts);
      case 'text': sendMeta(Object.assign(base, { title: res.title, mode: 'text', modes: [], info: res.type })); renderText(res); contentShown('text', opts.cached); return;
      case 'file': sendMeta(Object.assign(base, { title: res.title, mode: 'file', modes: [], info: [res.type, res.size ? X.formatBytes(res.size) : ''].filter(Boolean).join(' · ') })); renderFile(res); contentShown('file', opts.cached); return;
      case 'post': sendMeta(Object.assign(base, { title: res.title, mode: 'post', modes: [] })); renderPost(res); contentShown('post', opts.cached); return;
      case 'refused': sendMeta(Object.assign(base, { title: 'Not previewed', mode: 'refused', modes: [] })); renderRefused(res); contentShown('refused'); return;
      case 'permission': sendMeta(Object.assign(base, { title: 'Allow previews from ' + res.host + '?', mode: 'permission', modes: [] })); renderPermission(res); return;
      case 'timeout': sendMeta(Object.assign(base, { title: L.hostLabel(res.url) + ' is taking too long', mode: 'timeout', modes: [] })); renderTimeout(res); contentShown('timeout'); return;
      case 'error': default: sendMeta(Object.assign(base, { title: res.title || 'Couldn’t load', mode: 'error', modes: [] })); renderError(res); contentShown('error'); return;
    }
  }

  /* ----- Live page: the site itself, in a sandboxed, cookie-less frame ----- */
  function renderLive(res, opts) {
    const key = (res.cookies ? 'c|' : '') + res.finalUrl;
    let entry = liveFrames.get(key);
    stage.replaceChildren();
    stage.classList.add('hidden');
    // Is this exact live page what the panel is showing right now?
    const showingThis = () => !!(current && currentMode === 'live' && currentResult && currentResult.kind === 'page' &&
      ((currentResult.cookies ? 'c|' : '') + currentResult.finalUrl) === key);
    const meta = (extra) => sendMeta(Object.assign({ mode: 'live', modes: res.modes, title: res.meta.title, site: res.meta.site, finalUrl: res.finalUrl }, extra));
    if (!entry) {
      const f = document.createElement('iframe');
      f.className = 'live-frame';
      // A credentialless frame gets a fresh, empty cookie jar: the page sees a
      // logged-out visitor and can't act on your accounts.
      if (!res.cookies) f.credentialless = true;
      // No allow-top-navigation: a framed page can't redirect your tab.
      f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-presentation');
      // No autoplay: a page flipped past must not keep making noise.
      f.setAttribute('allow', 'fullscreen; picture-in-picture; encrypted-media');
      f.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
      f.setAttribute('title', res.meta.title || 'Live preview');
      entry = { iframe: f, loaded: false, revealed: false, interacted: false };
      liveFrames.set(key, entry);
      const reveal = () => {
        if (entry.revealed) return;
        entry.revealed = true;
        f.classList.add('loaded');
        if (showingThis()) {
          contentShown('live', false);
          if (!entry.loaded) meta({ loading: false, busy: true, info: 'Still loading' });
        }
      };
      f.addEventListener('load', () => {
        entry.loaded = true;
        reveal();
        if (showingThis()) meta({ loading: false, busy: false, info: 'Loaded logged out' });
      });
      // Pages keep painting long before every ad has loaded: show what's there.
      setTimeout(reveal, 1400);
      setTimeout(() => { if (!entry.loaded && showingThis()) meta({ loading: false, busy: false, info: 'Still loading' }); }, Math.max(3, current.timeoutSec || 8) * 1000);
      f.src = res.finalUrl + (res.hash && !res.finalUrl.includes('#') ? res.hash : '');
      layers.append(f);
      // Keep at most three live pages warm so flipping back is instant.
      while (liveFrames.size > 3) {
        const [k, v] = liveFrames.entries().next().value;
        if (k === key) break;
        v.iframe.remove();
        liveFrames.delete(k);
      }
    } else {
      liveFrames.delete(key); liveFrames.set(key, entry);
      if (entry.revealed) contentShown('live', true);
      if (entry.loaded) meta({ loading: false, busy: false, info: 'Loaded logged out' });
      else if (entry.revealed) meta({ loading: false, busy: true, info: 'Still loading' });
    }
    entry.iframe.style.visibility = 'visible';
    entry.iframe.classList.add('showing');
  }

  /* ----- Reader ----- */
  function siteRow(meta, url, label) {
    const img = h('img', { alt: '', referrerpolicy: 'no-referrer' });
    rescue(img, () => { img.src = faviconFallback(url); });
    img.src = meta.icon || faviconFallback(url);
    return h('div', { class: 'site-row' }, [img, h('span', { text: meta.site || L.hostLabel(url) }), label ? h('span', { class: 'label', text: label }) : null]);
  }

  function faviconFallback(url) {
    return chrome.runtime.getURL('/_favicon/') + '?pageUrl=' + encodeURIComponent(url) + '&size=32';
  }

  function dateRow(dates, extras) {
    const row = h('div', { class: 'meta-row' });
    const items = [];
    const d = dates && (dates.published || dates.modified);
    if (d) {
      const verb = dates.published ? 'Published' : 'Updated';
      items.push(h('span', { text: verb + ' ' + X.formatDate(d), title: 'From ' + (dates.source || 'the page') }));
      const years = (Date.now() - d.getTime()) / (365.25 * 864e5);
      const chip = h('span', { class: 'chip' + (years >= 2 ? ' old' : (years < 0.1 ? ' fresh' : '')), text: years >= 2 ? Math.floor(years) + ' years old' : X.relativeAge(d) });
      if (years >= 2) chip.title = 'This page is ' + Math.floor(years) + ' years old. Details may have changed.';
      items.push(chip);
      if (dates.published && dates.modified) items.push(h('span', { text: 'Updated ' + X.relativeAge(dates.modified) }));
    }
    for (const e of extras || []) if (e) items.push(typeof e === 'string' ? h('span', { text: e }) : e);
    items.forEach((it, i) => { if (i) row.append(h('span', { class: 'sep', text: '·' })); row.append(it); });
    return items.length ? row : null;
  }

  /* When Chrome won't load an image directly (cross-origin-isolated pages such
     as WhatsApp Web require images to opt in), the extension fetches it itself, without
     cookies, and shows the bytes. Only then does it give up on the image. */
  const rescuedBlobs = [];
  const RESCUE_CAP = 15 * 1024 * 1024;
  function rescue(img, onFail) {
    const ownerId = current && current.id;
    img.addEventListener('error', async () => {
      const src = img.currentSrc || img.src || '';
      if (img.dataset.rescued || !/^https?:/i.test(src) || !current || current.id !== ownerId) { if (onFail) onFail(); return; }
      img.dataset.rescued = '1';
      const ctl = new AbortController();
      cleanups.push(() => ctl.abort('left'));
      const timer = setTimeout(() => ctl.abort('timeout'), 15000);
      try {
        const r = await fetch(src, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: ctl.signal });
        const type = (r.headers.get('content-type') || '').split(';')[0];
        const len = parseInt(r.headers.get('content-length') || '0', 10);
        if (!r.ok || !/^image\//.test(type) || len > RESCUE_CAP) throw new Error('unusable');
        const blob = await readBody(r, RESCUE_CAP, ctl, null, 0, type);
        if (blob.truncated || !current || current.id !== ownerId) throw new Error('stale');
        const url = URL.createObjectURL(blob);
        rescuedBlobs.push(url);
        img.removeAttribute('srcset');
        img.addEventListener('error', () => { if (onFail) onFail(); }, { once: true });
        img.src = url;
      } catch (e) {
        if (onFail) onFail();
      } finally { clearTimeout(timer); }
    }, { once: true });
  }

  function hideBrokenImages(root) {
    for (const img of root.querySelectorAll('img')) {
      rescue(img, () => {
        const fig = img.closest('figure');
        if (fig && fig.querySelectorAll('img').length === 1) fig.remove(); else img.remove();
      });
    }
  }

  function renderReader(res) {
    const r = res.reader;
    const meta = res.meta;
    const content = r.node.cloneNode(true);
    content.className = 'content';
    const hasLeadImage = (() => {
      if (!meta.image) return true;
      const name = meta.image.split('?')[0].split('/').pop();
      const imgs = Array.from(content.querySelectorAll('img')).slice(0, 4);
      if (imgs.some((i) => (i.getAttribute('src') || '').includes(name))) return true;
      const first = content.firstElementChild;
      return !!(first && first.querySelector && first.querySelector('img'));
    })();
    const hero = !hasLeadImage && meta.image ? h('figure', { class: 'hero' }, [h('img', { src: meta.image, alt: '', referrerpolicy: 'no-referrer', loading: 'eager' })]) : null;
    const article = h('article', { class: 'reader', lang: meta.lang || null }, [
      siteRow(meta, res.finalUrl, r.label),
      h('h1', { class: 'title', text: r.title || meta.title }),
      r.byline && !/^by\s*$/i.test(r.byline) ? h('div', { class: 'byline', text: r.byline.length > 120 ? r.byline.slice(0, 120) + '…' : r.byline }) : null,
      dateRow(meta.dates, (r.extras || []).concat([r.minutes + ' min read'])),
      hero,
      content,
      h('footer', { class: 'footer' }, [
        h('span', { text: 'Reader preview · loaded ' + (res.cookies ? 'with your cookies' : 'logged out') + (res.frame && !res.frame.ok ? ' · ' + L.hostLabel(res.finalUrl) + ' doesn’t allow embedding' : '') }),
        h('a', { href: res.finalUrl, text: 'Open original ↗' })
      ])
    ]);
    hideBrokenImages(article);
    stage.replaceChildren(h('div', { class: 'reader-wrap' }, [article]));
  }

  /* ----- Summary card ----- */
  function renderSummary(res) {
    const meta = res.meta;
    const heroImg = meta.image ? h('img', { src: meta.image, alt: '', referrerpolicy: 'no-referrer' }) : null;
    const hero = heroImg ? h('div', { class: 'hero' }, [heroImg]) : null;
    if (heroImg) {
      rescue(heroImg, () => hero.remove());
      // Logos and square icons look wrong cropped to a 1.91:1 banner: letterbox them.
      heroImg.addEventListener('load', () => {
        const r = heroImg.naturalWidth / Math.max(1, heroImg.naturalHeight);
        if (r < 1.4 || r > 2.6 || heroImg.naturalWidth < 400) hero.classList.add('contain');
      }, { once: true });
    }
    const accent = meta.themeColor ? h('div', { class: 'accent' }) : null;
    if (accent) accent.style.background = meta.themeColor;
    const why = res.frame && !res.frame.ok
      ? L.hostLabel(res.finalUrl) + ' doesn’t allow embedding, and the page has no article text to show, so this is the summary it advertises for link previews.'
      : (res.reader ? '' : 'This page has no article text to show, so this is the summary it advertises for link previews.');
    const card = h('div', { class: 'card' }, [
      hero, accent,
      h('div', { class: 'body' }, [
        siteRow(meta, res.finalUrl),
        h('h1', { text: meta.title || L.hostLabel(res.finalUrl) }),
        meta.description ? h('p', { class: 'desc', text: meta.description }) : null,
        dateRow(meta.dates, meta.author ? [meta.author] : []),
        h('div', { class: 'url', text: res.finalUrl }),
        why ? h('div', { class: 'note', text: why }) : null
      ])
    ]);
    stage.replaceChildren(h('div', { class: 'card-view' }, [card]));
  }

  /* ----- Image ----- */
  function renderImage(res, base, opts) {
    const wrap = h('div', { class: 'media-view' });
    const img = h('img', { class: 'preview-img', alt: res.title || '', referrerpolicy: 'no-referrer', decoding: 'async' });
    const id = current.id;
    sendMeta(Object.assign({}, base, { title: res.title, mode: 'image', modes: [], loading: true }));
    img.addEventListener('load', () => {
      if (!current || current.id !== id) return;
      const info = [img.naturalWidth + ' × ' + img.naturalHeight, res.type ? res.type.replace('image/', '').toUpperCase().replace('SVG+XML', 'SVG') : null, res.size ? X.formatBytes(res.size) : null].filter(Boolean).join(' · ');
      sendMeta(Object.assign({}, base, { title: res.title, mode: 'image', modes: [], info, loading: false }));
      contentShown('image', opts.cached);
    });
    rescue(img, () => {
      if (!current || current.id !== id) return;
      renderResult({ kind: 'error', url: res.url, title: 'This image didn’t load', message: 'The server refused or the file isn’t an image Chrome can show.', cacheable: false });
    });
    img.addEventListener('click', () => wrap.classList.toggle('actual'));
    img.src = res.src;
    wrap.append(img);
    stage.replaceChildren();
    stage.classList.add('hidden');
    layers.append(wrap);
  }

  /* ----- Embedded players (YouTube, Vimeo) ----- */
  function renderEmbed(res, base, opts) {
    let title = res.title;
    let info = res.info || res.site;
    sendMeta(Object.assign({}, base, { title, mode: 'video', modes: [], info, loading: true }));
    const f = h('iframe', {
      allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen; web-share',
      title: res.title, referrerpolicy: 'strict-origin-when-cross-origin'
    });
    const id = current.id;
    const mine = () => current && current.id === id;
    if (res.provider === 'youtube') {
      // YouTube's iframe API: subscribe, then read title, state and errors.
      let ready = false;
      const onMsg = (e) => {
        if (e.source !== f.contentWindow || !/^https:\/\/www\.youtube(-nocookie)?\.com$/.test(e.origin)) return;
        let d = e.data;
        if (typeof d === 'string') { try { d = JSON.parse(d); } catch (err) { return; } }
        if (!d || !mine()) { if (!f.isConnected) removeEventListener('message', onMsg); return; }
        if (d.event === 'onReady' || d.event === 'initialDelivery') ready = true;
        const vd = d.info && d.info.videoData;
        if (vd && vd.title && vd.title !== title) {
          title = vd.title;
          info = vd.author || info;
          sendMeta(Object.assign({}, base, { title, mode: 'video', modes: [], info, loading: false }));
        }
        const code = d.event === 'onError' ? d.info : (vd && vd.errorCode && vd.isPlayable === false ? vd.errorCode : null);
        if (code != null) {
          removeEventListener('message', onMsg);
          renderVideoFallback(res, base, code, title);
        }
      };
      addEventListener('message', onMsg);
      cleanups.push(() => removeEventListener('message', onMsg));
      f.addEventListener('load', () => {
        let tries = 0;
        const ping = () => {
          if (ready || !f.isConnected || tries++ > 8) return;
          try { f.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: 'ql', channel: 'widget' }), 'https://www.youtube-nocookie.com'); } catch (err) { /* ignore */ }
          setTimeout(ping, 400);
        };
        ping();
      });
    }
    f.addEventListener('load', () => {
      if (!mine()) return;
      sendMeta(Object.assign({}, base, { title, mode: 'video', modes: [], info, loading: false }));
      contentShown('video', opts.cached);
    });
    f.credentialless = true; // needed inside cross-origin-isolated pages; the embed is cookie-free anyway
    f.src = res.embed;
    const box = h('div', { class: 'embed-box' + (res.vertical ? ' vertical' : '') }, [f]);
    stage.replaceChildren();
    stage.classList.add('hidden');
    layers.append(h('div', { class: 'embed-wrap' }, [box]));
  }

  function renderVideoFallback(res, base, code, title) {
    concealLayers();
    stage.classList.remove('hidden');
    const reason = (code === 101 || code === 150 || code === 152 || code === 153)
      ? 'The video’s owner doesn’t allow it to play outside YouTube.'
      : code === 100 ? 'This video was removed or made private.'
        : code === 2 ? 'This doesn’t look like a valid video link.'
          : 'YouTube wouldn’t play this video in a preview.';
    sendMeta(Object.assign({}, base, { title, mode: 'video', modes: [], info: 'Can’t play here', loading: false }));
    const thumb = res.videoId ? h('img', { src: 'https://i.ytimg.com/vi/' + res.videoId + '/hqdefault.jpg', alt: '', referrerpolicy: 'no-referrer' }) : null;
    const hero = thumb ? h('div', { class: 'hero' }, [thumb]) : null;
    if (thumb) rescue(thumb, () => hero.remove());
    stage.replaceChildren(h('div', { class: 'card-view' }, [h('div', { class: 'card' }, [
      hero,
      h('div', { class: 'body' }, [
        h('h1', { text: title }),
        h('p', { class: 'desc', text: reason }),
        h('div', { class: 'actions', style: 'justify-content:flex-start;margin-top:4px' }, [
          h('button', { class: 'btn primary', text: 'Watch on YouTube', onclick: () => post({ type: 'open', url: res.url, active: true }) }),
          h('button', { class: 'btn', text: 'Copy link', onclick: () => copy(res.url) })
        ])
      ])
    ])]));
  }

  /* ----- Video/audio files ----- */
  function renderMedia(res, base, opts) {
    const isVideo = res.kind === 'media-video';
    const el = h(isVideo ? 'video' : 'audio', { controls: true, autoplay: true, playsinline: true, preload: 'metadata' });
    const id = current.id;
    const mode = isVideo ? 'video' : 'audio';
    sendMeta(Object.assign({}, base, { title: res.title, mode, modes: [], loading: true }));
    el.addEventListener('loadedmetadata', () => {
      if (!current || current.id !== id) return;
      const dur = isFinite(el.duration) ? Math.floor(el.duration / 60) + ':' + String(Math.floor(el.duration % 60)).padStart(2, '0') : '';
      const info = [isVideo && el.videoWidth ? el.videoWidth + ' × ' + el.videoHeight : null, dur].filter(Boolean).join(' · ');
      sendMeta(Object.assign({}, base, { title: res.title, mode, modes: [], info, loading: false }));
      contentShown(mode, opts.cached);
    });
    el.addEventListener('error', () => {
      if (!current || current.id !== id) return;
      renderResult({ kind: 'error', url: res.url, title: 'This file didn’t play', message: 'Chrome can’t play this format, or the server refused the request.', cacheable: false });
    });
    el.src = res.src;
    const wrap = h('div', { class: 'media-view' }, [isVideo ? el : h('div', { class: 'audio-card' }, [h('div', { class: 'glyph' }, [GLYPH.music()]), h('h1', { text: res.title }), el])]);
    stage.replaceChildren();
    stage.classList.add('hidden');
    layers.append(wrap);
  }

  /* ----- PDF: Chrome's own viewer ----- */
  function renderPdf(res, base, opts) {
    const info = ['PDF', res.size ? X.formatBytes(res.size) : null].filter(Boolean).join(' · ');
    sendMeta(Object.assign({}, base, { title: res.title, mode: 'pdf', modes: [], info, loading: true }));
    const f = h('iframe', { class: 'pdf-frame', title: res.title });
    const id = current.id;
    f.addEventListener('load', () => {
      if (!current || current.id !== id) return;
      sendMeta(Object.assign({}, base, { title: res.title, mode: 'pdf', modes: [], info, loading: false }));
      contentShown('pdf', opts.cached);
    });
    f.src = res.src;
    stage.replaceChildren();
    stage.classList.add('hidden');
    layers.append(f);
  }

  /* ----- Text & JSON ----- */
  function renderText(res) {
    let text = res.text;
    const pre = h('pre');
    if (/json/.test(res.type) || /^\s*[{[]/.test(text.slice(0, 50))) {
      try {
        const pretty = JSON.stringify(JSON.parse(text), null, 2);
        highlightJson(pretty, pre);
      } catch (e) { pre.textContent = text; }
    } else {
      pre.textContent = text;
    }
    stage.replaceChildren(h('div', { class: 'text-view' }, [pre, res.truncated ? h('div', { class: 'trunc', text: 'Showing the first ' + X.formatBytes(TEXT_CAP) + '.' }) : null]));
  }

  function highlightJson(src, pre) {
    const re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
    let last = 0, m;
    while ((m = re.exec(src))) {
      if (m.index > last) pre.append(src.slice(last, m.index));
      const cls = m[1] ? (m[2] ? 'tok-key' : 'tok-str') : (m[3] ? 'tok-lit' : 'tok-num');
      pre.append(h('span', { class: cls, text: m[1] || m[3] || m[4] }));
      if (m[2]) pre.append(m[2]);
      last = re.lastIndex;
    }
    pre.append(src.slice(last));
  }

  /* ----- File card ----- */
  function renderFile(res) {
    const ext = ((res.title || '').match(/\.([a-z0-9]{1,6})$/i) || [0, (res.type || 'file').split('/').pop()])[1].toUpperCase().slice(0, 6);
    stage.replaceChildren(h('div', { class: 'card-view' }, [h('div', { class: 'notice' }, [
      h('div', { class: 'file-tile' }, [h('span', { text: ext })]),
      h('h1', { text: res.title }),
      h('p', { text: [res.type || 'File', res.size ? X.formatBytes(res.size) : null, res.site].filter(Boolean).join(' · ') }),
      h('p', { text: res.note || 'This link downloads a file, so there’s nothing to preview. Nothing was downloaded.' }),
      h('div', { class: 'actions' }, [
        h('button', { class: 'btn primary', text: 'Download', onclick: () => post({ type: 'open', url: res.url, active: true }) }),
        h('button', { class: 'btn', text: 'Copy link', onclick: () => copy(res.url) })
      ])
    ])]));
  }

  /* ----- Posts (X, Reddit) ----- */
  function renderPost(res) {
    const body = h('div', { class: 'body' });
    const card = h('div', { class: 'card' }, [body]);
    const wrap = h('div', { class: 'post' }, [card]);
    const parse = (html) => X.sanitize(new DOMParser().parseFromString(html, 'text/html').body, document, res.url);
    if (res.provider === 'x') {
      const doc = new DOMParser().parseFromString(res.html, 'text/html');
      const bq = doc.querySelector('blockquote') || doc.body;
      const p = bq.querySelector('p');
      const dateLink = Array.from(bq.querySelectorAll('a')).pop();
      body.append(
        h('div', { class: 'author' }, [h('b', { text: res.author || '' }), h('span', { text: res.authorUrl ? '@' + res.authorUrl.split('/').pop() : '' })]),
        h('div', { class: 'text' }, [p ? X.sanitize(p, document, res.url) : document.createTextNode(bq.textContent)]),
        dateLink ? h('div', { class: 'stats' }, [h('span', { text: dateLink.textContent })]) : null
      );
    } else {
      body.append(
        h('div', { class: 'author' }, [h('b', { text: res.site }), h('span', { text: res.author + (res.created ? ' · ' + X.relativeAge(res.created) : '') })]),
        h('h1', { text: res.title }),
        res.html ? h('div', { class: 'text' }, [parse(res.html)]) : null,
        res.link ? h('p', null, [h('a', { href: res.link, text: L.hostLabel(res.link) + ' ↗' })]) : null,
        res.image ? h('img', { class: 'media', src: res.image, alt: '', referrerpolicy: 'no-referrer' }) : null,
        h('div', { class: 'stats' }, [h('span', { text: '▲ ' + (res.score || 0) }), h('span', { text: (res.comments || 0) + ' comments' })])
      );
      if (res.top && res.top.length) {
        wrap.append(h('div', { class: 'comments' }, res.top.map((c) => h('div', { class: 'comment' }, [
          h('div', { class: 'who' }, [h('b', { text: 'u/' + c.author }), document.createTextNode(' · ▲ ' + c.score)]),
          h('div', { class: 'text' }, [parse(c.html)])
        ]))));
      }
    }
    hideBrokenImages(wrap);
    stage.replaceChildren(h('div', { class: 'card-view' }, [wrap]));
  }

  /* ----- Notices ----- */
  function notice(opts) {
    return h('div', { class: 'card-view' }, [h('div', { class: 'notice' + (opts.warn ? ' warn' : '') }, [
      h('div', { class: 'glyph' }, [opts.glyph()]),
      h('h1', { text: opts.title }),
      ...[].concat(opts.text || []).map((t) => h('p', { text: t })),
      opts.url ? h('div', { class: 'url', text: opts.url }) : null,
      h('div', { class: 'actions' }, opts.actions || []),
      opts.detail ? h('div', { class: 'detail', text: opts.detail }) : null
    ])]);
  }

  function openBtn(url, primary) {
    return h('button', { class: 'btn' + (primary ? ' primary' : ''), text: 'Open in New Tab', onclick: () => post({ type: 'open', url, active: true }) });
  }

  function renderRefused(res) {
    const actions = [openBtn(res.url, false)];
    if (!res.noForce) {
      actions.push(h('button', {
        class: 'btn', text: 'Preview Anyway', onclick: () => {
          forced.add(res.url);
          show(Object.assign({}, current, { id: current.id }));
        }
      }));
    }
    stage.replaceChildren(notice({
      glyph: GLYPH.shield, warn: true,
      title: 'This link wasn’t previewed',
      text: [res.verdict.reason, res.noForce ? '' : 'Previews load logged out, but some links act on a single visit, so anything that looks like one is skipped.'].filter(Boolean),
      url: res.url, actions
    }));
  }

  function renderPermission(res) {
    const retry = () => show(Object.assign({}, current));
    const request = (origins) => chrome.permissions.request({ origins }).then((ok) => { if (ok) retry(); else toast('Permission not granted'); }).catch((e) => toast(String(e.message || e)));
    stage.replaceChildren(notice({
      glyph: GLYPH.key,
      title: 'Allow previews from ' + res.host + '?',
      text: ['You chose to approve sites one at a time. Previews need your OK before they can fetch pages from ' + res.host + '. They still load logged out.'],
      actions: [
        h('button', { class: 'btn primary', text: 'Allow ' + res.host, onclick: () => request([res.origin]) }),
        h('button', { class: 'btn', text: 'Allow All Sites', onclick: () => request(['http://*/*', 'https://*/*']) }),
        openBtn(current.url, false)
      ]
    }));
  }

  function renderTimeout(res) {
    stage.replaceChildren(notice({
      glyph: GLYPH.clock,
      title: L.hostLabel(res.url) + ' is taking too long',
      text: ['Gave up after ' + ((current && current.timeoutSec) || 8) + ' seconds so a slow site doesn’t leave you staring at a spinner.'],
      url: res.url,
      actions: [
        h('button', { class: 'btn primary', text: 'Try Again', onclick: () => show(Object.assign({}, current, { timeoutSec: 30 })) }),
        openBtn(res.url, false)
      ]
    }));
  }

  function renderError(res) {
    const actions = [];
    if (res.frame && res.frame.ok && res.finalUrl) {
      actions.push(h('button', {
        class: 'btn', text: 'Show the Site’s Page', onclick: () => {
          const meta = res.meta || { title: res.title, site: L.hostLabel(res.finalUrl), dates: {} };
          renderResult({ kind: 'page', url: res.url, finalUrl: res.finalUrl, frame: res.frame, meta, reader: null, modes: ['live'], mode: 'live', hash: '' });
        }
      }));
    }
    actions.push(h('button', { class: 'btn', text: 'Retry', onclick: () => { cache.delete(res.url); show(Object.assign({}, current)); } }));
    actions.push(openBtn(res.url, true));
    stage.replaceChildren(notice({
      glyph: res.status ? GLYPH.lockdoc : GLYPH.cloudOff,
      title: res.title || 'Couldn’t load this preview',
      text: [res.message || ''],
      url: res.finalUrl || res.url,
      actions
    }));
  }

  function copy(text) {
    navigator.clipboard.writeText(text).then(() => toast('Link copied'), () => toast('Couldn’t copy'));
  }

  // Test hook (extension origin only).
  globalThis.__qlPreview = { cache, liveFrames, state: () => ({ current, currentMode, kind: currentResult && currentResult.kind }) };
})();
