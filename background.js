/* ‘Quick Look’ for LINKS — background service worker.
   Keeps the content script registered where you turned it on, keeps the
   privacy network rules in place, vouches for preview frames, opens tabs, and
   owns the context menu. It never makes network requests of its own. */
'use strict';

importScripts('shared/settings.js', 'shared/links.js');

const CONTENT_FILES = ['shared/settings.js', 'shared/links.js', 'content/panel.css.js', 'content/content.js'];
const SCRIPT_ID = 'ql-content';
const RULE_STRIP_COOKIES = 1;
const RULE_EMBED_REFERER = 2;
const RULE_FORCE_LIVE = 3;
const ALL_SITES = ['http://*/*', 'https://*/*'];
const EXT_PREFIX = 'chrome-extension://' + chrome.runtime.id + '/';

/* ---------- Where the extension runs ----------
   "Every website": Chrome granted access to all http and https sites.
   "Sites I approve": the content script only runs on sites the user switched
   on from the toolbar (enabledSites). Approving a site as a preview *source*
   from inside a preview does not switch Space on there. */

async function grantedOrigins() {
  const perms = await chrome.permissions.getAll();
  return (perms.origins || []).filter((o) => /^(https?|\*):\/\//.test(o) || o === '<all_urls>');
}

function isAllSites(origins) {
  return origins.includes('<all_urls>') || origins.includes('*://*/*') ||
    (origins.includes('http://*/*') && origins.includes('https://*/*'));
}

async function targetMatches() {
  const origins = await grantedOrigins();
  if (isAllSites(origins)) return ALL_SITES.slice();
  const { enabledSites } = await chrome.storage.local.get({ enabledSites: [] });
  return (enabledSites || []).filter((p) => origins.includes(p));
}

let syncChain = Promise.resolve();
function syncRegistration() {
  // Serialized: permission events and page messages can arrive together.
  syncChain = syncChain.then(doSyncRegistration, doSyncRegistration);
  return syncChain;
}

async function doSyncRegistration() {
  // Builds before 1.2 registered under an older id; drop it so nothing runs twice.
  try { await chrome.scripting.unregisterContentScripts({ ids: ['glance-content'] }); } catch (e) { /* not registered */ }
  const matches = await targetMatches();
  let existing = [];
  try { existing = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] }); } catch (e) { /* none */ }
  if (!matches.length) {
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] }).catch(() => {});
    return [];
  }
  const script = { id: SCRIPT_ID, js: CONTENT_FILES, matches, runAt: 'document_start', allFrames: false, persistAcrossSessions: true };
  try {
    if (existing.length) await chrome.scripting.updateContentScripts([script]);
    else await chrome.scripting.registerContentScripts([script]);
  } catch (e) {
    try { await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] }); } catch (e2) { /* ignore */ }
    await chrome.scripting.registerContentScripts([script]);
  }
  return matches;
}

/* Inject into tabs that are already open, so a change works without a reload. */
async function injectIntoOpenTabs(patterns) {
  if (!patterns || !patterns.length) return;
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: patterns }); } catch (e) { return; }
  await Promise.all(tabs.map((t) => injectTab(t.id).catch(() => {})));
}

async function injectTab(tabId) {
  await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: CONTENT_FILES });
}

/* ---------- Network rules: previews load as a logged-out visitor ---------- */

function validHosts(list) {
  return (list || []).map(QLSettings.normalizeHost).filter((h) => /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(h) && h.length < 254);
}

function buildRules(cookieSites, forceLive) {
  const strip = {
    initiatorDomains: [chrome.runtime.id],
    resourceTypes: ['sub_frame', 'xmlhttprequest', 'image', 'media', 'font', 'stylesheet', 'script', 'object', 'ping', 'other']
  };
  if (cookieSites.length) strip.excludedRequestDomains = cookieSites;
  return [
    {
      id: RULE_STRIP_COOKIES,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'cookie', operation: 'remove' }],
        responseHeaders: [{ header: 'set-cookie', operation: 'remove' }]
      },
      condition: strip
    },
    {
      // YouTube's official embed refuses to play ("Error 153") when the request
      // carries no Referer, which is always the case from an extension frame.
      id: RULE_EMBED_REFERER,
      priority: 2,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'referer', operation: 'set', value: 'https://quick-look-preview.invalid/' }] },
      condition: { initiatorDomains: [chrome.runtime.id], requestDomains: ['youtube-nocookie.com', 'youtube.com', 'player.vimeo.com'], resourceTypes: ['sub_frame'] }
    }
  ].concat(forceLive ? [{
    // "Show live pages even when a site blocks embedding": only for frames
    // the extension itself opens inside its preview. Those frames are sandboxed (no
    // redirecting your tab) and credentialless (an empty cookie jar), which is
    // what the site's embed block exists to protect against.
    id: RULE_FORCE_LIVE,
    priority: 3,
    action: {
      type: 'modifyHeaders',
      responseHeaders: [
        { header: 'x-frame-options', operation: 'remove' },
        { header: 'content-security-policy', operation: 'remove' }
      ]
    },
    // Never for sites you let previews use your cookies on: a signed-in page
    // keeps its own protection against being framed.
    condition: { initiatorDomains: [chrome.runtime.id], resourceTypes: ['sub_frame'], excludedRequestDomains: ['youtube-nocookie.com', 'player.vimeo.com'].concat(cookieSites) }
  }] : []);
}

async function syncRules() {
  const s = await QLSettings.get();
  const ids = [RULE_STRIP_COOKIES, RULE_EMBED_REFERER, RULE_FORCE_LIVE];
  const forceLive = s.forceLive !== false;
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ids, addRules: buildRules(validHosts(s.cookieSites), forceLive) });
  } catch (e) {
    // Fail closed: if the exceptions can't be applied, strip cookies everywhere.
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ids, addRules: buildRules([], forceLive) });
  }
}

