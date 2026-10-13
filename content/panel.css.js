/* ‘Quick Look’ for LINKS — styles for the panel, adopted into a closed shadow root.
   Kept in JS so it can be applied with a constructable stylesheet, which page
   Content-Security-Policy and Trusted Types cannot block. */
globalThis.QL_PANEL_CSS = `
:host { all: initial !important; }
* { box-sizing: border-box; }

.root {
  --font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", system-ui, Roboto, "Helvetica Neue", Arial, sans-serif;
  --accent: #0a84ff;
  --glass: rgba(246, 246, 248, 0.76);
  --glass-strong: rgba(250, 250, 252, 0.92);
  --hairline: rgba(0, 0, 0, 0.14);
  --highlight: rgba(255, 255, 255, 0.65);
  --text: #1d1d1f;
  --text-2: rgba(29, 29, 31, 0.62);
  --text-3: rgba(29, 29, 31, 0.42);
  --btn: rgba(0, 0, 0, 0.055);
  --btn-hover: rgba(0, 0, 0, 0.1);
  --btn-active: rgba(0, 0, 0, 0.16);
  --shadow: 0 0 0 0.5px rgba(0,0,0,0.18), 0 28px 70px rgba(0, 0, 0, 0.28), 0 10px 24px rgba(0, 0, 0, 0.14);
  --hint-bg: rgba(28, 28, 30, 0.86);
  --hint-text: #fff;
  color-scheme: light;
  font-family: var(--font);
  color: var(--text);
  -webkit-font-smoothing: antialiased;
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 2147483647;
  font-size: 13px;
  line-height: 1.35;
}
.root[data-theme="dark"] {
  --accent: #0a84ff;
  --glass: rgba(30, 30, 33, 0.84);
  --glass-strong: rgba(36, 36, 40, 0.95);
  --hairline: rgba(255, 255, 255, 0.14);
  --highlight: rgba(255, 255, 255, 0.10);
  --text: #f5f5f7;
  --text-2: rgba(245, 245, 247, 0.66);
  --text-3: rgba(245, 245, 247, 0.42);
  --btn: rgba(255, 255, 255, 0.08);
  --btn-hover: rgba(255, 255, 255, 0.14);
  --btn-active: rgba(255, 255, 255, 0.2);
  --shadow: 0 0 0 0.5px rgba(0,0,0,0.6), 0 28px 70px rgba(0, 0, 0, 0.55), 0 10px 24px rgba(0, 0, 0, 0.35);
  --hint-bg: rgba(242, 242, 247, 0.92);
  --hint-text: #1d1d1f;
  color-scheme: dark;
}

/* ---------- Panel ---------- */
.panel {
  position: fixed;
  left: 0; top: 0;
  width: 800px; height: 600px;
  display: none;
  flex-direction: column;
  pointer-events: auto;
  border-radius: 16px;
  background: var(--glass);
  -webkit-backdrop-filter: blur(40px) saturate(185%);
  backdrop-filter: blur(40px) saturate(185%);
  box-shadow: var(--shadow), inset 0 0.5px 0 var(--highlight);
  overflow: hidden;
  transform-origin: 0 0;
  will-change: transform, opacity;
  contain: layout style;
  outline: none;
}
.panel.open { display: flex; }
.panel.full { border-radius: 0; }
.panel.dragging, .panel.resizing { transition: none !important; user-select: none; }

/* ---------- Title bar ---------- */
.titlebar {
  flex: 0 0 auto;
  height: 42px;
  display: grid;
  grid-template-columns: minmax(max-content, 1fr) minmax(0, max-content) minmax(max-content, 1fr);
  align-items: center;
  gap: 8px;
  padding: 0 10px 0 12px;
  border-bottom: 0.5px solid var(--hairline);
  cursor: default;
  user-select: none;
  -webkit-user-select: none;
}
.tb-left, .tb-right { display: flex; align-items: center; gap: 6px; min-width: 0; }
.tb-right { justify-content: flex-end; }
.tb-center {
  display: flex; align-items: center; justify-content: center; gap: 7px; min-width: 0;
}
.favicon { width: 16px; height: 16px; flex: 0 0 16px; border-radius: 4px; }
.title-wrap { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.title {
  font-weight: 600; font-size: 13px; color: var(--text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0;
}
.site { font-size: 12px; color: var(--text-2); white-space: nowrap; flex: 0 0 auto; }
.site::before { content: "—"; margin-right: 6px; color: var(--text-3); }

.icon-btn {
  appearance: none; border: 0; margin: 0; padding: 0;
  width: 26px; height: 26px; border-radius: 50%;
  display: inline-grid; place-items: center;
  background: transparent; color: var(--text-2);
  cursor: default; flex: 0 0 auto;
  transition: background 120ms ease, color 120ms ease;
}
.icon-btn:hover { background: var(--btn-hover); color: var(--text); }
.icon-btn:active { background: var(--btn-active); }
.icon-btn svg { width: 14px; height: 14px; display: block; }
.icon-btn:focus-visible, .open-btn:focus-visible, .badge:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

.badge {
  appearance: none; border: 0; margin: 0;
  display: inline-flex; align-items: center; gap: 5px;
  height: 20px; padding: 0 8px 0 7px; border-radius: 10px;
  background: var(--btn); color: var(--text-2);
  font: 600 10.5px/1 var(--font); letter-spacing: 0.02em; text-transform: uppercase;
  white-space: nowrap; flex: 0 0 auto; cursor: default;
}
.badge:hover { background: var(--btn-hover); color: var(--text); }
.badge .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; opacity: 0.9; }
.badge[data-mode="live"] .dot { background: #30d158; }
.badge[data-mode="reader"] .dot { background: #0a84ff; }
.badge[data-mode="summary"] .dot { background: #bf5af2; }
.badge[data-mode="image"] .dot, .badge[data-mode="video"] .dot, .badge[data-mode="audio"] .dot { background: #ff375f; }
.badge[data-mode="pdf"] .dot { background: #ff453a; }
.badge[data-mode="text"] .dot, .badge[data-mode="file"] .dot { background: #8e8e93; }
.badge[data-mode="post"] .dot { background: #64d2ff; }
.badge[data-mode="refused"] .dot { background: #ff9f0a; }
.badge[data-mode="error"] .dot, .badge[data-mode="timeout"] .dot { background: #ff453a; }
.badge[data-mode="permission"] .dot { background: #ffd60a; }
.badge[data-mode="loading"] .dot, .badge.busy .dot { animation: pulse 1s ease-in-out infinite; }
.badge .chev { width: 8px; height: 8px; opacity: 0.6; display: none; }
.badge.switchable .chev { display: block; }

.counter {
  font-size: 12px; color: var(--text-3); font-variant-numeric: tabular-nums;
  white-space: nowrap; padding: 0 2px;
}
.open-btn {
  appearance: none; border: 0; margin: 0;
  height: 26px; padding: 0 11px; border-radius: 13px;
  background: var(--btn); color: var(--text);
  font: 500 12.5px/1 var(--font); white-space: nowrap;
  display: inline-flex; align-items: center; gap: 6px; cursor: default;
  transition: background 120ms ease;
}
.open-btn:hover { background: var(--btn-hover); }
.open-btn:active { background: var(--btn-active); }
.open-btn svg { width: 11px; height: 11px; }

/* ---------- Mode menu ---------- */
.menu {
  position: absolute; top: 40px; left: 50%; transform: translateX(-50%);
  min-width: 220px; padding: 5px;
  border-radius: 10px;
  background: var(--glass-strong);
  -webkit-backdrop-filter: blur(30px) saturate(180%);
  backdrop-filter: blur(30px) saturate(180%);
  box-shadow: var(--shadow);
  display: none; z-index: 5;
}
.menu.open { display: block; }
.menu button {
  appearance: none; border: 0; background: transparent; color: var(--text);
  width: 100%; display: flex; align-items: center; gap: 8px;
  padding: 6px 9px; border-radius: 6px; font: 13px/1.2 var(--font); text-align: left; cursor: default;
}
.menu button:hover:not([disabled]), .menu button.kb { background: var(--accent); color: #fff; }
.menu button[disabled] { color: var(--text-3); }
.menu .check { width: 12px; text-align: center; }
.menu .key { margin-left: auto; color: inherit; opacity: 0.55; font-size: 12px; }
.menu .desc { display: block; font-size: 11px; opacity: 0.7; margin-top: 1px; }

/* ---------- Body ---------- */
.body {
  position: relative; flex: 1 1 auto; min-height: 0;
}
.frame {
  position: absolute; inset: 0; width: 100%; height: 100%;
  border: 0; background: transparent; color-scheme: light;
  display: block;
}
.root[data-theme="dark"] .frame { color-scheme: dark; }
.loading {
  position: absolute; inset: 0; display: grid; place-items: center; pointer-events: none;
  opacity: 0; transition: opacity 160ms ease;
}
.loading.show { opacity: 1; transition-delay: 120ms; }
.spinner {
  width: 26px; height: 26px; border-radius: 50%;
  border: 2.5px solid var(--btn-active); border-top-color: var(--text-2);
  animation: spin 0.8s linear infinite;
}

.resize {
  position: absolute; right: 0; bottom: 0; width: 18px; height: 18px; cursor: nwse-resize; z-index: 3;
}
.panel.full .resize { display: none; }

/* ---------- Coach marks, toasts ---------- */
.coach, .toast {
  position: absolute; left: 50%; bottom: 16px; transform: translate(-50%, 8px);
  display: flex; align-items: center; gap: 10px;
  padding: 7px 12px; border-radius: 12px;
  background: var(--hint-bg); color: var(--hint-text);
  font: 500 12px/1 var(--font); white-space: nowrap;
  box-shadow: 0 8px 24px rgba(0,0,0,0.25);
  opacity: 0; pointer-events: none; z-index: 4;
  transition: opacity 200ms ease, transform 200ms ease;
}
.coach.show, .toast.show { opacity: 1; transform: translate(-50%, 0); }
.coach span { display: inline-flex; align-items: center; gap: 5px; opacity: 0.92; }
kbd {
  font: 600 11px/1 var(--font);
  min-width: 18px; height: 18px; padding: 0 5px;
  display: inline-grid; place-items: center;
  border-radius: 5px;
  background: rgba(127,127,127,0.28);
  box-shadow: inset 0 -1px 0 rgba(0,0,0,0.25);
}

/* ---------- Hover hint and link ring ---------- */
.hint {
  position: fixed; left: 0; top: 0;
  display: inline-flex; align-items: center; gap: 6px;
  padding: 5px 9px 5px 6px; border-radius: 9px;
  background: var(--hint-bg); color: var(--hint-text);
  -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
  font: 500 11.5px/1 var(--font); white-space: nowrap;
  box-shadow: 0 6px 18px rgba(0,0,0,0.22);
  opacity: 0; transform: translateY(4px);
  transition: opacity 180ms ease, transform 180ms ease;
  pointer-events: none;
}
.hint.show { opacity: 1; transform: translateY(0); }
.nudge { max-width: 330px; white-space: normal; line-height: 1.38; padding: 8px 11px; font-size: 12px; }
.ring {
  position: fixed; left: 0; top: 0; width: 0; height: 0;
  border-radius: 6px;
  box-shadow: 0 0 0 2px var(--accent), 0 0 0 5px color-mix(in srgb, var(--accent) 28%, transparent);
  opacity: 0; transition: opacity 150ms ease;
  pointer-events: none;
}
.ring.show { opacity: 1; }
.live { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

@keyframes spin { to { transform: rotate(360deg); } }
@keyframes pulse { 50% { opacity: 0.35; } }

@media (prefers-reduced-motion: reduce) {
  .hint, .ring, .coach, .toast, .loading { transition: none; }
  .spinner { animation-duration: 2s; }
}
`;
