/**
 * API-level tests. These boot the real server in a child process against a
 * throwaway data directory, so routing, validation and auth are covered end
 * to end rather than mocked.
 */

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

let server;
let dataDir;
let base;
let hostKey;

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'amplify-test-'));
  const port = 3400 + Math.floor(Math.random() * 400);
  base = `http://127.0.0.1:${port}`;

  server = spawn(process.execPath, [join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  hostKey = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('server did not start')), 10000);
    server.stdout.on('data', (chunk) => {
      buffer += chunk;
      const match = buffer.match(/Host key: (\w+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve(match[1]);
    });
    server.stderr.on('data', (c) => process.stderr.write(c));
  });
});

after(async () => {
  server?.kill();
  await rm(dataDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ helpers */

async function call(path, { method = 'GET', body, host = false, player } = {}) {
  const res = await fetch(base + '/api' + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(host ? { 'x-host-token': hostKey } : {}),
      ...(player ? { 'x-player-token': player } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const joinAs = (name, instruments = ['Guitar'], extra = {}) =>
  call('/join', { method: 'POST', body: { name, instruments, ...extra } });

/** GET with the path sent verbatim, bypassing URL normalisation. */
function rawGet(path) {
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
}

/* -------------------------------------------------------------------- tests */

test('serves the sign-up page', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
});

test('static paths cannot escape the public directory', async () => {
  // fetch() normalises "../" away, so these go out as raw request paths —
  // percent-encoded traversal is what actually reaches the file handler.
  const paths = [
    '/%2e%2e/server.js',
    '/..%2fserver.js',
    '/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd',
    '/....//server.js',
  ];
  for (const path of paths) {
    const status = await rawGet(path);
    assert.equal(status, 404, `${path} should not be served`);
  }
});

test('the host key is never exposed in public state', async () => {
  const { data } = await call('/state');
  assert.equal(data.hostToken, undefined);
  assert.equal(data.isHost, false);
});

test('player session tokens are stripped from public state', async () => {
  await joinAs('Token Holder');
  const { data } = await call('/state');
  assert.ok(data.players.length > 0);
  for (const p of data.players) assert.equal(p.token, undefined, 'no player token should be published');
});

test('joining requires a name and at least one instrument', async () => {
  assert.equal((await call('/join', { method: 'POST', body: { name: '', instruments: ['Bass'] } })).status, 400);
  assert.equal((await call('/join', { method: 'POST', body: { name: 'Nameless', instruments: [] } })).status, 400);
});

test('host endpoints reject a missing or wrong key', async () => {
  assert.equal((await call('/host/lineup', { method: 'POST', body: {} })).status, 403);
  assert.equal((await call('/host/settings', { method: 'PATCH', body: { restSongs: 4 } })).status, 403);
  assert.equal((await call('/host/reset', { method: 'POST', body: { mode: 'night' } })).status, 403);
  assert.equal((await call('/host/auth', { method: 'POST', body: { token: 'nope' } })).status, 403);
});

test('a player may edit their own sign-up but not anybody else’s', async () => {
  const a = await joinAs('Player A');
  const b = await joinAs('Player B');

  const own = await call(`/players/${a.data.id}`, { method: 'PATCH', body: { present: false }, player: a.data.token });
  assert.equal(own.status, 200);

  const other = await call(`/players/${b.data.id}`, { method: 'PATCH', body: { name: 'Hijacked' }, player: a.data.token });
  assert.equal(other.status, 403);

  const { data } = await call('/state');
  assert.equal(data.players.find((p) => p.id === b.data.id).name, 'Player B');
});

test('the host can edit anyone', async () => {
  const p = await joinAs('Editable');
  const res = await call(`/players/${p.data.id}`, { method: 'PATCH', body: { present: false }, host: true });
  assert.equal(res.status, 200);
});

test('a full round trip: songs, lineup, and committed turns', async () => {
  await call('/host/reset', { method: 'POST', body: { mode: 'night' }, host: true });

  const song = await call('/songs', { method: 'POST', body: { title: 'Test Song' }, host: true });
  assert.equal(song.status, 200);

  // Sign-ups drive the lineup, so both players sign up for this song.
  const drummer = await joinAs('Drummer', ['Drums'], { stances: { [song.data.id]: 'in' } });
  await joinAs('Guitarist', ['Guitar'], { stances: { [song.data.id]: 'in' } });

  const lineup = await call('/host/lineup', { method: 'POST', body: { songId: song.data.id }, host: true });
  assert.equal(lineup.status, 200);
  assert.ok(lineup.data.slots.some((s) => s.playerId === drummer.data.id), 'the drummer should be seated');

  const commit = await call('/host/commit', { method: 'POST', host: true });
  assert.equal(commit.status, 200);

  const { data } = await call('/state');
  assert.equal(data.roundIndex, 1);
  assert.equal(data.current, null);
  assert.equal(data.players.find((p) => p.id === drummer.data.id).stats.plays, 1);
});

test('a song marked "out" keeps that player off the lineup over the wire', async () => {
  await call('/host/reset', { method: 'POST', body: { mode: 'night' }, host: true });
  const song = await call('/songs', { method: 'POST', body: { title: 'Not For Me' }, host: true });

  await joinAs('Unwilling', ['Drums'], { stances: { [song.data.id]: 'out' } });

  const lineup = await call('/host/lineup', { method: 'POST', body: { songId: song.data.id }, host: true });
  const drums = lineup.data.slots.find((s) => s.instrument === 'Drums');
  assert.equal(drums.playerId, null);
  assert.match(lineup.data.warnings.join(' '), /No one available on Drums/);
});

test('skipping a song leaves every turn count untouched', async () => {
  await call('/host/reset', { method: 'POST', body: { mode: 'night' }, host: true });
  const song = await call('/songs', { method: 'POST', body: { title: 'Skipped' }, host: true });
  const p = await joinAs('Skipper', ['Guitar']);

  await call('/host/lineup', { method: 'POST', body: { songId: song.data.id }, host: true });
  await call('/host/skip', { method: 'POST', host: true });

  const { data } = await call('/state');
  assert.equal(data.roundIndex, 0);
  assert.equal(data.current, null);
  assert.equal(data.players.find((x) => x.id === p.data.id).stats.plays, 0);
});

test('a signed-in player can suggest songs, with no limit on how many', async () => {
  await call('/host/reset', { method: 'POST', body: { mode: 'night' }, host: true });
  const p = await joinAs('Suggester', ['Guitar']);

  for (let i = 0; i < 25; i++) {
    const res = await call('/songs', {
      method: 'POST',
      body: { title: `Idea ${i}`, artist: 'Someone' },
      player: p.data.token,
    });
    assert.equal(res.status, 200, `suggestion ${i} should be accepted`);
  }

  const { data } = await call('/state');
  assert.equal(data.songs.length, 25);
  assert.ok(data.songs.every((s) => s.suggestedBy === p.data.id), 'each is credited to the suggester');
});

test('suggestions are refused when the host closes them', async () => {
  await call('/host/reset', { method: 'POST', body: { mode: 'night' }, host: true });
  const p = await joinAs('Hopeful', ['Guitar']);
  await call('/host/settings', { method: 'PATCH', body: { allowSuggestions: false }, host: true });

  const res = await call('/songs', { method: 'POST', body: { title: 'Nope' }, player: p.data.token });
  assert.equal(res.status, 403);

  // The host is never blocked by that setting.
  assert.equal((await call('/songs', { method: 'POST', body: { title: 'Host pick' }, host: true })).status, 200);
  await call('/host/settings', { method: 'PATCH', body: { allowSuggestions: true }, host: true });
});

test('a stranger with no sign-up cannot suggest songs', async () => {
  const res = await call('/songs', { method: 'POST', body: { title: 'Drive-by' } });
  assert.equal(res.status, 403);
});

test('you can take back your own suggestion, but not somebody else’s', async () => {
  await call('/host/reset', { method: 'POST', body: { mode: 'night' }, host: true });
  const mine = await joinAs('Mine', ['Guitar']);
  const other = await joinAs('Other', ['Guitar']);

  const song = await call('/songs', { method: 'POST', body: { title: 'Mine to pull' }, player: mine.data.token });

  const wrong = await call(`/songs/${song.data.id}`, { method: 'DELETE', player: other.data.token });
  assert.equal(wrong.status, 403);

  const right = await call(`/songs/${song.data.id}`, { method: 'DELETE', player: mine.data.token });
  assert.equal(right.status, 200);
  assert.equal((await call('/state')).data.songs.length, 0);
});

test('a suggestion cannot be pulled once someone else has signed up for it', async () => {
  await call('/host/reset', { method: 'POST', body: { mode: 'night' }, host: true });
  const mine = await joinAs('Author', ['Guitar']);
  const fan = await joinAs('Fan', ['Bass']);

  const song = await call('/songs', { method: 'POST', body: { title: 'Popular' }, player: mine.data.token });
  await call(`/players/${fan.data.id}`, {
    method: 'PATCH', body: { stances: { [song.data.id]: 'in' } }, player: fan.data.token,
  });

  const blocked = await call(`/songs/${song.data.id}`, { method: 'DELETE', player: mine.data.token });
  assert.equal(blocked.status, 400);
  assert.match(blocked.data.error, /signed up for it/);

  // The host can still remove it.
  assert.equal((await call(`/songs/${song.data.id}`, { method: 'DELETE', host: true })).status, 200);
});

test('removing a song clears the sign-ups that pointed at it', async () => {
  await call('/host/reset', { method: 'POST', body: { mode: 'night' }, host: true });
  const p = await joinAs('Fan', ['Guitar']);
  const song = await call('/songs', { method: 'POST', body: { title: 'Doomed' }, host: true });

  await call(`/players/${p.data.id}`, {
    method: 'PATCH',
    body: { stances: { [song.data.id]: 'in' }, picks: { [song.data.id]: 'Guitar' } },
    player: p.data.token,
  });
  await call(`/songs/${song.data.id}`, { method: 'DELETE', host: true });

  const { data } = await call('/state');
  const player = data.players.find((x) => x.id === p.data.id);
  assert.deepEqual(player.stances, {}, 'no orphaned sign-up');
  assert.deepEqual(player.picks, {}, 'no orphaned chair request');
});

test('unknown endpoints and methods are refused cleanly', async () => {
  assert.equal((await call('/nope')).status, 404);
  assert.equal((await call('/state', { method: 'DELETE' })).status, 404);
});

test('oversized and malformed payloads are rejected, not crashed on', async () => {
  const res = await fetch(base + '/api/join', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'not json at all',
  });
  assert.equal(res.status, 400);

  // The server must still be answering afterwards.
  assert.equal((await call('/state')).status, 200);
});

test('free text is length-capped rather than stored unbounded', async () => {
  const res = await joinAs('x'.repeat(500), ['Guitar'], { notes: 'y'.repeat(2000) });
  const { data } = await call('/state');
  const player = data.players.find((p) => p.id === res.data.id);
  assert.ok(player.name.length <= 60);
  assert.ok(player.notes.length <= 280);
});
