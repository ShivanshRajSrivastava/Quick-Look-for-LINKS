/* ‘Quick Look’ for LINKS — welcome page: choose access, then try it on the links below.
   This page loads the content script directly, so the demo works here too. */
(async () => {
  'use strict';
  const S = QLSettings;
  const K = S.keyLabels();
  const $ = (id) => document.getElementById(id);
  const settings = await S.get();
  const trig = settings.trigger === 'ctrl-space' ? K.ctrl + ' Space' : 'Space';
  $('hero-key').textContent = trig;
  for (const k of document.querySelectorAll('.inline-key')) k.textContent = trig;

  const keys = [
    [[trig], 'Preview the link under the pointer'],
    [['⇧', 'Space'], 'Preview on YouTube, Docs and other sites that use Space'],
    [['←', '→'], 'Previous or next link'],
    [[K.alt, 'Space'], 'Full window'],
    [[K.enter], 'Open in a new tab'],
    [[K.mod, K.enter], 'Open in the background'],
    [['R'], 'Live, Reader or Summary'],
    [['Esc'], 'Close']
  ];
  const dl = $('keys');
  for (const [ks, what] of keys) {
    const dt = document.createElement('dt');
    for (const k of ks) { const e = document.createElement('kbd'); e.textContent = k; dt.append(e); }
    const dd = document.createElement('dd');
    dd.textContent = what;
    dl.append(dt, dd);
  }

  const status = $('setup-status');
  async function refresh() {
    const all = await chrome.permissions.contains({ origins: ['http://*/*', 'https://*/*'] });
    const perms = await chrome.permissions.getAll();
    const some = (perms.origins || []).some((o) => /^https?:\/\/[^*]/.test(o));
    $('choose-all').classList.toggle('selected', all);
    $('choose-sites').classList.toggle('selected', !all && (some || localStorage.getItem('ql-per-site') === '1'));
    status.className = 'setup-status' + (all || some ? ' ok' : '');
    if (all) status.textContent = '✓ On for every website. Pages that were already open work without reloading.';
    else if (some || localStorage.getItem('ql-per-site') === '1') status.textContent = '✓ Per-site mode. Click the toolbar button on any site to turn it on there.';
    else status.textContent = 'You can change this any time in Settings.';
  }
  $('choose-all').addEventListener('click', async () => {
    try {
      const ok = await chrome.permissions.request({ origins: ['http://*/*', 'https://*/*'] });
      if (ok) {
        await chrome.runtime.sendMessage({ type: 'ql:sync', inject: true }).catch(() => {});
        document.getElementById('try').scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    } catch (e) { status.textContent = String(e.message || e); }
    refresh();
  });
  $('choose-sites').addEventListener('click', async () => {
    try { localStorage.setItem('ql-per-site', '1'); } catch (e) { /* ignore */ }
    await chrome.permissions.remove({ origins: ['http://*/*', 'https://*/*'] }).catch(() => {});
    await chrome.runtime.sendMessage({ type: 'ql:sync' }).catch(() => {});
    refresh();
    document.getElementById('try').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  chrome.permissions.onAdded.addListener(refresh);
  chrome.permissions.onRemoved.addListener(refresh);
  refresh();
})();
