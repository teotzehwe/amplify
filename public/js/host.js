/* The host console: pick a song, get a fair lineup, call it out. */

import {
  $, api, el, guard, masthead, pluralize, render, subscribe, toast, tokens,
} from './common.js';
import { qrSvg } from './qr.js';

const app = $('#app');
const overlayRoot = $('#overlay');

let state = null;
let authed = false;
let tab = 'now';
let songQuery = '';
let calloutOpen = false;
let refresh = () => {};

/* -------------------------------------------------------------------- boot */

(async function boot() {
  const url = new URL(location.href);
  const fromLink = url.searchParams.get('k');
  if (fromLink) {
    tokens.host = fromLink;
    history.replaceState({}, '', '/host'); // keep the key out of the address bar
  }

  if (tokens.host) {
    authed = await api('/host/auth', { method: 'POST', body: { token: tokens.host } })
      .then(() => true)
      .catch(() => false);
  }
  refresh = subscribe((next) => {
    state = next;
    draw();
  });
})();

function draw() {
  if (!state) return;
  render(app, authed ? console_() : gate());
  render(overlayRoot, calloutOpen && state.current ? callout(state.current, { closable: true }) : null);
}

/* -------------------------------------------------------------------- gate */

function gate() {
  const submit = guard(async () => {
    const key = $('#hostkey').value.trim();
    await api('/host/auth', { method: 'POST', body: { token: key } });
    tokens.host = key;
    authed = true;
    refresh(true);
  });

  return el('div', { class: 'gate stack stack--lg' },
    masthead('Amplify', 'Host console'),
    el('section', { class: 'card stack' },
      el('div', { class: 'field' },
        el('label', { for: 'hostkey' }, 'Host key'),
        el('input', {
          id: 'hostkey',
          type: 'text',
          class: 'mono',
          placeholder: 'Paste the key from the terminal',
          onKeydown: (e) => e.key === 'Enter' && submit(),
        }),
      ),
      el('button', { class: 'btn btn--primary btn--block', onClick: submit }, 'Unlock console'),
      el('p', { class: 'section-note' },
        'The server prints this key — and a ready-made link — when it starts up.'),
    ),
  );
}

/* ------------------------------------------------------------------ shell */

const TABS = [
  ['now', 'Now'],
  ['roster', 'Roster'],
  ['songs', 'Songs'],
  ['settings', 'Settings'],
];

function console_() {
  const present = state.players.filter((p) => p.present).length;
  const counts = { roster: state.players.length, songs: state.songs.length };

  return el('div', { class: 'stack stack--lg' },
    masthead(state.jam.name, `${pluralize(state.roundIndex, 'song')} played · ${present} here now`,
      el('a', { class: 'btn btn--ghost btn--sm', href: '/board', target: '_blank' }, 'Stage display ↗'),
    ),

    el('nav', { class: 'tabs', role: 'tablist' },
      TABS.map(([id, label]) =>
        el('button', {
          role: 'tab',
          'aria-selected': String(tab === id),
          onClick: () => { tab = id; draw(); },
        }, label, counts[id] != null ? el('span', { class: 'count' }, counts[id]) : null),
      ),
    ),

    tab === 'now' ? nowTab() : null,
    tab === 'roster' ? rosterTab() : null,
    tab === 'songs' ? songsTab() : null,
    tab === 'settings' ? settingsTab() : null,
  );
}

/* -------------------------------------------------------------------- now */

function nowTab() {
  return state.current ? callSheet(state.current) : songChooser();
}

const songById = (id) => state.songs.find((s) => s.id === id) || null;
const playerById = (id) => state.players.find((p) => p.id === id) || null;

const drawLineup = (songId) => guard(async () => {
  await api('/host/lineup', { method: 'POST', body: { songId, locks: {} } });
  tab = 'now';
})();

