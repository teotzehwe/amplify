# Amplify

Sign-ups, comfort levels and a fair rotation for open jam nights.

People add their name and instruments before the jam, say how they feel about
each song on the list, and Amplify builds the band for every song — spreading
turns around, keeping anyone who has not played yet at the front of the queue,
and never calling someone for a song they said they would rather sit out.

```bash
node server.js
```

No install step, no dependencies, no internet. Node 18 or newer.

```
♪  Amplify — Open Jam Night

   Players sign up   http://192.168.1.24:3000/
   Host console      http://192.168.1.24:3000/host?k=6f2a…
   Stage display     http://192.168.1.24:3000/board
```

Share the sign-up link (a card by the stage works well). Keep the host link to
yourself — it carries the key that unlocks the console.

## Three screens

| Screen | Who it is for | What it does |
| --- | --- | --- |
| `/` | Musicians, on their phones | Sign up, rate the setlist, set limits, see when you are up |
| `/host` | Whoever is running the night | Draw lineups, swap chairs, call the song, log it |
| `/board` | A TV or spare laptop | The current lineup in room-sized type |

Everything updates live. A song added on the host console appears on every
phone immediately; a musician marking themselves on a break drops out of the
next lineup without anyone saying a word.

## Comfort is a boundary, not a preference

Each person answers three ways per song:

- **I'm in** — call me for this one.
- **Maybe** — I'll play it, but pick someone keen first.
- **Sit out** — do not call me for this.

**"Sit out" is absolute.** Nothing overrides it: not an empty chair, not a
half-staffed band, not the host pinning that person into a slot by hand. If a
song cannot be staffed because of it, Amplify says so and leaves the chair
open rather than putting someone on stage they did not agree to.

Because nobody rates every song, each person also picks a fallback for songs
they have not answered — including anything called on the spot later in the
night. Choose *Leave me out* and unrated songs behave like a "sit out".

There are three more limits people set for themselves:

- **A cap on turns** ("three songs and I'm done") — a hard stop.
- **Skip me for lead vocals** — still called for their instruments.
- **On a break** — keeps their place in the queue without being called.

## How the queue decides

For each chair, everyone still standing after the comfort rules is ranked:

1. **Rested before tired** — anyone still inside their rest gap is a last resort.
2. **Fewest turns tonight** — this is what pulls people who have not played to
   the front, and it is why someone arriving at 10pm is called next.
3. **A firm "in" before a "maybe"**.
4. **Longest wait** since they last played.
5. **Whoever leads the instrument**, then whoever arrived first.

Two more things happen before the lineup is final:

- **Scarce chairs are filled first.** The only drummer in the room does not get
  spent on a guitar seat that four other people could take.
- **One repair pass.** If a chair ends up empty but someone already seated could
  cover it — and their own chair has a backup — they are swapped across.

The rest gap is the one rule that bends. If a chair would otherwise sit empty,
Amplify calls someone back early, flags the row *no rest*, and writes the reason
next to their name ("Doubling up — played the last song, nobody else free").
Every pick shows its reasoning, so the host can always answer "why them?".

## Running a song

1. **Now** → pick a song. Each one shows who is in, who is out, and whether the
   band can actually be staffed before you call it.
2. **Draw lineup.** Swap anyone from the dropdown beside their chair, or leave a
   chair open. Manual picks survive a redraw; *Clear my picks* starts over.
3. **Call it out** — full-screen names, readable from across the room.
4. **Played ✓** logs the turns and moves everyone on stage to the back of the
   queue. **Cancel** drops the lineup without counting anything.

Turn counts are what drive fairness, so log songs as they happen.

## Settings

- **The band** — which chairs to fill (2 guitars, 1 bass, 1 drums…). Songs can
  override the template.
- **Songs off between turns** — the rest gap. Default 1.
- **Count "maybe" as available** — turn it off late in the night when you only
  want firm yeses. "Sit out" is honoured either way.
- **Let players suggest songs** — suggestions show who added them.
- **Reset turn counts** for a second set, or **clear the night** entirely.

## Data and privacy

Everything lives in `data/jam.json` next to the server — no database, no
accounts, no third parties. Delete the file and the night is gone.

That file holds the host key and each player's session token, so it is
gitignored; do not commit or share it. The public API never returns either: the
host key stays server-side, and player tokens are stripped from published state
so one phone cannot act as another.

Amplify has no transport security of its own. Run it on the venue's local
network, not the open internet.

Useful environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `DATA_DIR` | `./data` | Where `jam.json` is written |

## Tests

```bash
npm test
```

Covers the rotation engine directly — consent, rest gaps, scarcity, the repair
pass, personal caps, and turn spread across a simulated night — plus API-level
tests that boot the real server and check auth, validation and a full round trip.

## Layout

```
server.js            HTTP, REST API, live updates (server-sent events)
src/scheduler.js     the rotation engine — pure functions, no I/O
src/store.js         JSON persistence and public-state redaction
public/              the three screens; no build step, no framework
```
