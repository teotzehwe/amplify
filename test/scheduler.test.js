import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLineup, commitRound, songReadiness, stanceFor } from '../src/scheduler.js';

let seq = 0;
function player(name, instruments, extra = {}) {
  return {
    id: `p${++seq}`,
    name,
    present: true,
    joinedAt: seq,
    instruments: instruments.map((i) => (typeof i === 'string' ? { name: i, level: 'comfortable' } : i)),
    stances: {},
    unknownStance: 'in',
    limits: {},
    stats: { plays: 0, lastRound: null, streak: 0, byInstrument: {} },
    ...extra,
  };
}

const settings = (over = {}) => ({
  slots: [
    { instrument: 'Vocals', count: 1 },
    { instrument: 'Guitar', count: 1 },
    { instrument: 'Bass', count: 1 },
    { instrument: 'Drums', count: 1 },
  ],
  restSongs: 1,
  maxConsecutive: 1,
  maybeCountsAsAvailable: true,
  ...over,
});

const song = (id = 's1', over = {}) => ({ id, title: 'Sunshine', ...over });

const seated = (lineup, instrument) =>
  lineup.slots.filter((s) => s.instrument === instrument).map((s) => s.playerId);

test('fills every chair when the roster covers the band', () => {
  const players = [player('Ana', ['Vocals']), player('Bo', ['Guitar']), player('Cy', ['Bass']), player('Di', ['Drums'])];
  const lineup = buildLineup({ players, song: song(), settings: settings(), roundIndex: 0 });
  assert.equal(lineup.slots.filter((s) => s.playerId).length, 4);
  assert.deepEqual(lineup.warnings, []);
});

test('never seats someone who marked the song "out", even if the chair goes empty', () => {
  const drummer = player('Di', ['Drums'], { stances: { s1: 'out' } });
  const players = [player('Ana', ['Vocals']), player('Bo', ['Guitar']), player('Cy', ['Bass']), drummer];
  const lineup = buildLineup({ players, song: song(), settings: settings(), roundIndex: 0 });

  assert.deepEqual(seated(lineup, 'Drums'), [null]);
  assert.match(lineup.warnings.join(' '), /No one available on Drums/);
});

test('an "out" stance survives even when the host locked that person in', () => {
  const drummer = player('Di', ['Drums'], { stances: { s1: 'out' } });
  const lineup = buildLineup({
    players: [drummer],
    song: song(),
    settings: settings({ slots: [{ instrument: 'Drums', count: 1 }] }),
    roundIndex: 0,
    locks: { 'drums#0': drummer.id },
  });
  // The host can pin people, but consent is not a chair the host owns.
  assert.equal(lineup.slots[0].playerId, null);
});

test('people who have not played yet go before people who have', () => {
  const veteran = player('Vera', ['Guitar']);
  veteran.stats = { plays: 3, lastRound: 0, streak: 0, byInstrument: {} };
  const rookie = player('Rex', ['Guitar']);

  const lineup = buildLineup({
    players: [veteran, rookie],
    song: song(),
    settings: settings({ slots: [{ instrument: 'Guitar', count: 1 }] }),
    roundIndex: 5,
  });
  assert.equal(lineup.slots[0].playerId, rookie.id);
  assert.match(lineup.slots[0].reason, /not played yet/i);
});

test('a rest gap keeps the same person off two songs in a row', () => {
  const hot = player('Hot', ['Guitar']);
  hot.stats = { plays: 1, lastRound: 4, streak: 1, byInstrument: {} };
  const cool = player('Cool', ['Guitar']);
  cool.stats = { plays: 1, lastRound: 1, streak: 0, byInstrument: {} };

  const lineup = buildLineup({
    players: [hot, cool],
    song: song(),
    settings: settings({ slots: [{ instrument: 'Guitar', count: 1 }] }),
    roundIndex: 5,
  });
  assert.equal(lineup.slots[0].playerId, cool.id);
});

