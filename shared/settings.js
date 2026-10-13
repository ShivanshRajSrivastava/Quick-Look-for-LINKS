/* ‘Quick Look’ for LINKS — shared settings. Loaded by the background worker, content script,
   preview frame, popup, options and welcome pages. No network, no globals
   beyond the QLSettings namespace. */
(function (root) {
  'use strict';

  const DEFAULTS = Object.freeze({
    // Keyboard
    trigger: 'space',            // 'space' (Quick Look) | 'ctrl-space' (PowerToys Peek)
    arrows: 'similar',           // 'similar' links (smart) | 'all' links on the page
    // Look
    theme: 'system',             // 'system' | 'light' | 'dark'
    size: 'standard',            // 'standard' | 'large'
    readerFont: 'system',        // 'system' | 'serif'
    // Behaviour
    preferMode: 'live',          // 'live' page first, or 'reader' first
    forceLive: true,             // show the live page even when a site blocks embedding
    explainButtons: true,        // Space on a button: explain instead of scrolling
    hoverHint: true,
    closeOnOutsideClick: true,
    timeoutSec: 8,
    // Developer test mode (see content.js). Never on for normal use.
    testMode: false,
    testAutoSteps: 0,
    testDwellMs: 2500,
    // Safety & privacy
    refuseRisky: true,
    cookieSites: [],             // hostnames allowed to use your cookies in previews
    offSites: [],                // hostnames where the extension is completely off
    disabledSites: [             // hostnames where Space keeps its normal job (Shift+Space still previews)
      'docs.google.com',
      'youtube.com',
      'meet.google.com',
      'figma.com',
      'netflix.com',
      'twitch.tv',
      'primevideo.com',
      'colab.research.google.com',
      'codepen.io',
      'codesandbox.io',
      'replit.com',
      'vscode.dev',
      'github.dev'
    ]
  });

  const LOCAL_DEFAULTS = Object.freeze({
    hintShown: 0,                // how many times the hover hint has appeared
    coachShown: 0,               // how many times the keyboard coach-mark appeared
    panelSize: null,             // {w, h} after the user resizes the panel
    stats: null                  // local-only usage receipts, never sent anywhere
  });

  const HINT_LIMIT = 5;
  const COACH_LIMIT = 3;

  function normalizeHost(h) {
    return String(h || '').trim().toLowerCase()
      .replace(/^[a-z]+:\/\//, '')
      .replace(/\/.*$/, '')
      .replace(/:\d+$/, '')
      .replace(/^www\./, '');
  }

  /* True when `host` equals an entry or is a subdomain of it. */
  function hostMatches(host, list) {
    const h = normalizeHost(host);
    if (!h || !Array.isArray(list)) return false;
    return list.some((entry) => {
      const e = normalizeHost(entry);
      return e && (h === e || h.endsWith('.' + e));
    });
  }

  async function get() {
    try {
      const s = await chrome.storage.sync.get(DEFAULTS);
      return Object.assign({}, DEFAULTS, s);
    } catch (e) {
      return Object.assign({}, DEFAULTS);
    }
  }

  async function set(patch) {
    await chrome.storage.sync.set(patch);
  }

  async function getLocal() {
    try {
      const s = await chrome.storage.local.get(LOCAL_DEFAULTS);
      return Object.assign({}, LOCAL_DEFAULTS, s);
    } catch (e) {
      return Object.assign({}, LOCAL_DEFAULTS);
    }
  }

  async function setLocal(patch) {
    try { await chrome.storage.local.set(patch); } catch (e) { /* ignore */ }
  }

  function platform() {
    const p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    if (/mac/i.test(p)) return 'mac';
    if (/win/i.test(p)) return 'win';
    if (/cros/i.test(p)) return 'chromeos';
    return 'linux';
  }

  /* Human key labels for the current platform. */
  function keyLabels() {
    const mac = platform() === 'mac';
    return {
      alt: mac ? '⌥' : 'Alt',
      mod: mac ? '⌘' : 'Ctrl',
      ctrl: mac ? '⌃' : 'Ctrl',
      enter: mac ? '↩' : 'Enter',
      space: 'Space',
      mac
    };
  }

  root.QLSettings = {
    DEFAULTS, LOCAL_DEFAULTS, HINT_LIMIT, COACH_LIMIT,
    get, set, getLocal, setLocal, normalizeHost, hostMatches, platform, keyLabels
  };
})(globalThis);