/** Song picker with a live read on who can actually play each one. */
function songChooser() {
  if (!state.players.length) {
    return el('section', { class: 'card' },
      el('div', { class: 'empty' },
        'Nobody has signed up yet. Share the sign-up link from Settings and the roster will fill in here.'),
    );
  }

  const query = songQuery.trim().toLowerCase();
  const matches = state.songs.filter((s) =>
    !query || `${s.title} ${s.artist}`.toLowerCase().includes(query));

  return el('div', { class: 'stack' },
    el('section', { class: 'card stack' },
      el('div', { class: 'card__head' },
        el('h2', {}, "What's next?"),
        el('span', { class: 'hint' }, 'Pick a song and Amplify builds the band'),
      ),
      state.songs.length > 4
        ? el('input', {
            id: 'song-filter',
            type: 'search',
            placeholder: 'Filter songs…',
            value: songQuery,
            onInput: (e) => { songQuery = e.target.value; draw(); },
          })
        : null,

      state.songs.length
        ? el('div', { class: 'stack' }, matches.map(songChoice))
        : el('div', { class: 'empty' }, 'No songs yet — add a few under the Songs tab.'),

      el('hr', { class: 'divider' }),
      el('button', {
        class: 'btn btn--ghost btn--block',
        onClick: () => drawLineup(null),
      }, 'Free jam — build a band with no song set'),
    ),
  );
}

function songChoice(song) {
  const r = state.readiness[song.id] || { in: 0, maybe: 0, out: 0, gaps: [], playable: true };
  return el('div', { class: 'song-card' },
    el('div', {},
      el('div', { class: 'song-card__title' }, song.title),
      el('div', { class: 'muted small' },
        [song.artist, song.key && `key of ${song.key}`].filter(Boolean).join(' · ') || '—'),
      el('div', { class: 'readiness' },
        el('span', { class: 'tag tag--in' }, el('i', { class: 'dot dot--in' }), `${r.in} signed up`),
        r.maybe ? el('span', { class: 'tag' }, `${r.maybe} have not`) : null,
        r.out ? el('span', { class: 'tag tag--out' }, el('i', { class: 'dot dot--out' }), `${r.out} sitting out`) : null,
        r.gaps.length ? el('span', { class: 'tag tag--out' }, `No ${r.gaps.join(', no ')}`) : null,
      ),
    ),
    el('button', { class: 'btn btn--primary', onClick: () => drawLineup(song.id) }, 'Draw lineup'),
  );
}

/** The lineup on deck: who plays what, why, and one-tap swaps. */
function callSheet(current) {
  const song = songById(current.songId);
  const filled = current.slots.filter((s) => s.playerId).length;
  const hasPicks = Object.keys(current.locks || {}).length > 0;

  return el('div', { class: 'stack' },
    el('section', { class: 'card stack' },
      el('div', { class: 'row row--between row--wrap' },
        el('div', {},
          el('div', { class: 'tiny faint', style: { letterSpacing: '0.18em', textTransform: 'uppercase' } }, 'On deck'),
          el('h2', { style: { fontSize: '1.5rem', marginTop: '2px' } }, song ? song.title : 'Free jam'),
          el('div', { class: 'muted small' },
            song ? [song.artist, song.key && `key of ${song.key}`].filter(Boolean).join(' · ') : 'No song set',
          ),
        ),
        el('div', { class: 'row' },
          hasPicks
            ? el('button', {
                class: 'btn btn--ghost btn--sm',
                onClick: guard(() => api('/host/lineup', { method: 'POST', body: { songId: current.songId, locks: {} } })),
              }, 'Clear my picks')
            : null,
          el('button', {
            class: 'btn btn--sm',
            onClick: guard(() => api('/host/lineup', {
              method: 'POST',
              body: { songId: current.songId, locks: current.locks },
            })),
          }, 'Redraw'),
        ),
      ),

      // A lineup is a snapshot. If someone withdraws or steps out after it was
      // drawn, say so here rather than letting the host call a name that is no
      // longer good.
      el('div', { class: 'stack', style: { gap: '8px' } },
        staleSeats(current, song).map((w) => el('div', { class: 'alert alert--error' }, w)),
        current.warnings.map((w) => el('div', { class: 'alert alert--warn' }, w)),
      ),

      el('div', { class: 'stack', style: { gap: '8px' } }, current.slots.map(slotRow)),

      el('div', { class: 'row row--wrap', style: { marginTop: '6px' } },
        el('button', {
          class: 'btn btn--primary btn--lg grow',
          onClick: () => { calloutOpen = true; draw(); },
        }, 'Call it out'),
        el('button', {
          class: 'btn btn--lg',
          disabled: !filled,
          onClick: guard(async () => {
            await api('/host/commit', { method: 'POST' });
            calloutOpen = false;
            toast('Logged — everyone on stage moves down the queue');
          }),
        }, 'Played ✓'),
        el('button', {
          class: 'btn btn--ghost btn--lg',
          onClick: guard(() => api('/host/skip', { method: 'POST' })),
        }, 'Cancel'),
      ),
      el('p', { class: 'section-note' },
        'Played ✓ counts everyone on stage. Cancel drops the lineup without counting turns.'),
    ),
  );
}