test('the rest gap bends rather than leaving a hole, and says so', () => {
  const only = player('Solo', ['Drums']);
  only.stats = { plays: 4, lastRound: 4, streak: 1, byInstrument: {} };

  const lineup = buildLineup({
    players: [only],
    song: song(),
    settings: settings({ slots: [{ instrument: 'Drums', count: 1 }] }),
    roundIndex: 5,
  });
  assert.equal(lineup.slots[0].playerId, only.id);
  assert.equal(lineup.slots[0].resting, true);
  assert.match(lineup.slots[0].reason, /Doubling up/);
});

test('a firm "in" outranks a "maybe" when turns are equal', () => {
  const unsure = player('Maya', ['Bass'], { stances: { s1: 'maybe' } });
  const sure = player('Sam', ['Bass'], { stances: { s1: 'in' } });

  const lineup = buildLineup({
    players: [unsure, sure],
    song: song(),
    settings: settings({ slots: [{ instrument: 'Bass', count: 1 }] }),
    roundIndex: 0,
  });
  assert.equal(lineup.slots[0].playerId, sure.id);
});

test('"maybe" people can be excluded entirely when the host tightens the setting', () => {
  const unsure = player('Maya', ['Bass'], { stances: { s1: 'maybe' } });
  const lineup = buildLineup({
    players: [unsure],
    song: song(),
    settings: settings({ slots: [{ instrument: 'Bass', count: 1 }], maybeCountsAsAvailable: false }),
    roundIndex: 0,
  });
  assert.equal(lineup.slots[0].playerId, null);
});

test('scarce instruments are staffed before crowded ones', () => {
  // Jo is the only drummer but also plays guitar; three others cover guitar.
  const jo = player('Jo', ['Drums', 'Guitar']);
  const players = [jo, player('G1', ['Guitar']), player('G2', ['Guitar']), player('G3', ['Guitar'])];

  const lineup = buildLineup({
    players,
    song: song(),
    settings: settings({ slots: [{ instrument: 'Guitar', count: 2 }, { instrument: 'Drums', count: 1 }] }),
    roundIndex: 0,
  });
  assert.deepEqual(seated(lineup, 'Drums'), [jo.id]);
  assert.equal(seated(lineup, 'Guitar').filter(Boolean).length, 2);
});

test('a seated player is swapped aside when only they can cover an empty chair', () => {
  // Both play guitar; only Ivy plays bass. A naive pass could seat Ivy on guitar.
  const ivy = player('Ivy', ['Guitar', 'Bass']);
  const gus = player('Gus', ['Guitar']);

  const lineup = buildLineup({
    players: [ivy, gus],
    song: song(),
    settings: settings({ slots: [{ instrument: 'Guitar', count: 1 }, { instrument: 'Bass', count: 1 }] }),
    roundIndex: 0,
  });
  assert.deepEqual(seated(lineup, 'Bass'), [ivy.id]);
  assert.deepEqual(seated(lineup, 'Guitar'), [gus.id]);
});

test('nobody holds two chairs in one song', () => {
  const multi = player('Multi', ['Guitar', 'Bass', 'Drums', 'Vocals']);
  const lineup = buildLineup({ players: [multi], song: song(), settings: settings(), roundIndex: 0 });
  const assigned = lineup.slots.map((s) => s.playerId).filter(Boolean);
  assert.equal(assigned.length, 1);
});

test('a personal song cap is a hard stop', () => {
  const capped = player('Cap', ['Guitar'], { limits: { maxSongs: 2 } });
  capped.stats = { plays: 2, lastRound: 0, streak: 0, byInstrument: {} };

  const lineup = buildLineup({
    players: [capped],
    song: song(),
    settings: settings({ slots: [{ instrument: 'Guitar', count: 1 }] }),
    roundIndex: 9,
  });
  assert.equal(lineup.slots[0].playerId, null);
});

