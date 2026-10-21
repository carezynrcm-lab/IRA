// IRA client: a dependency-free single-page app.
//
// Speed comes from two ideas:
//  1. Stale-while-revalidate cache: every view renders instantly from cached data
//     and refreshes quietly in the background.
//  2. Optimistic mutations: book / reschedule / cancel / complete / add / save update
//     the UI immediately, then sync with the server, rolling back only if it fails.

// ---------------------------------------------------------------------------
// HTML helpers (auto-escaping template tag)
// ---------------------------------------------------------------------------
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
const raw = (s) => new Raw(s);
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
const val = (v) => (v == null || v === false ? '' : v instanceof Raw ? v.s : Array.isArray(v) ? v.map(val).join('') : esc(v));
const html = (strs, ...vals) => raw(strs.reduce((out, s, i) => out + val(vals[i - 1]) + s));

// ---------------------------------------------------------------------------
// Icons (Lucide-style strokes)
// ---------------------------------------------------------------------------
const ICONS = {
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  'calendar-plus': '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M12 14v4M10 16h4"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>',
  hospital: '<path d="M12 6v4M10 8h4"/><path d="M18 22V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v18"/><path d="M2 22h20M10 22v-4h4v4"/><path d="M6 12H4a2 2 0 0 0-2 2v8M18 12h2a2 2 0 0 1 2 2v8"/>',
  clipboard: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M9 12h6M9 16h4"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92Z"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
  'arrow-right': '<path d="M5 12h14M12 5l7 7-7 7"/>',
  'arrow-left': '<path d="m12 19-7-7 7-7M19 12H5"/>',
  'chev-left': '<path d="m15 18-6-6 6-6"/>',
  'chev-right': '<path d="m9 18 6-6-6-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  repeat: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M8 16H3v5"/>',
  trash: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  'check-circle': '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/>',
  'x-circle': '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/>',
  zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  sunrise: '<path d="M12 2v8M4.93 10.93l1.41 1.41M2 18h2M20 18h2M19.07 10.93l-1.41 1.41M22 22H2M8 6l4-4 4 4M16 18a4 4 0 0 0-8 0"/>',
};
const icon = (name, cls = 'i') => raw(`<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`);
const LOGO = raw('<svg viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0f9488"/><stop offset="1" stop-color="#4f46e5"/></linearGradient></defs><rect width="32" height="32" rx="9" fill="url(#lg)"/><path d="M13 8h6v5h5v6h-5v5h-6v-5H8v-6h5z" fill="#fff"/></svg>');
const LOGO_LIGHT = raw('<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="9" fill="rgba(255,255,255,.22)"/><path d="M13 8h6v5h5v6h-5v5h-6v-5H8v-6h5z" fill="#fff"/></svg>');

// ---------------------------------------------------------------------------
// Date & misc helpers (local time, YYYY-MM-DD / HH:MM strings like the server)
// ---------------------------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseD = (s) => new Date(`${s}T00:00:00`);
const today = () => ymd(new Date());
const nowHM = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const addDays = (s, n) => { const d = parseD(s); d.setDate(d.getDate() + n); return ymd(d); };
const fmtDate = (s, long = false) => parseD(s).toLocaleDateString(undefined,
  long ? { weekday: 'long', day: 'numeric', month: 'long' } : { weekday: 'short', day: 'numeric', month: 'short' });
const fmtTime = (t) => { const [h, m] = t.split(':').map(Number); return `${h % 12 || 12}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`; };
const monShort = (s) => parseD(s).toLocaleDateString(undefined, { month: 'short' });
const ago = (ms) => {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
};
function countdown(a) {
  const days = Math.round((parseD(a.date) - parseD(today())) / 86400000);
  if (days === 0) {
    const [h, m] = a.time.split(':').map(Number);
    const mins = h * 60 + m - (new Date().getHours() * 60 + new Date().getMinutes());
    return mins <= 60 ? `In ${Math.max(mins, 0)} min` : `Today · in ${Math.round(mins / 60)} h`;
  }
  return days === 1 ? 'Tomorrow' : `In ${days} days`;
}
const greeting = () => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; };
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEK = [1, 2, 3, 4, 5, 6, 0]; // Monday-first display order

const openDays = (h) => h.days_open.split(',').filter(Boolean).map(Number);
const isOpenOn = (h, d) => openDays(h).includes(parseD(d).getDay());
const isOpenNow = (h) => isOpenOn(h, today()) && nowHM() >= h.open_time && nowHM() < h.close_time;
const hoursLabel = (h) => `${fmtTime(h.open_time)} – ${fmtTime(h.close_time)}`;
function daysLabel(h) {
  const open = WEEK.map((d) => openDays(h).includes(d)); // Monday-first
  const n = open.filter(Boolean).length;
  if (!n) return 'Closed';
  if (n === 7) return 'Every day';
  // One contiguous run (wrapping around the week, e.g. Sun – Fri) reads as a range.
  const starts = open.flatMap((o, i) => (o && !open[(i + 6) % 7] ? [i] : []));
  if (starts.length === 1) {
    const s = starts[0];
    return n === 1 ? DOW[WEEK[s]] : `${DOW[WEEK[s]]} – ${DOW[WEEK[(s + n - 1) % 7]]}`;
  }
  return WEEK.filter((_, i) => open[i]).map((d) => DOW[d]).join(', ');
}
function firstOpenDate(h) {
  const t = today();
  for (let i = 0; i < 14; i++) {
    const d = addDays(t, i);
    if (isOpenOn(h, d) && !(i === 0 && nowHM() >= h.close_time)) return d;
  }
  return t;
}
function slotsPerDay(open, close, len) {
  const toM = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  return Math.max(0, Math.floor((toM(close) - toM(open)) / len));
}
const tags = (s) => (s || '').split(',').map((x) => x.trim()).filter(Boolean);
const slotsKey = (hid, d) => `/hospitals/${hid}/slots?date=${d}`;
function monthKey(month) {
  const [y, m] = month.split('-').map(Number);
  return `/appointments?from=${month}-01&to=${ymd(new Date(y, m, 0))}`;
}
const shiftMonth = (month, n) => { const [y, m] = month.split('-').map(Number); return ymd(new Date(y, m - 1 + n, 1)).slice(0, 7); };
const byWhen = (a, b) => (a.date + a.time).localeCompare(b.date + b.time);

