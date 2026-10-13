/* ‘Quick Look’ for LINKS — link utilities shared by the content script and the preview frame.
   Pure functions only: URL unwrapping, risky-link detection, media detection. */
(function (root) {
  'use strict';

  /* ---------- URL helpers ---------- */

  function toURL(href, base) {
    try { return new URL(href, base || undefined); } catch (e) { return null; }
  }

  function isWeb(u) {
    return !!u && (u.protocol === 'http:' || u.protocol === 'https:');
  }

  /* Key used to de-duplicate links: no hash, no trailing slash, lower-case host. */
  function dedupeKey(href) {
    // Fast path for already-normalized absolute URLs (what a.href returns).
    if (typeof href === 'string' && /^https?:\/\/[^/?#]+/.test(href)) {
      let s = href;
      const h = s.indexOf('#');
      if (h >= 0) s = s.slice(0, h);
      const q = s.indexOf('?');
      const path = q >= 0 ? s.slice(0, q) : s;
      return path.replace(/\/+$/, '') + (q >= 0 ? s.slice(q) : '');
    }
    const u = toURL(href);
    if (!u) return String(href);
    u.hash = '';
    let s = u.protocol + '//' + u.host.toLowerCase() + u.pathname.replace(/\/+$/, '') + u.search;
    return s;
  }

  function b64urlDecode(s) {
    try {
      s = s.replace(/-/g, '+').replace(/_/g, '/');
      while (s.length % 4) s += '=';
      return decodeURIComponent(escape(atob(s)));
    } catch (e) { return null; }
  }

  /* Click-tracking redirectors we can safely see through. Unwrapping means the
     preview goes straight to the destination and the tracker never hears about it. */
  const REDIRECTORS = [
    { host: /(^|\.)google\.[a-z.]+$/, path: /^\/url$/, params: ['q', 'url'] },
    { host: /^l[m]?\.facebook\.com$/, path: /^\/l\.php$/, params: ['u'] },
    { host: /^l\.instagram\.com$/, path: /^\/$/, params: ['u'] },
    { host: /^out\.reddit\.com$/, path: /.*/, params: ['url'] },
    { host: /(^|\.)duckduckgo\.com$/, path: /^\/l\/?$/, params: ['uddg'] },
    { host: /(^|\.)youtube\.com$/, path: /^\/redirect$/, params: ['q'] },
    { host: /^slack-redir\.net$/, path: /^\/link$/, params: ['url'] },
    { host: /(^|\.)linkedin\.com$/, path: /^\/safety\/go\/?$/, params: ['url'] },
    { host: /^steamcommunity\.com$/, path: /^\/linkfilter\/?$/, params: ['url', 'u'] },
    { host: /^vk\.com$/, path: /^\/away\.php$/, params: ['to'] },
    { host: /^href\.li$/, path: /.*/, params: ['url'] },
    { host: /^exit\.sc$/, path: /.*/, params: ['url'] },
    { host: /^t\.umblr\.com$/, path: /^\/redirect$/, params: ['z'] },
    { host: /^disq\.us$/, path: /^\/url$/, params: ['url'], strip: /:[^:]*$/ }
  ];

  const REDIRECT_HINT = /^https?:\/\/([^/]*\.)?(google\.|facebook\.com|instagram\.com|reddit\.com|duckduckgo\.com|youtube\.com|slack-redir\.net|linkedin\.com|steamcommunity\.com|vk\.com|href\.li|exit\.sc|umblr\.com|disq\.us|bing\.com)/i;

  function unwrap(href) {
    if (typeof href === 'string' && !REDIRECT_HINT.test(href)) return href;
    let u = toURL(href);
    for (let hops = 0; u && hops < 3; hops++) {
      const host = u.hostname.toLowerCase();
      let next = null;
      for (const r of REDIRECTORS) {
        if (!r.host.test(host) || !r.path.test(u.pathname)) continue;
        for (const p of r.params) {
          let v = u.searchParams.get(p);
          if (!v) continue;
          if (r.strip) v = v.replace(r.strip, '');
          const cand = toURL(v);
          if (isWeb(cand)) { next = cand; break; }
        }
        if (next) break;
      }
      // Bing wraps results as /ck/a?...&u=a1<base64url(destination)>
      if (!next && /(^|\.)bing\.com$/.test(host) && u.pathname === '/ck/a') {
        const raw = u.searchParams.get('u');
        if (raw && raw.startsWith('a1')) {
          const cand = toURL(b64urlDecode(raw.slice(2)) || '');
          if (isWeb(cand)) next = cand;
        }
      }
      if (!next) break;
      u = next;
    }
    return u ? u.href : href;
  }

  /* ---------- Risky links ---------- */

  const VERBS = [
    'delete', 'destroy', 'remove', 'deactivate', 'revoke', 'disconnect', 'unlink',
    'uninstall', 'purge', 'terminate', 'cancel', 'unfollow', 'unwatch', 'trash', 'erase',
    'unsubscribe', 'unsub', 'optout', 'opt-out', 'logout', 'logoff', 'signout', 'signoff'
  ];
  const VERB_RE = VERBS.map((v) => v.replace('-', '[-_]?')).join('|');
  const SIGN_OUT_RE = /(^|[\/_\-.?=&])(log|sign)[-_ ]?(out|off)([\/_\-.?=&#]|$)/i;
  const UNSUB_RE = /(^|[\/_\-.?=&])(unsub(scribe)?|opt[-_]?out|email[-_]?preferences\/unsub)([\/_\-.?=&#]|$)/i;
  // A destructive verb as the whole path segment, or leading/trailing a short one
  // ("delete", "delete-account", "account_delete") — but not article slugs such as
  // "how-to-delete-your-facebook-account".
  const SEGMENT_RE = new RegExp('^(?:(?:' + VERB_RE + ')(?:[-_.][a-z0-9]+)?|[a-z0-9]+[-_.](?:' + VERB_RE + '))$', 'i');
  const ONE_TIME_PATH_RE = /(^|\/)(verify|verification|confirm|confirmation|activate|activation|magic[-_]?link|magic|reset[-_]?password|password[-_]?reset|invite|invitation|accept|approve|claim|redeem|one[-_]?click|login[-_]?link|auth\/email|email[-_]?login|passwordless)(\/|$|[-_])/i;
  function tokenish(str) {
    // Long random-looking strings: 20+ chars, several digits, not a hyphenated slug.
    return String(str).split(/[=&?\/]/).some((part) => part.length >= 20 &&
      /^[A-Za-z0-9_\-%.]+$/.test(part) && (part.match(/\d/g) || []).length >= 3 &&
      (part.match(/-/g) || []).length <= 4 && !/^[a-z]+(-[a-z]+)+$/i.test(part));
  }
  const ACTION_KEYS = ['action', 'do', 'op', 'cmd', 'task', 'mode', 'method', 'act', 'a'];
  const TEXT_RE = /^\s*((log|sign)\s?(out|off)|unsubscribe|opt\s?out|delete|remove|deactivate|disconnect|revoke|cancel\s+(my\s+)?(subscription|account|membership|order|plan)|close\s+(my\s+)?account|leave\s+(group|team|workspace|channel)|block|unfollow)\b/i;

  /**
   * Decide whether a link is safe to preview.
   * Returns { ok: true } or { ok: false, kind, reason }.
   * ctx: { text, method, download }
   */
  function assess(href, ctx) {
    ctx = ctx || {};
    const u = toURL(href);
    if (!u) return { ok: false, kind: 'invalid', reason: 'This link isn’t a valid web address.' };
    if (!isWeb(u)) {
      const scheme = u.protocol.replace(':', '');
      return { ok: false, kind: 'scheme', reason: 'Only web pages can be previewed, and this is a ' + scheme + ': link.' };
    }
    const method = String(ctx.method || '').trim().toLowerCase();
    if (method && method !== 'get') {
      return { ok: false, kind: 'action', reason: 'The site marks this link as a ' + method.toUpperCase() + ' action, so loading it could change something.' };
    }
    const path = decodeSafe(u.pathname);
    const query = decodeSafe(u.search);
    if (SIGN_OUT_RE.test(path) || SIGN_OUT_RE.test(query)) {
      return { ok: false, kind: 'signout', reason: 'It looks like a sign-out link. Some sites sign you out the moment the page loads.' };
    }
    if (UNSUB_RE.test(path) || UNSUB_RE.test(query)) {
      return { ok: false, kind: 'unsubscribe', reason: 'It looks like an unsubscribe link. Those usually act on a single visit, no click needed.' };
    }
    const segs = path.split('/').filter(Boolean);
    for (const seg of segs) {
      if (SEGMENT_RE.test(seg)) {
        return { ok: false, kind: 'destructive', reason: 'The address contains “' + seg + '”, which looks like an action rather than a page.' };
      }
    }
    for (const k of ACTION_KEYS) {
      const v = u.searchParams.get(k);
      if (v && new RegExp('^(' + VERB_RE + ')', 'i').test(v)) {
        return { ok: false, kind: 'destructive', reason: 'The address asks the site to “' + v + '”, which looks like an action rather than a page.' };
      }
    }
    for (const key of u.searchParams.keys()) {
      if (new RegExp('^(' + VERB_RE + ')$', 'i').test(key)) {
        return { ok: false, kind: 'destructive', reason: 'The address includes a “' + key + '” instruction, which looks like an action rather than a page.' };
      }
    }
    if (ONE_TIME_PATH_RE.test(path) && (tokenish(query) || segs.some(tokenish))) {
      return { ok: false, kind: 'onetime', reason: 'It looks like a one-time link (a sign-in, invite or confirmation). Previewing it could use it up.' };
    }
    const text = String(ctx.text || '').trim();
    if (text && text.length <= 40 && TEXT_RE.test(text)) {
      return { ok: false, kind: 'text', reason: 'The link is labelled “' + text.replace(/\s+/g, ' ') + '”, so it may act on a single visit.' };
    }
    return { ok: true };
  }

  function decodeSafe(s) {
    try { return decodeURIComponent(s); } catch (e) { return s; }
  }

  /* ---------- Media & special links ---------- */

  const EXT = {
    image: /\.(png|jpe?g|jfif|pjpeg|gif|webp|avif|apng|svg|bmp|ico|heic)$/i,
    video: /\.(mp4|m4v|webm|mov|ogv)$/i,
    audio: /\.(mp3|m4a|aac|wav|oga|ogg|opus|flac)$/i,
    pdf: /\.pdf$/i,
    file: /\.(zip|dmg|pkg|exe|msi|tar|gz|tgz|bz2|xz|7z|rar|iso|img|deb|rpm|apk|ipa|appimage|jar|bin|torrent|docx?|xlsx?|pptx?|key|numbers|pages|csv|epub|mobi)$/i
  };

  function extKind(href) {
    const u = toURL(href);
    if (!u) return null;
    const p = u.pathname;
    for (const k of Object.keys(EXT)) if (EXT[k].test(p)) return k;
    // Common image CDNs that hide the extension behind query params
    if (/(^|\.)(i\.imgur\.com|pbs\.twimg\.com|images\.unsplash\.com)$/.test(u.hostname) && /format=|fm=|\.(jpe?g|png)/.test(u.search + p)) return 'image';
    return null;
  }

  function parseTime(t) {
    if (!t) return 0;
    if (/^\d+$/.test(t)) return parseInt(t, 10);
    const m = String(t).match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/);
    if (!m) return 0;
    return (parseInt(m[1] || 0, 10) * 3600) + (parseInt(m[2] || 0, 10) * 60) + parseInt(m[3] || 0, 10);
  }

  function youtube(href) {
    const u = toURL(href);
    if (!u) return null;
    const h = u.hostname.replace(/^(www|m|music)\./, '');
    let id = null;
    if (h === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
    else if (h === 'youtube.com' || h === 'youtube-nocookie.com') {
      if (u.pathname === '/watch') id = u.searchParams.get('v');
      else {
        const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{6,})/);
        if (m) id = m[1];
        else if (u.pathname === '/playlist' && u.searchParams.get('list')) {
          return { playlist: u.searchParams.get('list'), start: 0 };
        }
      }
    } else return null;
    if (!id || !/^[A-Za-z0-9_-]{6,20}$/.test(id)) return null;
    return { id, start: parseTime(u.searchParams.get('t') || u.searchParams.get('start')), list: u.searchParams.get('list') || null, shorts: /^\/shorts\//.test(u.pathname) };
  }

  function vimeo(href) {
    const u = toURL(href);
    if (!u) return null;
    const h = u.hostname.replace(/^www\./, '');
    if (h !== 'vimeo.com' && h !== 'player.vimeo.com') return null;
    const m = u.pathname.match(/\/(?:video\/)?(\d{5,})(?:\/([0-9a-f]{6,}))?/);
    if (!m) return null;
    return { id: m[1], hash: m[2] || u.searchParams.get('h') || null };
  }

  function tweet(href) {
    const u = toURL(href);
    if (!u) return null;
    const h = u.hostname.replace(/^(www|mobile)\./, '');
    if (h !== 'twitter.com' && h !== 'x.com') return null;
    const m = u.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d+)/);
    return m ? { user: m[1], id: m[2] } : null;
  }

  function reddit(href) {
    const u = toURL(href);
    if (!u) return null;
    const h = u.hostname.replace(/^(www|old|new|np|m)\./, '');
    if (h !== 'reddit.com') return null;
    const m = u.pathname.match(/^\/r\/[^/]+\/comments\/([a-z0-9]+)/i);
    return m ? { id: m[1], path: u.pathname.replace(/\/+$/, '') } : null;
  }

  function github(href) {
    const u = toURL(href);
    if (!u || u.hostname !== 'github.com') return null;
    const segs = u.pathname.split('/').filter(Boolean);
    if (segs.length < 2) return null;
    const reserved = /^(about|blog|collections|contact|customer-stories|enterprise|events|explore|features|login|join|marketplace|new|notifications|orgs|organizations|pricing|pulls|issues|search|security|settings|site|sponsors|topics|trending|readme|codespaces|copilot|team|premium-support|apps|users)$/i;
    if (reserved.test(segs[0])) return null;
    const info = { owner: segs[0], repo: segs[1], kind: 'repo' };
    if (segs[2] === 'blob' && segs.length >= 5) { info.kind = 'blob'; info.ref = segs[3]; info.path = segs.slice(4).join('/'); }
    else if (segs[2] === 'tree') info.kind = 'tree';
    else if (segs[2] === 'issues' && segs[3]) info.kind = 'issue';
    else if (segs[2] === 'pull' && segs[3]) info.kind = 'pull';
    else if (segs[2] === 'releases') info.kind = 'releases';
    else if (segs.length > 2) info.kind = 'other';
    return info;
  }

  /* Sites whose pages turn into a sign-in wall when shown logged out in a frame.
     The extension doesn't force a live view for these; Summary or Reader is more useful. */
  const LOGIN_WALLED = /(^|\.)(instagram\.com|facebook\.com|fb\.com|messenger\.com|linkedin\.com|x\.com|twitter\.com|threads\.(net|com)|tiktok\.com|pinterest\.[a-z.]+|quora\.com|snapchat\.com|whatsapp\.com|discord\.com|accounts\.google\.com|mail\.google\.com|outlook\.(live|office)\.com|web\.telegram\.org)$/i;
  function loginWalled(href) {
    const u = toURL(href);
    return !!(u && LOGIN_WALLED.test(u.hostname));
  }

  function hostLabel(href) {
    const u = toURL(href);
    return u ? u.hostname.replace(/^www\./, '') : '';
  }

  root.QLLinks = { toURL, isWeb, dedupeKey, unwrap, assess, extKind, youtube, vimeo, tweet, reddit, github, hostLabel, parseTime, loginWalled };
})(globalThis);
