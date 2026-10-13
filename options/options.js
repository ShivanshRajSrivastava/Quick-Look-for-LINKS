/* ‘Quick Look’ for LINKS — settings page. */
(async () => {
  'use strict';
  const S = QLSettings;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const K = S.keyLabels();
  $('#ver').textContent = 'Version ' + chrome.runtime.getManifest().version;
  $('#ctrl-space-label').textContent = (K.mac ? '⌃' : 'Ctrl') + ' + Space';

  let settings = await S.get();

  function flash() {
    const s = $('#saved');
    s.classList.add('show');
    clearTimeout(flash.t);
    flash.t = setTimeout(() => s.classList.remove('show'), 1100);
  }

  async function save(patch) {
    Object.assign(settings, patch);
    await S.set(patch);
    flash();
    if ('trigger' in patch) renderKeys();
  }

  /* ----- Simple controls ----- */
  for (const name of ['trigger', 'arrows', 'preferMode', 'size', 'readerFont', 'theme']) {
    for (const input of $$(`input[name="${name}"]`)) {
      input.checked = settings[name] === input.value;
      input.addEventListener('change', () => { if (input.checked) save({ [name]: input.value }); });
    }
  }
  for (const name of ['hoverHint', 'closeOnOutsideClick', 'refuseRisky', 'forceLive', 'explainButtons']) {
    const input = $(`input[name="${name}"]`);
    input.checked = !!settings[name];
    input.addEventListener('change', () => save({ [name]: input.checked }));
  }
  const timeout = $('select[name="timeoutSec"]');
  timeout.value = String(settings.timeoutSec);
  timeout.addEventListener('change', () => save({ timeoutSec: parseInt(timeout.value, 10) }));

  $('#reset-hints').addEventListener('click', async () => {
    await S.setLocal({ hintShown: 0, coachShown: 0 });
    if (!settings.hoverHint) await save({ hoverHint: true });
    $('input[name="hoverHint"]').checked = true;
    flash();
  });
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) $('#motion-status').textContent = 'Reduce Motion is on, so the panel fades instead of zooming.';

  /* ----- Keyboard table ----- */
  function renderKeys() {
    const trig = settings.trigger === 'ctrl-space' ? [K.ctrl, 'Space'] : ['Space'];
    const rows = [
      ['Preview the link under the pointer (or the focused link)', trig],
      ['Close the preview', ['Esc']],
      ['Preview on sites where Space is taken (YouTube, Docs…)', ['⇧', 'Space']],
      ['Preview a different link while one is open: hover it and press', trig],
      ['Next link / previous link', ['→', '↓', '/', '←', '↑']],
      ['Full window', [K.alt, 'Space']],
      ['Open in a new tab', [K.enter]],
      ['Open in the background and keep flipping', [K.mod, K.enter]],
      ['Open in a new window', ['Shift', K.enter]],
      ['Switch between Live, Reader and Summary', ['R']],
      ['Copy the link', [K.mod, 'C']],
      ['Scroll the preview', ['Page Up', 'Page Down']]
    ];
    const t = $('#keys-table');
    t.replaceChildren();
    for (const [what, keys] of rows) {
      const a = document.createElement('div'); a.className = 'what'; a.textContent = what;
      const b = document.createElement('div'); b.className = 'k';
      for (const k of keys) {
        if (k === '/') { const s = document.createElement('span'); s.className = 'muted'; s.textContent = ' / '; b.append(s); continue; }
        const e = document.createElement('kbd'); e.textContent = k; b.append(e);
      }
      t.append(a, b);
    }
    $('#lede-key').textContent = trig.join(' + ');
  }
  renderKeys();

  /* ----- Site lists ----- */
  function renderList(name) {
    const ul = document.getElementById(name);
    ul.replaceChildren();
    const list = settings[name] || [];
    if (!list.length) {
      const li = document.createElement('li'); li.className = 'empty'; li.textContent = 'None'; ul.append(li);
      return;
    }
    for (const host of list) {
      const li = document.createElement('li');
      li.append(document.createTextNode(host));
      const x = document.createElement('button');
      x.textContent = '×'; x.title = 'Remove ' + host; x.setAttribute('aria-label', 'Remove ' + host);
      x.addEventListener('click', async () => {
        await save({ [name]: (settings[name] || []).filter((h) => h !== host) });
        renderList(name);
      });
      li.append(x);
      ul.append(li);
    }
  }
  for (const form of $$('form.add')) {
    const name = form.dataset.list;
    renderList(name);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = form.querySelector('input');
      const host = S.normalizeHost(input.value);
      if (!host || !/^[a-z0-9.-]+\.[a-z]{2,}$|^localhost$/.test(host)) { input.focus(); input.select(); return; }
      const list = Array.from(new Set((settings[name] || []).concat([host])));
      await save({ [name]: list });
      input.value = '';
      renderList(name);
    });
  }
  $('#reset-disabled').addEventListener('click', async () => {
    await save({ disabledSites: S.DEFAULTS.disabledSites.slice() });
    renderList('disabledSites');
  });

  /* ----- Access ----- */
  async function renderAccess() {
    const all = await chrome.permissions.contains({ origins: ['http://*/*', 'https://*/*'] });
    const perms = await chrome.permissions.getAll();
    const origins = (perms.origins || []).filter((o) => /^https?:\/\/[^*]/.test(o));
    const any = all || origins.length > 0;
    for (const r of $$('input[name="access"]')) r.checked = any && ((all && r.value === 'all') || (!all && r.value === 'sites'));
    const status = $('#access-status');
    if (all) status.innerHTML = '<span class="pill ok">Active</span> Previews work on every website.';
    else if (origins.length) status.innerHTML = '<span class="pill ok">Active</span> Previews work on the sites you approved.';
    else status.innerHTML = '<span class="pill warn">Not set up</span> Pick one to start previewing links.';
    const wrap = $('#granted-wrap');
    wrap.classList.toggle('hidden', all || !origins.length);
    const { enabledSites } = await chrome.storage.local.get({ enabledSites: [] });
    const chip = (ul, label, onRemove, title) => {
      const li = document.createElement('li');
      li.append(document.createTextNode(label));
      const x = document.createElement('button');
      x.textContent = '×'; x.title = title; x.setAttribute('aria-label', title);
      x.addEventListener('click', async () => { await onRemove(); renderAccess(); });
      li.append(x);
      ul.append(li);
    };
    const hostOf = (o) => o.replace(/^https?:\/\//, '').replace(/\/\*$/, '');
    const enUl = $('#enabled'); enUl.replaceChildren();
    const en = (enabledSites || []).filter((o) => origins.includes(o));
    if (!en.length) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = 'None yet'; enUl.append(li); }
    for (const o of en) chip(enUl, hostOf(o), () => chrome.runtime.sendMessage({ type: 'ql:disable-site', origin: o }), 'Turn previews off on ' + hostOf(o));
    const ul = $('#granted'); ul.replaceChildren();
    for (const o of origins) chip(ul, hostOf(o), async () => { await chrome.runtime.sendMessage({ type: 'ql:disable-site', origin: o }).catch(() => {}); await chrome.permissions.remove({ origins: [o] }); }, 'Remove access to ' + hostOf(o));
  }
  for (const r of $$('input[name="access"]')) {
    r.addEventListener('change', async () => {
      if (!r.checked) return;
      if (r.value === 'all') {
        const ok = await chrome.permissions.request({ origins: ['http://*/*', 'https://*/*'] });
        if (ok) await chrome.runtime.sendMessage({ type: 'ql:sync', inject: true }).catch(() => {});
      } else {
        // Going per-site: drop blanket access. Sites already approved stay approved.
        await chrome.permissions.remove({ origins: ['http://*/*', 'https://*/*'] }).catch(() => {});
        await chrome.runtime.sendMessage({ type: 'ql:sync' }).catch(() => {});
      }
      renderAccess();
    });
  }
  chrome.permissions.onAdded.addListener(renderAccess);
  chrome.permissions.onRemoved.addListener(renderAccess);
  renderAccess();

  /* ----- Stats ----- */
  async function renderStats() {
    const { stats } = await S.getLocal();
    const box = $('#stats');
    box.replaceChildren();
    const st = stats || { opened: 0, modes: {}, times: [] };
    const fresh = (st.times || []).filter((t) => !t.cached && t.ms > 0).map((t) => t.ms).sort((a, b) => a - b);
    const cached = (st.times || []).filter((t) => t.cached).map((t) => t.ms).sort((a, b) => a - b);
    const median = (a) => a.length ? a[Math.floor(a.length / 2)] : null;
    const tile = (n, t) => { const d = document.createElement('div'); d.className = 'stat'; d.innerHTML = '<div class="n"></div><div class="t"></div>'; d.firstChild.textContent = n; d.lastChild.textContent = t; return d; };
    box.append(
      tile(String(st.opened || 0), 'previews opened'),
      tile(median(fresh) != null ? (median(fresh) / 1000).toFixed(2) + ' s' : '—', 'median time to open'),
      tile(median(cached) != null ? Math.round(median(cached)) + ' ms' : '—', 'median when flipping back')
    );
    const modes = Object.entries(st.modes || {}).sort((a, b) => b[1] - a[1]);
    if (modes.length) {
      const total = modes.reduce((s, [, v]) => s + v, 0);
      const bars = document.createElement('div'); bars.className = 'bars';
      const NAMES = { live: 'Live page', reader: 'Reader', summary: 'Summary', image: 'Image', video: 'Video', audio: 'Audio', pdf: 'PDF', text: 'Text', file: 'File', post: 'Post', refused: 'Refused', error: 'Error', timeout: 'Timed out' };
      for (const [m, v] of modes) {
        const row = document.createElement('div'); row.className = 'bar';
        row.innerHTML = '<span class="name"></span><span class="track"><span class="fill" style="display:block"></span></span><span class="v"></span>';
        row.querySelector('.name').textContent = NAMES[m] || m;
        row.querySelector('.fill').style.width = ((v / total) * 100).toFixed(1) + '%';
        row.querySelector('.v').textContent = String(v);
        bars.append(row);
      }
      box.append(bars);
    }
  }
  $('#reset-stats').addEventListener('click', async () => { await S.setLocal({ stats: null }); renderStats(); flash(); });
  renderStats();
  chrome.storage.onChanged.addListener((c, area) => { if (area === 'local' && c.stats) renderStats(); });
})();
