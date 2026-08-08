/* Read-only stage display. Point a TV or a spare laptop at /board. */

import { $, el, logoMark, pluralize, render, subscribe } from './common.js';
import { qrSvg } from './qr.js';

const app = $('#app');

subscribe((state) => {
  render(app, state.current ? callSheet(state) : idle(state));
});

function callSheet(state) {
  const current = state.current;
  const song = state.songs.find((s) => s.id === current.songId) || null;
  const nameOf = (id) => state.players.find((p) => p.id === id)?.name || null;

  return el('div', { class: 'callout callout--inline' },
    el('div', {},
      el('div', { class: 'callout__kicker' }, 'Up next'),
      el('div', { class: 'callout__song' }, song ? song.title : 'Free jam'),
      song && (song.artist || song.key)
        ? el('div', { class: 'callout__meta' },
            [song.artist, song.key && `key of ${song.key}`].filter(Boolean).join(' · '))
        : null,
    ),

    el('div', { class: `callout__grid${current.slots.length > 5 ? ' callout__grid--split' : ''}` },
      current.slots.map((slot) => {
        const who = nameOf(slot.playerId);
        return el('div', { class: `callout__row${who ? '' : ' callout__row--empty'}` },
          el('div', { class: 'callout__inst' }, slot.instrument),
          el('div', { class: `callout__name${who ? '' : ' callout__name--empty'}` }, who || 'open'),
        );
      }),
    ),

    el('div', { class: 'callout__foot' },
      el('span', {}, state.jam.name),
      el('span', {}, `${pluralize(state.roundIndex, 'song')} played`),
      el('span', {}, `${state.players.filter((p) => p.present).length} musicians here`),
    ),
  );
}

/**
 * Between songs the board becomes the sign-up card: a code big enough to scan
 * from a table, plus the URL for anyone whose camera will not play along.
 */
function idle(state) {
  const waiting = state.players.filter((p) => p.present && p.stats.plays === 0);
  const signupUrl = `${location.origin}/`;

  return el('div', { class: 'board-idle' },
    logoMark(),
    el('h2', {}, state.jam.name),
    el('div', { class: 'board-idle__qr' }, qrSvg(signupUrl, { size: 260 })),
    el('p', { class: 'board-idle__url mono' }, signupUrl),
    el('p', { class: 'waiting' },
      state.players.length
        ? `${pluralize(state.roundIndex, 'song')} played · ${pluralize(state.players.filter((p) => p.present).length, 'musician')} signed in`
        : 'Scan to get in the rotation'),
    waiting.length
      ? el('p', { class: 'waiting' },
          `Up soon: ${waiting.slice(0, 6).map((p) => p.name).join(' · ')}`)
      : null,
  );
}
