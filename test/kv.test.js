/**
 * Key-value backend tests.
 *
 * These run the real server against a stand-in that speaks the same REST
 * protocol as Upstash/Vercel Redis — a POSTed command array in, `{ result }`
 * out, including the EVAL used for compare-and-set. No network, no account,
 * but the code path exercised is the one that runs on Vercel.
 *
 * What matters here is that state survives across requests without a disk, and
 * that two people writing at the same moment cannot silently lose one of the
 * two sign-ups.
 */

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

/* ------------------------------------------------- a tiny fake Redis (REST) */

function startFakeRedis() {
  const data = new Map();
  let delayNextWrite = 0;

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const args = JSON.parse(Buffer.concat(chunks).toString() || '[]');
    const [cmd, ...rest] = args;

    // Latency belongs on the wire, not inside the command. Redis runs a Lua
    // script atomically, so nothing can slip between the compare and the write.
    if (delayNextWrite) await new Promise((r) => setTimeout(r, delayNextWrite));

    let result = null;
    if (cmd === 'GET') {
      result = data.has(rest[0]) ? data.get(rest[0]) : null;
    } else if (cmd === 'MGET') {
      // Atomic in real Redis, so it is atomic here: one snapshot, both keys.
      result = rest.map((k) => (data.has(k) ? data.get(k) : null));
    } else if (cmd === 'SET') {
      data.set(rest[0], rest[1]);
      result = 'OK';
    } else if (cmd === 'EVAL') {
      // EVAL <script> 2 stateKey versionKey expected state nextVersion
      const [, , stateKey, versionKey, expected, nextState, nextVersion] = rest;
      const current = data.has(versionKey) ? data.get(versionKey) : false;
      const matches = current === expected || (current === false && expected === '0');
      if (matches) {
        data.set(stateKey, nextState);
        data.set(versionKey, nextVersion);
        result = 1;
      } else {
        result = 0;
      }
    } else {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: `unsupported command ${cmd}` }));
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ result }));
  });

  return new Promise((resolve) => {
    server.listen(0, () => resolve({
      server,
      url: `http://127.0.0.1:${server.address().port}`,
      data,
      setWriteDelay: (ms) => { delayNextWrite = ms; },
    }));
  });
}

/* ------------------------------------------------------------------- setup */

let redis;
let app;
let base;
let hostKey;

before(async () => {
  redis = await startFakeRedis();
  const port = 3800 + Math.floor(Math.random() * 300);
  base = `http://127.0.0.1:${port}`;

  app = spawn(process.execPath, ['server.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      KV_REST_API_URL: redis.url,
      KV_REST_API_TOKEN: 'test-token',
      KV_PREFIX: 'kvtest',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  hostKey = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('server did not start')), 10000);
    app.stdout.on('data', (chunk) => {
      buffer += chunk;
      const match = buffer.match(/Host key: (\w+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve(match[1]);
    });
    app.stderr.on('data', (c) => process.stderr.write(c));
  });
});

after(() => {
  app?.kill();
  redis?.server.close();
});

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

/* -------------------------------------------------------------------- tests */

test('the night is stored in the key-value store, not on disk', async () => {
  await call('/join', { method: 'POST', body: { name: 'Stored', instruments: ['Bass'] } });

  const raw = redis.data.get('kvtest:state');
  assert.ok(raw, 'state should be written to the key-value store');
  assert.match(raw, /Stored/, 'the roster should be in the stored blob');
  assert.ok(Number(redis.data.get('kvtest:version')) >= 1, 'a version is tracked alongside it');
});

test('every request reads fresh state, so instances cannot drift apart', async () => {
  const before = (await call('/state')).data.players.length;

  // Somebody else's instance writes directly to the store.
  const blob = JSON.parse(redis.data.get('kvtest:state'));
  blob.jam.name = 'Renamed Elsewhere';
  redis.data.set('kvtest:state', JSON.stringify(blob));
  redis.data.set('kvtest:version', String(Number(redis.data.get('kvtest:version')) + 1));

  const after = await call('/state');
  assert.equal(after.data.jam.name, 'Renamed Elsewhere', 'the next request picks up the newer state');
  assert.equal(after.data.players.length, before);
});

test('the version advances on every write', async () => {
  const before = Number(redis.data.get('kvtest:version'));
  await call('/join', { method: 'POST', body: { name: 'Counter', instruments: ['Keys'] } });
  assert.equal(Number(redis.data.get('kvtest:version')), before + 1);
});

test('simultaneous sign-ups all survive — none is silently lost', async () => {
  await call('/host/reset', { method: 'POST', body: { mode: 'night' }, host: true });

  // Fire them together so they race on the same compare-and-set.
  const names = ['Ana', 'Bo', 'Cy', 'Di', 'Eli', 'Fay', 'Gus', 'Hana'];
  const results = await Promise.all(names.map((name) =>
    call('/join', { method: 'POST', body: { name, instruments: ['Guitar'] } })));

  for (const r of results) assert.equal(r.status, 200, 'every sign-up should be accepted');

  const { data } = await call('/state');
  assert.deepEqual(
    data.players.map((p) => p.name).sort(),
    [...names].sort(),
    'all eight are on the roster',
  );
});

test('a slow write does not drop a concurrent one', async () => {
  await call('/host/reset', { method: 'POST', body: { mode: 'night' }, host: true });
  redis.setWriteDelay(60);

  const [a, b] = await Promise.all([
    call('/join', { method: 'POST', body: { name: 'Slow One', instruments: ['Bass'] } }),
    call('/join', { method: 'POST', body: { name: 'Slow Two', instruments: ['Drums'] } }),
  ]);
  redis.setWriteDelay(0);

  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const { data } = await call('/state');
  assert.deepEqual(data.players.map((p) => p.name).sort(), ['Slow One', 'Slow Two']);
});

test('clients are told to poll, because no stream can be held open', async () => {
  const { data } = await call('/state');
  assert.equal(data.realtime, 'poll');
  assert.equal((await call('/events')).status, 501);
});

test('the host key still never leaves the server', async () => {
  const { data } = await call('/state');
  assert.equal(data.hostToken, undefined);
  for (const p of data.players) assert.equal(p.token, undefined);
});

test('a full round trip works against the key-value store', async () => {
  await call('/host/reset', { method: 'POST', body: { mode: 'night' }, host: true });
  const song = await call('/songs', { method: 'POST', body: { title: 'Remote Song' }, host: true });
  const drummer = await call('/join', {
    method: 'POST',
    body: { name: 'Remote Drummer', instruments: ['Drums'], stances: { [song.data.id]: 'in' } },
  });

  const lineup = await call('/host/lineup', { method: 'POST', body: { songId: song.data.id }, host: true });
  assert.ok(lineup.data.slots.some((s) => s.playerId === drummer.data.id));

  await call('/host/commit', { method: 'POST', host: true });
  const { data } = await call('/state');
  assert.equal(data.roundIndex, 1);
  assert.equal(data.players.find((p) => p.id === drummer.data.id).stats.plays, 1);
});
