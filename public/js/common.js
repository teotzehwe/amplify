/* Shared plumbing: tiny DOM builder, API client, live-state subscription. */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * Build an element. Children are set as text nodes unless they are already
 * nodes — user-entered names and song titles never reach innerHTML.
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style') Object.assign(node.style, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key in node && key !== 'list') node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(3)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const frag = (...children) => {
  const f = document.createDocumentFragment();
  for (const c of children.flat(3)) if (c != null && c !== false) f.append(c instanceof Node ? c : String(c));
  return f;
};

/** Replace a container's contents in one shot. */
export function render(container, ...children) {
  container.replaceChildren(...frag(...children).childNodes);
}

/* ------------------------------------------------------------------ tokens */

const KEYS = { host: 'amplify.hostKey', player: 'amplify.playerToken', playerId: 'amplify.playerId' };

export const tokens = {
  get host() { return localStorage.getItem(KEYS.host) || new URL(location.href).searchParams.get('k') || ''; },
  set host(v) { v ? localStorage.setItem(KEYS.host, v) : localStorage.removeItem(KEYS.host); },
  get player() { return localStorage.getItem(KEYS.player) || ''; },
  set player(v) { v ? localStorage.setItem(KEYS.player, v) : localStorage.removeItem(KEYS.player); },
  get playerId() { return localStorage.getItem(KEYS.playerId) || ''; },
  set playerId(v) { v ? localStorage.setItem(KEYS.playerId, v) : localStorage.removeItem(KEYS.playerId); },
};

/* --------------------------------------------------------------------- api */

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(tokens.host ? { 'x-host-token': tokens.host } : {}),
      ...(tokens.player ? { 'x-player-token': tokens.player } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/* ------------------------------------------------------------------- toast */

let toastTimer;
export function toast(message, kind = '') {
  let node = $('.toast');
  if (!node) document.body.append((node = el('div', { class: 'toast' })));
  node.className = `toast is-shown${kind ? ` toast--${kind}` : ''}`;
  node.textContent = message;
  node.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('is-shown'), 2600);
}

/** Wrap an async handler so failures surface as a toast instead of a dead click. */
export function guard(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      toast(err.message, 'error');
    }
  };
}

/* ------------------------------------------------------------- live state */

/**
 * Fetch state now, then again whenever the server says something changed.
 * Falls back to polling if the event stream drops (flaky venue wifi).
 */
export function subscribe(onState) {
  let last = -1;
  let busy = false;
  let queued = false;

  // `force` matters right after signing up: the version may already have been
  // consumed by an SSE refresh that started before our token was stored. Such a
  // refresh is also likely to be in flight, so a forced pull that arrives while
  // one is running has to be re-run rather than dropped.
  async function pull(force = false) {
    if (busy) {
      queued = queued || force;
      return;
    }
    busy = true;
    try {
      const state = await api('/state');
      if (force || state.version !== last) {
        last = state.version;
        onState(state);
      }
    } catch (err) {
      console.warn('state refresh failed', err);
    } finally {
      busy = false;
      if (queued) {
        queued = false;
        await pull(true);
      }
    }
  }

  pull();
  const events = new EventSource('/api/events');
  events.onmessage = () => pull();
  events.onerror = () => {}; // EventSource retries on its own

  const poll = setInterval(pull, 10000);
  window.addEventListener('beforeunload', () => {
    events.close();
    clearInterval(poll);
  });
  return pull;
}

/* ------------------------------------------------------------------ pieces */

export function logoMark() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML =
    '<path d="M4 13v-2m4 6V7m4 13V4m4 13V7m4 6v-2" stroke="#0b0909" stroke-width="2.4" stroke-linecap="round"/>';
  return el('div', { class: 'mark' }, svg);
}

export function masthead(title, subtitle, ...extra) {
  return el('header', { class: 'masthead' },
    logoMark(),
    el('div', { class: 'grow' },
      el('h1', {}, title),
      subtitle && el('div', { class: 'sub' }, subtitle),
    ),
    ...extra,
  );
}

export const pluralize = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
