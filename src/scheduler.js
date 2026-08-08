/**
 * The rotation engine.
 *
 * Two rules govern every pick, and they are not the same kind of rule:
 *
 *   1. Comfort is a hard boundary. If somebody said "not this one", they are
 *      never assigned to it — not to fill a hole, not as a last resort.
 *   2. Fairness is a preference. Rest gaps and turn caps bend (visibly, and
 *      only when the alternative is an empty slot) so the song can still go on.
 *
 * Everything here is pure: state in, lineup out. `server.js` owns persistence.
 */

export const STANCES = ['in', 'maybe', 'out'];
export const LEVELS = ['lead', 'comfortable', 'learning'];

const LEVEL_RANK = { lead: 0, comfortable: 1, learning: 2 };

/** Normalise an instrument name so "Bass " and "bass" are the same chair. */
export function normalizeInstrument(name) {
  return String(name || '').trim().toLowerCase();
}

/**
 * How a player feels about a specific song.
 * An explicit answer always wins; otherwise we fall back to the stance they
 * chose for songs they have not seen ("unknownStance").
 */
export function stanceFor(player, song) {
  if (!song) return player.unknownStance || 'maybe';
  const explicit = player.stances?.[song.id];
  if (explicit && STANCES.includes(explicit)) return explicit;
  return player.unknownStance || 'maybe';
}

/** The instrument entry for a player, or undefined if they don't play it. */
function instrumentEntry(player, instrument) {
  const want = normalizeInstrument(instrument);
  return (player.instruments || []).find((i) => normalizeInstrument(i.name) === want);
}

/**
 * Reasons a player simply cannot take this chair. These never bend.
 * Returns null when the player is eligible.
 */
function hardBlock(player, instrument, song, settings) {
  if (!player.present) return 'on a break';
  if (!instrumentEntry(player, instrument)) return `does not play ${instrument}`;

  const stance = stanceFor(player, song);
  if (stance === 'out') return 'sitting this song out';
  if (stance === 'maybe' && settings.maybeCountsAsAvailable === false) {
    return 'only a "maybe" on this song';
  }

  const cap = player.limits?.maxSongs;
  if (cap != null && player.stats.plays >= cap) return `at their limit of ${cap} songs`;

  if (song && player.limits?.noLeadVocals && normalizeInstrument(instrument) === 'vocals') {
    return 'not taking lead vocals tonight';
  }
  return null;
}

/**
 * Soft rules — the fairness guardrails. A player who trips one of these is
 * still a candidate, just a last-resort candidate, and the UI says why.
 */
function restCheck(player, roundIndex, settings) {
  const last = player.stats.lastRound;
  if (last == null) return { rested: true, waited: Infinity };
  const waited = roundIndex - last;
  if (waited <= settings.restSongs) {
    return { rested: false, waited, why: `played ${waited === 1 ? 'the last song' : `${waited} songs ago`}` };
  }
  if ((player.stats.streak || 0) >= settings.maxConsecutive) {
    return { rested: false, waited, why: `${player.stats.streak} songs back-to-back` };
  }
  return { rested: true, waited };
}

/**
 * Priority order within a chair. Lower sorts first.
 *
 * Rested players outrank tired ones, then it is straight fairness: fewest
 * turns tonight, then a firm "in" over a "maybe", then longest wait, then
 * who actually leads the instrument, then who arrived first.
 */
function rankKey(player, instrument, song, rest) {
  const level = instrumentEntry(player, instrument)?.level || 'comfortable';
  return [
    rest.rested ? 0 : 1,
    player.stats.plays,
    stanceFor(player, song) === 'in' ? 0 : 1,
    -rest.waited,
    LEVEL_RANK[level] ?? 1,
    player.joinedAt,
    player.id,
  ];
}

