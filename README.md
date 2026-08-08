# Amplify

Sign-ups, comfort levels and a fair rotation for open jam nights.

People add their name and instruments once, then sign up for songs one at a
time as the setlist fills in. Amplify builds the band for each song from
whoever signed up — spreading turns around, keeping anyone who has not played
yet at the front of the queue, and never calling someone who did not sign up.

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

Share the sign-up link. The host console's Settings tab shows it as a QR code
you can print for the stage, and the stage display shows the same code between
songs. Keep the host link to yourself — it carries the key that unlocks the
console.

## Three screens

| Screen | Who it is for | What it does |
| --- | --- | --- |
| `/` | Musicians, on their phones | Sign in, sign up for songs, set limits, see when you are up |
| `/host` | Whoever is running the night | Draw lineups, swap chairs, call the song, log it |
| `/board` | A TV or spare laptop | Sign-up code, **Now** and **Next**, and the lineup in room-sized type |

Everything updates live. A song added on the host console appears on every
phone immediately; a musician marking themselves on a break drops out of the
next lineup without anyone saying a word.

## Signing up, one song at a time

Signing in to the jam and signing up for a song are two separate things. You
give your name and instruments once. After that, every song on the setlist gets
its own **Sign up** button on your phone — one song per sign-up, as many songs
as you like, whenever you like. New songs appear the moment the host adds them.

If you play more than one instrument, each sign-up asks which one you want for
*that* song. Sign up for the ballad on keys and the blues on guitar; Amplify
seats you where you asked. **Withdraw** takes you off a single song and leaves
your other sign-ups alone.

**Not signing up is a complete answer.** By default nobody is called for a song
they did not sign up for — not to fill an empty chair, not to staff a half-empty
band, not by the host pinning them into a slot by hand. If a song cannot be
staffed, Amplify says so and leaves the chair open rather than putting someone
on stage who did not put themselves there.

Anyone signed in can also **suggest songs**, as many as they want. A suggestion
appears on every other phone immediately, credited to whoever added it, and
everyone can sign up for it like any other song. You can take back your own
suggestion until somebody else has signed up for it — after that it is the
host's to remove, so nobody loses a song they were counting on.

A lineup is a snapshot. If somebody withdraws or goes on a break after it was
drawn, the host's call sheet flags it in red before the names get read out.

There are two more limits people set for themselves:

- **A cap on turns** ("three songs and I'm done") — a hard stop.
- **On a break** — keeps their place in the queue without being called.

## How the queue decides

For each chair, everyone who signed up is ranked:

1. **Rested before tired** — anyone still inside their rest gap is a last resort.
2. **Fewest turns tonight** — this is what pulls people who have not played to
   the front, and it is why someone arriving at 10pm is called next.
3. **Signed up before not**.
4. **The chair they asked for**, ahead of one they did not.
5. **Longest wait** since they last played, then whoever arrived first.

Three more things happen before the lineup is final:

- **Requested chairs are honoured first.** If you signed up for a song on keys,
  you get keys — an earlier slot in the template cannot claim you for vocals
  and quietly lose your request.
- **Scarce chairs are filled next.** The only drummer in the room does not get
  spent on a guitar seat that four other people could take.
- **One repair pass.** If a chair ends up empty but someone already seated could
  cover it — and their own chair has a backup — they are swapped across.

The rest gap is the one rule that bends. If a chair would otherwise sit empty,
Amplify calls someone back early, flags the row *no rest*, and writes the reason
next to their name ("Doubling up — played the last song, nobody else free").
Every pick shows its reasoning, so the host can always answer "why them?".

## Running a song

1. **Now** → pick a song. Each one shows who is in, who is out, and whether the
   band can actually be staffed before you call it. The **Songs** tab is the
   queue: reorder it with the arrows, or hit **Play next** to jump a song to
   the front. The top song not yet played is marked *up next*, and that is what
   the stage display shows as **Next**.
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
- **Also call people who did not sign up** — off by default, which is what makes
  sign-ups mean something. Turn it on for a loose night where you would rather
  fill every chair than wait for sign-ups.
- **Let players suggest songs** — on by default. Anyone signed in can add as
  many as they like from their phone, and suggestions show who added them.
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
public/js/qr.js      QR encoder, so the sign-up code works with the wifi down
src/scheduler.js     the rotation engine — pure functions, no I/O
src/store.js         JSON persistence and public-state redaction
public/              the three screens; no build step, no framework
```
