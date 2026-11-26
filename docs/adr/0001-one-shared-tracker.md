# 0001. One shared tracker, 12 s behind live, for every view

## Status

Accepted, 2026-11-25 (ticket #20, spec #16).

## Context

The page draws live aircraft in three views: the Diorama (one airport in 3D), the World map, and the
Journey (one followed flight, gate to gate, across both). Each view used to run its own Tracker, fed by
its own poll and played back at its own delay:

| View | Poll | Delay | Flown on after the last listing |
| --- | --- | --- | --- |
| Diorama | `/api/traffic/<airport>` every 5 s | 8 s | 15 s |
| World map | `/api/region/<cell>` every 10 s | 12 s | 30 s |
| Journey | `/api/hex/<hex>` every 5 s | 8 s | 60 s |

The same aircraft was therefore drawn at three different moments from three different sets of fixes. A
flight drawn on the map moved when the Handover brought the Diorama up, and the Journey had to borrow the
Diorama's drawn pose frame by frame (`sight`) to hide the gap. The trackers also measured their metres
from different points (each airport's reference point, and the map's origin in the middle of the US), so
no pose could be handed from one to another without a conversion.

Ticket #19 made a drawn aircraft never jump and never move backward, but only within one tracker: two
trackers that disagree still put the same aircraft in two places.

## Decision

One geographic Tracker per page, keyed by hex, in `src/lib/shared-sky.ts` (`SharedSky`), made once and
kept across airport switches.

- **Every poll feeds it.** The airport feed, the World map's region reads and the Journey's hex poll each
  add their snapshots as a feed of their own (`airport:<code>`, `region`, `hex:<hex>`). A fix is placed by
  when it was taken (the snapshot's time less the position's age), in time order whatever order it
  arrives in, so an older fix from one poll that lands between two from another is used, not dropped.
  The rule that a snapshot not newer than the newest is ignored now holds per feed, where it belongs
  (it drops the server's last answer served again). The same fix heard by two polls on two clocks (within
  1 s and 1 m) is one fix.
- **Every view reads it.** The Diorama reads the aircraft its airport's feed lists, in the airport's
  metres; the World map reads them all, in the map's metres; the Journey reads its one hex. Each view fills
  and reads it through a feed `SharedSky` gives it (`airport`, `worldMap`, `flight`), never through the
  tracker itself. Each aircraft carries a latitude and longitude, so a pose is the same pose in any view.
- **Placed by latitude and longitude.** Each track measures its metres from a point near the aircraft
  (moved along with it every 50 km), with headings turned to match, so dead reckoning and the motion rules
  run where north is north, wherever the aircraft is. The Diorama is no less exact near its field, and an
  aircraft far from any view's origin flies on along its true track.
- **One delay: `PLAYBACK_DELAY` = 12 s behind live, everywhere.** 12 s covers the 4 s server cache, a 5 s
  poll and the 10 s region read with a fix to spare either side.
- **One moment per frame.** The tracker's drawn (smoothed) state is per aircraft, and a read at a moment
  earlier than the last starts that smoothing over. Every view reads the tracker at `SharedSky.time()`: the
  feed's clock, read once per animation frame (keyed on `document.timeline.currentTime`). All views in a
  frame see identical poses, and no view ever reads behind another.
- **How long an aircraft is flown on stays a property of the feed that listed it** (airport 15 s, region
  30 s, hex 60 s). A view's fade in and fade out follow the feeds it reads, so the Diorama still lets an
  aircraft go when its airport's feed does, while the map, still reading it, does not.

Two things stay outside the shared tracker on purpose: a frozen recording (`?fixture=1`,
`?fixture=sequence`, and the map's recorded regions in any fixture) is a moment of its own on a clock that
stands still or starts at that moment, so it keeps a tracker of its own; and the Replayer that answers a
rewind (10x, 30x) rebuilds its own tracker from the history, 30 s behind its own clock, because it knows
what came next. Neither moves the picture off 12 s: a recording is drawn 12 s behind its own moment, and
the Replayer's picture is the live clock less the same 12 s, its 30 s being only how far ahead in the
history it reads.

Kept apart, the Replayer and the live tracker can draw an aircraft tens of metres apart at the moment a
replay catches up with live (46 m for a slow taxi in the recorded Atlanta sequence). That seam is not a
jump of the picture, so it is not cut: across it each aircraft is eased from where the replay last drew it
to where live has it, under the Tracker's own rules for a frame (`Seam` in `src/lib/replay.ts`): a step no
longer than a second of its speed (never under 5 m), never back along its heading unless at rest (it holds
and live comes on to meet it), a gap over 1,500 m taken at once, and nothing carried over frames more than
a second apart. LIVE pressed, a seek and a replay started are jumps of the picture and are not eased.

## Consequences

- An aircraft is at the same place in the Diorama, on the World map and in the Journey at the same instant,
  so switching views, or the Handover, never moves it. Tests: `src/lib/tracker.test.ts` ("Tracker shared by
  every view") and `src/lib/shared-sky.test.ts`; smoke: `scripts/smoke-shared-tracker.mjs`.
- A replay catching up with live hands each aircraft over without a hop. Tests: `src/lib/replay.test.ts`
  ("catching up with live", a synthetic disagreement either way and the recorded Atlanta sequence).
- Each view sees more fixes of the aircraft it shows (a followed flight is heard by its hex poll and by the
  airport feed), so it is drawn between real fixes more often and dead reckoned less.
- The Diorama's picture is 4 s further behind live than before (12 s, was 8 s). Ground dead reckoning grew
  to 16 s to cross the longer delay with a read or two missed.
- The tracker now holds the map's region aircraft as well as the airport's; the Diorama filters by feed on
  every frame. Reading is linear in the aircraft held, which stays in the low thousands at most.
- The Journey no longer needs a tracker of its own; its `sight` of the Diorama's drawn aircraft stays,
  because the Diorama keeps a taxiing aircraft on the pavement, which the tracker does not know about.

## Alternatives considered

- **Per-view delays** (keep 8 s for the Diorama and the Journey, 12 s for the map, each with its own
  tracker). Each view would keep the delay best suited to its poll, but the same aircraft would be drawn
  at two moments 4 s apart, hundreds of metres apart for an airliner, exactly at the Handover where the
  two pictures meet. Converting a pose from one view's moment to another's would mean dead reckoning it
  across the gap, which is the jump #19 removed. Rejected.
- **Per-aircraft adaptive delay** (play each aircraft just far enough behind its own newest fix: shorter
  for one heard every second, longer for a rarely reporting one). It gives the freshest picture of each
  aircraft, but then two aircraft on one screen are drawn at different moments, so their spacing on final
  or at a runway hold is wrong, the delay of each would change as its reads came and went (a visible speed
  up or slow down), and the views would still need one moment to agree on. Rejected for one fixed delay
  that every aircraft and every view share.
