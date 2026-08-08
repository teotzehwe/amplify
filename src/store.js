/**
 * Persistence. One jam per server, kept in a single JSON file so a night can
 * survive a laptop lid closing. Writes are atomic (temp file + rename) and
 * debounced, because a busy jam touches state on every tap.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const DEFAULT_INSTRUMENTS = [
  'Vocals', 'Guitar', 'Bass', 'Drums', 'Keys', 'Sax', 'Trumpet',
  'Violin', 'Harmonica', 'Percussion', 'Flute', 'Cello', 'Banjo', 'Ukulele',
];

export function newId(prefix = '') {
  return prefix + randomBytes(8).toString('hex');
}

function defaultState() {
  return {
    jam: {
      name: 'Open Jam Night',
      createdAt: Date.now(),
      restSongs: 1,
      maxConsecutive: 1,
      // Sign-ups drive the night: by default only people who signed up for a
      // song can be called for it. The host can widen this in Settings.
      maybeCountsAsAvailable: false,
      allowSuggestions: true,
      slots: [
        { instrument: 'Vocals', count: 1 },
        { instrument: 'Guitar', count: 2 },
        { instrument: 'Bass', count: 1 },
        { instrument: 'Drums', count: 1 },
        { instrument: 'Keys', count: 1 },
      ],
    },
    hostToken: newId(),
    players: [],
    songs: [],
    rounds: [],
    current: null,
    roundIndex: 0,
  };
}

/** Fill in anything a hand-edited or older state file is missing. */
function migrate(state) {
  const base = defaultState();
  const out = { ...base, ...state, jam: { ...base.jam, ...(state.jam || {}) } };
  out.hostToken = state.hostToken || base.hostToken;
  out.players = (state.players || []).map((p) => ({
    limits: {},
    stances: {},
    picks: {},
    instruments: [],
    unknownStance: 'maybe',
    present: true,
    removed: false,
    notes: '',
    ...p,
    stats: { plays: 0, lastRound: null, streak: 0, byInstrument: {}, ...(p.stats || {}) },
  }));
  out.songs = (state.songs || []).map((s) => ({ key: '', notes: '', slots: null, ...s }));
  return out;
}

export class Store {
  constructor(file) {
    this.file = file;
    this.version = 0;
    this.listeners = new Set();
    this.flushTimer = null;
    this.state = existsSync(file) ? migrate(JSON.parse(readFileSync(file, 'utf8'))) : defaultState();
    mkdirSync(dirname(file), { recursive: true });
  }

  /** Mutate state through here so every change bumps the version and notifies clients. */
  update(fn) {
    const result = fn(this.state);
    this.version += 1;
    this.scheduleFlush();
    for (const listener of this.listeners) listener(this.version);
    return result;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, 250);
    this.flushTimer.unref?.();
  }

  flush() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.file);
  }

  /**
   * What a browser is allowed to see. The host token never leaves the server;
   * player tokens are stripped so one phone cannot impersonate another.
   */
  publicState() {
    const { hostToken, ...rest } = this.state;
    return {
      ...rest,
      version: this.version,
      players: rest.players
        .filter((p) => !p.removed)
        .map(({ token, ...p }) => p),
    };
  }

  isHost(token) {
    return Boolean(token) && token === this.state.hostToken;
  }

  playerByToken(token) {
    if (!token) return null;
    return this.state.players.find((p) => p.token === token && !p.removed) || null;
  }
}

export function openStore(dataDir = join(process.cwd(), 'data')) {
  mkdirSync(dataDir, { recursive: true });
  return new Store(join(dataDir, 'jam.json'));
}