const initials = (name = '?') => name.replace(/[^\p{L}\s]/gu, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
const hue = (s = '') => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
const avatar = (name, cls = '') => html`<span class="avatar ${cls}" style="--hue:${hue(name)}">${initials(name)}</span>`;
const td = (label, content, cls = '') => html`<td data-label="${label}" class="${cls}">${content}</td>`;

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function downloadCsv(filename, rows, columns) {
  const cell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [columns.map(([label]) => cell(label)).join(','), ...rows.map((r) => columns.map(([, get]) => cell(get(r))).join(','))];
  download(filename, `${lines.join('\n')}\n`, 'text/csv;charset=utf-8');
  toast(`Exported ${rows.length} row${rows.length === 1 ? '' : 's'}`, 'success');
}
function downloadIcs(a) {
  const stamp = (d, t) => `${d.replaceAll('-', '')}T${t.replace(':', '')}00`;
  const start = new Date(`${a.date}T${a.time}:00`);
  const end = new Date(start.getTime() + (a.slot_minutes || 30) * 60000);
  const icsText = (s) => String(s || '').replace(/[,;\\]/g, (c) => `\\${c}`).replace(/\n/g, '\\n');
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//IRA//EN', 'BEGIN:VEVENT',
    `UID:ira-${a.id}@ira`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`,
    `DTSTART:${stamp(a.date, a.time)}`, `DTEND:${stamp(ymd(end), `${pad(end.getHours())}:${pad(end.getMinutes())}`)}`,
    `SUMMARY:${icsText(`Appointment · ${a.hospital_name}`)}`, `LOCATION:${icsText(a.hospital_address || a.hospital_city)}`,
    `DESCRIPTION:${icsText(a.reason ? `Reason: ${a.reason}` : 'Booked with IRA')}`,
    'BEGIN:VALARM', 'TRIGGER:-PT1H', 'ACTION:DISPLAY', 'DESCRIPTION:Appointment reminder', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
  download(`appointment-${a.date}.ics`, ics, 'text/calendar');
}

const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------------------------------------------------------------------------
// State, session, API
// ---------------------------------------------------------------------------
const $app = document.getElementById('app');
const $modal = document.getElementById('modal-root');
const $toasts = document.getElementById('toasts');
const SESSION_KEY = 'ira.session';
const THEME_KEY = 'ira.theme';
const STALE_MS = 5000;

const state = {
  token: null,
  user: null,
  hospital: null,
  cache: new Map(),     // path -> { data, t, mutatedAt }
  inflight: new Map(),  // path -> Promise
  pending: new Map(),   // path -> number of optimistic mutations in flight
  renderKeys: new Set(),
  search: { hq: '', pq: '', aq: '', ahq: '' },
  adminHospitalFilter: '',
  pop: null,            // 'notif' | 'menu' | null
  confirm: null,
  modalView: null,      // function rendering the open modal's content (for live updates)
  resched: null,
  seen: {},
  enterUntil: 0,
  lastView: null,
  lastUnread: 0,
  justBooked: null,
};

function loadSession() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    if (s?.token) Object.assign(state, { token: s.token, user: s.user, hospital: s.hospital });
  } catch { /* storage unavailable */ }
}
function saveSession() {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify({ token: state.token, user: state.user, hospital: state.hospital })); } catch { /* ignore */ }
}
function clearSession() {
  Object.assign(state, { token: null, user: null, hospital: null, pop: null, lastView: null });
  state.cache.clear();
  try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
}

// Thin top progress bar while requests are in flight (only if they take >150ms).
let activeRequests = 0;
let progressTimer = null;
function trackRequest(delta) {
  activeRequests += delta;
  if (delta > 0 && activeRequests === 1) progressTimer = setTimeout(() => document.body.classList.add('loading'), 150);
  if (activeRequests === 0) { clearTimeout(progressTimer); document.body.classList.remove('loading'); }
}

async function api(method, path, body) {
  let res;
  trackRequest(1);
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('You appear to be offline. Please check your connection.');
  } finally {
    trackRequest(-1);
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (res.status === 401 && state.token && !path.startsWith('/auth/')) {
    clearSession();
    toast('Your session expired. Please sign in again.', 'error');
    go('/login');
  }
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

// ---------------------------------------------------------------------------
// Stale-while-revalidate cache
// ---------------------------------------------------------------------------
const peek = (path) => state.cache.get(path)?.data;

function get(path, seed) {
  state.renderKeys.add(path);
  let entry = state.cache.get(path);
  if (!entry && seed !== undefined) {
    entry = { data: seed, t: 0, mutatedAt: 0 };
    state.cache.set(path, entry);
  }
  if (!entry || Date.now() - entry.t > STALE_MS) revalidate(path);
  return entry?.data;
}

function setCache(path, data) {
  state.cache.set(path, { data, t: Date.now(), mutatedAt: performance.now() });
}

function mutate(path, fn) {
  const entry = state.cache.get(path);
  if (entry) setCache(path, fn(entry.data));
}

function revalidate(path) {
  if (state.inflight.has(path) || state.pending.get(path)) return state.inflight.get(path);
  const startedAt = performance.now();
  const p = api('GET', path)
    .then((data) => {
      const prev = state.cache.get(path);
      // Ignore responses that would overwrite a newer optimistic change.
      if (state.pending.get(path) || (prev && prev.mutatedAt > startedAt)) return;
      const changed = !prev || JSON.stringify(prev.data) !== JSON.stringify(data);
      state.cache.set(path, { data, t: Date.now(), mutatedAt: prev?.mutatedAt ?? 0 });
      if (changed) onDataChange(path);
    })
    .catch((err) => { if (state.user) console.warn(path, err.message); })
    .finally(() => state.inflight.delete(path));
  state.inflight.set(path, p);
  return p;
}

const prefetch = (path) => { if (state.user && !state.cache.has(path)) revalidate(path); };
const refreshSoon = (paths, ms = 1800) => setTimeout(() => paths.forEach(revalidate), ms);
const invalidate = (prefix) => { for (const k of state.cache.keys()) if (k.startsWith(prefix)) state.cache.delete(k); };

function onDataChange(path) {
  if (path === '/notifications') return renderTop();
  if (state.renderKeys.has(path)) scheduleRender();
  if (state.modalView) renderModal();
}

// Apply a change locally right away, then confirm it with the server.
async function optimistic({ keys, apply, request, commit, onError }) {
  const snapshot = keys.map((k) => [k, state.cache.get(k)]);
  keys.forEach((k) => state.pending.set(k, (state.pending.get(k) || 0) + 1));
  apply();
  scheduleRender();
  try {
    const result = await request();
    commit?.(result);
  } catch (err) {
    for (const [k, entry] of snapshot) {
      if (entry) setCache(k, entry.data);
      else state.cache.delete(k);
    }
    toast(err.message, 'error');
    onError?.(err);
  } finally {
    keys.forEach((k) => state.pending.set(k, state.pending.get(k) - 1));
    keys.forEach((k) => revalidate(k));
    scheduleRender();
  }
}

// Returns true the first time a section shows a given key (used to animate changes once).
function fresh(slot, key) {
  const isNew = state.seen[slot] !== key;
  state.seen[slot] = key;
  return isNew;
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------
const effectiveTheme = () => document.documentElement.dataset.theme
  || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
const themeBtn = () => html`<button class="icon-btn theme-btn" data-action="theme" aria-label="Toggle dark mode" title="Toggle theme">
  ${effectiveTheme() === 'dark' ? icon('sun', 'sun') : icon('moon', 'moon')}</button>`;
function toggleTheme() {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem(THEME_KEY, next); } catch { /* ignore */ }
  document.querySelectorAll('.theme-btn').forEach((b) => { b.outerHTML = themeBtn().s; });
}

// ---------------------------------------------------------------------------
// Toasts, modals
// ---------------------------------------------------------------------------
function toast(message, type = '', action) {
  const life = type === 'error' ? 5000 : 3200;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.style.setProperty('--life', `${life}ms`);
  el.innerHTML = html`<span class="t-ico">${icon(type === 'error' ? 'alert' : type === 'success' ? 'check' : 'bell')}</span>
    <span>${message}</span>${action ? html`<button type="button">${action.label}</button>` : ''}`.s;
  const dismiss = () => { el.classList.add('out'); setTimeout(() => el.remove(), 250); };
  if (action) el.querySelector('button').addEventListener('click', () => { action.run(); dismiss(); });
  $toasts.append(el);
  while ($toasts.children.length > 3) $toasts.firstChild.remove();
  setTimeout(dismiss, life);
}

function openModal(content, { focus, cls = '', drawer = false, view = null } = {}) {
  state.modalView = view;
  $modal.innerHTML = html`<div class="backdrop ${drawer ? 'drawer' : ''}" data-action="backdrop">
    <div class="modal ${cls}" role="dialog" aria-modal="true">${content}</div></div>`.s;
  const target = focus ? $modal.querySelector(focus) : $modal.querySelector('input:not([type=hidden]), textarea, select');
  target?.focus({ preventScroll: true });
}
// Re-render an open dynamic modal in place (no re-animation).
function renderModal() {
  const box = $modal.querySelector('.modal');
  if (box && state.modalView) box.innerHTML = state.modalView().s;
}
const openDynamicModal = (view, opts = {}) => openModal(view(), { ...opts, view });
function closeModal() {
  $modal.innerHTML = '';
  state.confirm = null;
  state.modalView = null;
  state.resched = null;
}
const closeBtn = () => html`<button class="icon-btn" data-action="close-modal" aria-label="Close">${icon('x')}</button>`;
function confirmBox({ title, text, ok = 'Confirm', danger = false, onOk }) {
  openModal(html`
    <h3>${title}</h3>
    <p class="lead">${text}</p>
    <div class="modal-actions">
      <button class="btn ghost" data-action="close-modal">Go back</button>
      <button class="btn ${danger ? 'danger' : ''}" data-action="confirm-ok">${ok}</button>
    </div>`, { focus: '[data-action=confirm-ok]' });
  state.confirm = onOk;
}

// ---------------------------------------------------------------------------
// Router & rendering
// ---------------------------------------------------------------------------
const HOME = { patient: '/hospitals', hospital: '/calendar', admin: '/overview' };
const NAV = {
  patient: [['/hospitals', 'Hospitals', 'hospital'], ['/my', 'Appointments', 'calendar']],
  hospital: [['/calendar', 'Calendar', 'calendar'], ['/patients', 'Patients', 'users'], ['/settings', 'Settings', 'sliders']],
  admin: [['/overview', 'Overview', 'grid'], ['/admin/hospitals', 'Hospitals', 'hospital'], ['/admin/patients', 'Patients', 'users']],
};

function route() {
  const h = location.hash.slice(1) || '/';
  const [path, qs] = h.split('?');
  return { path, parts: path.split('/').filter(Boolean), query: Object.fromEntries(new URLSearchParams(qs || '')) };
}
const go = (path) => { location.hash = path; };
const replaceRoute = (path) => location.replace(`#${path}`);

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

function pageFor(r) {
  const p = r.parts;
  switch (state.user.role) {
    case 'patient':
      if (r.path === '/hospitals') return hospitalsView();
      if (p[0] === 'hospital' && p[1]) return hospitalView(p[1], r.query);
      if (r.path === '/my') return myAppointmentsView();
      break;
    case 'hospital':
      if (r.path === '/calendar') return calendarView(r.query);
      if (r.path === '/patients') return hospitalPatientsView();
      if (r.path === '/settings') return settingsView();
      break;
    case 'admin':
      if (r.path === '/overview') return overviewView();
      if (r.path === '/admin/hospitals') return adminHospitalsView();
      if (p[0] === 'admin' && p[1] === 'hospital' && p[2]) return adminHospitalView(p[2]);
      if (r.path === '/admin/patients') return adminPatientsView();
      break;
  }
  return null;
}

function render() {
  const r = route();
  if (!state.user) {
    if (r.path !== '/login' && r.path !== '/register') return replaceRoute('/login');
    $app.innerHTML = (r.path === '/register' ? registerView() : loginView()).s;
    state.lastView = null;
    return;
  }
  if (r.path === '/login' || r.path === '/register' || r.path === '/') return replaceRoute(HOME[state.user.role]);

  // Keep focus, caret and in-progress form edits across re-renders.
  const active = document.activeElement;
  const focusId = $app.contains(active) ? active?.id : null;
  let caret = null;
  try { caret = [active.selectionStart, active.selectionEnd]; } catch { /* not a text field */ }
  const viewKey = r.path;
  const kept = {};
  if (viewKey === state.lastView) {
    $app.querySelectorAll('form[data-keep] [id]').forEach((el) => { kept[el.id] = el.type === 'checkbox' ? el.checked : el.value; });
  } else {
    state.enterUntil = Date.now() + 700; // animate the page in
    state.seen[`count:${viewKey}`] = null;
  }

  state.renderKeys = new Set();
  const page = pageFor(r);
  if (page === null) return replaceRoute(HOME[state.user.role]);
  const entering = Date.now() < state.enterUntil;
  $app.innerHTML = layout(r, page, entering).s;
  state.lastView = viewKey;

  for (const [id, v] of Object.entries(kept)) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = v; else el.value = v;
  }
  if (focusId) {
    const el = document.getElementById(focusId);
    if (el && el !== document.activeElement) {
      el.focus({ preventScroll: true });
      try { if (caret?.[0] != null) el.setSelectionRange(...caret); } catch { /* ignore */ }
    }
  }
  const counters = $app.querySelectorAll('[data-count]');
  if (entering && counters.length && fresh(`count:${viewKey}`, 'done')) countUp(counters);
}

// Stats count up from zero when a page is entered.
function countUp(els) {
  if (reduceMotion()) return;
  els.forEach((el) => {
    const to = Number(el.dataset.count);
    if (!to) return;
    const t0 = performance.now();
    const step = (t) => {
      const p = Math.min(1, (t - t0) / 800);
      el.textContent = Math.round(to * (1 - (1 - p) ** 3));
      if (p < 1 && el.isConnected) requestAnimationFrame(step);
    };
    el.textContent = '0';
    requestAnimationFrame(step);
  });
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------
const skeleton = (n = 3, h = 72) => html`<div class="stack">${Array.from({ length: n }, () => html`<div class="skel" style="height:${h}px"></div>`)}</div>`;
const emptyBox = (text, ico = 'inbox', card = true) => html`<div class="${card ? 'card ' : ''}empty">${icon(ico)}${text}</div>`;
const badge = (status) => html`<span class="badge ${status}">${status}</span>`;
const stat = (label, value, ico, tone = '') => html`
  <div class="card stat"><div class="ico ${tone}">${icon(ico)}</div><div class="label">${label}</div>
  <div class="value" data-count="${value}">${value}</div></div>`;

function layout(r, page, entering) {
  const u = state.user;
  const isActive = (href) => r.path.startsWith(href.replace(/s$/, ''));
  const links = NAV[u.role].map(([href, label, ico]) => html`<a href="#${href}" class="${isActive(href) ? 'active' : ''}">${icon(ico)}${label}</a>`);
  return html`
    <header class="topbar">
      <div class="wrap topbar-in">
        <a class="brand" href="#${HOME[u.role]}">${LOGO} IRA</a>
        <nav class="nav">${links}</nav>
        <div class="top-right" id="top-actions">${topActions()}</div>
      </div>
    </header>
    <main class="wrap main ${entering ? 'enter' : ''}">${page}</main>
    <nav class="tabbar">${links}</nav>`;
}

function topActions() {
  const u = state.user;
  const n = get('/notifications');
  const unread = n?.unread || 0;
  const ring = unread > state.lastUnread;
  state.lastUnread = unread;
  const sub = u.role === 'hospital' ? state.hospital?.name || 'Hospital' : u.role;
  return html`
    ${themeBtn()}
    <div class="pop-wrap">
      <button class="icon-btn ${ring ? 'ring' : ''}" data-action="toggle-notif" aria-label="Notifications">${icon('bell')}
        ${unread ? html`<span class="dot">${unread > 9 ? '9+' : unread}</span>` : ''}</button>
      ${state.pop === 'notif' ? html`
        <div class="pop">
          <h4>Notifications</h4>
          ${n?.items?.length
            ? n.items.map((x) => html`<div class="notif ${x.read ? '' : 'unread'}"><span class="n-dot"></span><div>${x.message}<small class="muted">${ago(x.created_at)}</small></div></div>`)
            : emptyBox("You're all caught up.", 'bell', false)}
        </div>` : ''}
    </div>
    <div class="pop-wrap">
      <button class="avatar-btn" data-action="toggle-menu" aria-label="Account">${avatar(u.name, 'sm')}
        <span class="who">${u.name}<small>${sub}</small></span></button>
      ${state.pop === 'menu' ? html`
        <div class="pop menu">
          <div class="menu-head">${avatar(u.name, 'round')}<div><b>${u.name}</b><small class="muted">${u.email}</small></div></div>
          <button data-action="profile">${icon('edit')} Edit profile</button>
          <button data-action="theme-menu">${icon(effectiveTheme() === 'dark' ? 'sun' : 'moon')} ${effectiveTheme() === 'dark' ? 'Light' : 'Dark'} mode</button>
          <button class="danger" data-action="logout">${icon('logout')} Log out</button>
        </div>` : ''}
    </div>`;
}
function renderTop() {
  const el = document.getElementById('top-actions');
  if (el) el.innerHTML = topActions().s;
}

function searchBox(id, placeholder, value) {
  return html`<div class="search-box">${icon('search')}<input id="${id}" type="search" placeholder="${placeholder}" value="${value}" data-input="${id}" autocomplete="off"></div>`;
}

// ---------------------------------------------------------------------------
// Auth views
// ---------------------------------------------------------------------------
function authShell(card) {
  return html`
    <div class="auth">
      <div class="auth-art">
        <span class="blob b1"></span><span class="blob b2"></span>
        <div class="brand">${LOGO_LIGHT} IRA</div>
        <div>
          <h2>Healthcare appointments, without the waiting.</h2>
          <p>Find a hospital, pick a time that suits you, and you're booked in seconds.</p>
          <div class="features">
            <div class="feature">${icon('zap')} Instant booking with live slot availability</div>
            <div class="feature">${icon('calendar')} Hospitals run their day from one clear calendar</div>
            <div class="feature">${icon('shield')} One platform for admins, hospitals and patients</div>
          </div>
        </div>
        <small style="color:#fff;opacity:.7">© ${new Date().getFullYear()} IRA</small>
      </div>
      <div class="auth-side">
        <div class="theme-corner">${themeBtn()}</div>
        <div class="auth-card">
          <div class="brand mobile-brand">${LOGO} IRA</div>
          ${card}
        </div>
      </div>
    </div>`;
}

function loginView() {
  return authShell(html`
    <h1>Welcome back</h1>
    <p class="sub">Sign in to manage your appointments.</p>
    <form data-form="login" novalidate>
      <div class="form-error" hidden></div>
      <label><span>Email</span><input id="l-email" name="email" type="email" autocomplete="email" placeholder="you@example.com" required></label>
      <label><span>Password</span><input id="l-pw" name="password" type="password" autocomplete="current-password" placeholder="••••••••" required></label>
      <button class="btn grad block">Sign in ${icon('arrow-right')}</button>
    </form>
    <div class="switch">New patient? <a href="#/register">Create an account</a></div>
    <div class="demo">
      <p>Try a demo account</p>
      <div class="demo-btns">
        <button class="btn ghost sm" data-action="demo" data-email="patient@demo.com" data-pw="patient123">${icon('user')}Patient</button>
        <button class="btn ghost sm" data-action="demo" data-email="city@demo.com" data-pw="hospital123">${icon('hospital')}Hospital</button>
        <button class="btn ghost sm" data-action="demo" data-email="admin@demo.com" data-pw="admin123">${icon('grid')}Admin</button>
      </div>
    </div>`);
}

function registerView() {
  return authShell(html`
    <h1>Create your account</h1>
    <p class="sub">Book your first appointment in under a minute.</p>
    <form data-form="register" novalidate>
      <div class="form-error" hidden></div>
      <label><span>Full name</span><input name="name" autocomplete="name" placeholder="Your name" required></label>
      <label><span>Email</span><input name="email" type="email" autocomplete="email" placeholder="you@example.com" required></label>
      <label><span>Phone (optional)</span><input name="phone" type="tel" autocomplete="tel" placeholder="+91 …"></label>
      <label><span>Password</span><input name="password" type="password" autocomplete="new-password" minlength="6" required placeholder="At least 6 characters"></label>
      <button class="btn grad block">Create account ${icon('arrow-right')}</button>
    </form>
    <div class="switch">Already have an account? <a href="#/login">Sign in</a></div>`);
}

// ---------------------------------------------------------------------------
// Patient views
// ---------------------------------------------------------------------------
function topSpecialties(list) {
  const counts = {};
  for (const h of list || []) for (const t of tags(h.specialties)) counts[t] = (counts[t] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8).map(([t]) => t);
}

function hospitalsView() {
  const list = get('/hospitals');
  get('/appointments'); // warm "your next visit" hints and the appointments tab
  const q = state.search.hq;
  return html`
    <section class="hero anim">
      <h1>${greeting()}, ${state.user.name.split(' ')[0]}</h1>
      <p>Choose a hospital, pick a time that suits you, and you're booked instantly. No calls, no queues.</p>
      ${searchBox('hq', 'Search by hospital, city or specialty…', q)}
      <div class="chips">${topSpecialties(list).map((t) => html`
        <button class="chip ${q.toLowerCase() === t.toLowerCase() ? 'on' : ''}" data-action="chip" data-v="${t}">${t}</button>`)}</div>
    </section>
    <div id="hq-results">${hospitalCards(list)}</div>`;
}

function hospitalCards(list) {
  if (!list) return html`<div class="grid">${Array.from({ length: 4 }, () => html`<div class="skel" style="height:196px"></div>`)}</div>`;
  const q = state.search.hq.trim().toLowerCase();
  const items = q ? list.filter((h) => `${h.name} ${h.city} ${h.specialties}`.toLowerCase().includes(q)) : list;
  if (!items.length) return emptyBox(`No hospitals match “${state.search.hq}”.`, 'search');
  const mine = (peek('/appointments') || []).filter((a) => a.status === 'booked' && a.date >= today()).sort(byWhen);
  return html`
    <h3 class="section-title">${items.length} hospital${items.length === 1 ? '' : 's'} ${q ? 'found' : 'available'}</h3>
    <div class="grid stagger">${items.map((h) => {
      const next = mine.find((a) => a.hospital_id === h.id);
      const open = isOpenNow(h);
      return html`
      <a class="card hospital-card" href="#/hospital/${h.id}" data-prefetch="${slotsKey(h.id, firstOpenDate(h))}">
        <div class="hc-top">${avatar(h.name, 'lg')}<div><h3>${h.name}</h3><div class="meta">${icon('pin')}${h.city}</div></div></div>
        <div class="hc-row">
          <span class="open-badge ${open ? 'on' : ''}">${open ? 'Open now' : 'Closed now'}</span>
          <span class="meta">${icon('clock')}${daysLabel(h)} · ${hoursLabel(h)}</span>
        </div>
        <div class="tags">${tags(h.specialties).map((t) => html`<span class="tag">${t}</span>`)}</div>
        ${next ? html`<div class="badge booked" style="align-self:flex-start;text-transform:none">Your visit · ${fmtDate(next.date)}, ${fmtTime(next.time)}</div>` : ''}
        <div class="hc-cta">Book appointment ${icon('arrow-right')}</div>
      </a>`;
    })}</div>`;
}

function dateChips(h, selected, action, extra = {}) {
  const dates = Array.from({ length: 14 }, (_, i) => addDays(today(), i));
  return html`<div class="dates">${dates.map((d) => {
    const dt = parseD(d);
    const attrs = Object.entries({ hid: h.id, date: d, ...extra }).map(([k, v]) => `data-${k}="${esc(v)}"`).join(' ');
    return html`<button class="date-chip ${d === selected ? 'active' : ''} ${isOpenOn(h, d) ? '' : 'closed'}"
      data-action="${action}" ${raw(attrs)} data-prefetch="${slotsKey(h.id, d)}">
      <small>${d === today() ? 'Today' : DOW[dt.getDay()]}</small><b>${dt.getDate()}</b><small>${monShort(d)}</small>
    </button>`;
  })}</div>`;
}

const SLOT_GROUPS = [['Morning', 'sunrise', (t) => t < '12:00'], ['Afternoon', 'sun', (t) => t >= '12:00' && t < '17:00'], ['Evening', 'moon', (t) => t >= '17:00']];

function slotButtons(data, { key, action, h, date, picked, current }) {
  if (!data) return html`<div class="slots">${Array.from({ length: 12 }, () => html`<div class="skel" style="height:42px"></div>`)}</div>`;
  if (!data.open) return emptyBox(`${h.name} is closed on this day. Please pick another date.`, 'calendar', false);
  const usable = data.slots.some((s) => s.status === 'free' || s.status === 'mine');
  if (!data.slots.length || !usable) return emptyBox('Fully booked on this day. Try another date.', 'calendar', false);
  const anim = fresh(`slots:${action}`, key);
  return html`<div class="${anim ? 'fresh-slots' : ''}">${SLOT_GROUPS.map(([label, ico, test]) => {
    const slots = data.slots.filter((s) => test(s.time));
    if (!slots.length) return '';
    const free = slots.filter((s) => s.status === 'free').length;
    return html`<div class="slot-group"><h4>${icon(ico)}${label} <span class="muted">· ${free} open</span></h4><div class="slots">${slots.map((s) => {
      let cls = s.status;
      if (current && s.time === current) cls = 'current';
      else if (picked === s.time) cls = 'picked';
      if (state.justBooked === `${key}|${s.time}`) cls += ' just-booked';
      const clickable = s.status === 'free';
      return html`<button class="slot ${cls}" ${clickable ? '' : 'disabled'}
        title="${s.status === 'mine' ? 'Your appointment' : clickable ? 'Choose this time' : 'Not available'}"
        data-action="${action}" data-hid="${h.id}" data-date="${date}" data-time="${s.time}">${fmtTime(s.time)}</button>`;
    })}</div></div>`;
  })}</div>`;
}

function hospitalView(hid, query) {
  const h = get(`/hospitals/${hid}`, peek('/hospitals')?.find((x) => String(x.id) === hid));
  if (!h) return skeleton(2, 160);
  const dates = Array.from({ length: 14 }, (_, i) => addDays(today(), i));
  const date = dates.includes(query.date) ? query.date : firstOpenDate(h);
  const key = slotsKey(h.id, date);
  const data = get(key);
  // Warm the cache for the next couple of open days so switching dates is instant.
  dates.filter((d) => d > date && isOpenOn(h, d)).slice(0, 2).forEach((d) => prefetch(slotsKey(h.id, d)));
  const free = data?.slots?.filter((s) => s.status === 'free').length;

  return html`
    <a class="back" href="#/hospitals">${icon('arrow-left')} All hospitals</a>
    <div class="hosp-head anim">
      <div class="who-block">${avatar(h.name, 'lg')}
        <div><h1>${h.name}</h1><div class="tags">${tags(h.specialties).map((t) => html`<span class="tag">${t}</span>`)}</div></div>
      </div>
    </div>
    <div class="info-pills anim" style="margin-bottom:20px">
      <span class="info-pill">${icon('pin')}${h.address || h.city}</span>
      ${h.phone ? html`<span class="info-pill">${icon('phone')}${h.phone}</span>` : ''}
      <span class="info-pill">${icon('clock')}${daysLabel(h)} · ${hoursLabel(h)}</span>
      <span class="open-badge ${isOpenNow(h) ? 'on' : ''} info-pill">${isOpenNow(h) ? 'Open now' : 'Closed now'}</span>
    </div>
    <div class="card anim">
      <h2>Choose a date</h2>
      ${dateChips(h, date, 'pick-date')}
      <div class="card-head" style="margin-top:6px">
        <h2>${fmtDate(date, true)}</h2>
        ${data?.open ? html`<span class="count-pill">${free} slot${free === 1 ? '' : 's'} open</span>` : ''}
      </div>
      <div class="legend">
        <span><i></i>Available</span>
        <span><i style="background:var(--surface-2);border-color:transparent"></i>Booked</span>
        <span><i style="background:var(--grad);border-color:transparent"></i>Your booking</span>
      </div>
      ${slotButtons(data, { key, action: 'pick-slot', h, date })}
    </div>`;
}

function bookingModal({ hid, date, time }) {
  const h = peek(`/hospitals/${hid}`);
  return html`
    <div class="modal-top"><h3>Confirm appointment</h3>${closeBtn()}</div>
    <p class="lead">Check the details, then confirm. You'll get a notification right away.</p>
    <div class="summary-box">${avatar(h?.name || 'H')}<div><b>${h?.name}</b>
      <span class="meta">${icon('calendar')}${fmtDate(date, true)} · ${fmtTime(time)}</span></div></div>
    <form data-form="book">
      <input type="hidden" name="hospitalId" value="${hid}">
      <input type="hidden" name="date" value="${date}">
      <input type="hidden" name="time" value="${time}">
      <label><span>Reason for visit (optional)</span>
        <textarea name="reason" maxlength="500" placeholder="e.g. Fever for two days, follow-up visit…"></textarea></label>
      <div class="modal-actions">
        <button type="button" class="btn ghost" data-action="close-modal">Back</button>
        <button class="btn grad">${icon('check')} Confirm booking</button>
      </div>
    </form>`;
}

function myAppointmentsView() {
  const list = get('/appointments');
  const head = html`
    <div class="page-head anim">
      <div><h1>My appointments</h1><p>Your upcoming visits and history.</p></div>
      <a class="btn grad" href="#/hospitals">${icon('plus')} Book new</a>
    </div>`;
  if (!list) return html`${head}${skeleton(3, 96)}`;
  const t = today(), now = nowHM();
  const isUpcoming = (a) => a.status === 'booked' && (a.date > t || (a.date === t && a.time >= now));
  const upcoming = list.filter(isUpcoming).sort(byWhen);
  const history = list.filter((a) => !isUpcoming(a)).sort((a, b) => byWhen(b, a));
  const [next, ...rest] = upcoming;
  return html`${head}
    ${next ? nextCard(next) : emptyBox(raw(`No upcoming appointments. <a href="#/hospitals">Find a hospital</a> to book one.`), 'calendar')}
    ${rest.length ? html`
      <h3 class="section-title">Also coming up <span class="count-pill">${rest.length}</span></h3>
      <div class="stack stagger">${rest.map((a) => patientApptCard(a, true))}</div>` : ''}
    <h3 class="section-title">History <span class="count-pill">${history.length}</span></h3>
    ${history.length ? html`<div class="stack stagger">${history.slice(0, 30).map((a) => patientApptCard(a, false))}</div>` : emptyBox('Nothing here yet.')}`;
}

function nextCard(a) {
  return html`
    <div class="card next-card anim">
      <div class="label">${a.pending ? 'Confirming…' : 'Next appointment'}</div>
      <div class="big">${fmtDate(a.date, true)} · ${fmtTime(a.time)}</div>
      <div class="sub">${a.hospital_name}${a.hospital_address ? ` · ${a.hospital_address}` : ''}</div>
      ${a.reason ? html`<div class="sub" style="opacity:.8;margin-top:4px">Reason: ${a.reason}</div>` : ''}
      <span class="countdown">${countdown(a)}</span>
      ${a.pending ? '' : html`<div class="actions">
        <button class="btn ghost sm" data-action="reschedule" data-id="${a.id}">${icon('repeat')} Reschedule</button>
        <button class="btn ghost sm" data-action="ics" data-id="${a.id}">${icon('calendar-plus')} Add to calendar</button>
        <button class="btn ghost sm" data-action="patient-cancel" data-id="${a.id}">${icon('x')} Cancel</button>
      </div>`}
    </div>`;
}

function patientApptCard(a, upcoming) {
  const dt = parseD(a.date);
  return html`
    <div class="card appt ${a.pending ? 'is-pending' : ''}">
      <div class="appt-main">
        <div class="date-tile ${upcoming ? '' : 'dim'}"><small>${monShort(a.date)}</small><b>${dt.getDate()}</b><small>${DOW[dt.getDay()]}</small></div>
        <div>
          <div class="when">${a.hospital_name}</div>
          <div class="meta">${icon('clock')}${fmtTime(a.time)} · ${fmtDate(a.date, true)}</div>
          ${a.reason ? html`<div class="meta">${a.reason}</div>` : ''}
        </div>
      </div>
      <div class="actions">
        ${a.pending ? html`<span class="badge pending">Confirming</span>` : badge(a.status)}
        ${upcoming && !a.pending ? html`
          <button class="btn ghost sm" data-action="reschedule" data-id="${a.id}">${icon('repeat')} Reschedule</button>
          <button class="btn ghost sm icon-only" data-action="ics" data-id="${a.id}" title="Add to calendar" aria-label="Add to calendar">${icon('calendar-plus')}</button>
          <button class="btn danger-ghost sm" data-action="patient-cancel" data-id="${a.id}">Cancel</button>` : ''}
        ${!upcoming ? html`<a class="btn ghost sm" href="#/hospital/${a.hospital_id}">Book again</a>` : ''}
      </div>
    </div>`;
}

function rescheduleView() {
  const rs = state.resched;
  const a = peek('/appointments')?.find((x) => x.id === rs.id);
  const h = get(`/hospitals/${rs.hid}`, peek('/hospitals')?.find((x) => x.id === rs.hid));
  if (!a || !h) return html`<div class="modal-top"><h3>Reschedule</h3>${closeBtn()}</div>${skeleton(2, 80)}`;
  const key = slotsKey(h.id, rs.date);
  const data = get(key);
  return html`
    <div class="modal-top"><h3>Reschedule appointment</h3>${closeBtn()}</div>
    <p class="lead">${h.name} · currently <b>${fmtDate(a.date)} at ${fmtTime(a.time)}</b></p>
    ${dateChips(h, rs.date, 'rs-date')}
    ${slotButtons(data, { key, action: 'rs-slot', h, date: rs.date, picked: rs.time, current: rs.date === a.date ? a.time : null })}
    <div class="modal-actions">
      <button class="btn ghost" data-action="close-modal">Keep current time</button>
      <button class="btn grad" data-action="rs-confirm" ${rs.time ? '' : 'disabled'}>
        ${icon('repeat')} ${rs.time ? `Move to ${fmtDate(rs.date)}, ${fmtTime(rs.time)}` : 'Pick a new time'}</button>
    </div>`;
}

function profileModal() {
  const u = state.user;
  return html`
    <div class="modal-top"><h3>Edit profile</h3>${closeBtn()}</div>
    <p class="lead">${u.email}</p>
    <form data-form="profile">
      <label><span>Name</span><input name="name" value="${u.name}" required maxlength="80"></label>
      <label><span>Phone</span><input name="phone" type="tel" value="${u.phone || ''}" maxlength="20"></label>
      <div class="modal-actions">
        <button type="button" class="btn ghost" data-action="close-modal">Cancel</button>
        <button class="btn">Save</button>
      </div>
    </form>`;
}

// ---------------------------------------------------------------------------
// Hospital views
// ---------------------------------------------------------------------------
function calendarView(query) {
  const t = today();
  const month = /^\d{4}-\d{2}$/.test(query.month || '') ? query.month : t.slice(0, 7);
  const sel = query.day?.startsWith(month) ? query.day : t.startsWith(month) ? t : `${month}-01`;
  const key = monthKey(month);
  const list = get(key);
  prefetch(monthKey(shiftMonth(month, 1)));
  prefetch(monthKey(shiftMonth(month, -1)));

  const all = list || [];
  const counts = {};
  for (const a of all) if (a.status !== 'cancelled') counts[a.date] = (counts[a.date] || 0) + 1;
  const [y, m] = month.split('-').map(Number);
  const lead = (new Date(y, m - 1, 1).getDay() + 6) % 7;
  const total = new Date(y, m, 0).getDate();
  const cells = Array.from({ length: total }, (_, i) => {
    const d = `${month}-${pad(i + 1)}`;
    const c = counts[d] || 0;
    const cls = [d === t && 'today', d === sel && 'sel', d < t && 'past-day'].filter(Boolean).join(' ');
    const dots = c ? Math.min(3, c >= 4 ? 3 : c >= 2 ? 2 : 1) : 0;
    return html`<button class="day ${cls}" data-action="cal-day" data-month="${month}" data-day="${d}"
      title="${c} appointment${c === 1 ? '' : 's'}" aria-label="${fmtDate(d, true)}, ${c} appointments">
      ${i + 1}<span class="heat">${Array.from({ length: dots }, () => raw('<i></i>'))}</span></button>`;
  });
  const dayItems = all.filter((a) => a.date === sel).sort((a, b) => a.time.localeCompare(b.time));
  const activeCount = dayItems.filter((a) => a.status !== 'cancelled').length;
  const ms = {
    total: all.filter((a) => a.status !== 'cancelled').length,
    upcoming: all.filter((a) => a.status === 'booked' && a.date >= t).length,
    completed: all.filter((a) => a.status === 'completed').length,
    cancelled: all.filter((a) => a.status === 'cancelled').length,
  };
  const calAnim = fresh('cal', month);
  const dayAnim = fresh('day', `${sel}:${!!list}`);

  return html`
    <div class="page-head anim">
      <div><h1>${state.hospital?.name || 'Calendar'}</h1><p>${greeting()}! You have <b>${counts[t] || 0}</b> appointment${counts[t] === 1 ? '' : 's'} today.</p></div>
      <button class="btn ghost" data-action="export-month" data-key="${key}" data-month="${month}">${icon('download')} Export month</button>
    </div>
    <div class="mini-stats stagger">
      ${stat('Bookings this month', ms.total, 'calendar')}
      ${stat('Upcoming', ms.upcoming, 'clock', 'indigo')}
      ${stat('Completed', ms.completed, 'check-circle', 'ok')}
      ${stat('Cancelled', ms.cancelled, 'x-circle', 'danger')}
    </div>
    <div class="split">
      <div class="card anim">
        <div class="cal-head">
          <h2>${new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h2>
          <button class="icon-btn" data-action="cal-nav" data-month="${shiftMonth(month, -1)}" aria-label="Previous month">${icon('chev-left')}</button>
          <button class="btn ghost sm" data-action="cal-nav" data-month="${t.slice(0, 7)}" data-day="${t}">Today</button>
          <button class="icon-btn" data-action="cal-nav" data-month="${shiftMonth(month, 1)}" aria-label="Next month">${icon('chev-right')}</button>
        </div>
        <div class="cal ${calAnim ? 'fresh-cal' : ''}">
          ${WEEK.map((d) => html`<div class="dow">${DOW[d].slice(0, 2)}</div>`)}
          ${Array.from({ length: lead }, () => html`<div class="day blank"></div>`)}
          ${cells}
        </div>
      </div>
      <div class="card anim">
        <div class="card-head">
          <h2>${fmtDate(sel, true)}</h2>
          <span class="count-pill">${activeCount} appointment${activeCount === 1 ? '' : 's'}</span>
        </div>
        ${!list ? skeleton(3, 56) : dayItems.length
          ? html`<div class="${dayAnim ? 'fresh' : ''}">${dayItems.map((a) => timelineItem(a, key))}</div>`
          : emptyBox('No appointments on this day.', 'calendar', false)}
      </div>
    </div>`;
}

function timelineItem(a, key) {
  return html`
    <div class="tl-item ${a.status}">
      <div class="tl-time">${fmtTime(a.time)}</div>
      <div class="tl-body">
        <div class="tl-who">${avatar(a.patient_name, 'sm')}
          <div><b>${a.patient_name}</b>
            <span class="meta">${a.patient_phone ? html`${icon('phone')}${a.patient_phone}` : a.patient_email}</span>
            ${a.reason ? html`<span class="meta">“${a.reason}”</span>` : ''}
          </div>
        </div>
        <div class="tl-actions">
          ${a.status === 'booked' ? html`
            <button class="btn sm" data-action="hosp-status" data-id="${a.id}" data-status="completed" data-key="${key}">${icon('check')} Done</button>
            <button class="btn danger-ghost sm" data-action="hosp-status" data-id="${a.id}" data-status="cancelled" data-key="${key}">Cancel</button>`
            : badge(a.status)}
        </div>
      </div>
    </div>`;
}

function patientsTable(list, q, emptyText = 'No patients yet.', clickable = false) {
  if (!list) return html`<div style="padding:16px">${skeleton(4, 44)}</div>`;
  const term = q.trim().toLowerCase();
  const rows = term ? list.filter((p) => `${p.name} ${p.email} ${p.phone}`.toLowerCase().includes(term)) : list;
  if (!rows.length) return emptyBox(term ? 'No patients match your search.' : emptyText, 'users', false);
  return html`
    <div class="table-wrap"><table class="rtable">
      <thead><tr><th>Patient</th><th>Phone</th><th class="num">Visits</th><th class="num">Upcoming</th><th>Last appointment</th></tr></thead>
      <tbody>${rows.map((p) => html`
        <tr class="${clickable ? 'clickable' : ''}" ${clickable ? raw(`data-action="patient-drawer" data-id="${p.id}"`) : ''}>
          ${td('Patient', html`<div class="person">${avatar(p.name, 'round')}<div><b>${p.name}</b><small class="muted">${p.email}</small></div></div>`, 'primary')}
          ${td('Phone', p.phone || '—', 'nowrap')}
          ${td('Visits', p.visits, 'num')}
          ${td('Upcoming', p.upcoming || 0, 'num')}
          ${td('Last appointment', p.last_date ? fmtDate(p.last_date) : '—', 'nowrap')}
        </tr>`)}
      </tbody>
    </table></div>`;
}

function hospitalPatientsView() {
  const list = get('/hospital/patients');
  return html`
    <div class="page-head anim">
      <div><h1>Patients</h1><p>Everyone who has booked with ${state.hospital?.name || 'your hospital'}${list ? ` · ${list.length} total` : ''}.</p></div>
      <div class="toolbar">
        ${searchBox('pq', 'Search patients…', state.search.pq)}
        <button class="btn ghost" data-action="export-hospital-patients">${icon('download')} Export</button>
      </div>
    </div>
    <div class="card flush anim" id="pq-results">${patientsTable(list, state.search.pq)}</div>`;
}

function slotHint(open, close, len, days) {
  const n = slotsPerDay(open, close, len);
  return html`${icon('activity')} ${n} appointment slot${n === 1 ? '' : 's'} per day · ${n * days} per week`;
}

function settingsView() {
  const h = get('/hospital/settings', state.hospital ?? undefined);
  if (!h) return skeleton(1, 320);
  const days = openDays(h);
  return html`
    <div class="page-head anim">
      <div><h1>Settings</h1><p>Working hours decide which slots patients can book.</p></div>
    </div>
    <form class="card anim" data-form="settings" data-keep data-input="slot-hint" style="max-width:680px">
      <div class="hint" id="slot-hint">${slotHint(h.open_time, h.close_time, h.slot_minutes, days.length)}</div>
      <div class="row">
        <label><span>Opening time</span><input id="s-open" type="time" name="open_time" value="${h.open_time}" required></label>
        <label><span>Closing time</span><input id="s-close" type="time" name="close_time" value="${h.close_time}" required></label>
      </div>
      <label><span>Appointment length</span>
        <select id="s-slot" name="slot_minutes">${[10, 15, 20, 30, 45, 60].map((n) =>
          html`<option value="${n}" ${n === h.slot_minutes ? 'selected' : ''}>${n} minutes</option>`)}</select></label>
      <label><span>Working days</span></label>
      <div class="days">${WEEK.map((d) => html`
        <label class="day-check"><input type="checkbox" id="s-d${d}" name="days_open" value="${d}" ${days.includes(d) ? 'checked' : ''}> ${DOW[d]}</label>`)}
      </div>
      <div class="row">
        <label><span>Phone</span><input id="s-phone" name="phone" value="${h.phone}"></label>
        <label><span>Address</span><input id="s-addr" name="address" value="${h.address}"></label>
      </div>
      <label><span>Specialties (comma separated)</span><input id="s-spec" name="specialties" value="${h.specialties}"></label>
      <button class="btn grad">${icon('check')} Save changes</button>
    </form>`;
}

// ---------------------------------------------------------------------------
// Admin views
// ---------------------------------------------------------------------------
function overviewView() {
  const s = get('/admin/stats');
  const patients = get('/admin/patients');
  const head = html`<div class="page-head anim"><div><h1>Platform overview</h1><p>All hospitals and patients at a glance.</p></div>
    <a class="btn ghost" href="#/admin/hospitals">${icon('plus')} Add hospital</a></div>`;
  if (!s) return html`${head}<div class="stats">${Array.from({ length: 6 }, () => html`<div class="skel" style="height:126px"></div>`)}</div>`;
  const T = s.totals;
  const max = Math.max(1, ...s.next14.map((d) => d.count));
  const topMax = Math.max(1, ...s.top.map((h) => h.bookings));
  const statusTotal = Math.max(1, T.upcoming + T.completed + T.cancelled);
  const a = (T.upcoming / statusTotal) * 100;
  const b = a + (T.completed / statusTotal) * 100;
  return html`${head}
    <div class="stats stagger">
      ${stat('Hospitals', T.hospitals, 'hospital')}
      ${stat('Patients', T.patients, 'users', 'indigo')}
      ${stat('Appointments', T.appointments, 'clipboard')}
      ${stat('Today', T.today, 'zap', 'warn')}
      ${stat('Upcoming', T.upcoming, 'clock', 'indigo')}
      ${stat('Completed', T.completed, 'check-circle', 'ok')}
      ${stat('Cancelled', T.cancelled, 'x-circle', 'danger')}
    </div>
    <div class="split wide-left">
      <div class="card anim">
        <div class="card-head"><h2>Bookings · next 14 days</h2><span class="count-pill">${s.next14.reduce((n, d) => n + d.count, 0)} total</span></div>
        <div class="bars">${s.next14.map((d) => html`
          <div class="bar ${d.date === today() ? 'is-today' : ''}" title="${fmtDate(d.date)}: ${d.count}">
            <span class="n">${d.count || ''}</span>
            <span class="fill" style="height:${(d.count / max) * 100}%"></span>
            <span class="d">${parseD(d.date).getDate()}</span>
          </div>`)}</div>
      </div>
      <div class="card anim">
        <h2>Appointment status</h2>
        <div class="donut-wrap">
          <div class="donut" style="--a:${a}%;--b:${b}%"><span><b>${statusTotal}</b>total</span></div>
          <ul class="legend-list">
            <li><i style="background:var(--primary)"></i>Upcoming<b>${T.upcoming}</b></li>
            <li><i style="background:var(--ok)"></i>Completed<b>${T.completed}</b></li>
            <li><i style="background:var(--danger)"></i>Cancelled<b>${T.cancelled}</b></li>
          </ul>
        </div>
      </div>
    </div>
    <div class="split" style="margin-top:20px">
      <div class="card anim">
        <h2>Top hospitals</h2>
        <ul class="top-list">${s.top.map((h) => html`
          <li><a href="#/admin/hospital/${h.id}"><span class="tl-row"><span>${h.name} <span class="muted">· ${h.city}</span></span><span>${h.bookings}</span></span>
            <span class="track"><span style="width:${(h.bookings / topMax) * 100}%"></span></span></a></li>`)}</ul>
      </div>
      <div class="card anim">
        <div class="card-head"><h2>Newest patients</h2><a href="#/admin/patients" class="meta">View all ${icon('arrow-right')}</a></div>
        ${!patients ? skeleton(4, 40) : html`<div class="stack">${patients.slice(0, 5).map((p) => html`
          <div class="tl-who clickable" style="cursor:pointer" data-action="patient-drawer" data-id="${p.id}">${avatar(p.name, 'round')}
            <div><b>${p.name}</b><span class="meta">${p.hospitals.length ? p.hospitals.map((x) => x.name).join(', ') : 'No bookings yet'}</span></div></div>`)}</div>`}
      </div>
    </div>
    <p class="muted" style="font-size:13px;margin-top:18px">${icon('activity')} Statistics are computed in the background · updated ${ago(s.generatedAt)}</p>`;
}

function adminHospitalsView() {
  const list = get('/admin/hospitals');
  return html`
    <div class="page-head anim">
      <div><h1>Hospitals</h1><p>${list ? `${list.length} hospitals on the platform` : 'Loading…'}</p></div>
      <div class="toolbar">
        ${searchBox('ahq', 'Search hospitals…', state.search.ahq)}
        <button class="btn grad" data-action="add-hospital">${icon('plus')} Add hospital</button>
      </div>
    </div>
    <div class="card flush anim" id="ahq-results">${adminHospitalsTable(list)}</div>`;
}

function adminHospitalsTable(list) {
  if (!list) return html`<div style="padding:16px">${skeleton(4, 48)}</div>`;
  const term = state.search.ahq.trim().toLowerCase();
  const rows = term ? list.filter((h) => `${h.name} ${h.city} ${h.login_email} ${h.specialties}`.toLowerCase().includes(term)) : list;
  if (!rows.length) return emptyBox(term ? 'No hospitals match your search.' : 'No hospitals yet.', 'hospital', false);
  return html`
    <div class="table-wrap"><table class="rtable">
      <thead><tr><th>Hospital</th><th>Login</th><th>Hours</th><th class="num">Patients</th><th class="num">Appointments</th><th class="num">Upcoming</th><th></th></tr></thead>
      <tbody>${rows.map((h) => html`
        <tr class="${h.pending ? 'is-pending' : 'clickable'}" ${h.pending ? '' : raw(`data-action="nav" data-href="/admin/hospital/${h.id}"`)}>
          ${td('Hospital', html`<div class="person">${avatar(h.name)}<div><b>${h.name}</b><small class="muted">${h.city}</small></div></div>`, 'primary')}
          ${td('Login', h.login_email)}
          ${td('Hours', html`${daysLabel(h)}<small class="muted" style="display:block">${hoursLabel(h)}</small>`, 'nowrap')}
          ${td('Patients', h.patients, 'num')}
          ${td('Appointments', h.appointments, 'num')}
          ${td('Upcoming', h.upcoming, 'num')}
          ${td('', h.pending ? html`<span class="badge pending">Saving</span>`
            : html`<button class="btn danger-ghost sm" data-action="delete-hospital" data-id="${h.id}" aria-label="Delete ${h.name}">${icon('trash')}</button>`, 'num end')}
        </tr>`)}
      </tbody>
    </table></div>`;
}

function hospitalFormModal(values = {}, error = '') {
  const v = (k) => values[k] ?? '';
  return html`
    <div class="modal-top"><h3>Add a hospital</h3>${closeBtn()}</div>
    <p class="lead">This also creates the hospital's login account.</p>
    <form data-form="add-hospital">
      ${error ? html`<div class="form-error">${error}</div>` : ''}
      <label><span>Hospital name</span><input name="name" required value="${v('name')}" placeholder="e.g. Apollo Clinic"></label>
      <div class="row">
        <label><span>City</span><input name="city" required value="${v('city')}"></label>
        <label><span>Phone</span><input name="phone" value="${v('phone')}"></label>
      </div>
      <label><span>Address</span><input name="address" value="${v('address')}"></label>
      <label><span>Specialties (comma separated)</span><input name="specialties" value="${v('specialties')}" placeholder="Cardiology, Pediatrics"></label>
      <div class="row">
        <label><span>Login email</span><input name="email" type="email" required value="${v('email')}"></label>
        <label><span>Password</span><input name="password" minlength="6" required value="${v('password')}" placeholder="Min 6 characters"></label>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn ghost" data-action="close-modal">Cancel</button>
        <button class="btn grad">${icon('plus')} Add hospital</button>
      </div>
    </form>`;
}

function adminHospitalView(hid) {
  const data = get(`/admin/hospitals/${hid}`);
  const back = html`<a class="back" href="#/admin/hospitals">${icon('arrow-left')} All hospitals</a>`;
  if (!data) return html`${back}${skeleton(3, 120)}`;
  const { hospital: h, patients, appointments } = data;
  const upcoming = appointments.filter((a) => a.status === 'booked' && a.date >= today()).length;
  return html`${back}
    <div class="hosp-head anim">
      <div class="who-block">${avatar(h.name, 'lg')}
        <div><h1>${h.name}</h1><div class="tags">${tags(h.specialties).map((t) => html`<span class="tag">${t}</span>`)}</div></div>
      </div>
    </div>
    <div class="info-pills anim" style="margin-bottom:20px">
      <span class="info-pill">${icon('pin')}${h.address || h.city}</span>
      ${h.phone ? html`<span class="info-pill">${icon('phone')}${h.phone}</span>` : ''}
      <span class="info-pill">${icon('clock')}${daysLabel(h)} · ${hoursLabel(h)} · ${h.slot_minutes} min</span>
      <span class="info-pill">${icon('mail')}${h.login_email}</span>
    </div>
    <div class="stats stagger">
      ${stat('Patients', patients.length, 'users', 'indigo')}
      ${stat('Appointments', appointments.length, 'clipboard')}
      ${stat('Upcoming', upcoming, 'clock', 'warn')}
      ${stat('Completed', appointments.filter((a) => a.status === 'completed').length, 'check-circle', 'ok')}
    </div>
    <h3 class="section-title">Patients <span class="count-pill">${patients.length}</span></h3>
    <div class="card flush anim">${patientsTable(patients, '', 'No patients have booked here yet.', true)}</div>
    <h3 class="section-title">Recent appointments</h3>
    <div class="card flush anim">${appointments.length ? html`
      <div class="table-wrap"><table class="rtable">
        <thead><tr><th>Patient</th><th>Date</th><th>Time</th><th>Reason</th><th>Status</th></tr></thead>
        <tbody>${appointments.map((a) => html`<tr>
          ${td('Patient', html`<div class="person">${avatar(a.patient_name, 'sm')}<b>${a.patient_name}</b></div>`, 'primary')}
          ${td('Date', fmtDate(a.date), 'nowrap')}${td('Time', fmtTime(a.time), 'nowrap')}
          ${td('Reason', a.reason || '—')}${td('Status', badge(a.status))}</tr>`)}</tbody>
      </table></div>` : emptyBox('No appointments yet.', 'calendar', false)}
    </div>`;
}

function filteredAdminPatients(list) {
  const term = state.search.aq.trim().toLowerCase();
  const hid = state.adminHospitalFilter;
  return list.filter((p) =>
    (!term || `${p.name} ${p.email} ${p.phone} ${p.hospitals.map((h) => h.name).join(' ')}`.toLowerCase().includes(term))
    && (!hid || p.hospitals.some((h) => String(h.id) === hid)));
}

function adminPatientsView() {
  const list = get('/admin/patients');
  const hospitals = new Map();
  for (const p of list || []) for (const h of p.hospitals) hospitals.set(h.id, h.name);
  const options = [...hospitals].sort((a, b) => a[1].localeCompare(b[1]));
  return html`
    <div class="page-head anim">
      <div><h1>Patients</h1><p>Every patient on the platform and the hospitals they visit.</p></div>
      <div class="toolbar">
        ${searchBox('aq', 'Search name, email, hospital…', state.search.aq)}
        <select id="ahf" data-input="ahf" aria-label="Filter by hospital">
          <option value="">All hospitals</option>
          ${options.map(([id, name]) => html`<option value="${id}" ${String(id) === state.adminHospitalFilter ? 'selected' : ''}>${name}</option>`)}
        </select>
        <button class="btn ghost" data-action="export-admin-patients">${icon('download')} Export</button>
      </div>
    </div>
    <div class="card flush anim" id="aq-results">${adminPatientsTable(list)}</div>`;
}

// Show the patient's top hospitals (the filtered one first), then "+N" for the rest.
function hospitalTags(list, highlightId) {
  const sorted = highlightId ? [...list].sort((a, b) => (String(b.id) === highlightId) - (String(a.id) === highlightId)) : list;
  const shown = sorted.slice(0, 2);
  const rest = sorted.slice(2);
  return html`<div class="tags">${shown.map((h) => html`<span class="tag ${String(h.id) === highlightId ? 'hl' : ''}"
      title="${h.visits} appointment${h.visits === 1 ? '' : 's'}">${h.name}<b>${h.visits}</b></span>`)}
    ${rest.length ? html`<span class="tag" title="${rest.map((h) => `${h.name} (${h.visits})`).join(', ')}">+${rest.length} more</span>` : ''}</div>`;
}

function adminPatientsTable(list) {
  if (!list) return html`<div style="padding:16px">${skeleton(5, 48)}</div>`;
  const rows = filteredAdminPatients(list);
  if (!rows.length) return emptyBox('No patients found.', 'users', false);
  const hid = state.adminHospitalFilter;
  return html`
    <div class="table-wrap"><table class="rtable">
      <thead><tr><th>Patient</th><th>Phone</th><th>Hospitals</th><th class="num">Appointments</th><th class="num">Upcoming</th><th>Last appointment</th></tr></thead>
      <tbody>${rows.map((p) => html`
        <tr class="clickable" data-action="patient-drawer" data-id="${p.id}">
          ${td('Patient', html`<div class="person">${avatar(p.name, 'round')}<div><b>${p.name}</b><small class="muted">${p.email}</small></div></div>`, 'primary')}
          ${td('Phone', p.phone || '—', 'nowrap')}
          ${td('Hospitals', p.hospitals.length
            ? hospitalTags(p.hospitals, hid)
            : html`<span class="muted">None yet</span>`)}
          ${td('Appointments', p.appointments, 'num')}
          ${td('Upcoming', p.upcoming, 'num')}
          ${td('Last appointment', p.last_date ? fmtDate(p.last_date) : '—', 'nowrap')}
        </tr>`)}
      </tbody>
    </table></div>`;
}

function patientDrawer(pid) {
  return () => {
    const summary = peek('/admin/patients')?.find((p) => String(p.id) === String(pid));
    const data = get(`/admin/patients/${pid}`);
    const p = data?.patient || summary;
    if (!p) return html`<div class="modal-top"><h3>Patient</h3>${closeBtn()}</div>${skeleton(3, 70)}`;
    const appts = data?.appointments;
    const perHospital = new Map();
    for (const a of appts || []) {
      const e = perHospital.get(a.hospital_id) || { id: a.hospital_id, name: a.hospital_name, visits: 0 };
      e.visits += 1;
      perHospital.set(a.hospital_id, e);
    }
    const hospitals = appts ? [...perHospital.values()].sort((x, y) => y.visits - x.visits) : summary?.hospitals || [];
    const upcoming = appts ? appts.filter((a) => a.status === 'booked' && a.date >= today()).length : summary?.upcoming ?? 0;
    return html`
      <div class="modal-top">
        <div class="who-block">${avatar(p.name, 'lg round')}
          <div><h3 style="margin:0">${p.name}</h3>
            <span class="meta">${icon('mail')}${p.email}</span>
            ${p.phone ? html`<span class="meta">${icon('phone')}${p.phone}</span>` : ''}</div>
        </div>
        ${closeBtn()}
      </div>
      <div class="mini-stats" style="grid-template-columns:repeat(3,1fr);margin:20px 0 6px">
        <div class="card stat"><div class="label">Appointments</div><div class="value">${appts ? appts.length : summary?.appointments ?? '…'}</div></div>
        <div class="card stat"><div class="label">Upcoming</div><div class="value">${upcoming}</div></div>
        <div class="card stat"><div class="label">Hospitals</div><div class="value">${hospitals.length}</div></div>
      </div>
      <h4 class="section-title">Hospitals</h4>
      ${hospitals.length ? html`<div class="tags">${hospitals.map((h) => html`<a class="tag" href="#/admin/hospital/${h.id}">${h.name}<b>${h.visits}</b></a>`)}</div>`
        : html`<p class="muted">This patient hasn't booked anywhere yet.</p>`}
      <h4 class="section-title">Appointment history</h4>
      ${!appts ? skeleton(3, 60) : appts.length ? html`<div class="stack">${appts.map((a) => {
        const dt = parseD(a.date);
        return html`<div class="appt">
          <div class="appt-main">
            <div class="date-tile ${a.status === 'booked' && a.date >= today() ? '' : 'dim'}"><small>${monShort(a.date)}</small><b>${dt.getDate()}</b><small>${DOW[dt.getDay()]}</small></div>
            <div><b>${a.hospital_name}</b><span class="meta">${icon('clock')}${fmtTime(a.time)}${a.reason ? ` · ${a.reason}` : ''}</span></div>
          </div>
          ${badge(a.status)}
        </div>`;
      })}</div>` : html`<p class="muted">No appointments yet.</p>`}
      <p class="muted" style="font-size:12.5px;margin-top:20px">Joined ${p.created_at?.slice(0, 10) ?? ''}</p>`;
  };
}

// ---------------------------------------------------------------------------
// Actions (clicks)
// ---------------------------------------------------------------------------
const actions = {
  nav: ({ href }) => go(href),
  'close-modal': closeModal,
  'confirm-ok': () => { const fn = state.confirm; closeModal(); fn?.(); },
  theme: toggleTheme,
  'theme-menu': () => { toggleTheme(); renderTop(); },

  logout() {
    api('POST', '/auth/logout').catch(() => {});
    clearSession();
    $toasts.innerHTML = '';
    go('/login');
  },

  demo({ email, pw }, el) {
    const form = el.closest('.auth-card').querySelector('form');
    form.email.value = email;
    form.password.value = pw;
    form.requestSubmit();
  },

  'toggle-notif'() {
    state.pop = state.pop === 'notif' ? null : 'notif';
    const n = peek('/notifications');
    if (state.pop === 'notif' && n?.unread) {
      // Hide the badge now; items stay highlighted until the next refresh.
      setCache('/notifications', { ...n, unread: 0 });
      api('POST', '/notifications/read').catch(() => {});
    }
    renderTop();
  },
  'toggle-menu'() { state.pop = state.pop === 'menu' ? null : 'menu'; renderTop(); },
  profile() { state.pop = null; renderTop(); openModal(profileModal()); },

  chip({ v }) {
    state.search.hq = state.search.hq.toLowerCase() === v.toLowerCase() ? '' : v;
    scheduleRender();
  },

  'pick-date': ({ hid, date }) => replaceRoute(`/hospital/${hid}?date=${date}`),
  'pick-slot': (d) => openModal(bookingModal(d), { focus: 'textarea' }),

  ics({ id }) {
    const a = peek('/appointments')?.find((x) => String(x.id) === id);
    if (a) { downloadIcs(a); toast('Calendar file downloaded', 'success'); }
  },

  reschedule({ id }) {
    const a = peek('/appointments')?.find((x) => String(x.id) === id);
    if (!a) return;
    const h = peek(`/hospitals/${a.hospital_id}`) || peek('/hospitals')?.find((x) => x.id === a.hospital_id);
    state.resched = { id: a.id, hid: a.hospital_id, date: h && !isOpenOn(h, a.date) ? firstOpenDate(h) : a.date, time: null };
    state.seen['slots:rs-slot'] = null;
    openDynamicModal(rescheduleView, { cls: 'wide', focus: '.date-chip.active' });
  },
  'rs-date'({ date }) { state.resched.date = date; state.resched.time = null; renderModal(); },
  'rs-slot'({ time }) { state.resched.time = time; renderModal(); },
  'rs-confirm'() {
    const rs = state.resched;
    const a = peek('/appointments')?.find((x) => x.id === rs?.id);
    if (!a || !rs.time) return;
    const { date, time } = rs;
    closeModal();
    const oldKey = slotsKey(a.hospital_id, a.date);
    const newKey = slotsKey(a.hospital_id, date);
    optimistic({
      keys: ['/appointments', oldKey, newKey],
      apply() {
        mutate('/appointments', (list) => list.map((x) => (x.id === a.id ? { ...x, date, time } : x)));
        mutate(oldKey, (d) => ({ ...d, slots: d.slots.map((s) => (s.time === a.time ? { ...s, status: 'free' } : s)) }));
        mutate(newKey, (d) => ({ ...d, slots: d.slots.map((s) => (s.time === time ? { ...s, status: 'mine' } : s)) }));
      },
      request: () => api('POST', `/appointments/${a.id}/reschedule`, { date, time }),
      commit: (updated) => mutate('/appointments', (list) => list.map((x) => (x.id === a.id ? updated : x))),
    });
    toast(`Moved to ${fmtDate(date)} at ${fmtTime(time)}`, 'success');
    refreshSoon(['/notifications']);
  },

  'patient-cancel'({ id }) {
    const a = peek('/appointments')?.find((x) => String(x.id) === id);
    if (!a) return;
    confirmBox({
      title: 'Cancel appointment?',
      text: `${a.hospital_name} · ${fmtDate(a.date, true)} at ${fmtTime(a.time)}`,
      ok: 'Yes, cancel it',
      danger: true,
      onOk() {
        const sKey = slotsKey(a.hospital_id, a.date);
        optimistic({
          keys: ['/appointments', sKey],
          apply() {
            mutate('/appointments', (list) => list.map((x) => (x.id === a.id ? { ...x, status: 'cancelled' } : x)));
            mutate(sKey, (d) => ({ ...d, slots: d.slots.map((s) => (s.time === a.time ? { ...s, status: 'free' } : s)) }));
          },
          request: () => api('PATCH', `/appointments/${a.id}`, { status: 'cancelled' }),
        });
        toast('Appointment cancelled', 'success');
        refreshSoon(['/notifications']);
      },
    });
  },

  'cal-day': ({ month, day }) => replaceRoute(`/calendar?month=${month}&day=${day}`),
  'cal-nav': ({ month, day }) => replaceRoute(`/calendar?month=${month}${day ? `&day=${day}` : ''}`),

  'hosp-status'({ id, status, key }) {
    const a = peek(key)?.find((x) => String(x.id) === id);
    if (!a) return;
    const run = () => {
      optimistic({
        keys: [key],
        apply: () => mutate(key, (list) => list.map((x) => (x.id === a.id ? { ...x, status } : x))),
        request: () => api('PATCH', `/appointments/${a.id}`, { status }),
      });
      toast(status === 'completed' ? `${a.patient_name} marked as completed` : 'Appointment cancelled', 'success');
      state.cache.delete('/hospital/patients');
    };
    if (status === 'completed') return run();
    confirmBox({
      title: 'Cancel this appointment?',
      text: `${a.patient_name} · ${fmtDate(a.date, true)} at ${fmtTime(a.time)}. The patient will be notified.`,
      ok: 'Cancel appointment',
      danger: true,
      onOk: run,
    });
  },

  'export-month'({ key, month }) {
    const rows = (peek(key) || []).slice().sort(byWhen);
    downloadCsv(`appointments-${month}.csv`, rows, [
      ['Date', (a) => a.date], ['Time', (a) => a.time], ['Patient', (a) => a.patient_name], ['Phone', (a) => a.patient_phone],
      ['Email', (a) => a.patient_email], ['Reason', (a) => a.reason], ['Status', (a) => a.status]]);
  },
  'export-hospital-patients'() {
    downloadCsv('patients.csv', peek('/hospital/patients') || [], [
      ['Name', (p) => p.name], ['Email', (p) => p.email], ['Phone', (p) => p.phone], ['Visits', (p) => p.visits],
      ['Upcoming', (p) => p.upcoming], ['Last appointment', (p) => p.last_date]]);
  },
  'export-admin-patients'() {
    downloadCsv('all-patients.csv', filteredAdminPatients(peek('/admin/patients') || []), [
      ['Name', (p) => p.name], ['Email', (p) => p.email], ['Phone', (p) => p.phone],
      ['Hospitals', (p) => p.hospitals.map((h) => `${h.name} (${h.visits})`).join('; ')],
      ['Appointments', (p) => p.appointments], ['Upcoming', (p) => p.upcoming], ['Last appointment', (p) => p.last_date], ['Joined', (p) => p.created_at]]);
  },

  'patient-drawer'({ id }) { openDynamicModal(patientDrawer(id), { drawer: true, focus: '[data-action=close-modal]' }); },

  'add-hospital': () => openModal(hospitalFormModal()),

  'delete-hospital'({ id }) {
    const h = peek('/admin/hospitals')?.find((x) => String(x.id) === id);
    if (!h) return;
    confirmBox({
      title: `Delete ${h.name}?`,
      text: 'This permanently removes the hospital, its login and all its appointments.',
      ok: 'Delete hospital',
      danger: true,
      onOk() {
        optimistic({
          keys: ['/admin/hospitals'],
          apply: () => mutate('/admin/hospitals', (list) => list.filter((x) => x.id !== h.id)),
          request: () => api('DELETE', `/admin/hospitals/${h.id}`),
        });
        toast(`${h.name} deleted`, 'success');
        state.cache.delete('/admin/patients');
        refreshSoon(['/admin/stats'], 2500);
      },
    });
  },
};

// ---------------------------------------------------------------------------
// Forms (submits)
// ---------------------------------------------------------------------------
function showFormError(form, message) {
  const box = form.querySelector('.form-error');
  if (box) {
    box.textContent = message;
    box.hidden = false;
    box.style.animation = 'none';
    void box.offsetWidth; // restart the shake
    box.style.animation = '';
  } else toast(message, 'error');
}

async function signIn(form, path, data, busyText) {
  const btn = form.querySelector('button:not([type=button])');
  const label = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = html`<span class="spinner" style="width:16px;height:16px;border-width:2px;border-top-color:#fff"></span> ${busyText}`.s;
  try {
    const res = await api('POST', path, data);
    Object.assign(state, { token: res.token, user: res.user, hospital: res.hospital });
    state.cache.clear();
    saveSession();
    go(HOME[res.user.role]);
  } catch (err) {
    showFormError(form, err.message);
    btn.disabled = false;
    btn.innerHTML = label;
  }
}

const forms = {
  login(data, form) {
    if (!data.email || !data.password) return showFormError(form, 'Please enter your email and password.');
    signIn(form, '/auth/login', data, 'Signing in…');
  },

  register(data, form) {
    if (!data.name.trim() || !data.email.trim()) return showFormError(form, 'Please enter your name and email.');
    if (data.password.length < 6) return showFormError(form, 'Password must be at least 6 characters.');
    signIn(form, '/auth/register', data, 'Creating account…');
  },

  book(data) {
    closeModal();
    const hid = Number(data.hospitalId);
    const { date, time, reason } = data;
    const h = peek(`/hospitals/${hid}`);
    const sKey = slotsKey(hid, date);
    const tempId = `tmp-${Date.now()}`;
    state.justBooked = `${sKey}|${time}`;
    setTimeout(() => { state.justBooked = null; }, 700);
    optimistic({
      keys: [sKey, '/appointments'],
      apply() {
        mutate(sKey, (d) => ({ ...d, slots: d.slots.map((s) => (s.time === time ? { ...s, status: 'mine' } : s)) }));
        mutate('/appointments', (list) => [{
          id: tempId, hospital_id: hid, date, time, reason, status: 'booked', pending: true, slot_minutes: h?.slot_minutes,
          hospital_name: h?.name ?? 'Hospital', hospital_city: h?.city, hospital_address: h?.address,
        }, ...list]);
      },
      request: () => api('POST', '/appointments', { hospitalId: hid, date, time, reason }),
      commit: (created) => mutate('/appointments', (list) => list.map((a) => (a.id === tempId ? created : a))),
    });
    toast(`Booked · ${fmtDate(date)} at ${fmtTime(time)}`, 'success', { label: 'View', run: () => go('/my') });
    refreshSoon(['/notifications']);
  },

  profile(data) {
    if (!data.name.trim()) return toast('Name is required', 'error');
    closeModal();
    const prev = state.user;
    state.user = { ...prev, name: data.name.trim(), phone: data.phone.trim() };
    renderTop();
    scheduleRender();
    toast('Profile updated', 'success');
    api('PUT', '/me', data)
      .then((user) => { state.user = user; saveSession(); renderTop(); })
      .catch((err) => { state.user = prev; renderTop(); scheduleRender(); toast(err.message, 'error'); });
  },

  settings(data, form, fd) {
    const payload = { ...data, slot_minutes: Number(data.slot_minutes), days_open: fd.getAll('days_open').map(Number) };
    if (payload.open_time >= payload.close_time) return toast('Closing time must be after opening time', 'error');
    if (!payload.days_open.length) return toast('Choose at least one working day', 'error');
    const next = { ...peek('/hospital/settings'), ...payload, days_open: payload.days_open.join(',') };
    const prevHospital = state.hospital;
    optimistic({
      keys: ['/hospital/settings'],
      apply: () => { setCache('/hospital/settings', next); state.hospital = next; },
      request: () => api('PUT', '/hospital/settings', payload),
      commit: (saved) => { setCache('/hospital/settings', saved); state.hospital = saved; saveSession(); },
      onError: () => { state.hospital = prevHospital; },
    });
    toast('Settings saved', 'success');
  },

  'add-hospital'(data) {
    if (!data.name.trim() || !data.city.trim() || !data.email.trim()) {
      return openModal(hospitalFormModal(data, 'Name, city and login email are required.'));
    }
    if (data.password.length < 6) return openModal(hospitalFormModal(data, 'Password must be at least 6 characters.'));
    closeModal();
    const tempId = `tmp-${Date.now()}`;
    const temp = {
      id: tempId, pending: true, name: data.name.trim(), city: data.city.trim(), login_email: data.email.trim(),
      open_time: '09:00', close_time: '17:00', slot_minutes: 30, days_open: '1,2,3,4,5,6', patients: 0, appointments: 0, upcoming: 0,
    };
    optimistic({
      keys: ['/admin/hospitals'],
      apply: () => mutate('/admin/hospitals', (list) => [...list, temp].sort((a, b) => a.name.localeCompare(b.name))),
      request: () => api('POST', '/admin/hospitals', data),
      commit: (created) => mutate('/admin/hospitals', (list) => list.map((x) => (x.id === tempId ? created : x))),
      onError: (err) => openModal(hospitalFormModal(data, err.message)),
    });
    toast(`${temp.name} added`, 'success');
    refreshSoon(['/admin/stats'], 2500);
  },
};

// Live search & filters: re-render just the results, not the whole page.
const swap = (id, content) => { const el = document.getElementById(id); if (el) el.innerHTML = content.s; };
const inputs = {
  hq(v) {
    state.search.hq = v;
    swap('hq-results', hospitalCards(peek('/hospitals')));
    document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c.dataset.v.toLowerCase() === v.trim().toLowerCase()));
  },
  pq(v) { state.search.pq = v; swap('pq-results', patientsTable(peek('/hospital/patients'), v)); },
  aq(v) { state.search.aq = v; swap('aq-results', adminPatientsTable(peek('/admin/patients'))); },
  ahf(v) { state.adminHospitalFilter = v; swap('aq-results', adminPatientsTable(peek('/admin/patients'))); },
  ahq(v) { state.search.ahq = v; swap('ahq-results', adminHospitalsTable(peek('/admin/hospitals'))); },
  'slot-hint'(_, form) {
    const f = form.closest('form');
    const days = f.querySelectorAll('input[name=days_open]:checked').length;
    if (f.open_time.value && f.close_time.value) swap('slot-hint', slotHint(f.open_time.value, f.close_time.value, Number(f.slot_minutes.value), days));
  },
};

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------
document.addEventListener('click', (e) => {
  if (state.pop && !e.target.closest('.pop-wrap')) {
    state.pop = null;
    renderTop();
  }
  const el = e.target.closest('[data-action]');
  if (!el) return;
  if (el.dataset.action === 'backdrop') {
    if (e.target === el) closeModal();
    return;
  }
  const fn = actions[el.dataset.action];
  if (fn) {
    e.preventDefault();
    fn(el.dataset, el, e);
  }
});

document.addEventListener('submit', (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  const fd = new FormData(form);
  forms[form.dataset.form]?.(Object.fromEntries(fd), form, fd);
});

document.addEventListener('input', (e) => {
  const el = e.target.closest('[data-input]');
  if (el) inputs[el.dataset.input]?.(e.target.value, e.target);
});

// Prefetch on hover/touch so the next screen is usually already loaded on click.
const onIntent = (e) => {
  const el = e.target.closest?.('[data-prefetch]');
  if (el) prefetch(el.dataset.prefetch);
};
document.addEventListener('mouseover', onIntent, { passive: true });
document.addEventListener('touchstart', onIntent, { passive: true });

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if ($modal.firstChild) closeModal();
  else if (state.pop) { state.pop = null; renderTop(); }
});

window.addEventListener('hashchange', () => {
  const pathChanged = route().path !== state.lastView;
  state.pop = null;
  closeModal();
  render();
  if (pathChanged) window.scrollTo(0, 0);
});

// Background refresh: notifications + whatever the current page shows.
function refreshVisible() {
  if (!state.user || document.hidden) return;
  revalidate('/notifications');
  state.renderKeys.forEach((k) => revalidate(k));
}
setInterval(refreshVisible, 15000);
document.addEventListener('visibilitychange', refreshVisible);

// ---------------------------------------------------------------------------
// Boot: render instantly from the saved session, verify it in the background.
// ---------------------------------------------------------------------------
loadSession();
render();
if (state.token) {
  api('GET', '/me')
    .then(({ user, hospital }) => {
      const changed = JSON.stringify([user, hospital]) !== JSON.stringify([state.user, state.hospital]);
      Object.assign(state, { user, hospital });
      saveSession();
      if (changed) scheduleRender();
    })
    .catch(() => {});
}