/* ---------- Preview frames: only frames this extension created ----------
   The content script registers a one-time secret for its tab before it creates
   the frame. The frame must claim that secret from inside the same tab before
   it accepts any instructions. Web pages can't call these APIs, so a page that
   embeds preview.html itself gets a frame that never does anything. */

async function registerFrame(sid, tabId) {
  if (typeof sid !== 'string' || !/^[0-9a-f]{32}$/.test(sid)) return false;
  await chrome.storage.session.set({ ['frame:' + sid]: { tabId, t: Date.now() } });
  return true;
}

async function claimFrame(sid, tabId) {
  if (typeof sid !== 'string' || !/^[0-9a-f]{32}$/.test(sid)) return false;
  const key = 'frame:' + sid;
  const got = await chrome.storage.session.get(key);
  const rec = got[key];
  if (!rec) return false;
  await chrome.storage.session.remove(key);
  return rec.tabId === tabId && Date.now() - rec.t < 5 * 60 * 1000;
}

/* ---------- Context menu ---------- */

function setupMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'ql-preview', title: 'Quick Look this link', contexts: ['link'], targetUrlPatterns: ALL_SITES });
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'ql-preview' || !tab || tab.id == null) return;
  const msg = { type: 'ql:preview-url', url: info.linkUrl };
  try {
    await chrome.tabs.sendMessage(tab.id, msg, { frameId: 0 });
  } catch (e) {
    // Not running here yet: the context-menu click grants activeTab, so inject now.
    try {
      await injectTab(tab.id);
      await chrome.tabs.sendMessage(tab.id, msg, { frameId: 0 });
    } catch (e2) { /* restricted page */ }
  }
});

/* ---------- Messages ---------- */

const fromExtensionPage = (sender) => typeof sender.url === 'string' && sender.url.startsWith(EXT_PREFIX) && !sender.url.startsWith(EXT_PREFIX + 'preview/');

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('ql:')) return;
  if (sender.id !== chrome.runtime.id) return;
  (async () => {
    switch (msg.type) {
      case 'ql:open': {
        const u = QLLinks.toURL(msg.url);
        if (!QLLinks.isWeb(u)) return { ok: false };
        if (msg.newWindow) {
          await chrome.windows.create({ url: u.href, incognito: !!(sender.tab && sender.tab.incognito) });
        } else {
          const props = { url: u.href, active: msg.active !== false };
          if (sender.tab) { props.index = sender.tab.index + 1; props.openerTabId = sender.tab.id; props.windowId = sender.tab.windowId; }
          await chrome.tabs.create(props);
        }
        return { ok: true };
      }
      case 'ql:register-frame':
        if (!sender.tab || sender.tab.id == null) return { ok: false };
        return { ok: await registerFrame(msg.sid, sender.tab.id) };
      case 'ql:claim-frame':
        if (!sender.tab || sender.tab.id == null || !String(sender.url || '').startsWith(EXT_PREFIX + 'preview/preview.html')) return { ok: false };
        return { ok: await claimFrame(msg.sid, sender.tab.id) };
      case 'ql:sync': {
        if (!fromExtensionPage(sender)) return { ok: false };
        const m = await syncRegistration();
        if (msg.inject) await injectIntoOpenTabs(m);
        return { ok: true, matches: m };
      }
      case 'ql:enable-site': {
        // From the popup, after Chrome granted this origin.
        if (!fromExtensionPage(sender) || typeof msg.origin !== 'string' || !/^https?:\/\/[^/*]+\/\*$/.test(msg.origin)) return { ok: false };
        const has = await chrome.permissions.contains({ origins: [msg.origin] });
        if (!has) return { ok: false };
        const { enabledSites } = await chrome.storage.local.get({ enabledSites: [] });
        const next = Array.from(new Set((enabledSites || []).concat([msg.origin])));
        await chrome.storage.local.set({ enabledSites: next });
        await syncRegistration();
        await injectIntoOpenTabs([msg.origin]);
        return { ok: true };
      }
      case 'ql:disable-site': {
        if (!fromExtensionPage(sender) || typeof msg.origin !== 'string') return { ok: false };
        const { enabledSites } = await chrome.storage.local.get({ enabledSites: [] });
        await chrome.storage.local.set({ enabledSites: (enabledSites || []).filter((p) => p !== msg.origin) });
        await syncRegistration();
        return { ok: true };
      }
      default:
        return { ok: false };
    }
  })().then(sendResponse, (e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
  return true;
});

/* ---------- Lifecycle ---------- */

chrome.runtime.onInstalled.addListener(async (details) => {
  setupMenu();
  await syncRules().catch(() => {});
  const m = await syncRegistration().catch(() => []);
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome/welcome.html') });
  } else if (details.reason === 'update') {
    // Content scripts in open tabs were orphaned by the update: replace them.
    await injectIntoOpenTabs(m);
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await syncRules().catch(() => {});
  await syncRegistration().catch(() => {});
});

chrome.permissions.onAdded.addListener(async (p) => {
  await syncRules().catch(() => {});
  const m = await syncRegistration().catch(() => []);
  // Only a switch to "every website" injects everywhere; approving a preview
  // source doesn't turn Space on for that site.
  if (p.origins && isAllSites(p.origins)) await injectIntoOpenTabs(m);
});

chrome.permissions.onRemoved.addListener(async () => {
  await syncRegistration().catch(() => {});
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && (changes.cookieSites || changes.forceLive)) syncRules().catch(() => {});
});