/**
 * Seats that have gone stale since the lineup was drawn — someone withdrew
 * their sign-up or went on a break. Redrawing clears these.
 */
function staleSeats(current, song) {
  const notes = [];
  for (const slot of current.slots) {
    const player = slot.playerId ? playerById(slot.playerId) : null;
    if (!player) continue;
    if (!player.present) {
      notes.push(`${player.name} (${slot.instrument}) is on a break now — redraw before calling it.`);
    } else if (song && player.stances?.[song.id] !== 'in') {
      notes.push(`${player.name} (${slot.instrument}) withdrew from this song — redraw before calling it.`);
    }
  }
  return notes;
}

function slotRow(slot) {
  const player = playerById(slot.playerId);
  const classes = ['slot'];
  if (!player) classes.push('slot--empty');
  else if (slot.locked) classes.push('slot--locked');
  else if (slot.resting) classes.push('slot--resting');

  const picker = el('select', {
    'aria-label': `Who plays ${slot.instrument}`,
    onChange: guard((e) => api('/host/assign', {
      method: 'POST',
      body: { slotKey: slot.key, playerId: e.target.value || null },
    })),
  });
  if (player) picker.append(el('option', { value: player.id, selected: true }, `${player.name} — on stage`));
  for (const alt of slot.alternates) {
    picker.append(el('option', { value: alt.id },
      `${alt.name} — ${pluralize(alt.plays, 'turn')}${alt.rested ? '' : ' (needs a rest)'}`));
  }
  picker.append(el('option', { value: '', selected: !player }, 'Leave empty'));

  return el('div', { class: classes.join(' ') },
    el('div', { class: 'slot__inst' }, slot.instrument),
    el('div', {},
      player
        ? el('div', { class: 'slot__name' }, player.name,
            slot.locked ? el('span', { class: 'tag tag--lead', style: { marginLeft: '8px' } }, 'your pick') : null,
            slot.resting ? el('span', { class: 'tag tag--maybe', style: { marginLeft: '8px' } }, 'no rest') : null)
        : el('div', { class: 'slot__name slot__name--empty' },
            slot.blank ? 'Left open' : 'Nobody available'),
      slot.reason ? el('div', { class: 'slot__why' }, slot.reason) : null,
    ),
    picker,
  );
}

/* ------------------------------------------------------------------ roster */

/** Roster ordered the way the queue sees it: next in line at the top. */
function queueOrder(players) {
  return [...players].sort((a, b) =>
    a.stats.plays - b.stats.plays ||
    (a.stats.lastRound ?? -1) - (b.stats.lastRound ?? -1) ||
    a.joinedAt - b.joinedAt);
}

function rosterTab() {
  if (!state.players.length) {
    return el('section', { class: 'card' },
      el('div', { class: 'empty' }, 'No sign-ups yet. The link lives in Settings.'));
  }

  const maxPlays = Math.max(1, ...state.players.map((p) => p.stats.plays));
  const waiting = state.players.filter((p) => p.present && p.stats.plays === 0).length;

  return el('div', { class: 'stack' },
    el('section', { class: 'card' },
      el('div', { class: 'stat-strip' },
        el('div', { class: 'stat' }, el('b', {}, state.players.length), el('span', {}, 'Signed up')),
        el('div', { class: 'stat' },
          el('b', {}, state.players.filter((p) => p.present).length), el('span', {}, 'Here now')),
        el('div', { class: 'stat' }, el('b', {}, waiting), el('span', {}, 'Still waiting')),
        el('div', { class: 'stat' }, el('b', {}, state.roundIndex), el('span', {}, 'Songs played')),
      ),
      waiting
        ? el('div', { class: 'alert alert--info', style: { marginTop: '14px' } },
            `${pluralize(waiting, 'person', 'people')} ${waiting === 1 ? 'has' : 'have'} not played yet — they sit at the front of the queue.`)
        : null,
    ),
    el('section', { class: 'card' },
      el('div', { class: 'card__head' },
        el('h2', {}, 'Queue order'),
        el('span', { class: 'hint' }, 'Next in line first'),
      ),
      el('div', { class: 'roster' }, queueOrder(state.players).map((p) => personCard(p, maxPlays))),
    ),
  );
}