function compareKeys(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/** Human-readable justification shown next to each name in the call sheet. */
function explain(player, rest) {
  if (player.stats.plays === 0) return 'Has not played yet tonight';
  if (!rest.rested) return `Doubling up — ${rest.why}, nobody else free`;
  if (rest.waited === Infinity) return 'Has not played yet tonight';
  const turns = player.stats.plays === 1 ? '1 turn' : `${player.stats.plays} turns`;
  return `Sat out ${rest.waited === 1 ? '1 song' : `${rest.waited} songs`} · ${turns} tonight`;
}

/** The chairs to fill for a song: the jam's default band, unless the song overrides it. */
export function slotsForSong(song, settings) {
  const template = (song?.slots?.length ? song.slots : settings.slots) || [];
  const out = [];
  for (const slot of template) {
    const count = Math.max(0, Math.min(12, Number(slot.count) || 0));
    for (let i = 0; i < count; i++) {
      out.push({ key: `${normalizeInstrument(slot.instrument)}#${i}`, instrument: slot.instrument });
    }
  }
  return out;
}

/**
 * Build a full lineup for one song.
 *
 * @param {object}   opts
 * @param {object[]} opts.players     roster, each with `stats`
 * @param {object}   opts.song        the song being called (may be null for a free jam)
 * @param {object}   opts.settings    jam settings
 * @param {number}   opts.roundIndex  index of the song about to be played
 * @param {object}   opts.locks       { [slotKey]: playerId } chairs the host pinned by hand
 * @returns {{slots: object[], warnings: string[]}}
 */
export function buildLineup({ players, song, settings, roundIndex, locks = {} }) {
  const slots = slotsForSong(song, settings).map((s) => ({
    ...s,
    playerId: null,
    locked: false,
    blank: false,
    resting: false,
    reason: '',
    candidates: [],
  }));

  const roster = players.filter((p) => !p.removed);
  const taken = new Set();

  // Every chair learns who could sit in it, in priority order.
  for (const slot of slots) {
    slot.candidates = roster
      .map((player) => {
        const blocked = hardBlock(player, slot.instrument, song, settings);
        if (blocked) return null;
        const rest = restCheck(player, roundIndex, settings);
        return { player, rest, key: rankKey(player, slot.instrument, song, rest) };
      })
      .filter(Boolean)
      .sort((a, b) => compareKeys(a.key, b.key));
  }

  const overrides = [];

  // Honour the host's manual picks before anything is auto-assigned — but a
  // pin is not a consent override. Blocked pins are dropped and reported.
  for (const slot of slots) {
    if (!(slot.key in locks)) continue;
    const pinned = locks[slot.key];

    // An empty-string lock is the host saying "leave this chair open" —
    // distinct from "not decided yet", so auto-fill must not undo it.
    if (!pinned) {
      slot.blank = true;
      slot.reason = 'Left open by the host';
      continue;
    }
    const player = roster.find((p) => p.id === pinned);
    if (!player || taken.has(pinned)) continue;

    const blocked = hardBlock(player, slot.instrument, song, settings);
    if (blocked) {
      overrides.push(`${player.name} was pinned to ${slot.instrument} but is ${blocked} — left open.`);
      continue;
    }
    const rest = restCheck(player, roundIndex, settings);
    slot.playerId = pinned;
    slot.locked = true;
    slot.resting = !rest.rested;
    slot.reason = 'Picked by the host';
    taken.add(pinned);
  }

  // Fill the scarcest chairs first — the lone bassist should not be spent on
  // a guitar seat that four other people could have taken.
  const open = slots
    .filter((s) => !s.playerId && !s.blank)
    .sort((a, b) => {
      const av = a.candidates.filter((c) => c.rest.rested).length;
      const bv = b.candidates.filter((c) => c.rest.rested).length;
      if (av !== bv) return av - bv;
      return a.candidates.length - b.candidates.length;
    });

  for (const slot of open) {
    const pick = slot.candidates.find((c) => !taken.has(c.player.id));
    if (!pick) continue;
    slot.playerId = pick.player.id;
    slot.resting = !pick.rest.rested;
    slot.reason = explain(pick.player, pick.rest);
    taken.add(pick.player.id);
  }

  repairEmptySlots(slots, taken);

  const warnings = [...overrides];
  for (const slot of slots) {
    if (slot.playerId || slot.blank) continue;
    const willing = slot.candidates.length;
    warnings.push(
      willing === 0
        ? `No one available on ${slot.instrument} for this song.`
        : `${slot.instrument} is uncovered — everyone who plays it is already on stage.`,
    );
  }
  if (song) {
    const sittingOut = roster.filter((p) => p.present && stanceFor(p, song) === 'out');
    if (sittingOut.length) {
      warnings.push(
        `${sittingOut.map((p) => p.name).join(', ')} ${sittingOut.length === 1 ? 'is' : 'are'} sitting this one out.`,
      );
    }
  }

  return { slots, warnings };
}

/**
 * One swap pass: an empty chair may be fillable by someone already seated
 * elsewhere, if that other chair has a backup. Cheap, and it rescues the
 * common "our only drummer got put on guitar" case.
 */
function repairEmptySlots(slots, taken) {
  for (const empty of slots.filter((s) => !s.playerId && !s.blank && s.candidates.length)) {
    for (const cand of empty.candidates) {
      const seat = slots.find((s) => s.playerId === cand.player.id && !s.locked);
      if (!seat) continue;
      const backup = seat.candidates.find((c) => !taken.has(c.player.id) && c.player.id !== cand.player.id);
      if (!backup) continue;

      empty.playerId = cand.player.id;
      empty.resting = !cand.rest.rested;
      empty.reason = explain(cand.player, cand.rest);

      seat.playerId = backup.player.id;
      seat.resting = !backup.rest.rested;
      seat.reason = explain(backup.player, backup.rest);
      taken.add(backup.player.id);
      break;
    }
  }
}

/**
 * Who is available for a chair but not currently in it — powers the host's
 * one-tap "swap this person out" menu.
 */
export function alternatesFor(slot, excludeIds) {
  return slot.candidates
    .filter((c) => !excludeIds.has(c.player.id))
    .map((c) => ({ id: c.player.id, name: c.player.name, rested: c.rest.rested, plays: c.player.stats.plays }));
}

/**
 * Apply a finished song to the roster: turns counted, streaks updated, and
 * everyone who sat it out moves one song closer to the front of the queue.
 */
export function commitRound(players, lineup, roundIndex) {
  const played = new Set(lineup.slots.map((s) => s.playerId).filter(Boolean));
  for (const player of players) {
    if (played.has(player.id)) {
      const backToBack = player.stats.lastRound === roundIndex - 1;
      player.stats.plays += 1;
      player.stats.streak = backToBack ? (player.stats.streak || 0) + 1 : 1;
      player.stats.lastRound = roundIndex;
      const chair = lineup.slots.find((s) => s.playerId === player.id);
      if (chair) {
        const key = normalizeInstrument(chair.instrument);
        player.stats.byInstrument[key] = (player.stats.byInstrument[key] || 0) + 1;
      }
    } else {
      player.stats.streak = 0;
    }
  }
}

/** Collapse expanded slot instances back into {instrument, count} pairs. */
function groupSlots(acc, slot) {
  const found = acc.find((s) => normalizeInstrument(s.instrument) === normalizeInstrument(slot.instrument));
  if (found) found.count += 1;
  else acc.push({ instrument: slot.instrument, count: 1 });
  return acc;
}

/**
 * Roster-wide read of a song before it is called: who is in, who is out, and
 * whether the band can actually be staffed. Drives the song list's health dots.
 */
export function songReadiness(players, song, settings) {
  const roster = players.filter((p) => !p.removed && p.present);
  const counts = { in: 0, maybe: 0, out: 0 };
  for (const p of roster) counts[stanceFor(p, song)] += 1;

  const gaps = [];
  for (const slot of slotsForSong(song, settings).reduce(groupSlots, [])) {
    const able = roster.filter((p) => !hardBlock(p, slot.instrument, song, settings)).length;
    if (able < slot.count) gaps.push(slot.instrument);
  }
  return { ...counts, gaps, playable: gaps.length === 0 };
}
