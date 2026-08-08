/* Read-only stage display. Point a TV or a spare laptop at /board. */

import { $, el, pluralize, render, subscribe, upNext } from './common.js';
import { qrSvg } from './qr.js';

const app = $('#app');

subscribe((state) => render(app, board(state)));

/**
 * One layout in every state, so the screen never jumps around mid-set: the
 * sign-up code stays put on the left, Now and Next sit beside it, and the
 * lineup fills the width underneath where the names stay biggest.
 */
function board(state) {
  const current = state.current;
  const song = current ? state.songs.find((s) => s.id === current.songId) : null;
  const next = upNext(state);
  const signupUrl = `${location.origin}/`;

  return el('div', { class: 'board' },
    el('div', { class: 'board__head' },
      el('div', { class: 'board__qr' },
        qrSvg(signupUrl, { size: 240 }),
        el('div', { class: 'board__url mono' }, signupUrl.replace(/^https?:\/\//, '')),
      ),

      el('div', { class: 'board__titles' },
        el('div', {},
          el('div', { class: 'board__kicker' }, 'Now'),
          el('div', { class: 'board__now' },
            current ? (song ? song.title : 'Free jam') : 'Between songs'),
          detail(song),
        ),
        el('div', {},
          el('div', { class: 'board__kicker board__kicker--next' }, 'Next'),
          el('div', { class: 'board__next' }, next ? next.title : 'Nothing queued yet'),
          detail(next, true),
        ),
      ),
    ),

    current ? lineup(state, current) : waitingFor(state),

    el('div', { class: 'callout__foot' },
      el('span', {}, state.jam.name),
      el('span', {}, `${pluralize(state.roundIndex, 'song')} played`),
      el('span', {}, `${state.players.filter((p) => p.present).length} musicians here`),
    ),
  );
}

const detail = (song, small = false) => {
  if (!song) return null;
  const text = [song.artist, song.key && `key of ${song.key}`].filter(Boolean).join(' · ');
  return text ? el('div', { class: `board__meta${small ? ' board__meta--small' : ''}` }, text) : null;
};

function lineup(state, current) {
  const nameOf = (id) => state.players.find((p) => p.id === id)?.name || null;

  return el('div', { class: `callout__grid${current.slots.length > 5 ? ' callout__grid--split' : ''}` },
    current.slots.map((slot) => {
      const who = nameOf(slot.playerId);
      return el('div', { class: `callout__row${who ? '' : ' callout__row--empty'}` },
        el('div', { class: 'callout__inst' }, slot.instrument),
        el('div', { class: `callout__name${who ? '' : ' callout__name--empty'}` }, who || 'open'),
      );
    }),
  );
}

/** Between songs the space under the titles becomes the sign-up nudge. */
function waitingFor(state) {
  const waiting = state.players.filter((p) => p.present && p.stats.plays === 0);
  return el('div', { class: 'board__idle' },
    el('p', {}, state.players.length ? 'Scan to sign up and get in the rotation' : 'Scan to get on the list'),
    waiting.length
      ? el('p', { class: 'board__waiting' },
          `Not up yet: ${waiting.slice(0, 8).map((p) => p.name).join(' · ')}`)
      : null,
  );
}