test('players on a break are skipped', () => {
  const away = player('Away', ['Bass'], { present: false });
  const here = player('Here', ['Bass']);
  const lineup = buildLineup({
    players: [away, here],
    song: song(),
    settings: settings({ slots: [{ instrument: 'Bass', count: 1 }] }),
    roundIndex: 0,
  });
  assert.equal(lineup.slots[0].playerId, here.id);
});

test('unrated songs fall back to the stance the player chose for surprises', () => {
  const cautious = player('Cautious', ['Guitar'], { unknownStance: 'out' });
  assert.equal(stanceFor(cautious, song('brand-new')), 'out');

  const lineup = buildLineup({
    players: [cautious],
    song: song('brand-new'),
    settings: settings({ slots: [{ instrument: 'Guitar', count: 1 }] }),
    roundIndex: 0,
  });
  assert.equal(lineup.slots[0].playerId, null);
});

test('committing a song advances turns, streaks and per-instrument tallies', () => {
  const played = player('Played', ['Guitar']);
  const sat = player('Sat', ['Guitar']);
  sat.stats = { plays: 1, lastRound: 2, streak: 1, byInstrument: {} };

  const lineup = { slots: [{ instrument: 'Guitar', playerId: played.id }] };
  commitRound([played, sat], lineup, 3);

  assert.equal(played.stats.plays, 1);
  assert.equal(played.stats.lastRound, 3);
  assert.equal(played.stats.streak, 1);
  assert.equal(played.stats.byInstrument.guitar, 1);
  assert.equal(sat.stats.streak, 0, 'sitting out breaks a streak');
});

test('back-to-back songs raise the streak, a gap resets it', () => {
  const p = player('Streaky', ['Bass']);
  const lineup = { slots: [{ instrument: 'Bass', playerId: p.id }] };
  commitRound([p], lineup, 0);
  commitRound([p], lineup, 1);
  assert.equal(p.stats.streak, 2);
  commitRound([], { slots: [] }, 2);
  commitRound([p], lineup, 3);
  assert.equal(p.stats.streak, 1);
});

test('turns even out across a long night instead of favouring early arrivals', () => {
  const players = ['A', 'B', 'C', 'D', 'E', 'F'].map((n) => player(n, ['Guitar', 'Bass']));
  const cfg = settings({ slots: [{ instrument: 'Guitar', count: 1 }, { instrument: 'Bass', count: 1 }] });

  for (let round = 0; round < 12; round++) {
    const lineup = buildLineup({ players, song: song(`s${round}`), settings: cfg, roundIndex: round });
    commitRound(players, lineup, round);
  }

  const plays = players.map((p) => p.stats.plays);
  assert.equal(plays.reduce((a, b) => a + b, 0), 24);
  assert.ok(Math.max(...plays) - Math.min(...plays) <= 1, `turns should be within one of each other, got ${plays}`);
});

test('someone who joins halfway through is put at the front of the queue', () => {
  const regulars = ['A', 'B'].map((n) => player(n, ['Guitar']));
  const cfg = settings({ slots: [{ instrument: 'Guitar', count: 1 }], restSongs: 0 });
  for (let round = 0; round < 6; round++) {
    const lineup = buildLineup({ players: regulars, song: song(`s${round}`), settings: cfg, roundIndex: round });
    commitRound(regulars, lineup, round);
  }

  const latecomer = player('Late', ['Guitar']);
  const all = [...regulars, latecomer];
  const lineup = buildLineup({ players: all, song: song('s6'), settings: cfg, roundIndex: 6 });
  assert.equal(lineup.slots[0].playerId, latecomer.id);
});

test('readiness reports the split and any instrument the song cannot staff', () => {
  const players = [
    player('Ana', ['Vocals'], { stances: { s1: 'in' } }),
    player('Bo', ['Guitar'], { stances: { s1: 'maybe' } }),
    player('Cy', ['Bass'], { stances: { s1: 'out' } }),
  ];
  const readiness = songReadiness(players, song(), settings());
  assert.deepEqual({ in: readiness.in, maybe: readiness.maybe, out: readiness.out }, { in: 1, maybe: 1, out: 1 });
  assert.deepEqual(readiness.gaps.sort(), ['Bass', 'Drums']);
  assert.equal(readiness.playable, false);
});

