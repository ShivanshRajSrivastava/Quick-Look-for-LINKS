/* ‘Quick Look’ for LINKS — page understanding: metadata, page dates, embedding policy,
   reader extraction and a strict allow-list sanitizer.
   Runs inside the extension frame, which has no inline-script privileges, so
   even if something slipped through the sanitizer it could not execute. */
(function (root) {
  'use strict';

  const L = root.QLLinks;

  /* ---------- Decoding ---------- */

  function charsetFrom(contentType, bytes) {
    const m = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType || '');
    if (m) return m[1];
    // Sniff <meta charset> in the first 4 KB
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4096));
    const mm = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head);
    return mm ? mm[1] : 'utf-8';
  }

  function decode(bytes, contentType) {
    let cs = charsetFrom(contentType, bytes).toLowerCase();
    if (cs === 'iso-8859-1' || cs === 'latin1' || cs === 'ascii' || cs === 'us-ascii') cs = 'windows-1252';
    try { return new TextDecoder(cs).decode(bytes); } catch (e) { return new TextDecoder('utf-8').decode(bytes); }
  }

  /* ---------- Embedding policy ---------- */

  /* Can this response be shown in a frame? Mirrors Chrome's own rules:
     CSP frame-ancestors wins over X-Frame-Options when present.
     Any frame-ancestors directive counts as a refusal here, even "*": the
     wildcard only matches http(s) ancestors, and a preview frame's parent is
     the extension itself, so Chrome blocks it (found in testing). */
  function frameability(headers) {
    const csp = headers.get('content-security-policy');
    if (csp) {
      for (const policy of csp.split(',')) {
        const dir = policy.split(';').map((s) => s.trim()).find((d) => /^frame-ancestors(\s|$)/i.test(d));
        if (dir) return { ok: false, reason: 'csp', detail: dir.length > 140 ? dir.slice(0, 140) + '…' : dir };
      }
    }
    const xfo = headers.get('x-frame-options');
    if (xfo && /\b(deny|sameorigin)\b/i.test(xfo)) return { ok: false, reason: 'xfo', detail: 'X-Frame-Options: ' + xfo.trim() };
    return { ok: true, reason: 'none' };
  }

  /* ---------- Metadata ---------- */

  function abs(u, base) {
    if (!u) return null;
    try {
      const x = new URL(u.trim(), base);
      return (x.protocol === 'http:' || x.protocol === 'https:' || x.protocol === 'data:') ? x.href : null;
    } catch (e) { return null; }
  }

  function metaContent(doc, selectors) {
    for (const sel of selectors) {
      const el = doc.querySelector(sel);
      const v = el && (el.getAttribute('content') || el.getAttribute('value') || el.getAttribute('datetime'));
      if (v && v.trim()) return v.trim();
    }
    return null;
  }

  function jsonLd(doc) {
    const out = [];
    for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(s.textContent);
        const walk = (o, depth) => {
          if (!o || typeof o !== 'object' || depth > 5) return;
          if (Array.isArray(o)) { o.forEach((x) => walk(x, depth + 1)); return; }
          out.push(o);
          if (o['@graph']) walk(o['@graph'], depth + 1);
          if (o.mainEntity) walk(o.mainEntity, depth + 1);
        };
        walk(data, 0);
      } catch (e) { /* bad JSON-LD is common */ }
    }
    return out;
  }

  function validDate(v) {
    if (!v) return null;
    let s = String(v).trim();
    if (/^\d{10}$/.test(s)) s = Number(s) * 1000;
    else if (/^\d{13}$/.test(s)) s = Number(s);
    const d = new Date(s);
    if (isNaN(d)) return null;
    const t = d.getTime();
    if (t < Date.UTC(1991, 0, 1) || t > Date.now() + 2 * 864e5) return null;
    return d;
  }

  const TEXT_DATE_RE = /\b(Published(?:\s+Date)?|Posted(?:\s+on)?|Updated(?:\s+on)?|Last\s+(?:updated|modified|reviewed)(?:\s+on)?|Modified|Date)\s*[:\-–]?\s*((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{4}|\d{4}-\d{2}-\d{2})/i;

  function extractDates(doc, ld, headers) {
    let published = null, modified = null, source = null;
    for (const o of ld) {
      if (!published) published = validDate(o.datePublished || o.dateCreated || o.uploadDate);
      if (!modified) modified = validDate(o.dateModified);
    }
    if (published || modified) source = 'structured data';
    if (!published) {
      published = validDate(metaContent(doc, [
        'meta[property="article:published_time"]', 'meta[name="article:published_time"]',
        'meta[property="og:published_time"]', 'meta[itemprop="datePublished"]', '[itemprop="datePublished"][datetime]',
        'meta[name="pubdate"]', 'meta[name="publishdate"]', 'meta[name="publish-date"]', 'meta[name="publish_date"]',
        'meta[name="date"]', 'meta[name="DC.date.issued"]', 'meta[name="dc.date"]', 'meta[name="DC.date"]',
        'meta[name="dcterms.date"]', 'meta[name="sailthru.date"]', 'meta[name="parsely-pub-date"]', 'meta[name="citation_publication_date"]'
      ]));
      if (published) source = source || 'page metadata';
    }
    if (!modified) {
      modified = validDate(metaContent(doc, [
        'meta[property="article:modified_time"]', 'meta[property="og:updated_time"]', 'meta[itemprop="dateModified"]',
        '[itemprop="dateModified"][datetime]', 'meta[name="last-modified"]', 'meta[name="dcterms.modified"]'
      ]));
      if (modified) source = source || 'page metadata';
    }
    if (!published) {
      const t = doc.querySelector('article time[datetime], main time[datetime], header time[datetime], time[pubdate][datetime], time[datetime]');
      if (t) { published = validDate(t.getAttribute('datetime')); if (published) source = source || 'page'; }
    }
    if (!published && !modified && doc.body) {
      const text = (doc.body.textContent || '').slice(0, 60000);
      const m = TEXT_DATE_RE.exec(text);
      if (m) {
        const d = validDate(m[2]);
        if (d) {
          if (/updat|modif|review/i.test(m[1])) modified = d; else published = d;
          source = 'page text';
        }
      }
    }
    if (!published && !modified && headers) {
      // Server Last-Modified is only meaningful for static pages: ignore "just now".
      const lm = validDate(headers.get('last-modified'));
      if (lm && Date.now() - lm.getTime() > 3 * 864e5) { modified = lm; source = 'server'; }
    }
    if (published && modified && Math.abs(modified - published) < 864e5) modified = null;
    return { published, modified, source };
  }

  function pickIcon(doc, base) {
    const links = Array.from(doc.querySelectorAll('link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"], link[rel="apple-touch-icon-precomposed"], link[rel="mask-icon"]'));
    let best = null, bestScore = -1;
    for (const l of links) {
      const href = abs(l.getAttribute('href'), base);
      if (!href) continue;
      const rel = (l.getAttribute('rel') || '').toLowerCase();
      if (rel === 'mask-icon') continue;
      const size = parseInt(((l.getAttribute('sizes') || '').match(/(\d+)/) || [0, 0])[1], 10) || (rel.includes('apple') ? 180 : 16);
      const score = (size >= 32 && size <= 192 ? 200 - Math.abs(64 - size) : size) + (/\.svg($|\?)/.test(href) ? 50 : 0);
      if (score > bestScore) { best = href; bestScore = score; }
    }
    if (!best) { try { best = new URL('/favicon.ico', base).href; } catch (e) { /* ignore */ } }
    return best;
  }

  function extractMeta(doc, url, headers) {
    const ld = jsonLd(doc);
    const og = (p) => metaContent(doc, ['meta[property="og:' + p + '"]', 'meta[name="og:' + p + '"]']);
    const tw = (p) => metaContent(doc, ['meta[name="twitter:' + p + '"]', 'meta[property="twitter:' + p + '"]']);
    const docTitle = (doc.querySelector('title') && doc.querySelector('title').textContent || '').replace(/\s+/g, ' ').trim();
    const h1 = doc.querySelector('h1');
    let title = og('title') || tw('title') || docTitle || (h1 && h1.textContent.trim()) || '';
    const site = og('site_name') || metaContent(doc, ['meta[name="application-name"]', 'meta[name="apple-mobile-web-app-title"]']) || L.hostLabel(url);
    let author = metaContent(doc, ['meta[name="author"]', 'meta[property="article:author"]', 'meta[name="parsely-author"]', 'meta[name="sailthru.author"]']);
    if (author && /^https?:/i.test(author)) author = null;
    if (!author) {
      for (const o of ld) {
        const a = o.author;
        if (!a) continue;
        const name = Array.isArray(a) ? a.map((x) => x && (x.name || x)).filter((x) => typeof x === 'string').join(', ') : (a.name || (typeof a === 'string' ? a : null));
        if (name) { author = name; break; }
      }
    }
    let image = og('image:secure_url') || og('image') || tw('image') || tw('image:src') ||
      (doc.querySelector('link[rel="image_src"]') && doc.querySelector('link[rel="image_src"]').getAttribute('href'));
    if (!image) {
      for (const o of ld) {
        const im = o.image || o.thumbnailUrl;
        const v = Array.isArray(im) ? im[0] : im;
        const s = v && (typeof v === 'string' ? v : v.url);
        if (s) { image = s; break; }
      }
    }
    const description = og('description') || tw('description') || metaContent(doc, ['meta[name="description"]', 'meta[itemprop="description"]']) || '';
    const themeColor = metaContent(doc, ['meta[name="theme-color"]:not([media])', 'meta[name="theme-color"]']);
    // No declared site name: "Article title | Site Name" usually carries one.
    let siteName = site;
    if (!og('site_name')) {
      const m = /^(.{8,}?)\s+[|–—·]\s+([^|–—·]{2,32})$/.exec(title);
      if (m) { title = m[1].trim(); siteName = m[2].trim(); }
      else {
        // "Quick Look - Wikipedia": a dash suffix that matches the host name.
        const d = /^(.{8,}?)\s+-\s+([^-]{2,32})$/.exec(title);
        const host = L.hostLabel(url).replace(/[^a-z0-9]/gi, '').toLowerCase();
        if (d && host.includes(d[2].replace(/[^a-z0-9]/gi, '').toLowerCase())) { title = d[1].trim(); siteName = d[2].trim(); }
      }
    }
    // Strip " | Site" / " - Site" suffixes from titles when the site name is shown separately.
    if (site && title.length > site.length + 3) {
      const esc = site.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      title = title.replace(new RegExp('\\s+[|\\-–—·:]\\s+' + esc + '$', 'i'), '').trim();
    }
    return {
      title: title.slice(0, 300),
      site: String(siteName).slice(0, 80),
      description: description.replace(/\s+/g, ' ').trim().slice(0, 600),
      image: abs(image, url),
      icon: pickIcon(doc, url),
      themeColor: themeColor && /^#[0-9a-f]{3,8}$|^rgb/i.test(themeColor) ? themeColor : null,
      author: author ? String(author).slice(0, 120) : null,
      type: og('type') || null,
      lang: (doc.documentElement.getAttribute('lang') || '').slice(0, 12),
      dates: extractDates(doc, ld, headers)
    };
  }

  /* ---------- Reader extraction ---------- */

  const LAZY_ATTRS = ['data-src', 'data-lazy-src', 'data-original', 'data-url', 'data-hi-res-src', 'data-actualsrc', 'data-lazy', 'data-full-src', 'data-orig-file', 'data-large-file'];
  const LAZY_SRCSET = ['data-srcset', 'data-lazy-srcset', 'data-original-set'];

  function isPlaceholder(src) {
    return !src || /^data:image\/(gif|png|svg)/i.test(src) || /(spacer|blank|placeholder|pixel|transparent|lazy)[^/]*\.(gif|png|svg)/i.test(src) || /1x1/.test(src);
  }

  /* Promote lazy-loading attributes so images survive outside the original page. */
  function fixLazyMedia(doc) {
    for (const img of doc.querySelectorAll('img')) {
      const src = img.getAttribute('src');
      if (isPlaceholder(src)) {
        for (const a of LAZY_ATTRS) {
          const v = img.getAttribute(a);
          if (v && !/^data:/.test(v)) { img.setAttribute('src', v); break; }
        }
      }
      if (!img.getAttribute('srcset')) {
        for (const a of LAZY_SRCSET) {
          const v = img.getAttribute(a);
          if (v) { img.setAttribute('srcset', v); break; }
        }
      }
      img.removeAttribute('loading');
    }
    for (const s of doc.querySelectorAll('source')) {
      if (!s.getAttribute('srcset')) {
        for (const a of LAZY_SRCSET) { const v = s.getAttribute(a); if (v) { s.setAttribute('srcset', v); break; } }
      }
    }
  }

  /* Make sure relative URLs resolve against the page, not against the extension.
     Without this, every image in a reader preview points at chrome-extension://. */
  function setBase(doc, url) {
    let base = doc.querySelector('base[href]');
    let baseHref = url;
    if (base) {
      try { baseHref = new URL(base.getAttribute('href'), url).href; } catch (e) { baseHref = url; }
      base.setAttribute('href', baseHref);
    } else {
      base = doc.createElement('base');
      base.setAttribute('href', url);
      (doc.head || doc.documentElement).prepend(base);
    }
    return baseHref;
  }

  /* Site adapters: pages where we know exactly where the content lives. */
  function adapterContent(doc, url) {
    const gh = L.github(url);
    if (gh) {
      const ogt = (doc.querySelector('meta[property="og:title"]') || {}).content || '';
      const m = /^GitHub - ([^:]+?)(?::\s*(.*))?$/.exec(ogt);
      const extras = [];
      const stars = doc.querySelector('#repo-stars-counter-star');
      if (stars) {
        const n = (stars.getAttribute('title') || stars.textContent || '').trim();
        if (n) extras.push('★ ' + n);
      }
      const lang = doc.querySelector('[itemprop="programmingLanguage"], .BorderGrid .color-fg-default.text-bold.mr-1');
      if (lang && lang.textContent.trim().length < 30) extras.push(lang.textContent.trim());
      const md = doc.querySelector('article.markdown-body, .markdown-body.entry-content, #readme article');
      if (md && (gh.kind === 'repo' || gh.kind === 'tree' || gh.kind === 'blob')) {
        return { el: md, label: gh.kind === 'blob' ? 'File' : 'README', title: m ? m[1] : null, byline: m && m[2] ? m[2] : null, extras };
      }
      if (gh.kind === 'releases') {
        const rel = doc.querySelector('[data-test-selector="body-content"], .markdown-body');
        if (rel) return { el: rel, label: 'Release notes', extras };
      }
    }
    return null;
  }

  function wordCount(text) {
    const cjk = (text.match(/[぀-ヿ㐀-鿿가-힯]/g) || []).length;
    const words = (text.replace(/[぀-ヿ㐀-鿿가-힯]/g, ' ').match(/\S+/g) || []).length;
    return { words: words + Math.round(cjk / 2), minutes: Math.max(1, Math.round(words / 230 + cjk / 500)) };
  }

  function extractReader(doc, url, meta) {
    const base = setBase(doc, url);
    fixLazyMedia(doc);
    const adapter = adapterContent(doc, base);
    let contentEl = null, byline = null, title = meta.title, excerpt = null, label = null;
    let extras = [];
    if (adapter) {
      contentEl = adapter.el;
      label = adapter.label;
      if (adapter.title) title = adapter.title;
      if (adapter.byline) byline = adapter.byline;
      extras = adapter.extras || [];
    } else if (typeof root.Readability === 'function') {
      try {
        const clone = doc.cloneNode(true);
        const article = new root.Readability(clone, {
          charThreshold: 400,
          keepClasses: false,
          serializer: (el) => el
        }).parse();
        if (article && article.content) {
          contentEl = article.content;
          byline = article.byline || null;
          excerpt = article.excerpt || null;
          if (article.title && article.title.length > 3 && (!title || title.length > 140)) title = article.title;
          if (!meta.dates.published && article.publishedTime) {
            const d = validDate(article.publishedTime);
            if (d) meta.dates.published = d;
          }
        }
      } catch (e) { contentEl = null; }
    }
    if (!contentEl) return null;
    const text = (contentEl.textContent || '').replace(/\s+/g, ' ').trim();
    if (text.length < (adapter ? 40 : 450)) return null;
    const { words, minutes } = wordCount(text);
    return { title, byline: byline || meta.author, excerpt, label, extras, contentEl, base, words, minutes, textLength: text.length };
  }

  /* ---------- Sanitizer ---------- */

  const ALLOWED = new Set(['p', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
    'em', 'strong', 'b', 'i', 'u', 's', 'del', 'ins', 'sub', 'sup', 'br', 'hr', 'img', 'picture', 'source', 'figure',
    'figcaption', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col', 'dl', 'dt', 'dd',
    'span', 'div', 'section', 'article', 'aside', 'header', 'footer', 'main', 'small', 'mark', 'abbr', 'time', 'kbd', 'var', 'samp',
    'details', 'summary', 'cite', 'q', 'address', 'wbr']);
  const DROP = new Set(['script', 'style', 'noscript', 'template', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
    'form', 'input', 'button', 'select', 'textarea', 'option', 'link', 'meta', 'base', 'canvas', 'svg', 'math', 'video', 'audio',
    'track', 'map', 'area', 'dialog', 'portal', 'slot', 'head', 'title', 'nav']);
  const GLOBAL_ATTRS = ['title', 'lang', 'dir', 'id'];
  const TAG_ATTRS = {
    a: ['href'], img: ['src', 'srcset', 'alt', 'width', 'height', 'sizes'], source: ['srcset', 'media', 'type', 'sizes'],
    td: ['colspan', 'rowspan', 'align'], th: ['colspan', 'rowspan', 'align', 'scope'], col: ['span'], colgroup: ['span'],
    ol: ['start', 'type', 'reversed'], li: ['value'], time: ['datetime'], details: ['open'], abbr: ['title'], q: ['cite'], blockquote: ['cite']
  };

  function safeUrl(v, base, kind) {
    if (!v) return null;
    const t = v.trim();
    if (kind === 'img' && /^data:image\/(png|jpe?g|gif|webp|avif)[;,]/i.test(t)) return t.length < 200000 ? t : null;
    try {
      const u = new URL(t, base);
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
      if (kind === 'link' && u.protocol === 'mailto:') return u.href;
    } catch (e) { /* ignore */ }
    return null;
  }

  function safeSrcset(v, base) {
    return v.split(/,(?=\s*\S)/).map((part) => {
      const [u, ...desc] = part.trim().split(/\s+/);
      const su = safeUrl(u, base, 'img');
      return su && !su.startsWith('data:') ? [su].concat(desc).join(' ') : null;
    }).filter(Boolean).join(', ');
  }

  /* Rebuild `src` (a node from a parsed foreign document) into `doc`,
     keeping only allow-listed elements and attributes. */
  function sanitize(src, doc, base) {
    const frag = doc.createDocumentFragment();
    let budget = 30000;
    const walk = (node, out, depth) => {
      if (--budget < 0 || depth > 60) return;
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 3) { out.append(doc.createTextNode(child.nodeValue)); continue; }
        if (child.nodeType !== 1) continue;
        const tag = child.localName;
        if (tag === 'iframe') {
          const embedSrc = child.getAttribute('src') || child.getAttribute('data-src');
          const yt = embedSrc && L.youtube(safeUrl(embedSrc, base, 'link') || '');
          if (yt && yt.id) {
            const p = doc.createElement('p');
            p.className = 'g-embed';
            const a = doc.createElement('a');
            a.href = 'https://www.youtube.com/watch?v=' + yt.id;
            a.textContent = '▶ Video on YouTube';
            p.append(a);
            out.append(p);
          }
          continue;
        }
        if (DROP.has(tag)) continue;
        if (!ALLOWED.has(tag)) { walk(child, out, depth + 1); continue; }
        const el = doc.createElement(tag);
        for (const name of GLOBAL_ATTRS.concat(TAG_ATTRS[tag] || [])) {
          const v = child.getAttribute(name);
          if (v == null) continue;
          if (name === 'id') { if (/^[\w:.-]{1,80}$/.test(v)) el.setAttribute('id', 'g-' + v); }
          else if (name === 'href') {
            const u = safeUrl(v, base, 'link');
            if (u) {
              el.setAttribute('href', u);
              // In-page links (tables of contents, footnotes) scroll the preview instead of opening a tab.
              const hash = u.indexOf('#');
              if (hash > 0 && u.slice(0, hash) === String(base).split('#')[0]) el.setAttribute('data-anchor', u.slice(hash + 1));
            }
          }
          else if (name === 'src') { const u = safeUrl(v, base, 'img'); if (u) el.setAttribute('src', u); }
          else if (name === 'srcset') { const s = safeSrcset(v, base); if (s) el.setAttribute('srcset', s); }
          else if (name === 'cite') { const u = safeUrl(v, base, 'link'); if (u) el.setAttribute('cite', u); }
          else el.setAttribute(name, v.slice(0, 500));
        }
        if (tag === 'img') {
          if (!el.getAttribute('src') && !el.getAttribute('srcset')) continue;
          el.setAttribute('loading', 'lazy');
          el.setAttribute('decoding', 'async');
          el.setAttribute('referrerpolicy', 'no-referrer');
        }
        if (tag === 'a') {
          if (!el.getAttribute('href')) { walk(child, out, depth + 1); continue; }
          el.setAttribute('rel', 'noopener noreferrer');
          el.setAttribute('target', '_blank');
        }
        if (tag === 'table') {
          const wrap = doc.createElement('div');
          wrap.className = 'g-table';
          wrap.append(el);
          out.append(wrap);
        } else {
          out.append(el);
        }
        walk(child, el, depth + 1);
      }
    };
    walk(src, frag, 0);
    return frag;
  }

  /* Remove empty wrappers and leading duplicates of the title. */
  function tidy(frag, title, byline) {
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const t = norm(title);
    const firstHeading = frag.querySelector('h1, h2');
    if (firstHeading && t && norm(firstHeading.textContent) === t) firstHeading.remove();
    // Bylines repeated in the body ("By Jane Doe") when the header already shows them.
    const b = norm(byline).replace(/^by\s+/, '');
    if (b) {
      const early = Array.from(frag.querySelectorAll('p, div, span')).slice(0, 6);
      for (const el of early) {
        const txt = norm(el.textContent).replace(/^by\s+/, '');
        if (txt === b && !el.querySelector('img')) { el.remove(); break; }
      }
    }
    // Common boilerplate that survives extraction (version pickers, skip links, share prompts).
    const JUNK = /^(select version:?|modifying this control will update this page automatically\.?|skip to (main )?content|advertisement|share (this|on).{0,20}|sign up for (our|the) newsletter.{0,40}|table of contents|was this (page|article) helpful\??.{0,40}|copy link|print)$/i;
    for (const el of Array.from(frag.querySelectorAll('section, p, div, span, li, label, legend, h2, h3, h4'))) {
      // (Inside a fragment nothing is "connected", so check membership instead.)
      if (!frag.contains(el) || el.querySelector('img, picture, table, pre')) continue;
      const t = el.textContent.replace(/\s+/g, ' ').trim();
      if ((t.length <= 80 && JUNK.test(t)) || (t.length <= 200 && /modifying this control will update this page automatically/i.test(t))) el.remove();
    }
    for (const el of Array.from(frag.querySelectorAll('div, span, section, p, figure, li'))) {
      if (!el.textContent.trim() && !el.querySelector('img, picture, hr, br, table')) el.remove();
    }
    return frag;
  }

  function relativeAge(date) {
    const diff = (Date.now() - date.getTime()) / 1000;
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
    const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
    for (const [unit, secs] of units) {
      if (Math.abs(diff) >= secs) return rtf.format(-Math.round(diff / secs), unit);
    }
    return 'just now';
  }

  function formatDate(date) {
    return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function formatBytes(n) {
    if (!(n >= 0)) return '';
    if (n < 1024) return n + ' bytes';
    const u = ['KB', 'MB', 'GB'];
    let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return (n >= 100 ? Math.round(n) : n.toFixed(1)) + ' ' + u[i];
  }

  root.QLExtract = { decode, frameability, extractMeta, extractReader, sanitize, tidy, relativeAge, formatDate, formatBytes, abs, validDate, setBase };
})(globalThis);
