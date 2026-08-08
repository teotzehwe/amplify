#!/usr/bin/env node
/**
 * Amplify — open jam sign-up + fair rotation.
 *
 * Zero dependencies on purpose: a jam night should start with `node server.js`
 * on whatever laptop is nearest, with no install step and no internet.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';

import { openStore, newId, DEFAULT_INSTRUMENTS } from './src/store.js';
import { buildLineup, commitRound, alternatesFor, songReadiness, STANCES, LEVELS } from './src/scheduler.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3000;

const store = openStore(process.env.DATA_DIR || join(ROOT, 'data'));

/* ------------------------------------------------------------------ helpers */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const bad = (msg) => new HttpError(400, msg);

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256 * 1024) throw bad('Request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw bad('Expected JSON');
  }
}

/** Trim, cap length, and reject anything that is not a usable string. */
function str(value, { max = 120, field = 'value', required = false, fallback = '' } = {}) {
  if (value == null) {
    if (required) throw bad(`${field} is required`);
    return fallback;
  }
  const out = String(value).replace(/\s+/g, ' ').trim().slice(0, max);
  if (required && !out) throw bad(`${field} is required`);
  return out;
}

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function intOrNull(value, { min = 1, max = 99 } = {}) {
  if (value == null || value === '') return null;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

function parseInstruments(input) {
  if (!Array.isArray(input)) throw bad('instruments must be a list');
  const seen = new Set();
  const out = [];
  for (const raw of input.slice(0, 12)) {
    const name = str(typeof raw === 'string' ? raw : raw?.name, { max: 40 });
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, level: oneOf(raw?.level, LEVELS, 'comfortable') });
  }
  if (!out.length) throw bad('Pick at least one instrument');
  return out;
}

function parseStances(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const [songId, stance] of Object.entries(input).slice(0, 500)) {
    if (!STANCES.includes(stance)) continue;
    out[str(songId, { max: 40 })] = stance;
  }
  return out;
}

function parseLimits(input = {}) {
  return {
    maxSongs: intOrNull(input.maxSongs, { min: 1, max: 50 }),
    noLeadVocals: Boolean(input.noLeadVocals),
  };
}

function parseSlots(input, fallback) {
  if (!Array.isArray(input)) return fallback;
  const out = [];
  for (const slot of input.slice(0, 12)) {
    const instrument = str(slot?.instrument, { max: 40 });
    const count = intOrNull(slot?.count, { min: 0, max: 12 });
    if (!instrument || count == null) continue;
    out.push({ instrument, count });
  }
  return out.length ? out : fallback;
}

/* ------------------------------------------------------------------- lineup */

/**
 * Build a lineup and decorate it for the UI: names resolved, and a ready-made
 * list of who else could take each chair so swapping is one tap.
 */
function computeLineup(state, songId, locks = {}) {
  const song = state.songs.find((s) => s.id === songId) || null;
  const lineup = buildLineup({
    players: state.players,
    song,
    settings: state.jam,
    roundIndex: state.roundIndex,
    locks,
  });

  const taken = new Set(lineup.slots.map((s) => s.playerId).filter(Boolean));
  return {
    songId: song?.id || null,
    locks,
    createdAt: Date.now(),
    warnings: lineup.warnings,
    slots: lineup.slots.map((slot) => ({
      key: slot.key,
      instrument: slot.instrument,
      playerId: slot.playerId,
      locked: slot.locked,
      blank: slot.blank,
      resting: slot.resting,
      reason: slot.reason,
      alternates: alternatesFor(slot, taken),
    })),
  };
}

/* --------------------------------------------------------------------- API */

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

/** Anything under /api/host/* additionally requires the host token. */
function requireHost(ctx) {
  if (!store.isHost(ctx.hostToken)) throw new HttpError(403, 'Host key required');
}

route('GET', /^\/api\/state$/, (ctx) => {
  const me = store.playerByToken(ctx.playerToken);
  return {
    ...store.publicState(),
    presets: DEFAULT_INSTRUMENTS,
    youId: me?.id || null,
    isHost: store.isHost(ctx.hostToken),
    readiness: Object.fromEntries(
      store.state.songs.map((s) => [s.id, songReadiness(store.state.players, s, store.state.jam)]),
    ),
  };
});

route('POST', /^\/api\/join$/, (ctx) => {
  const name = str(ctx.body.name, { max: 60, field: 'Name', required: true });
  const player = {
    id: newId('u'),
    token: newId(),
    name,
    joinedAt: Date.now(),
    present: true,
    removed: false,
    instruments: parseInstruments(ctx.body.instruments),
    stances: parseStances(ctx.body.stances),
    unknownStance: oneOf(ctx.body.unknownStance, STANCES, 'maybe'),
    limits: parseLimits(ctx.body.limits),
    notes: str(ctx.body.notes, { max: 280 }),
    stats: { plays: 0, lastRound: null, streak: 0, byInstrument: {} },
  };
  store.update((state) => state.players.push(player));
  return { id: player.id, token: player.token };
});