test('signing up for a chair puts you in it over someone with no preference', () => {
  const asked = player('Asked', ['Guitar', 'Bass'], { picks: { s1: 'Bass' } });
  const neutral = player('Neutral', ['Bass']);

  const lineup = buildLineup({
    players: [asked, neutral],
    song: song(),
    settings: settings({ slots: [{ instrument: 'Bass', count: 1 }] }),
    roundIndex: 0,
  });
  assert.equal(lineup.slots[0].playerId, asked.id);
});

test('a requested chair wins even when an earlier slot could have claimed you', () => {
  // Maya is the only person available for both chairs, and asked for Keys.
  // Vocals comes first in the template, so a naive fill would take her there.
  const maya = player('Maya', ['Vocals', 'Keys'], { picks: { s1: 'Keys' } });

  const lineup = buildLineup({
    players: [maya],
    song: song(),
    settings: settings({ slots: [{ instrument: 'Vocals', count: 1 }, { instrument: 'Keys', count: 1 }] }),
    roundIndex: 0,
  });
  assert.deepEqual(seated(lineup, 'Keys'), [maya.id], 'she asked for keys');
  assert.deepEqual(seated(lineup, 'Vocals'), [null], 'and is not spent on vocals instead');
  assert.match(lineup.slots.find((s) => s.instrument === 'Keys').reason, /Signed up for Keys/);
});

test('asking for one chair does not get you seated in a different one first', () => {
  // Both play guitar; Kit asked for drums, so the guitar seat should go to Lou.
  const kit = player('Kit', ['Guitar', 'Drums'], { picks: { s1: 'Drums' } });
  const lou = player('Lou', ['Guitar']);

  const lineup = buildLineup({
    players: [kit, lou],
    song: song(),
    settings: settings({ slots: [{ instrument: 'Guitar', count: 1 }, { instrument: 'Drums', count: 1 }] }),
    roundIndex: 0,
  });
  assert.deepEqual(seated(lineup, 'Drums'), [kit.id]);
  assert.deepEqual(seated(lineup, 'Guitar'), [lou.id]);
});

test('in sign-up-only mode, nobody who skipped the song is called', () => {
  const signedUp = player('Signed', ['Guitar'], { stances: { s1: 'in' } });
  // Never touched this song, so they fall back to the join default.
  const silent = player('Silent', ['Guitar'], { unknownStance: 'maybe' });
  const cfg = settings({ slots: [{ instrument: 'Guitar', count: 2 }], maybeCountsAsAvailable: false });

  const lineup = buildLineup({ players: [signedUp, silent], song: song(), settings: cfg, roundIndex: 0 });
  assert.deepEqual(seated(lineup, 'Guitar'), [signedUp.id, null]);
});

test('fairness still applies among people who signed up', () => {
  const busy = player('Busy', ['Guitar'], { stances: { s1: 'in' } });
  busy.stats = { plays: 3, lastRound: 0, streak: 0, byInstrument: {} };
  const fresh = player('Fresh', ['Guitar'], { stances: { s1: 'in' } });

  const lineup = buildLineup({
    players: [busy, fresh],
    song: song(),
    settings: settings({ slots: [{ instrument: 'Guitar', count: 1 }], maybeCountsAsAvailable: false }),
    roundIndex: 5,
  });
  assert.equal(lineup.slots[0].playerId, fresh.id, 'fewest turns still wins among sign-ups');
});

test('a song can override the band template', () => {
  const players = [player('D', ['Drums']), player('P', ['Percussion'])];
  const lineup = buildLineup({
    players,
    song: song('s1', { slots: [{ instrument: 'Percussion', count: 1 }] }),
    settings: settings(),
    roundIndex: 0,
  });
  assert.equal(lineup.slots.length, 1);
  assert.equal(lineup.slots[0].playerId, players[1].id);
});
