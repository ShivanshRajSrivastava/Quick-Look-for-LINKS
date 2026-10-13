/* ‘Quick Look’ for LINKS — content script.
   Hover a link, press Space, see it in a Quick Look-style panel.
   This file owns the keyboard model, the panel chrome and link navigation.
   The preview itself renders inside a sealed extension frame (preview.html). */
(() => {
  'use strict';
  // A newer copy (after an extension update, or a second injection) replaces
  // the old one instead of bowing out, so open tabs never end up with a dead script.
  for (const previous of [globalThis.__qlContent, globalThis.__glanceContent]) { // __glanceContent: builds before 1.2
    if (previous && typeof previous.teardown === 'function') { try { previous.teardown(); } catch (e) { /* ignore */ } }
  }
  try { delete globalThis.__glanceContent; } catch (e) { /* ignore */ }
  const registered = [];
  const chromeListeners = [];
  const onChrome = (ev, fn) => { ev.addListener(fn); chromeListeners.push([ev, fn]); };
  const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); registered.push([target, type, fn, opts]); };
  let torn = false;
  globalThis.__qlContent = {
    teardown() {
      torn = true;
      for (const [t, type, fn, opts] of registered) t.removeEventListener(type, fn, opts);
      for (const [ev, fn] of chromeListeners) { try { ev.removeListener(fn); } catch (e) { /* context gone */ } }
      try { clearTimeout(hintTimer); } catch (e) { /* ignore */ }
      try { if (ui && ui.host) ui.host.remove(); } catch (e) { /* ignore */ }
    }
  };

  const S = globalThis.QLSettings;
  const L = globalThis.QLLinks;
  if (!S || !L) return;

  // The frame's real origin. (getURL returns a per-session dynamic URL that redirects here.)
  const EXT_ORIGIN = 'chrome-extension://' + chrome.runtime.id;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const XLINK_NS = 'http://www.w3.org/1999/xlink';
  const reduceMotionMQ = matchMedia('(prefers-reduced-motion: reduce)');
  const darkMQ = matchMedia('(prefers-color-scheme: dark)');
  const KEYS = S.keyLabels();

  /* ---------------- State ---------------- */
  let settings = Object.assign({}, S.DEFAULTS);
  let local = Object.assign({}, S.LOCAL_DEFAULTS);
  let siteDisabled = false;          // Space reserved for the page here (Shift+Space still previews)
  let siteOff = false;               // the extension completely off here
  let extensionAlive = true;

  const pointer = { x: -1, y: -1, t: 0 };   // t: last real mouse movement
  let lastFocusAt = 0;
  const swallowed = new Map();        // key code -> time: keyup/keypress we must eat
  let swallowNextClick = false;

  let ui = null;                      // lazily built shadow UI
  let panelOpen = false;
  let full = false;
  let current = null;                 // { el, url, text, id }
  let seq = null;                     // arrow-key sequence
  let modes = [];                     // modes the current preview can switch between
  let currentMode = 'loading';
  let openSeq = 0;
  let manualPos = null;               // {x, y} after the user drags the panel
  let lastContextLink = null;

  /* ---------------- Settings ---------------- */
  function applySettings() {
    const ext = location.protocol === 'chrome-extension:';
    siteDisabled = !ext && S.hostMatches(location.hostname, settings.disabledSites);
    siteOff = !ext && S.hostMatches(location.hostname, settings.offSites || []);
    if (ui) applyTheme();
  }

  /* The key that previews here: Space, or Shift+Space on sites where the page
     uses Space itself (YouTube, Google Docs…), or Ctrl+Space if chosen. */
  function hintKeyLabel() {
    if (settings.trigger === 'ctrl-space') return KEYS.ctrl + ' Space';
    return siteDisabled ? '⇧ Space' : 'Space';
  }
  S.get().then((s) => { settings = s; applySettings(); });
  S.getLocal().then((l) => { local = l; });
  try {
    onChrome(chrome.storage.onChanged, (changes, area) => {
      if (area === 'sync') {
        for (const k of Object.keys(changes)) settings[k] = changes[k].newValue === undefined ? S.DEFAULTS[k] : changes[k].newValue;
        applySettings();
      } else if (area === 'local') {
        for (const k of Object.keys(changes)) local[k] = changes[k].newValue;
      }
    });
  } catch (e) { /* extension reloaded */ }
  on(darkMQ, 'change', () => ui && applyTheme());

  function alive() {
    if (torn) return false;
    try { return !!chrome.runtime.id; } catch (e) { extensionAlive = false; return false; }
  }

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
    if (children) for (const c of children) if (c) el.append(c);
    return el;
  }
  function svg(paths, opts) {
    opts = opts || {};
    const s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('viewBox', opts.viewBox || '0 0 16 16');
    s.setAttribute('fill', 'none');
    s.setAttribute('aria-hidden', 'true');
    for (const d of paths) {
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', d);
      p.setAttribute('stroke', 'currentColor');
      p.setAttribute('stroke-width', opts.width || '1.6');
      p.setAttribute('stroke-linecap', 'round');
      p.setAttribute('stroke-linejoin', 'round');
      s.append(p);
    }
    return s;
  }
  const ICONS = {
    close: () => svg(['M4.5 4.5l7 7', 'M11.5 4.5l-7 7']),
    expand: () => svg(['M9.5 3h3.5v3.5', 'M13 3L9 7', 'M6.5 13H3V9.5', 'M3 13l4-4']),
    shrink: () => svg(['M13 7H9.5V3.5', 'M9.5 7L13.5 3', 'M3 9h3.5v3.5', 'M6.5 9l-4 4']),
    open: () => svg(['M6 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5V10', 'M9 2h5v5', 'M14 2L7.5 8.5'], { width: '1.7' }),
    chev: () => svg(['M4 6l4 4 4-4'], { width: '2' }),
    copy: () => svg(['M5.5 5.5V3.5A1.5 1.5 0 0 1 7 2h5.5A1.5 1.5 0 0 1 14 3.5V9a1.5 1.5 0 0 1-1.5 1.5h-2', 'M2 7a1.5 1.5 0 0 1 1.5-1.5H9A1.5 1.5 0 0 1 10.5 7v5.5A1.5 1.5 0 0 1 9 14H3.5A1.5 1.5 0 0 1 2 12.5z'])
  };

  function deepActiveElement() {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  }

  function deepElementFromPoint(x, y) {
    let el = document.elementFromPoint(x, y);
    for (let i = 0; el && el.shadowRoot && i < 20; i++) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  function parentOf(n) {
    if (!n) return null;
    if (n.assignedSlot) return n.assignedSlot;
    const p = n.parentNode;
    if (p && p.nodeType === 11 && p.host) return p.host;
    return p && p.nodeType === 1 ? p : null;
  }

  function isOurs(n) {
    return !!(ui && n && (n === ui.host || (ui.host.contains && ui.host.contains(n))));
  }

  /* ---------------- Links ---------------- */
  function isLinkEl(n) {
    if (!n || n.nodeType !== 1) return false;
    const name = n.localName;
    if (name === 'a') {
      if (n.namespaceURI === SVG_NS) return !!(n.getAttribute('href') || n.getAttributeNS(XLINK_NS, 'href'));
      return n.hasAttribute('href');
    }
    return name === 'area' && n.hasAttribute('href');
  }

  function rawHref(el) {
    if (el.namespaceURI === SVG_NS) {
      const v = el.getAttribute('href') || el.getAttributeNS(XLINK_NS, 'href');
      try { return new URL(v, document.baseURI).href; } catch (e) { return null; }
    }
    const attr = el.getAttribute('href');
    if (attr == null) return null;
    const t = attr.trim();
    if (!t || t === '#' || /^javascript:/i.test(t)) return null;
    return el.href || null;
  }

  /* The URL the extension should preview for a link, or null when Space should keep its normal job. */
  function previewUrl(el) {
    const href = rawHref(el);
    if (!href || !/^https?:/i.test(href)) return null;
    // In-page anchors (#section) are not previews.
    const hash = href.indexOf('#');
    if (hash >= 0 && href.slice(0, hash) === location.href.split('#')[0]) return null;
    return L.unwrap(href);
  }

  function closestLink(el) {
    for (let n = el, i = 0; n && i < 40; n = parentOf(n), i++) {
      if (isOurs(n)) return null;
      if (isLinkEl(n)) return previewUrl(n) ? n : null;
    }
    return null;
  }

  function linkText(el) {
    const t = (el.getAttribute('aria-label') || el.innerText || el.textContent || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
    if (t) return t.slice(0, 200);
    const img = el.querySelector && el.querySelector('img[alt]');
    return img ? img.getAttribute('alt').trim().slice(0, 200) : '';
  }

  function linkRect(el) {
    let r = el.getBoundingClientRect();
    if (r.width >= 2 && r.height >= 2) return r;
    // Inline anchors wrapping block children, or display:contents
    let box = null;
    const kids = el.children ? Array.from(el.children).slice(0, 8) : [];
    for (const k of kids) {
      const kr = k.getBoundingClientRect();
      if (kr.width < 1 || kr.height < 1) continue;
      box = box ? {
        left: Math.min(box.left, kr.left), top: Math.min(box.top, kr.top),
        right: Math.max(box.right, kr.right), bottom: Math.max(box.bottom, kr.bottom)
      } : { left: kr.left, top: kr.top, right: kr.right, bottom: kr.bottom };
    }
    if (!box) return r;
    return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.right - box.left, height: box.bottom - box.top, x: box.left, y: box.top };
  }

  function isVisible(el) {
    if (typeof el.checkVisibility === 'function') {
      const vis = el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
      if (!vis && getComputedStyle(el).display !== 'contents') return false;
    }
    const r = linkRect(el);
    if (!r || r.width < 2 || r.height < 2) return false;
    // Skip-links and other off-canvas anchors
    const docLeft = r.left + scrollX, docTop = r.top + scrollY;
    if (docLeft + r.width <= 0 || docTop + r.height <= 0) return false;
    return true;
  }

  /* Collect every link in document order, piercing open shadow roots. */
  function collectAnchors() {
    const out = [];
    const sel = 'a[href], area[href]';
    const hosts = [];
    const all = document.querySelectorAll('*');
    for (let i = 0; i < all.length; i++) if (all[i].shadowRoot) hosts.push(all[i]);
    if (!hosts.length) return Array.from(document.querySelectorAll(sel));
    // Ordered walk when shadow DOM is in play.
    const walk = (root) => {
      const tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let n = tw.currentNode.nodeType === 1 ? tw.currentNode : tw.nextNode();
      while (n) {
        if (isLinkEl(n)) out.push(n);
        if (n.shadowRoot) walk(n.shadowRoot);
        n = tw.nextNode();
      }
    };
    walk(document.documentElement);
    return out;
  }

  const STATE_CLASS = /^(active|is-active|current|is-current|selected|is-selected|visited|hover|focus|focused|open|is-open|expanded|first|last|odd|even|new|unread|read)$/i;
  function classSig(el) {
    if (!el.classList || !el.classList.length) return '';
    return '.' + Array.from(el.classList).filter((c) => !STATE_CLASS.test(c) && !/\d{3,}/.test(c)).sort().join('.');
  }
  /* Structural signatures, computed once per link per sequence build. */
  function makeSigner() {
    const cache = new Map();
    const cls = new Map();
    const classSigCached = (n) => { let v = cls.get(n); if (v === undefined) { v = classSig(n); cls.set(n, v); } return v; };
    return (el, depth) => {
      let c = cache.get(el);
      if (!c) {
        const parts = [];
        let n = el;
        for (let i = 0; i <= 6 && n; i++) { parts.push(n.localName + classSigCached(n)); n = parentOf(n); }
        const heading = el.querySelector && el.querySelector('h1,h2,h3,h4,h5,h6,[role="heading"]') ? 'H' : '';
        c = { parts, heading, sigs: [] };
        cache.set(el, c);
      }
      if (!c.sigs[depth]) c.sigs[depth] = c.parts.slice(0, depth + 1).join('<') + '|' + c.heading;
      return c.sigs[depth];
    };
  }

  /* Is this sequence item showing on the page? Falls back to a visible duplicate. */
  function resolveVisible(it) {
    if (it.vis !== undefined) return it.vis;
    if (it.el.isConnected && isVisible(it.el)) { it.vis = true; return true; }
    for (let i = 0; i < it.alts.length; i++) {
      const alt = it.alts[i];
      if (alt.isConnected && isVisible(alt)) { it.alts[i] = it.el; it.el = alt; it.vis = true; return true; }
    }
    it.vis = false;
    return false;
  }

  /* Build the Finder-style sequence the arrow keys walk through.
     "Similar" mode finds the list the link belongs to (search results, a thread
     of posts, a column of headlines) by matching structural signatures.
     Visibility is checked up front for normal lists and lazily for huge ones,
     so a page with 20,000 links still opens instantly. */
  function buildSequence(startEl) {
    const anchors = collectAnchors();
    const startUrl = previewUrl(startEl) || '';
    const startKey = L.dedupeKey(startUrl);
    let entries = [];
    let startEntry = null;
    for (const el of anchors) {
      const url = previewUrl(el);
      if (!url) continue;
      const e = { el, url, key: L.dedupeKey(url) };
      if (el === startEl) startEntry = e;
      entries.push(e);
    }
    if (!startEntry) { startEntry = { el: startEl, url: startUrl, key: startKey }; entries.push(startEntry); }
    let mode = 'all';
    if (settings.arrows === 'similar' && entries.length > 3) {
      const sig = makeSigner();
      const groupAt = (d) => {
        const target = sig(startEntry.el, d);
        return entries.filter((e) => e === startEntry || sig(e.el, d) === target);
      };
      // Start from the link's local shape (itself, its parent, grandparent):
      // that already separates search results from nav bars and footers.
      // Go deeper while the list barely shrinks (drops stray look-alikes);
      // go shallower only if the local shape is too rare to be a list.
      let pick = null;
      const g2 = groupAt(2);
      if (g2.length >= 3) {
        pick = g2;
        for (let d = 3; d <= 6; d++) {
          const g = groupAt(d);
          if (g.length >= 3 && g.length >= g2.length * 0.8) pick = g; else break;
        }
      } else {
        for (const d of [1, 0]) {
          const g = groupAt(d);
          if (g.length >= 3) { pick = g; break; }
        }
      }
      if (pick && pick.length < entries.length) { entries = pick; mode = 'similar'; }
    }
    // De-duplicate within the chosen list. Later copies become fallbacks in
    // case the first one is hidden; the hovered copy always wins.
    let list = [];
    const byKey = new Map();
    for (const e of entries) {
      const ex = byKey.get(e.key);
      if (ex) {
        if (e === startEntry) { ex.alts.push(ex.el); ex.el = e.el; ex.vis = true; }
        else ex.alts.push(e.el);
        continue;
      }
      const item = { el: e.el, url: e.url, key: e.key, alts: [], vis: e === startEntry ? true : undefined };
      byKey.set(e.key, item);
      list.push(item);
    }
    const startItem = byKey.get(startEntry.key);
    const items = list;
    const lazy = list.length > 1500;
    if (!lazy) list = list.filter(resolveVisible);
    let index = list.indexOf(startItem);
    if (index < 0) { list = items; index = items.indexOf(startItem); mode = 'all'; }
    return { list, index, mode, startEl, lazy, builtAt: performance.now() };
  }

  /* ---------------- Typing contexts: Space belongs to the page ---------------- */
  const TEXT_INPUTS = /^(text|search|email|url|tel|password|number|date|datetime-local|month|week|time)$/i;
  const TEXT_ROLES = /^(textbox|searchbox|combobox|spinbutton|slider|application|grid)$/;
  const CONTROL_ROLES = /^(button|checkbox|radio|switch|menuitem|menuitemcheckbox|menuitemradio|tab|option|treeitem|gridcell)$/;

  /* A focused button keeps Space only for someone using the keyboard: if the
     mouse has moved since that button got focus, the person is pointing at a
     link and means to preview it (YouTube, for one, leaves focus on its search
     button after every search). */
  function keyboardFocused(el) {
    return el.matches(':focus-visible') && lastFocusAt >= pointer.t;
  }

  function ownsSpace(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.isContentEditable) return true;
    const tag = el.localName;
    if (tag === 'textarea' || tag === 'select') return true;
    if (tag === 'input') return TEXT_INPUTS.test(el.type || 'text') || keyboardFocused(el);
    if (tag === 'video' || tag === 'audio') return true;
    if (tag === 'button' || tag === 'summary') return keyboardFocused(el);
    if (tag === 'canvas' || tag === 'embed' || tag === 'object' || tag === 'iframe') return true;
    const role = el.getAttribute('role');
    if (role && TEXT_ROLES.test(role)) return true;
    if (role && CONTROL_ROLES.test(role)) return keyboardFocused(el);
    return false;
  }

  function isTypingContext(e) {
    if (document.designMode === 'on') return true;
    const t = e && e.composedPath ? e.composedPath()[0] : null;
    if (ownsSpace(t)) return true;
    const ae = deepActiveElement();
    if (ae && ae !== t && ownsSpace(ae)) return true;
    return false;
  }

  function targetLink() {
    const ae = deepActiveElement();
    if (ae && isLinkEl(ae) && previewUrl(ae) && ae.matches(':focus-visible')) return ae;
    if (pointer.x < 0) return null;
    const el = deepElementFromPoint(pointer.x, pointer.y);
    if (!el || isOurs(el)) return null;
    return closestLink(el);
  }

  /* ---------------- Shadow UI ---------------- */
  function buildUI() {
    const host = document.createElement('quick-look-links-root');
    host.setAttribute('popover', 'manual');
    const st = host.style;
    const important = (k, v) => st.setProperty(k, v, 'important');
    [['all', 'initial'], ['position', 'fixed'], ['inset', '0'], ['width', '100vw'], ['height', '100vh'],
      ['max-width', 'none'], ['max-height', 'none'], ['margin', '0'], ['padding', '0'], ['border', '0'],
      ['background', 'transparent'], ['overflow', 'visible'], ['pointer-events', 'none'],
      ['z-index', '2147483647'], ['display', 'none'], ['color-scheme', 'normal']].forEach(([k, v]) => important(k, v));
    const shadow = host.attachShadow({ mode: 'closed' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(globalThis.QL_PANEL_CSS || '');
    shadow.adoptedStyleSheets = [sheet];

    const root = h('div', { class: 'root' });
    const hint = h('div', { class: 'hint', 'aria-hidden': 'true' }, [h('kbd', { text: hintKeyLabel() }), document.createTextNode('to preview')]);
    const nudge = h('div', { class: 'hint nudge', role: 'status' });
    const ring = h('div', { class: 'ring' });

    const closeBtn = h('button', { class: 'icon-btn', title: 'Close (Esc)', 'aria-label': 'Close preview' }, [ICONS.close()]);
    const fullBtn = h('button', { class: 'icon-btn', title: 'Full window (' + KEYS.alt + 'Space)', 'aria-label': 'Toggle full window' }, [ICONS.expand()]);
    const favicon = h('img', { class: 'favicon', alt: '' });
    favicon.addEventListener('error', () => { favicon.style.visibility = 'hidden'; });
    const title = h('span', { class: 'title' });
    const site = h('span', { class: 'site' });
    const badgeLabel = h('span', { class: 'badge-label', text: 'Loading' });
    const badge = h('button', { class: 'badge', 'data-mode': 'loading', title: 'Preview type', 'aria-haspopup': 'menu' }, [h('span', { class: 'dot' }), badgeLabel, ICONS.chev()]);
    badge.lastChild.classList.add('chev');
    const counter = h('span', { class: 'counter' });
    const copyBtn = h('button', { class: 'icon-btn', title: 'Copy link (' + KEYS.mod + 'C)', 'aria-label': 'Copy link' }, [ICONS.copy()]);
    const openBtn = h('button', { class: 'open-btn', title: 'Open in a new tab (' + KEYS.enter + ')' }, [h('span', { text: 'Open in ' + browserName() }), ICONS.open()]);

    const titlebar = h('div', { class: 'titlebar' }, [
      h('div', { class: 'tb-left' }, [closeBtn, fullBtn]),
      h('div', { class: 'tb-center' }, [favicon, h('div', { class: 'title-wrap' }, [title, site]), badge]),
      h('div', { class: 'tb-right' }, [counter, copyBtn, openBtn])
    ]);
    const menu = h('div', { class: 'menu', role: 'menu' });
    const frameWrap = h('div', { class: 'body' });
    const loading = h('div', { class: 'loading' }, [h('div', { class: 'spinner' })]);
    frameWrap.append(loading);
    const coach = h('div', { class: 'coach', 'aria-hidden': 'true' });
    const toast = h('div', { class: 'toast', role: 'status' });
    const resize = h('div', { class: 'resize', title: 'Resize' });
    const live = h('div', { class: 'live', 'aria-live': 'polite' });
    const panel = h('div', { class: 'panel', role: 'dialog', 'aria-label': '‘Quick Look’ for LINKS preview', tabindex: '-1' }, [titlebar, menu, frameWrap, coach, toast, resize]);
    root.append(ring, hint, nudge, panel, live);
    shadow.append(root);

    closeBtn.addEventListener('click', () => close());
    fullBtn.addEventListener('click', () => toggleFull());
    openBtn.addEventListener('click', (e) => openInTab({ active: !(e.metaKey || e.ctrlKey), newWindow: e.shiftKey }));
    copyBtn.addEventListener('click', () => copyLink());
    badge.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });
    titlebar.addEventListener('dblclick', (e) => { if (!e.target.closest('button')) toggleFull(); });
    titlebar.addEventListener('pointerdown', startDrag);
    resize.addEventListener('pointerdown', startResize);
    panel.addEventListener('pointerdown', (e) => { if (!e.composedPath().includes(menu) && !e.composedPath().includes(badge)) closeMenu(); });

    ui = { host, shadow, root, hint, nudge, ring, panel, titlebar, closeBtn, fullBtn, favicon, title, site, badge, badgeLabel, counter, copyBtn, openBtn, menu, frameWrap, loading, coach, toast, resize, live, frame: null, port: null, ready: false, queue: [], sid: null };
    applyTheme();
    return ui;
  }

  function mountHost() {
    if (!ui) buildUI();
    // A page's open modal <dialog> makes everything outside it inert, so live inside it.
    let parent = document.documentElement || document.body;
    try { const modal = document.querySelector('dialog:modal'); if (modal) parent = modal; } catch (e) { /* :modal unsupported */ }
    if (ui.host.parentNode !== parent) parent.append(ui.host);
    ui.host.style.setProperty('display', 'block', 'important');
    try {
      // Re-showing moves the panel to the top of the top layer, above the page's own popovers.
      if (ui.host.matches(':popover-open')) ui.host.hidePopover();
      ui.host.showPopover();
    } catch (e) { /* popover unsupported */ }
  }

  function unmountHostIfIdle() {
    if (!ui || panelOpen || ui.hint.classList.contains('show')) return;
    try { if (ui.host.matches(':popover-open')) ui.host.hidePopover(); } catch (e) { /* ignore */ }
    ui.host.style.setProperty('display', 'none', 'important');
  }

  function effectiveTheme() {
    if (settings.theme === 'light' || settings.theme === 'dark') return settings.theme;
    return darkMQ.matches ? 'dark' : 'light';
  }

  function applyTheme() {
    ui.root.dataset.theme = effectiveTheme();
    send({ type: 'theme', theme: effectiveTheme(), readerFont: settings.readerFont });
  }

  function browserName() {
    try {
      const brands = (navigator.userAgentData && navigator.userAgentData.brands || []).map((b) => b.brand);
      if (getComputedStyle(document.documentElement).getPropertyValue('--arc-palette-title').trim()) return 'Arc';
      if (navigator.brave || brands.includes('Brave')) return 'Brave';
      if (brands.includes('Microsoft Edge')) return 'Edge';
      if (brands.includes('Opera') || brands.includes('Opera GX')) return 'Opera';
      if (brands.includes('Vivaldi')) return 'Vivaldi';
      if (brands.includes('Google Chrome')) return 'Chrome';
      if (/Edg\//.test(navigator.userAgent)) return 'Edge';
      if (/OPR\//.test(navigator.userAgent)) return 'Opera';
      if (brands.includes('Chromium')) return 'Chromium';
    } catch (e) { /* ignore */ }
    return 'New Tab';
  }

  /* ---------------- Preview frame bridge ---------------- */
  function ensureFrame() {
    if (ui.frame && ui.frame.isConnected && !ui.frameTampered) return;
    if (ui.frame) ui.frame.remove();
    ui.frame = null;
    ui.frameTampered = false;
    ui.ready = false;
    ui.port = null;
    const sid = randomId();
    ui.sid = sid;
    // Vouch for this frame with the background before it loads. The frame must
    // claim the same secret from this tab before it accepts any instructions;
    // web pages can't reach these APIs, so they can't forge a preview frame.
    const vouched = chrome.runtime.sendMessage({ type: 'ql:register-frame', sid }).catch(() => null);
    const frame = document.createElement('iframe');
    frame.className = 'frame';
    frame.setAttribute('allow', 'autoplay; fullscreen; picture-in-picture; clipboard-write; encrypted-media');
    frame.setAttribute('allowtransparency', 'true');
    frame.setAttribute('title', 'Preview');
    // Cross-origin-isolated pages (WhatsApp Web, Figma…) send
    // Cross-Origin-Embedder-Policy: require-corp and refuse any frame that
    // doesn't opt in. A credentialless frame is the sanctioned exception, but
    // it also takes away cookies for previews you allowed them on, so the extension
    // only switches to it on pages that refused the normal frame.
    if (ui.needCredentialless) frame.credentialless = true;
    let loads = 0;
    let readyTimer = 0;
    frame.addEventListener('load', async () => {
      loads++;
      if (loads > 1) {
        // Reloaded or navigated by someone else (or moved in the DOM): never trust it again.
        if (ui.frame !== frame) return;
        ui.frameTampered = true;
        ui.ready = false;
        ui.port = null;
        if (panelOpen) {
          ensureFrame();
          if (ui.lastShow) send(ui.lastShow);
        } else {
          frame.remove();
          ui.frame = null;
        }
        return;
      }
      await vouched;
      if (ui.frame !== frame) return;
      const ch = new MessageChannel();
      ui.port = ch.port1;
      ui.port.onmessage = (ev) => { if (ui.frame === frame) { clearTimeout(readyTimer); onFrameMessage(ev.data); } };
      try { frame.contentWindow.postMessage({ ql: 'init', sid }, EXT_ORIGIN, [ch.port2]); } catch (e) { /* ignore */ }
      // No answer means the page blocked the frame (Chrome showed its error
      // page instead). Rebuild it the way cross-origin-isolated pages accept.
      if (!ui.needCredentialless) {
        readyTimer = setTimeout(() => {
          if (ui.frame !== frame || ui.ready) return;
          ui.needCredentialless = true;
          ensureFrameFresh();
        }, 900);
      }
    });
    frame.src = chrome.runtime.getURL('preview/preview.html') + '#' + sid;
    ui.frame = frame;
    ui.frameWrap.prepend(frame);
  }

  function ensureFrameFresh() {
    if (ui.frame) ui.frame.remove();
    ui.frame = null;
    ui.ready = false;
    ui.port = null;
    ensureFrame();
    if (panelOpen && ui.lastShow) send(ui.lastShow);
  }

  function send(msg) {
    if (!ui) return;
    if (msg.type === 'show' && ui.needCredentialless) msg.noCookies = true;
    if (msg.type === 'show') ui.lastShow = msg;
    if (msg.type === 'hide') ui.lastShow = null;
    if (ui.ready && ui.port) { ui.port.postMessage(msg); return; }
    if (msg.type === 'hide') {
      // Closed before the frame was ready: forget the pending preview entirely.
      ui.queue = ui.queue.filter((m) => m.type === 'theme');
      return;
    }
    if (msg.type === 'show' || msg.type === 'theme') {
      ui.queue = ui.queue.filter((m) => m.type !== msg.type);
      ui.queue.push(msg);
    }
  }

  function randomId() {
    const a = new Uint8Array(16);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function onFrameMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'ready':
        ui.ready = true;
        for (const m of ui.queue.splice(0)) ui.port.postMessage(m);
        break;
      case 'meta':
        if (!current || msg.id !== current.id) return;
        applyMeta(msg);
        break;
      case 'key':
        handlePanelKey(msg, true);
        break;
      case 'open':
        if (msg.url) chrome.runtime.sendMessage({ type: 'ql:open', url: msg.url, active: msg.active !== false, newWindow: !!msg.newWindow }).catch(() => {});
        if (msg.active !== false && !msg.newWindow) close({ instant: true });
        break;
      case 'favicon':
        if (current && msg.id === current.id && typeof msg.data === 'string' && msg.data.startsWith('data:image/')) {
          ui.favicon.src = msg.data;
          ui.favicon.style.visibility = 'visible';
        }
        break;
      case 'close':
        close();
        break;
      case 'stat':
        recordStat(msg);
        break;
      case 'toast':
        toast(msg.text);
        break;
    }
  }

  const MODE_LABEL = {
    loading: 'Loading', live: 'Live', reader: 'Reader', summary: 'Summary', image: 'Image', video: 'Video',
    audio: 'Audio', pdf: 'PDF', text: 'Text', file: 'File', post: 'Post', refused: 'Not previewed',
    error: 'Couldn’t load', timeout: 'Timed out', permission: 'Needs access'
  };
  const MODE_DESC = {
    live: 'The page itself, as a logged-out visitor',
    reader: 'Clean article text fetched from the page',
    summary: 'The title, description and image the page advertises'
  };

  function applyMeta(m) {
    if (m.title) { ui.title.textContent = m.title; ui.title.title = m.title; }
    if (m.site) ui.site.textContent = m.site;
    if (m.finalUrl) current.finalUrl = m.finalUrl;
    currentMode = m.mode || currentMode;
    modes = Array.isArray(m.modes) ? m.modes : [];
    ui.badge.dataset.mode = currentMode;
    ui.badgeLabel.textContent = MODE_LABEL[currentMode] || currentMode;
    ui.badge.classList.toggle('switchable', modes.length > 1);
    ui.badge.title = (m.info ? m.info + ' · ' : '') + (modes.length > 1 ? 'Click to switch preview type (R)' : 'Preview type');
    ui.loading.classList.toggle('show', !!m.loading);
    ui.badge.classList.toggle('busy', !!m.busy);
    if (m.mode && m.mode !== 'loading') ui.live.textContent = 'Previewing ' + (m.title || '') + ', ' + (MODE_LABEL[m.mode] || '') + ' preview';
  }

  /* ---------------- Mode menu ---------------- */
  function toggleMenu() {
    if (ui.menu.classList.contains('open')) return closeMenu();
    if (!modes.length) return;
    ui.menu.replaceChildren();
    for (const m of ['live', 'reader', 'summary']) {
      const has = modes.includes(m);
      const b = h('button', { role: 'menuitemradio', 'aria-checked': String(m === currentMode), disabled: !has }, [
        h('span', { class: 'check', text: m === currentMode ? '✓' : '' }),
        h('span', null, [document.createTextNode(MODE_LABEL[m]), h('span', { class: 'desc', text: has ? MODE_DESC[m] : (m === 'live' ? 'This site doesn’t allow embedding' : 'Not available for this page') })])
      ]);
      b.addEventListener('click', () => { closeMenu(); switchMode(m); });
      ui.menu.append(b);
    }
    ui.menu.classList.add('open');
  }
  function closeMenu() { if (ui) ui.menu.classList.remove('open'); }

  function switchMode(m) {
    if (!current || !modes.includes(m) || m === currentMode) return;
    send({ type: 'mode', id: current.id, mode: m });
  }

  function cycleMode() {
    if (modes.length < 2) { toast(modes.length ? 'Only one preview type for this page' : ''); return; }
    const order = ['live', 'reader', 'summary'].filter((m) => modes.includes(m));
    const i = order.indexOf(currentMode);
    switchMode(order[(i + 1) % order.length]);
  }

  /* ---------------- Geometry & animation ---------------- */
  function viewport() {
    const de = document.documentElement;
    return { w: Math.min(innerWidth, de.clientWidth || innerWidth), h: Math.min(innerHeight, de.clientHeight || innerHeight) };
  }

  function targetRect(isFull) {
    const vp = viewport();
    if (isFull) return { x: 0, y: 0, w: vp.w, h: vp.h };
    const large = settings.size === 'large';
    const saved = local.panelSize;
    let w = saved && saved.w ? saved.w : (large ? vp.w * 0.86 : Math.min(vp.w * 0.74, 1120));
    let hgt = saved && saved.h ? saved.h : (large ? vp.h * 0.88 : Math.min(vp.h * 0.84, 900));
    w = Math.round(Math.max(Math.min(w, vp.w - 24), Math.min(380, vp.w - 12)));
    hgt = Math.round(Math.max(Math.min(hgt, vp.h - 24), Math.min(280, vp.h - 12)));
    let x = Math.round((vp.w - w) / 2);
    let y = Math.round((vp.h - hgt) / 2);
    if (manualPos) {
      x = Math.max(4 - w + 120, Math.min(manualPos.x, vp.w - 120));
      y = Math.max(0, Math.min(manualPos.y, vp.h - 42));
    }
    return { x, y, w, h: hgt };
  }

  function setRect(r) {
    const p = ui.panel.style;
    p.left = r.x + 'px'; p.top = r.y + 'px'; p.width = r.w + 'px'; p.height = r.h + 'px';
    ui.rect = r;
  }

  function animateFrom(fromRect, toRect, opts) {
    opts = opts || {};
    const reduce = reduceMotionMQ.matches;
    if (reduce || !fromRect || !fromRect.width) {
      return ui.panel.animate([{ opacity: opts.reverse ? 1 : 0 }, { opacity: opts.reverse ? 0 : 1 }], { duration: reduce ? 120 : 180, easing: 'ease-out', fill: 'none' }).finished.catch(() => {});
    }
    const sx = Math.max(fromRect.width / toRect.w, 0.02);
    const sy = Math.max(fromRect.height / toRect.h, 0.02);
    const dx = fromRect.left - toRect.x;
    const dy = fromRect.top - toRect.y;
    const from = { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, opacity: 0.35, borderRadius: '6px' };
    const to = { transform: 'none', opacity: 1, borderRadius: full ? '0px' : '16px' };
    const frames = opts.reverse ? [to, from] : [from, to];
    if (opts.reverse) frames[1].opacity = 0;
    return ui.panel.animate(frames, {
      duration: opts.reverse ? 220 : 330,
      easing: opts.reverse ? 'cubic-bezier(.4,0,.6,1)' : 'cubic-bezier(.16,1,.3,1)',
      fill: 'none'
    }).finished.catch(() => {});
  }

  function originRectFor(el) {
    if (!el || !el.isConnected) return null;
    const r = linkRect(el);
    const vp = viewport();
    if (r.width < 1 || r.bottom < 0 || r.top > vp.h || r.right < 0 || r.left > vp.w) return null;
    return r;
  }

  /* ---------------- Ring around the current link ---------------- */
  let ringRaf = 0;
  function updateRing() {
    if (!ui || !panelOpen || !current || !current.el || !current.el.isConnected) { if (ui) ui.ring.classList.remove('show'); return; }
    const r = linkRect(current.el);
    const pad = 3;
    const s = ui.ring.style;
    s.left = (r.left - pad) + 'px'; s.top = (r.top - pad) + 'px';
    s.width = (r.width + pad * 2) + 'px'; s.height = (r.height + pad * 2) + 'px';
    ui.ring.classList.toggle('show', !full);
  }
  function scheduleRing() {
    if (ringRaf) return;
    ringRaf = requestAnimationFrame(() => { ringRaf = 0; updateRing(); });
  }

  /* ---------------- Open / close ---------------- */
  function open(el, opts) {
    opts = opts || {};
    const isAction = !!opts.url;            // a button or script link with a readable destination
    const url = opts.url || previewUrl(el);
    if (!url) return;
    let deferSeq = false;
    if (!panelOpen) {
      seq = null;
      deferSeq = !isAction;
      startPanel(el, opts);
    } else if (isAction) {
      seq = null;
    } else {
      const idx = seq ? seq.list.findIndex((it) => it.el === el || it.key === L.dedupeKey(url)) : -1;
      if (idx >= 0) seq.index = idx;
      else { seq = null; deferSeq = true; }
    }
    show(el, url, opts.text || linkText(el), {
      method: opts.method || el.getAttribute('data-method') || el.getAttribute('data-turbo-method') || '',
      download: el.hasAttribute('download'),
      fromAction: !!opts.fromAction
    });
    if (isAction && current) current.isAction = true;
    // The preview request goes out first; mapping the page's links can wait a frame.
    if (deferSeq) {
      const id = current && current.id;
      setTimeout(() => {
        if (!panelOpen || !current || current.id !== id || seq) return;
        seq = buildSequence(el);
        updateCounter();
      }, 0);
    }
  }

  /* Preview a bare URL (context menu, links inside a reader preview). */
  function showUrl(url, opts) {
    opts = opts || {};
    const el = opts.el || null;
    if (!panelOpen) {
      seq = el ? buildSequence(el) : null;
      startPanel(el, opts);
    }
    show(el, L.unwrap(url), opts.text || '', {});
  }

  function startPanel(el, opts) {
    clearTimeout(teardownTimer);
    if (settings.testMode) testSteps = settings.testAutoSteps || 0;
    mountHost();
    ensureFrame();
    hideHint();
    full = !!opts.full;
    manualPos = null;
    const rect = targetRect(full);
    setRect(rect);
    ui.panel.classList.toggle('full', full);
    setFullIcon();
    ui.panel.classList.add('open');
    if (ui.frame) ui.frame.inert = false;
    panelOpen = true;
    watchHost();
    animateFrom(originRectFor(el), rect);
    maybeCoach();
  }

  function show(el, url, text, extra) {
    testLog({ ev: 'show', url, text: (text || '').slice(0, 80) });
    const id = ++openSeq;
    current = { el, url, text, id, t0: performance.now() };
    ui.title.textContent = text || L.hostLabel(url);
    ui.title.title = url;
    ui.site.textContent = L.hostLabel(url);
    ui.favicon.style.visibility = 'hidden';
    ui.favicon.removeAttribute('src');
    modes = [];
    applyMeta({ mode: 'loading', modes: [], loading: true });
    updateCounter();
    closeMenu();
    updateRing();
    send({
      type: 'show', id, url, text,
      method: extra.method || '', download: !!extra.download,
      preferMode: settings.preferMode,
      refuseRisky: settings.refuseRisky !== false,
      cookies: S.hostMatches(L.hostLabel(url), settings.cookieSites),
      timeoutSec: settings.timeoutSec || 8,
      fromAction: !!extra.fromAction,
      theme: effectiveTheme(), readerFont: settings.readerFont,
      pageUrl: location.href
    });
  }

  function updateCounter() {
    if (seq && seq.list.length > 1 && current && current.el) {
      ui.counter.textContent = (seq.index + 1) + ' of ' + seq.list.length;
      ui.counter.title = seq.mode === 'similar' ? 'Similar links on this page (' + seq.list.length + ')' : 'Links on this page';
    } else {
      ui.counter.textContent = '';
    }
  }

  let stepTimer = 0;
  function step(dir, repeat) {
    if (!current) return;
    if (current.isAction) { bump(dir); return; }
    if (!seq && current.el && current.el.isConnected) seq = buildSequence(current.el);
    if (!seq) return;
    let list = seq.list;
    let i = seq.index + dir;
    // Rebuild when the page changed under us (infinite scroll, removed nodes),
    // but not on every press while bumping against the end of a huge list.
    const atEdge = i < 0 || i >= list.length;
    if ((atEdge && performance.now() - (seq.builtAt || 0) > 1200) || (!atEdge && !list[i].el.isConnected)) {
      const anchor = current.el && current.el.isConnected ? current.el : null;
      if (anchor) {
        const fresh = buildSequence(anchor);
        if (fresh.list.length !== list.length || (fresh.list[fresh.index + dir] && fresh.list[fresh.index + dir].el !== (list[i] && list[i].el))) {
          seq = fresh; list = seq.list; i = seq.index + dir;
        }
      }
    }
    // Hidden links (collapsed menus, off-canvas copies) are skipped as you go.
    while (i >= 0 && i < list.length && !resolveVisible(list[i])) i += dir;
    if (i < 0 || i >= list.length) { bump(dir); return; }
    seq.index = i;
    const it = list[i];
    // Virtualized lists recycle nodes: preview what the link says now.
    const nowUrl = previewUrl(it.el);
    if (nowUrl && nowUrl !== it.url) { it.url = nowUrl; it.key = L.dedupeKey(nowUrl); }
    try { it.el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reduceMotionMQ.matches ? 'auto' : 'smooth' }); } catch (e) { /* ignore */ }
    const go = () => show(it.el, it.url, linkText(it.el), { method: it.el.getAttribute('data-method') || '', download: it.el.hasAttribute('download') });
    clearTimeout(stepTimer);
    if (repeat) {
      // Holding an arrow key: move the title and ring at once, fetch when the key settles.
      current = { el: it.el, url: it.url, text: '', id: ++openSeq, t0: performance.now() };
      ui.title.textContent = linkText(it.el) || L.hostLabel(it.url);
      ui.site.textContent = L.hostLabel(it.url);
      ui.favicon.style.visibility = 'hidden';
      applyMeta({ mode: 'loading', modes: [], loading: true });
      updateCounter();
      updateRing();
      stepTimer = setTimeout(go, 160);
      return;
    }
    go();
  }

  /* Don't leave the extension's frame in the page once you're done with it: it holds
     memory, and while another extension's frame is in a tab Chrome won't let
     debugger-based tools (screen readers' helpers, automation, Claude in Chrome)
     attach to that tab. Kept briefly so a quick re-open stays instant. */
  let teardownTimer = 0;
  function scheduleFrameTeardown() {
    clearTimeout(teardownTimer);
    teardownTimer = setTimeout(() => {
      if (panelOpen || !ui || !ui.frame) return;
      ui.frame.remove();
      ui.frame = null;
      ui.ready = false;
      ui.port = null;
      ui.queue = [];
    }, settings.testMode ? 50 : 20000);
  }

  /* ---------------- Test mode (off unless a developer sets testMode) ----------------
     Writes what the extension did into a page attribute so automated tests can read it
     after the panel closes, and walks the arrow-key sequence on its own. */
  let testSteps = 0;
  function testLog(evt) {
    if (!settings.testMode) return;
    const de = document.documentElement;
    let log = [];
    try { log = JSON.parse(de.getAttribute('data-quick-look-log') || '[]'); } catch (e) { log = []; }
    log.push(Object.assign({ t: Math.round(performance.now()) }, evt));
    de.setAttribute('data-quick-look-log', JSON.stringify(log.slice(-80)));
  }
  function testAdvance() {
    if (!settings.testMode || !panelOpen) return;
    clearTimeout(testAdvance.t);
    testAdvance.t = setTimeout(() => {
      if (!panelOpen) return;
      if (testSteps > 0) { testSteps--; step(1); } else close({ instant: true });
    }, settings.testDwellMs || 2500);
  }

  function bump(dir) {
    testLog({ ev: 'bump', dir });
    if (settings.testMode) { close({ instant: true }); return; }
    if (reduceMotionMQ.matches) return;
    ui.panel.animate([{ transform: 'none' }, { transform: `translateX(${dir * 10}px)` }, { transform: 'none' }], { duration: 220, easing: 'ease-out' });
  }

  /* If the page tears down the DOM we live in (document.open, replaced <html>), close cleanly. */
  let hostObserver = null;
  function watchHost() {
    if (hostObserver) hostObserver.disconnect();
    hostObserver = new MutationObserver(() => { if (panelOpen && !ui.host.isConnected) close({ instant: true }); });
    hostObserver.observe(document, { childList: true, subtree: false });
    if (document.documentElement) hostObserver.observe(document.documentElement, { childList: true });
    if (ui.host.parentNode && ui.host.parentNode !== document.documentElement) hostObserver.observe(ui.host.parentNode, { childList: true });
  }

  function close(opts) {
    opts = opts || {};
    if (!panelOpen || !ui) return;
    testLog({ ev: 'close' });
    panelOpen = false;
    clearTimeout(stepTimer);
    if (hostObserver) { hostObserver.disconnect(); hostObserver = null; }
    closeMenu();
    hideCoach();
    ui.ring.classList.remove('show');
    send({ type: 'hide' });
    const origin = opts.instant ? null : originRectFor(current && current.el);
    const finish = () => {
      if (panelOpen) return;
      ui.panel.classList.remove('open');
      ui.loading.classList.remove('show');
      if (ui.frame) ui.frame.inert = true;
      unmountHostIfIdle();
      scheduleFrameTeardown();
    };
    if (opts.instant) finish();
    else animateFrom(origin, ui.rect, { reverse: true }).then(finish);
    // Give the keyboard back to the page: if focus is anywhere inside the
    // panel (say you clicked into a preview), pull it out to the page itself.
    const ae = document.activeElement;
    if (ae === ui.host) {
      try { ae.blur(); } catch (e) { /* ignore */ }
      try { if (ui.frame) ui.frame.blur(); window.focus(); } catch (e) { /* ignore */ }
    }
    current = null;
  }

  function toggleFull() {
    if (!panelOpen) return;
    const before = ui.panel.getBoundingClientRect();
    full = !full;
    ui.panel.classList.toggle('full', full);
    setFullIcon();
    const r = targetRect(full);
    setRect(r);
    if (!reduceMotionMQ.matches) {
      const sx = before.width / r.w, sy = before.height / r.h;
      ui.panel.animate([
        { transform: `translate(${before.left - r.x}px, ${before.top - r.y}px) scale(${sx}, ${sy})` },
        { transform: 'none' }
      ], { duration: 300, easing: 'cubic-bezier(.16,1,.3,1)' });
    }
    updateRing();
  }

  function setFullIcon() {
    ui.fullBtn.replaceChildren(full ? ICONS.shrink() : ICONS.expand());
    ui.fullBtn.title = full ? 'Exit full window (' + KEYS.alt + 'Space)' : 'Full window (' + KEYS.alt + 'Space)';
  }

  /* ---------------- Drag & resize ---------------- */
  function startDrag(e) {
    if (e.button !== 0 || full || e.target.closest('button')) return;
    const start = { x: e.clientX, y: e.clientY, left: ui.rect.x, top: ui.rect.y };
    let moved = false;
    const move = (ev) => {
      const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;
      ui.panel.classList.add('dragging');
      manualPos = { x: start.left + dx, y: start.top + dy };
      setRect(targetRect(false));
    };
    const up = () => {
      ui.panel.classList.remove('dragging');
      ui.titlebar.removeEventListener('pointermove', move);
      ui.titlebar.removeEventListener('pointerup', up);
      ui.titlebar.removeEventListener('pointercancel', up);
    };
    ui.titlebar.setPointerCapture(e.pointerId);
    ui.titlebar.addEventListener('pointermove', move);
    ui.titlebar.addEventListener('pointerup', up);
    ui.titlebar.addEventListener('pointercancel', up);
  }

  function startResize(e) {
    if (e.button !== 0 || full) return;
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, w: ui.rect.w, h: ui.rect.h, left: ui.rect.x, top: ui.rect.y };
    ui.panel.classList.add('resizing');
    const move = (ev) => {
      const vp = viewport();
      // Centered panels grow on both sides, like dragging a window corner with Option held.
      const centered = !manualPos;
      const k = centered ? 2 : 1;
      const w = Math.max(380, Math.min(vp.w - 12, start.w + (ev.clientX - start.x) * k));
      const hh = Math.max(280, Math.min(vp.h - 12, start.h + (ev.clientY - start.y) * k));
      local.panelSize = { w: Math.round(w), h: Math.round(hh) };
      if (!centered) manualPos = { x: start.left, y: start.top };
      setRect(targetRect(false));
    };
    const up = () => {
      ui.panel.classList.remove('resizing');
      ui.resize.removeEventListener('pointermove', move);
      ui.resize.removeEventListener('pointerup', up);
      ui.resize.removeEventListener('pointercancel', up);
      S.setLocal({ panelSize: local.panelSize });
    };
    ui.resize.setPointerCapture(e.pointerId);
    ui.resize.addEventListener('pointermove', move);
    ui.resize.addEventListener('pointerup', up);
    ui.resize.addEventListener('pointercancel', up);
  }

  /* ---------------- Actions ---------------- */
  function openInTab(opts) {
    if (!current) return;
    const url = current.finalUrl || current.url;
    chrome.runtime.sendMessage({ type: 'ql:open', url, active: opts.active, newWindow: !!opts.newWindow }).catch(() => {});
    if (opts.active || opts.newWindow) close({ instant: true });
    else toast('Opened in a background tab');
  }

  function copyLink() {
    if (!current) return;
    const url = current.finalUrl || current.url;
    const done = () => toast('Link copied');
    const fallback = () => {
      const ta = h('textarea', { 'aria-hidden': 'true' });
      ta.value = url;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      ui.shadow.append(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { /* ignore */ }
      ta.remove();
    };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(url).then(done, fallback);
    else fallback();
  }

  let toastTimer = 0;
  function toast(text) {
    if (!ui || !text) return;
    ui.toast.textContent = text;
    ui.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toast.classList.remove('show'), 1600);
  }

  let coachTimer = 0;
  function maybeCoach() {
    if ((local.coachShown || 0) >= S.COACH_LIMIT) return;
    local.coachShown = (local.coachShown || 0) + 1;
    S.setLocal({ coachShown: local.coachShown });
    const item = (keys, label) => h('span', null, keys.map((k) => h('kbd', { text: k })).concat([document.createTextNode(label)]));
    ui.coach.replaceChildren(
      item(['←', '→'], 'flip through links'),
      item([KEYS.enter], 'open'),
      item([KEYS.alt, 'Space'], 'full window'),
      item(['Esc'], 'close')
    );
    clearTimeout(coachTimer);
    setTimeout(() => ui.coach.classList.add('show'), 450);
    coachTimer = setTimeout(hideCoach, 5200);
  }
  function hideCoach() { if (ui) ui.coach.classList.remove('show'); }

  /* ---------------- Local-only stats (receipts) ---------------- */
  let statsQueue = null;
  function recordStat(msg) {
    if (!current || msg.id !== current.id) return;
    const ms = Math.round(performance.now() - current.t0);
    testLog({ ev: 'shown', url: current.url, mode: msg.mode, cached: !!msg.cached, ms, title: ui.title.textContent, info: ui.badge.title, modes: modes.slice(), seq: seq ? { index: seq.index, length: seq.list.length, mode: seq.mode } : null });
    testAdvance();
    S.getLocal().then((l) => {
      const st = l.stats || { since: Date.now(), opened: 0, modes: {}, times: [] };
      st.opened = (st.opened || 0) + 1;
      st.modes = st.modes || {};
      st.modes[msg.mode] = (st.modes[msg.mode] || 0) + 1;
      st.times = (st.times || []).concat([{ mode: msg.mode, ms, cached: !!msg.cached }]).slice(-300);
      statsQueue = st;
      return S.setLocal({ stats: st });
    }).catch(() => {});
  }

  /* ---------------- Hover hint ---------------- */
  let hintTimer = 0;
  let hintEl = null;
  let lastHintAt = 0;
  function considerHint(link) {
    if (torn || !settings.hoverHint || siteOff || panelOpen || !link) return;
    if ((local.hintShown || 0) >= S.HINT_LIMIT) return;
    if (local.stats && local.stats.opened >= 3) return;
    if (performance.now() - lastHintAt < 20000 && lastHintAt) return;
    clearTimeout(hintTimer);
    hintEl = link;
    hintTimer = setTimeout(() => {
      if (torn || hintEl !== link || panelOpen) return;
      mountHost();
      const r = linkRect(link);
      const vp = viewport();
      const hint = ui.hint;
      hint.firstChild.textContent = hintKeyLabel();
      // Just below and right of the pointer, like a tooltip, but never off-screen.
      const y = pointer.y >= 0 ? pointer.y + 22 : r.bottom + 6;
      hint.style.left = Math.max(6, Math.min((pointer.x >= 0 ? pointer.x : r.left) + 12, vp.w - 150)) + 'px';
      hint.style.top = Math.min(y, vp.h - 34) + 'px';
      hint.classList.add('show');
      lastHintAt = performance.now();
      local.hintShown = (local.hintShown || 0) + 1;
      S.setLocal({ hintShown: local.hintShown });
    }, 650);
  }
  function hideHint() {
    clearTimeout(hintTimer);
    hintEl = null;
    if (ui && ui.hint.classList.contains('show') && !ui.nudge.classList.contains('show')) {
      ui.hint.classList.remove('show');
      setTimeout(unmountHostIfIdle, 200);
    }
  }

  /* ---------------- Event handlers ---------------- */
  function onPointerMove(e) {
    if (!e.isTrusted) return;
    if (e.isTrusted && (e.movementX || e.movementY || pointer.x !== e.clientX || pointer.y !== e.clientY)) pointer.t = performance.now();
    pointer.x = e.clientX; pointer.y = e.clientY;
  }

  function onMouseOver(e) {
    if (!e.isTrusted) return;
    pointer.x = e.clientX; pointer.y = e.clientY;
    if (!alive()) return;
    const path = e.composedPath();
    let link = null;
    for (const n of path) {
      if (n === window || n === document) break;
      if (isOurs(n)) { link = null; break; }
      if (isLinkEl(n)) { link = previewUrl(n) ? n : null; break; }
    }
    if (link) { if (link !== hintEl) { hideHint(); considerHint(link); } }
    else if (hintEl) hideHint();
  }

  function onMouseOut(e) {
    if (!e.relatedTarget) { pointer.x = -1; pointer.y = -1; hideHint(); }
  }

  function swallow(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.code) swallowed.set(e.code, performance.now());
  }

  /* 'plain' (Space), 'shift' (Shift+Space, works on every site) or 'ctrl'. */
  function triggerKind(e) {
    if (e.code !== 'Space' && e.key !== ' ') return null;
    if (e.metaKey) return null;
    if (settings.trigger === 'ctrl-space') return e.ctrlKey && !e.shiftKey ? 'ctrl' : null;
    if (e.shiftKey && !e.ctrlKey) return 'shift';
    return !e.ctrlKey ? 'plain' : null;
  }

  function onKeyDown(e) {
    if (!e.isTrusted || !alive()) return;
    if (panelOpen) { handlePanelKey(e, false); return; }
    const kind = triggerKind(e);
    if (!kind || e.isComposing || e.repeat || siteOff) return;
    if (kind === 'plain' && siteDisabled) return;
    if (document.fullscreenElement || document.pointerLockElement) return;
    if (isTypingContext(e)) return;
    const link = targetLink();
    if (link) {
      testLog({ ev: 'trigger', url: previewUrl(link), x: pointer.x, y: pointer.y, focused: deepActiveElement() === link, tag: link.localName, text: linkText(link).slice(0, 60) });
      swallow(e);
      hideHint();
      open(link, { full: e.altKey });
      return;
    }
    // Not a link: maybe a button or a script "link" (href="javascript:…").
    const act = actionTarget();
    if (!act) return;
    const res = resolveAction(act);
    testLog({ ev: 'action', tag: act.localName, url: res.url || null, why: res.why || null, text: linkText(act).slice(0, 60) });
    if (res.url) {
      swallow(e);
      hideHint();
      open(act, { full: e.altKey, url: res.url, text: linkText(act), method: res.method || '', fromAction: true });
    } else if (settings.explainButtons !== false) {
      swallow(e);
      hideHint();
      explainAction(act, res);
    }
  }

  /* ---------------- Buttons and script links ---------------- */
  const ACTION_SEL = 'a, button, [role="button"], [role="link"], [role="menuitem"], [role="tab"], input[type="submit"], input[type="button"], input[type="image"], summary, [onclick]';
  // Attributes that name a page to go to. (data-url is left out on purpose:
  // sites use it for background requests like "like" or "follow".)
  const URL_ATTRS = ['data-href', 'data-link', 'data-target-url', 'data-location', 'data-navigate', 'data-redirect'];
  let lastScrollAt = 0;

  function mediaPlaying() {
    for (const m of document.querySelectorAll('video, audio')) if (!m.paused && !m.ended && m.readyState > 2) return true;
    return false;
  }

  function actionTarget() {
    if (pointer.x < 0) return null;
    // Only for a pointer the person just moved onto something: a parked
    // mouse that a scroll slid over a button shouldn't stop Space-scrolling.
    // (Scroll events land a frame after the move that caused them, hence the slack.)
    if (pointer.t < lastScrollAt - 300 || performance.now() - pointer.t > 15000) return null;
    // Media sites use Space for play/pause.
    if (mediaPlaying()) return null;
    const el = deepElementFromPoint(pointer.x, pointer.y);
    if (!el || isOurs(el)) return null;
    const vp = viewport();
    const active = deepActiveElement();
    for (let n = el, i = 0; n && i < 12; n = parentOf(n), i++) {
      if (n.nodeType !== 1 || n === document.body || n === document.documentElement) break;
      if (!n.matches || !n.matches(ACTION_SEL)) continue;
      // A control you clicked (a player's play button) keeps its Space.
      if (active && active !== document.body && (n === active || n.contains(active))) return null;
      if (n.localName === 'a' && !n.hasAttribute('onclick') && !n.getAttribute('role') && !URL_ATTRS.some((a) => n.hasAttribute(a))) {
        const href = (n.getAttribute('href') || '').trim();
        // Only placeholder and javascript: links act like buttons. Email,
        // phone, app and in-page links keep Space's usual job.
        if (!(href === '#' || href === '' || /^javascript:/i.test(href))) return null;
        if (href === '' && !n.hasAttribute('href')) return null;
      }
      const r = n.getBoundingClientRect();
      // Big clickable containers (whole cards, page wrappers) aren't "a button".
      const generic = !/^(a|button|input|summary)$/.test(n.localName);
      if (r.width * r.height > vp.w * vp.h * (generic ? 0.12 : 0.25)) return null;
      return n;
    }
    return null;
  }

  function absUrl(v, loose) {
    if (!v) return null;
    const t = String(v).trim();
    if (!loose && !/^(https?:\/\/|\/(?!\/)|\.\.?\/)/i.test(t)) return null;
    try {
      const u = new URL(t, document.baseURI);
      return /^https?:$/.test(u.protocol) ? u.href : null;
    } catch (e) { return null; }
  }

  const BACKGROUND_REQUEST = /\b(fetch|ajax|\$\.(get|post|getJSON)|XMLHttpRequest|axios|sendBeacon|submit|method\s*:|post\s*\()/i;
  const NAV_PATTERNS = [
    /(?:window\.|document\.|top\.|self\.)?location(?:\.href)?\s*=\s*(['"`])([^'"`]+)\1(\s*[+;,)]|$)/,
    /location\.(?:assign|replace)\(\s*(['"`])([^'"`]+)\1(\s*[,)])/,
    /window\.open\(\s*(['"`])([^'"`]+)\1(\s*[,)])/
  ];

  /* A destination the extension can see without running the page's script. */
  function resolveAction(el) {
    for (const a of URL_ATTRS) {
      const u = absUrl(el.getAttribute(a));
      if (u) return { url: L.unwrap(u), how: a };
    }
    // Buttons that submit a form
    const isSubmit = (el.localName === 'button' && (el.getAttribute('type') || 'submit').toLowerCase() === 'submit') ||
      (el.localName === 'input' && /^(submit|image)$/i.test(el.type));
    const form = isSubmit ? el.form : null;
    if (form) {
      const method = (el.getAttribute('formmethod') || form.getAttribute('method') || 'get').toLowerCase();
      const rawAction = el.getAttribute('formaction') || form.getAttribute('action') || '';
      const action = rawAction ? absUrl(rawAction, true) : location.href;
      if (!action) return { why: 'script' };
      if (method !== 'get') return { why: 'form', method, target: action };
      const typed = Array.from(form.elements).some((f) => f.matches && f.matches('input, textarea, select') &&
        !/^(hidden|submit|image|button|reset)$/i.test(f.type || ''));
      if (typed) return { why: 'form-input', target: action };
      try {
        const u = new URL(action);
        u.search = new URLSearchParams(new FormData(form, el)).toString();
        return { url: u.href, method: 'get', how: 'form' };
      } catch (e) { return { why: 'form-input' }; }
    }
    // Script links: location = '/x', location.assign('/x'), window.open('/x')
    const href = el.localName === 'a' ? (el.getAttribute('href') || '') : '';
    const code = (/^javascript:/i.test(href) ? href.replace(/^javascript:/i, '') : '') + ' ' + (el.getAttribute('onclick') || '');
    if (code.trim()) {
      if (BACKGROUND_REQUEST.test(code)) return { why: 'script' };
      for (const re of NAV_PATTERNS) {
        const m = re.exec(code);
        if (!m) continue;
        const lit = m[2];
        const before = code.slice(0, m.index + m[0].indexOf(m[1])).trimEnd();
        // Skip URLs glued together from pieces ('/item/' + id, `${x}`).
        if (lit.includes('${') || /\+\s*$/.test(before) || /^\s*\+/.test(m[3] || '')) return { why: 'script' };
        const u = absUrl(lit, true);
        if (u) return { url: L.unwrap(u), how: 'script' };
      }
      return { why: 'script' };
    }
    return { why: el.localName === 'a' ? 'empty' : 'button' };
  }

  let nudgeTimer = 0;
  function explainAction(el, res) {
    mountHost();
    const text = linkText(el).replace(/\s+/g, ' ').trim();
    const label = text && text.length <= 40 ? '“' + text + '”' : 'This';
    const risky = !!text && !L.assess('https://quick-look.invalid/', { text }).ok;
    let msg;
    if (res.why === 'form') msg = label + ' sends a form' + (risky ? ', so it won’t be pressed' : ', and buttons are never pressed') + '.';
    else if (risky) msg = label + ' runs an action, so it won’t be pressed.';
    else if (res.why === 'form-input') msg = label + ' searches or submits what you type, so there’s nothing to preview yet.';
    else msg = label + (el.localName === 'a' ? ' runs a script instead of linking to a page' : ' is a button, not a link') + ', so there’s nothing to preview.';
    const n = ui.nudge;
    n.textContent = msg;
    const vp = viewport();
    n.style.left = Math.max(6, Math.min(pointer.x + 12, vp.w - 340)) + 'px';
    n.style.top = Math.min(pointer.y + 22, vp.h - 40) + 'px';
    n.classList.add('show');
    clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(() => { n.classList.remove('show'); setTimeout(unmountHostIfIdle, 250); }, 2600);
  }

  /* Keys while the panel is open. `fromFrame` events come from inside the preview. */
  function handlePanelKey(e, fromFrame) {
    const key = e.key;
    const mod = e.metaKey || e.ctrlKey;
    const evt = fromFrame ? null : e;
    const eat = () => { if (evt) swallow(evt); };
    if (e.isComposing) return;
    // Let the page keep keys when the user is typing into one of its fields.
    if (!fromFrame && key !== 'Escape' && isTypingContext(e)) return;

    if (key === 'Escape') {
      eat();
      if (ui.menu.classList.contains('open')) closeMenu();
      else close();
      return;
    }
    if (e.code === 'Space' || key === ' ') {
      if (e.metaKey) return;
      eat();
      if (e.repeat) return;
      if (e.altKey) { toggleFull(); return; }
      if (settings.trigger === 'ctrl-space' && !e.ctrlKey && fromFrame) { close(); return; }
      const l = fromFrame ? null : targetLink();
      if (l && current && l !== current.el && previewUrl(l) && L.dedupeKey(previewUrl(l)) !== L.dedupeKey(current.url)) open(l);
      else close();
      return;
    }
    if (ui.menu.classList.contains('open') && (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Enter')) {
      eat();
      menuKey(key);
      return;
    }
    switch (key) {
      case 'ArrowRight': case 'ArrowDown':
        if (mod || e.altKey) return;
        eat(); step(1, e.repeat); return;
      case 'ArrowLeft': case 'ArrowUp':
        if (mod || e.altKey) return;
        eat(); step(-1, e.repeat); return;
      case 'Enter':
        eat();
        openInTab({ active: !mod, newWindow: e.shiftKey && !mod });
        return;
      case 'PageDown': case 'PageUp': case 'Home': case 'End':
        if (mod) return;
        eat();
        send({ type: 'scroll', key });
        return;
      case 'Tab':
        return;
    }
    if (!mod && !e.altKey && (key === 'f' || key === 'F')) { eat(); toggleFull(); return; }
    if (!mod && !e.altKey && (key === 'r' || key === 'R')) { eat(); cycleMode(); return; }
    if (mod && !e.altKey && !e.shiftKey && (key === 'c' || key === 'C')) {
      const sel = String(getSelection() || '');
      if (!sel) { eat(); copyLink(); }
      return;
    }
    // Keep page shortcuts (GitHub's "s", YouTube's "k"…) from firing underneath the preview.
    if (!mod && !e.altKey && key && key.length === 1) eat();
  }

  function menuKey(key) {
    const btns = Array.from(ui.menu.querySelectorAll('button:not([disabled])'));
    if (!btns.length) return;
    let i = btns.findIndex((b) => b.classList.contains('kb'));
    if (key === 'Enter') { if (i >= 0) btns[i].click(); return; }
    btns.forEach((b) => b.classList.remove('kb'));
    i = key === 'ArrowDown' ? (i + 1) % btns.length : (i - 1 + btns.length) % btns.length;
    btns[i].classList.add('kb');
  }

  function onKeyUpOrPress(e) {
    if (!e.isTrusted) return;
    const t = swallowed.get(e.code);
    // Entries expire: the keyup may land in another tab (Enter opened one).
    const fresh = t !== undefined && performance.now() - t < 1500;
    if (t !== undefined && !fresh) swallowed.delete(e.code);
    const spaceWhileOpen = panelOpen && (e.code === 'Space' || e.key === ' ') && !isTypingContext(e);
    if (fresh || spaceWhileOpen) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
    if (e.type === 'keyup') swallowed.delete(e.code);
  }

  function onPointerDown(e) {
    if (!panelOpen || !e.isTrusted) return;
    if (e.composedPath().includes(ui.host)) return;
    if (!settings.closeOnOutsideClick) return;
    // Clicking outside closes the preview, and that click doesn't also follow a link.
    e.preventDefault();
    e.stopImmediatePropagation();
    swallowNextClick = true;
    setTimeout(() => { swallowNextClick = false; }, 600);
    close();
  }

  function onClick(e) {
    if (swallowNextClick) {
      swallowNextClick = false;
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }

  on(window, 'pointermove', onPointerMove, { capture: true, passive: true });
  on(window, 'focusin', () => { lastFocusAt = performance.now(); }, { capture: true, passive: true });
  on(window, 'mouseover', onMouseOver, { capture: true, passive: true });
  on(window, 'mouseout', onMouseOut, { capture: true, passive: true });
  on(window, 'keydown', onKeyDown, true);
  on(window, 'keyup', onKeyUpOrPress, true);
  on(window, 'keypress', onKeyUpOrPress, true);
  on(window, 'pointerdown', onPointerDown, true);
  on(window, 'click', onClick, true);
  on(window, 'contextmenu', (e) => {
    const path = e.composedPath();
    lastContextLink = path.find((n) => n.nodeType === 1 && isLinkEl(n)) || null;
  }, true);
  on(window, 'scroll', () => { lastScrollAt = performance.now(); if (panelOpen) scheduleRing(); hideHint(); }, { capture: true, passive: true });
  on(window, 'resize', () => {
    if (!panelOpen) return;
    setRect(targetRect(full));
    scheduleRing();
  }, { passive: true });
  on(window, 'pagehide', () => close({ instant: true }));
  on(window, 'popstate', () => close({ instant: true }));
  // Single-page apps: close when the page navigates itself (not on hash or replace updates).
  if (window.navigation) on(window.navigation, 'navigate', (e) => {
    if (panelOpen && !e.hashChange && (e.navigationType === 'push' || e.navigationType === 'traverse')) close({ instant: true });
  });
  on(document, 'visibilitychange', () => { if (document.hidden) swallowed.clear(); });
  on(window, 'blur', () => swallowed.clear());
  on(window, 'blur', () => hideHint());

  try {
    onChrome(chrome.runtime.onMessage, (msg) => {
      if (!msg || msg.type !== 'ql:preview-url' || !msg.url) return;
      const el = lastContextLink && previewUrl(lastContextLink) && L.dedupeKey(previewUrl(lastContextLink)) === L.dedupeKey(L.unwrap(msg.url)) ? lastContextLink : null;
      if (el) open(el); else showUrl(msg.url, {});
    });
  } catch (e) { /* ignore */ }

  // Test hook for the welcome page demo and automated tests (isolated world only).
  globalThis.__qlDebug = { open: (el) => open(el), close, step, buildSequence, ui: () => ui && { needCred: !!ui.needCredentialless, ready: !!ui.ready, frame: !!ui.frame, panelOpen, swallowed: Array.from(swallowed.keys()) }, probe: () => { const a = actionTarget(); return { a: a && (a.localName + '#' + a.id), res: a && resolveAction(a), pt: pointer.t, ls: lastScrollAt, now: performance.now(), link: !!targetLink() }; }, isOpen: () => panelOpen, state: () => ({ current, seq: seq && { index: seq.index, length: seq.list.length, mode: seq.mode }, mode: currentMode, modes, full }) };
})();