route('PATCH', /^\/api\/players\/([\w-]+)$/, (ctx) => {
  const target = store.state.players.find((p) => p.id === ctx.params[0] && !p.removed);
  if (!target) throw new HttpError(404, 'Player not found');

  const me = store.playerByToken(ctx.playerToken);
  const isHost = store.isHost(ctx.hostToken);
  if (!isHost && me?.id !== target.id) throw new HttpError(403, 'That is not your sign-up');

  const body = ctx.body;
  store.update(() => {
    if (body.name != null) target.name = str(body.name, { max: 60, field: 'Name', required: true });
    if (body.instruments != null) target.instruments = parseInstruments(body.instruments);
    if (body.stances != null) target.stances = { ...target.stances, ...parseStances(body.stances) };
    if (body.unknownStance != null) target.unknownStance = oneOf(body.unknownStance, STANCES, target.unknownStance);
    if (body.limits != null) target.limits = parseLimits(body.limits);
    if (body.notes != null) target.notes = str(body.notes, { max: 280 });
    if (body.present != null) target.present = Boolean(body.present);
  });
  return { ok: true };
});

route('DELETE', /^\/api\/players\/([\w-]+)$/, (ctx) => {
  const target = store.state.players.find((p) => p.id === ctx.params[0]);
  if (!target) throw new HttpError(404, 'Player not found');
  const me = store.playerByToken(ctx.playerToken);
  if (!store.isHost(ctx.hostToken) && me?.id !== target.id) throw new HttpError(403, 'That is not your sign-up');
  store.update(() => {
    target.removed = true;
    target.present = false;
  });
  return { ok: true };
});

route('POST', /^\/api\/songs$/, (ctx) => {
  const isHost = store.isHost(ctx.hostToken);
  const me = store.playerByToken(ctx.playerToken);
  if (!isHost && !store.state.jam.allowSuggestions) throw new HttpError(403, 'Suggestions are closed');
  if (!isHost && !me) throw new HttpError(403, 'Sign up before suggesting songs');

  const song = {
    id: newId('s'),
    title: str(ctx.body.title, { max: 80, field: 'Title', required: true }),
    artist: str(ctx.body.artist, { max: 80 }),
    key: str(ctx.body.key, { max: 12 }),
    notes: str(ctx.body.notes, { max: 200 }),
    slots: Array.isArray(ctx.body.slots) ? parseSlots(ctx.body.slots, null) : null,
    suggestedBy: isHost ? null : me.id,
    addedAt: Date.now(),
  };
  store.update((state) => state.songs.push(song));
  return { id: song.id };
});

route('PATCH', /^\/api\/songs\/([\w-]+)$/, (ctx) => {
  requireHost(ctx);
  const song = store.state.songs.find((s) => s.id === ctx.params[0]);
  if (!song) throw new HttpError(404, 'Song not found');
  store.update(() => {
    if (ctx.body.title != null) song.title = str(ctx.body.title, { max: 80, field: 'Title', required: true });
    if (ctx.body.artist != null) song.artist = str(ctx.body.artist, { max: 80 });
    if (ctx.body.key != null) song.key = str(ctx.body.key, { max: 12 });
    if (ctx.body.notes != null) song.notes = str(ctx.body.notes, { max: 200 });
    if (ctx.body.slots !== undefined) song.slots = ctx.body.slots ? parseSlots(ctx.body.slots, null) : null;
  });
  return { ok: true };
});

route('DELETE', /^\/api\/songs\/([\w-]+)$/, (ctx) => {
  requireHost(ctx);
  store.update((state) => {
    state.songs = state.songs.filter((s) => s.id !== ctx.params[0]);
    if (state.current?.songId === ctx.params[0]) state.current = null;
  });
  return { ok: true };
});

route('POST', /^\/api\/host\/auth$/, (ctx) => {
  if (!store.isHost(ctx.body.token)) throw new HttpError(403, 'That key does not match');
  return { ok: true, jam: store.state.jam.name };
});

route('PATCH', /^\/api\/host\/settings$/, (ctx) => {
  requireHost(ctx);
  const body = ctx.body;
  store.update((state) => {
    const jam = state.jam;
    if (body.name != null) jam.name = str(body.name, { max: 60, fallback: jam.name }) || jam.name;
    if (body.restSongs != null) jam.restSongs = intOrNull(body.restSongs, { min: 0, max: 10 }) ?? 0;
    if (body.maxConsecutive != null) jam.maxConsecutive = intOrNull(body.maxConsecutive, { min: 1, max: 10 }) ?? 1;
    if (body.maybeCountsAsAvailable != null) jam.maybeCountsAsAvailable = Boolean(body.maybeCountsAsAvailable);
    if (body.allowSuggestions != null) jam.allowSuggestions = Boolean(body.allowSuggestions);
    if (body.slots != null) jam.slots = parseSlots(body.slots, jam.slots);
  });
  return { ok: true };
});