function personCard(person, maxPlays) {
  const stances = Object.values(person.stances || {});
  const outs = stances.filter((s) => s === 'out').length;
  const maybes = stances.filter((s) => s === 'maybe').length;
  const save = guard((patch) => api(`/players/${person.id}`, { method: 'PATCH', body: patch }));

  return el('div', { class: `person${person.present ? '' : ' person--away'}` },
    el('div', { class: 'person__top' },
      el('span', { class: `dot dot--${person.present ? 'in' : 'out'}` }),
      el('span', { class: 'person__name grow truncate' }, person.name),
      el('span', { class: 'turns' }, pluralize(person.stats.plays, 'turn')),
    ),
    el('div', { class: 'queue-bar' },
      el('i', { style: { width: `${(person.stats.plays / maxPlays) * 100}%` } })),
    el('div', { class: 'row row--wrap', style: { gap: '6px' } },
      person.instruments.map((i) =>
        el('span', { class: `tag${i.level === 'lead' ? ' tag--lead' : ''}` }, i.name)),
    ),
    el('div', { class: 'row row--wrap tiny faint', style: { gap: '10px' } },
      el('span', {}, person.stats.lastRound == null
        ? 'Not up yet tonight'
        : `Last played song ${person.stats.lastRound + 1}`),
      outs ? el('span', {}, `· sits out ${outs}`) : null,
      maybes ? el('span', {}, `· ${maybes} maybe`) : null,
      person.limits?.maxSongs ? el('span', {}, `· caps at ${person.limits.maxSongs}`) : null,
    ),
    person.notes ? el('div', { class: 'small muted' }, `“${person.notes}”`) : null,
    el('div', { class: 'row', style: { marginTop: '2px' } },
      el('button', {
        class: 'btn btn--sm btn--ghost',
        onClick: () => save({ present: !person.present }),
      }, person.present ? 'Mark on a break' : 'Mark back'),
      el('span', { class: 'spacer' }),
      el('button', {
        class: 'btn btn--sm btn--quiet',
        onClick: guard(async () => {
          if (!confirm(`Remove ${person.name} from tonight?`)) return;
          await api(`/players/${person.id}`, { method: 'DELETE' });
        }),
      }, 'Remove'),
    ),
  );
}

/* ------------------------------------------------------------------- songs */

function songsTab() {
  const add = guard(async () => {
    const title = $('#s-title').value.trim();
    if (!title) return toast('A title, at least', 'error');
    await api('/songs', {
      method: 'POST',
      body: {
        title,
        artist: $('#s-artist').value.trim(),
        key: $('#s-key').value.trim(),
      },
    });
    for (const id of ['#s-title', '#s-artist', '#s-key']) $(id).value = '';
    $('#s-title').focus();
    toast('Added — everyone can rate it now');
  });

  return el('div', { class: 'stack' },
    el('section', { class: 'card stack' },
      el('div', { class: 'card__head' }, el('h2', {}, 'Add a song')),
      el('div', { class: 'row row--wrap' },
        el('input', { id: 's-title', type: 'text', placeholder: 'Title', class: 'grow',
          onKeydown: (e) => e.key === 'Enter' && add() }),
        el('input', { id: 's-artist', type: 'text', placeholder: 'Artist', class: 'grow',
          onKeydown: (e) => e.key === 'Enter' && add() }),
        el('input', { id: 's-key', type: 'text', placeholder: 'Key', style: { maxWidth: '110px' },
          onKeydown: (e) => e.key === 'Enter' && add() }),
        el('button', { class: 'btn btn--primary', onClick: add }, 'Add'),
      ),
      el('p', { class: 'section-note' },
        'Everyone signed up sees new songs immediately and can mark how they feel about them.'),
    ),

    el('section', { class: 'card stack' },
      el('div', { class: 'card__head' },
        el('h2', {}, 'Setlist'),
        el('span', { class: 'hint' }, `${pluralize(state.songs.length, 'song')}`),
      ),
      state.songs.length
        ? el('div', { class: 'stack', style: { gap: '10px' } }, state.songs.map(songAdminCard))
        : el('div', { class: 'empty' }, 'Nothing here yet. Add the songs you expect to call tonight.'),
    ),
  );
}

