/* ‘Quick Look’ for LINKS — toolbar popup: status for this site, quick toggles, shortcuts. */
(async () => {
  'use strict';
  const S = QLSettings;
  const $ = (id) => document.getElementById(id);
  const K = S.keyLabels();
  $('k-alt').textContent = K.alt;
  $('k-mod').textContent = K.mod;
  $('k-enter').textContent = K.enter;
  $('k-enter2').textContent = K.enter;
  $('version').textContent = 'v' + chrome.runtime.getManifest().version;
  $('open-settings').addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); window.close(); });
  $('open-welcome').addEventListener('click', (e) => { e.preventDefault(); chrome.tabs.create({ url: chrome.runtime.getURL('welcome/welcome.html#try') }); window.close(); });

  const settings = await S.get();
  if (settings.trigger === 'ctrl-space') $('k-trigger').replaceChildren(kbd(K.ctrl), kbd('Space'));

  // ?tab=<id> lets the popup be opened in a tab for screenshots and tests.
  const forced = Number(new URLSearchParams(location.search).get('tab'));
  const tab = forced ? await chrome.tabs.get(forced) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  const all = await chrome.permissions.contains({ origins: ['http://*/*', 'https://*/*'] });
  const perms = await chrome.permissions.getAll();
  const anyAccess = (perms.origins || []).some((o) => /^(https?|\*):/.test(o));
  $('mode-line').textContent = all ? 'On for all websites' : anyAccess ? 'On for sites you choose' : 'Not set up yet';

  let url = null;
  try { url = tab && tab.url ? new URL(tab.url) : null; } catch (e) { url = null; }
  const body = $('site-body');
  const pill = $('site-pill');
  const web = url && (url.protocol === 'http:' || url.protocol === 'https:');
  const host = web ? url.hostname.replace(/^www\./, '') : '';
  $('site-host').textContent = web ? host : 'This page';
  if (web) $('site-icon').src = chrome.runtime.getURL('/_favicon/') + '?pageUrl=' + encodeURIComponent(url.href) + '&size=32';
  else $('site-icon').remove();

  function kbd(t) { const k = document.createElement('kbd'); k.textContent = t; return k; }
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function setPill(cls, text) { pill.className = 'pill ' + cls; pill.textContent = text; }
  function toggleRow(label, hint, checked, onChange) {
    const row = el('label', 'toggle-row');
    const l = el('span', 'label', label);
    if (hint) l.append(el('small', null, hint));
    const sw = el('span', 'switch');
    const input = document.createElement('input');
    input.type = 'checkbox'; input.checked = checked; input.setAttribute('role', 'switch');
    input.addEventListener('change', () => onChange(input.checked, input));
    sw.append(input);
    row.append(l, sw);
    return row;
  }

  if (!web) {
    setPill('warn', 'Unavailable');
    body.append(el('p', null, 'Browsers don’t let extensions run on built-in pages like this one. Previews work on regular websites.'));
    return;
  }
  if (!anyAccess) {
    setPill('warn', 'Setup');
    body.append(el('p', null, 'Choose where previews can work to get started.'));
    const b = el('button', 'btn primary', 'Finish setup');
    b.addEventListener('click', () => { chrome.tabs.create({ url: chrome.runtime.getURL('welcome/welcome.html') }); window.close(); });
    body.append(b);
    return;
  }
  const originPattern = url.protocol + '//' + url.hostname + '/*';
  const { enabledSites } = await chrome.storage.local.get({ enabledSites: [] });
  const granted = all || ((enabledSites || []).includes(originPattern) && await chrome.permissions.contains({ origins: [originPattern] }));
  if (!granted) {
    setPill('info', 'Off here');
    body.append(el('p', null, 'You approve sites one at a time. Turn previews on for ' + host + ' to use them here.'));
    const b = el('button', 'btn primary', 'Turn on for ' + host);
    b.addEventListener('click', async () => {
      const ok = await chrome.permissions.request({ origins: [originPattern] });
      if (ok) {
        await chrome.runtime.sendMessage({ type: 'ql:enable-site', origin: originPattern }).catch(() => {});
        window.close();
      }
    });
    body.append(b);
    return;
  }
  const off = S.hostMatches(host, settings.offSites || []);
  const reserved = S.hostMatches(host, settings.disabledSites);
  const status = () => {
    if (off) setPill('warn', 'Off');
    else if (reserved) setPill('info', '⇧Space');
    else setPill('ok', 'On');
  };
  status();
  const parentRule = (settings.disabledSites || []).find((d) => S.hostMatches(host, [d]) && S.normalizeHost(d) !== host);
  const reservedHint = parentRule
    ? 'Space belongs to all of ' + S.normalizeHost(parentRule) + '. Use ⇧Space to preview. Turning this on gives Space to previews there too.'
    : 'Space keeps its normal job here. Use ⇧Space to preview.';
  const spaceRow = toggleRow('Space previews links here', reserved ? reservedHint : 'Hover a link and press Space (⇧Space also works)', !reserved, async (on, input) => {
    const s2 = await S.get();
    let list = (s2.disabledSites || []).slice();
    if (on) list = list.filter((d) => !S.hostMatches(host, [d])); else list.push(host);
    await S.set({ disabledSites: Array.from(new Set(list)) });
    input.closest('.toggle-row').querySelector('small').textContent = on ? 'Hover a link and press Space (⇧Space also works)' : 'Space keeps its normal job here. Use ⇧Space to preview.';
  });
  const offParent = (settings.offSites || []).find((d) => S.hostMatches(host, [d]) && S.normalizeHost(d) !== host);
  const offHint = offParent ? 'Off for all of ' + S.normalizeHost(offParent) + '. Turning this on turns it back on there too.' : 'Off: no previews, no hints on ' + host;
  body.append(toggleRow('On for this site', off ? offHint : 'Turn off to keep previews out of this site entirely', !off, async (on) => {
    const s2 = await S.get();
    let list = (s2.offSites || []).slice();
    if (on) list = list.filter((d) => !S.hostMatches(host, [d])); else list.push(host);
    await S.set({ offSites: Array.from(new Set(list)) });
    window.location.reload();
  }));
  if (!off) body.append(spaceRow);
  if (off) return;
  const cookieOn = S.hostMatches(host, settings.cookieSites);
  body.append(toggleRow('Use my cookies for ' + host + ' previews', cookieOn ? 'Previews of this site see you signed in' : 'Previews load as a logged-out visitor', cookieOn, async (on, input) => {
    const s = await S.get();
    let list = (s.cookieSites || []).slice();
    if (on) list.push(host); else list = list.filter((d) => !S.hostMatches(host, [d]));
    await S.set({ cookieSites: Array.from(new Set(list)) });
    input.closest('.toggle-row').querySelector('small').textContent = on ? 'Previews of this site see you signed in' : 'Previews load as a logged-out visitor';
  }));
})();