/** Draw up a lineup for a song and put it on deck. */
route('POST', /^\/api\/host\/lineup$/, (ctx) => {
  requireHost(ctx);
  const songId = ctx.body.songId ? str(ctx.body.songId, { max: 40 }) : null;
  const locks = {};
  if (ctx.body.locks && typeof ctx.body.locks === 'object') {
    for (const [key, playerId] of Object.entries(ctx.body.locks).slice(0, 24)) {
      locks[str(key, { max: 60 })] = playerId ? str(playerId, { max: 40 }) : '';
    }
  }
  return store.update((state) => {
    state.current = computeLineup(state, songId, locks);
    return state.current;
  });
});

/** Pin, swap, or clear one chair, then rebuild the rest around that choice. */
route('POST', /^\/api\/host\/assign$/, (ctx) => {
  requireHost(ctx);
  if (!store.state.current) throw bad('No song is on deck');
  const key = str(ctx.body.slotKey, { max: 60, field: 'slotKey', required: true });
  const playerId = ctx.body.playerId ? str(ctx.body.playerId, { max: 40 }) : null;

  return store.update((state) => {
    const locks = { ...state.current.locks };
    locks[key] = playerId || ''; // '' means "host wants this chair left open"
    state.current = computeLineup(state, state.current.songId, locks);
    return state.current;
  });
});

/** The song happened: bank the turns and clear the deck. */
route('POST', /^\/api\/host\/commit$/, (ctx) => {
  requireHost(ctx);
  const current = store.state.current;
  if (!current) throw bad('No song is on deck');

  store.update((state) => {
    commitRound(state.players, current, state.roundIndex);
    state.rounds.push({
      index: state.roundIndex,
      songId: current.songId,
      playedAt: Date.now(),
      slots: current.slots.map(({ instrument, playerId }) => ({ instrument, playerId })),
    });
    state.roundIndex += 1;
    state.current = null;
  });
  return { ok: true };
});

/** Called it, didn't play it. No turns counted. */
route('POST', /^\/api\/host\/skip$/, (ctx) => {
  requireHost(ctx);
  store.update((state) => {
    state.current = null;
  });
  return { ok: true };
});

route('POST', /^\/api\/host\/reset$/, (ctx) => {
  requireHost(ctx);
  const mode = oneOf(ctx.body.mode, ['turns', 'night'], 'turns');
  store.update((state) => {
    state.current = null;
    state.rounds = [];
    state.roundIndex = 0;
    for (const p of state.players) p.stats = { plays: 0, lastRound: null, streak: 0, byInstrument: {} };
    if (mode === 'night') {
      state.players = [];
      state.songs = [];
    }
  });
  return { ok: true };
});

/* --------------------------------------------------------------------- SSE */

const clients = new Set();

store.subscribe((version) => {
  for (const res of clients) {
    // A client that vanished mid-write must not stop the others from being
    // notified — nor bubble a socket error up into the request that made
    // the change.
    try {
      res.write(`data: ${version}\n\n`);
    } catch {
      clients.delete(res);
    }
  }
});

function streamEvents(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(`retry: 2000\n\ndata: ${store.version}\n\n`);
  clients.add(res);

  const beat = setInterval(() => res.write(': ping\n\n'), 25000);
  beat.unref?.();
  res.on('close', () => {
    clearInterval(beat);
    clients.delete(res);
  });
}

/* ------------------------------------------------------------------ static */

const PAGES = { '/': 'index.html', '/host': 'host.html', '/board': 'board.html' };

async function serveStatic(url, res) {
  const rel = PAGES[url] || normalize(decodeURIComponent(url)).replace(/^([/\\.])+/, '');
  const file = join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC) || !existsSync(file)) return send(res, 404, { error: 'Not found' });

  const body = await readFile(file);
  send(res, 200, body, {
    'content-type': MIME[extname(file)] || 'application/octet-stream',
    'cache-control': 'no-cache',
  });
}

/* ------------------------------------------------------------------ server */

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  if (path === '/api/events') return streamEvents(res);

  if (path.startsWith('/api/')) {
    try {
      const match = routes.find((r) => r.method === req.method && r.pattern.test(path));
      if (!match) return send(res, 404, { error: 'Unknown endpoint' });

      const ctx = {
        params: path.match(match.pattern).slice(1),
        body: req.method === 'GET' ? {} : await readBody(req),
        hostToken: req.headers['x-host-token'] || url.searchParams.get('k') || '',
        playerToken: req.headers['x-player-token'] || '',
      };
      return send(res, 200, match.handler(ctx) ?? { ok: true });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      return send(res, status, { error: err.message || 'Something went wrong' });
    }
  }

  if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
  return serveStatic(path, res);
});

function lanAddress() {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return 'localhost';
}

server.listen(PORT, () => {
  const host = lanAddress();
  const key = store.state.hostToken;
  store.flush();
  console.log(`
  ♪  Amplify — ${store.state.jam.name}

     Players sign up   http://${host}:${PORT}/
     Host console      http://${host}:${PORT}/host?k=${key}
     Stage display     http://${host}:${PORT}/board

     Host key: ${key}
     Share the sign-up link; keep the host link to yourself.
`);
});