function songAdminCard(song) {
  const r = state.readiness[song.id] || { in: 0, maybe: 0, out: 0, gaps: [] };
  const suggester = song.suggestedBy ? playerById(song.suggestedBy) : null;

  return el('div', { class: 'song-card' },
    el('div', {},
      el('div', { class: 'song-card__title' }, song.title),
      el('div', { class: 'muted small' },
        [song.artist, song.key && `key of ${song.key}`, suggester && `suggested by ${suggester.name}`]
          .filter(Boolean).join(' · ') || '—'),
      el('div', { class: 'readiness' },
        el('span', { class: 'tag tag--in' }, `${r.in} signed up`),
        r.maybe ? el('span', { class: 'tag' }, `${r.maybe} have not`) : null,
        r.out ? el('span', { class: 'tag tag--out' }, `${r.out} sitting out`) : null,
        r.gaps.length
          ? el('span', { class: 'tag tag--out' }, `Cannot staff: ${r.gaps.join(', ')}`)
          : el('span', { class: 'tag tag--in' }, 'Full band available'),
      ),
    ),
    el('div', { class: 'row' },
      el('button', { class: 'btn btn--sm', onClick: () => drawLineup(song.id) }, 'Draw'),
      el('button', {
        class: 'btn btn--sm btn--quiet',
        onClick: guard(async () => {
          if (!confirm(`Remove “${song.title}” from the setlist?`)) return;
          await api(`/songs/${song.id}`, { method: 'DELETE' });
        }),
      }, 'Remove'),
    ),
  );
}

/* ---------------------------------------------------------------- settings */

function settingsTab() {
  const jam = state.jam;
  const save = guard((patch) => api('/host/settings', { method: 'PATCH', body: patch }));
  const signupUrl = `${location.origin}/`;

  const copy = (text) => async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied');
    } catch {
      toast('Copy failed — select the link by hand', 'error');
    }
  };

  return el('div', { class: 'stack' },
    el('section', { class: 'card' },
      el('div', { class: 'card__head' },
        el('h2', {}, 'Share the sign-up'),
        el('span', { class: 'hint' }, 'Point a phone camera at the code'),
      ),
      el('div', { class: 'share' },
        el('div', { class: 'share__qr' }, qrSvg(signupUrl, { size: 190 })),
        el('div', { class: 'stack grow' },
          el('div', { class: 'row row--wrap' },
            el('input', { type: 'text', readOnly: true, class: 'mono grow', value: signupUrl,
              onFocus: (e) => e.target.select() }),
            el('button', { class: 'btn', onClick: copy(signupUrl) }, 'Copy link'),
          ),
          el('p', { class: 'section-note' },
            'Anyone on the same wifi can scan this or type the link. The stage display shows the same code between songs.'),
          el('button', {
            class: 'btn btn--ghost btn--sm',
            onClick: () => window.print(),
          }, 'Print a card for the stage'),
        ),
      ),
    ),

    el('section', { class: 'card stack stack--lg' },
      el('div', { class: 'card__head' }, el('h2', {}, 'The band')),
      el('p', { class: 'section-note' }, 'Chairs Amplify fills for each song.'),
      slotEditor(jam.slots, (slots) => save({ slots })),
    ),

    el('section', { class: 'card stack stack--lg' },
      el('div', { class: 'card__head' }, el('h2', {}, 'Rotation')),
      el('div', { class: 'field' },
        el('label', { for: 'rest' }, 'Songs off between turns'),
        el('div', { class: 'row' },
          el('input', {
            id: 'rest', type: 'number', min: '0', max: '10', value: jam.restSongs,
            style: { maxWidth: '110px' },
            onChange: (e) => save({ restSongs: Number(e.target.value) }),
          }),
          el('span', { class: 'muted small grow' },
            'Nobody is called again until this many songs have gone by — unless the chair would otherwise sit empty.'),
        ),
      ),
      el('label', { class: 'toggle' },
        el('input', {
          type: 'checkbox',
          checked: jam.maybeCountsAsAvailable,
          onChange: (e) => save({ maybeCountsAsAvailable: e.target.checked }),
        }),
        el('span', { class: 'toggle__track' }),
        el('span', { class: 'toggle__text' }, 'Also call people who did not sign up',
          el('small', {}, 'Off means only people who signed up for the song can be called — the usual choice when the room signs up song by song.')),
      ),
      el('label', { class: 'toggle' },
        el('input', {
          type: 'checkbox',
          checked: jam.allowSuggestions,
          onChange: (e) => save({ allowSuggestions: e.target.checked }),
        }),
        el('span', { class: 'toggle__track' }),
        el('span', { class: 'toggle__text' }, 'Let players suggest songs'),
      ),
    ),

    el('section', { class: 'card stack' },
      el('div', { class: 'card__head' }, el('h2', {}, 'Jam name')),
      el('div', { class: 'row row--wrap' },
        el('input', {
          id: 'jam-name', type: 'text', class: 'grow', value: jam.name, maxLength: 60,
          onChange: (e) => save({ name: e.target.value }),
        }),
      ),
    ),

    el('section', { class: 'card stack' },
      el('div', { class: 'card__head' }, el('h2', {}, 'Start over')),
      el('div', { class: 'row row--wrap' },
        el('button', {
          class: 'btn btn--danger',
          onClick: guard(async () => {
            if (!confirm('Reset turn counts? The roster and setlist stay.')) return;
            await api('/host/reset', { method: 'POST', body: { mode: 'turns' } });
            toast('Turns reset');
          }),
        }, 'Reset turn counts'),
        el('button', {
          class: 'btn btn--danger',
          onClick: guard(async () => {
            if (!confirm('Clear the whole night — every sign-up and song?')) return;
            await api('/host/reset', { method: 'POST', body: { mode: 'night' } });
            toast('Fresh night');
          }),
        }, 'Clear the night'),
      ),
    ),
  );
}

/** Add, remove and re-count the chairs in the band. */
function slotEditor(slots, onSave) {
  const rows = slots.map((slot, i) =>
    el('div', { class: 'row' },
      el('input', {
        type: 'text', value: slot.instrument, class: 'grow',
        onChange: (e) => {
          const next = slots.map((s, j) => (j === i ? { ...s, instrument: e.target.value } : s));
          onSave(next);
        },
      }),
      el('input', {
        type: 'number', min: '0', max: '12', value: slot.count, style: { maxWidth: '92px' },
        onChange: (e) => {
          const next = slots.map((s, j) => (j === i ? { ...s, count: Number(e.target.value) } : s));
          onSave(next);
        },
      }),
      el('button', {
        class: 'btn btn--icon btn--ghost',
        title: `Remove ${slot.instrument}`,
        onClick: () => onSave(slots.filter((_, j) => j !== i)),
      }, '×'),
    ),
  );

  return el('div', { class: 'stack' },
    ...rows,
    el('button', {
      class: 'btn btn--sm btn--ghost',
      onClick: () => onSave([...slots, { instrument: 'Percussion', count: 1 }]),
    }, '+ Add a chair'),
  );
}

/* ----------------------------------------------------------------- callout */

/**
 * The full-screen call sheet — big enough to read from behind a drum kit.
 * Shared shape with the /board stage display.
 */
function callout(current, { closable = false, songs = state.songs, players = state.players } = {}) {
  const song = songs.find((s) => s.id === current.songId) || null;
  const name = (id) => players.find((p) => p.id === id)?.name || null;

  const view = el('div', { class: `callout${closable ? ' callout--overlay' : ' callout--inline'}` },
    el('div', { class: 'callout__head' },
      el('div', { class: 'callout__kicker' }, 'Up next'),
      el('div', { class: 'callout__song' }, song ? song.title : 'Free jam'),
      song && (song.artist || song.key)
        ? el('div', { class: 'callout__meta' },
            [song.artist, song.key && `key of ${song.key}`].filter(Boolean).join(' · '))
        : null,
    ),
    el('div', { class: `callout__grid${current.slots.length > 5 ? ' callout__grid--split' : ''}` },
      current.slots.map((slot) => {
        const who = name(slot.playerId);
        return el('div', {
          class: `callout__row${who ? '' : ' callout__row--empty'}${slot.resting ? ' callout__row--resting' : ''}`,
        },
          el('div', { class: 'callout__inst' }, slot.instrument),
          el('div', { class: `callout__name${who ? '' : ' callout__name--empty'}` }, who || 'open'),
        );
      }),
    ),
    el('div', { class: 'callout__foot' },
      el('span', {}, `${pluralize(state?.roundIndex ?? 0, 'song')} played`),
      el('span', {}, `${current.slots.filter((s) => s.playerId).length} on stage`),
    ),
  );

  if (!closable) return view;

  return el('div', {},
    view,
    el('div', { class: 'callout__close row' },
      el('button', {
        class: 'btn btn--primary',
        onClick: guard(async () => {
          await api('/host/commit', { method: 'POST' });
          calloutOpen = false;
          toast('Logged');
        }),
      }, 'Played ✓'),
      el('button', {
        class: 'btn',
        onClick: () => { calloutOpen = false; draw(); },
      }, 'Close'),
    ),
  );
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && calloutOpen) {
    calloutOpen = false;
    draw();
  }
});
