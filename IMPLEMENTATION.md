# SNOWFLOW — multiplayer combat implementation plan

**v2** — decisions from the 2026-08-01 review are locked in. One new problem
surfaced while checking numbers against the code (§7.1); it needs a ruling before
Phase 1.

---

## 1. Decisions (locked)

| | Decision |
|---|---|
| Players per world | **4**, free-for-all |
| Teams / friendly fire | None — everyone damages everyone |
| Time to kill | **~10 hits** |
| Spell recharge | **45 s per spell**, independent timers |
| Snow-surf | **Kept**, slowed |
| Sprint | Slowed |
| Parry | **By clash** — no separate input, the swing itself parries |
| Blind severity | As specced: 1.2 s, ~70 % white-out |
| Terrain deformation | Local-only, **except spell zones**, which are authoritative |
| Joining | **Shareable link** |
| Combat area | **120 m radius**, clamped from the 620 m world |
| Hosting | Free; my call — see §3.1 |
| Anti-cheat | **None.** Development build, clients are trusted |
| Weapons | Sword always in hand, spells always available |
| Spells 2 and 3 | Re-purpose existing visuals, stay close to what they look like now |

The two answers that most change the engineering are **"no anti-cheat"** and
**"4 players"**. Together they delete the hardest phase of v1 — see §3.2.

---

## 2. What we already have

| Asset | State | Relevance |
|---|---|---|
| Terrain, sky, snow, deformation | Done | Shared world; deformation stays local except spell zones |
| 18-bone procedural rig, cloth, fur | Done, single instance | **A remote player is ~12 floats** — the biggest win we have |
| Locomotion: walk/run/jump/flip/surf | Done | Becomes one row in a player table |
| Sword: mesh, shader, whip spring | Done, single instance | 443 tris, cheap to instance |
| Combo: 3-hit string, phases, hit-stop | Done | Already event-driven: `slashHit` / `stompHit` are the network events |
| Five spells | **Visuals only** | No damage, no targets, no collision against players |
| Contact system | Done | Already the "cosmetic, event-driven" pattern we want |
| Networking, health, damage, N players | **None** | — |

Nothing about poses, bones or animation state ever goes over the wire. Position,
velocity, facing and a few phase scalars are enough for a remote client to rebuild
gait, arm swing, cloth, sword arc and hit-stop locally, because all of it is
procedural. This is why 4 players is comfortable and 16 would still be fine.

---

## 3. Architecture

### 3.1 Hosting, free

Development: a **~150-line Node process** using `ws`, run locally, exposed with a
**Cloudflare quick tunnel** (`cloudflared tunnel --url localhost:8787`). Free, no
account needed, and it hands back an `https://…trycloudflare.com` URL — which *is*
the shareable link, with the room code in the query string:

```
https://<tunnel>.trycloudflare.com/?room=SNOW-4KQ2
```

When the tunnel URL should stop changing, the same process deploys unmodified to a
free tier (Fly.io, Render, or Deno Deploy — all support WebSockets). No code
changes, just a different host in the link.

### 3.2 Trust model — much simpler than v1 assumed

With no anti-cheat required, the server stops being a simulator and becomes a
**sequencer**:

| Owner | Responsibility |
|---|---|
| Each client | Its own player's movement, animation, and **its own hit detection** |
| Server | Player registry, health, death and respawn, spell cooldowns, relaying |

What this deletes from the v1 plan: client-side prediction, reconciliation,
rollback, the 1 s ring buffer, and rewind-based lag compensation. **All of it.**
Each client is authoritative over where it is, so there is nothing to predict and
nothing to correct.

The server still owns **health** rather than the victim, for one reason: with four
clients deciding independently, two of them can each believe they landed the kill.
One arbiter for "who is dead" costs nothing and removes a whole class of confusion.

Snapshots at **20 Hz** (not 30 — trusted clients need no correction, so the rate
only has to be smooth enough to interpolate), remotes rendered ~100 ms behind.

### 3.3 Message set

Small enough to write out in full:

```
→ server   join {room, name}
→ server   state {pos, vel, facing, flags, swingStage, swingArc, surf, air}   20 Hz
→ server   hit {targetId, damage, kind}         claimed by the attacker
→ server   clash {otherId}                      both blades met
→ server   cast {spellId, origin, aim}
→ server   effectHit {targetId, effect, spellId}

← client   welcome {yourId, players[], world seed}
← client   snapshot {[id]: state}                20 Hz
← client   health {id, hp, lastHitBy}
← client   died {id, killerId} / spawned {id, pos}
← client   cast {casterId, spellId, origin, aim}
← client   effect {targetId, effect, endsAt}
← client   cooldowns {spellId: readyAt}
```

Bandwidth is a rounding error: 4 players × ~40 B × 20 Hz ≈ 3 KB/s.

### 3.4 Deformation, per your ruling

Footprints, sword cuts and surf grooves stay **local** — each client brushes from
its own replicated events, differences are sub-centimetre and invisible.

**Spell zones are authoritative**, because they are gameplay volumes: the crystal
field damages anyone standing in it, so all four clients must agree on where it is
and when it ends. They come from the replicated `cast` message, so they match by
construction — the deformation is then drawn locally from the same authoritative
position and lifetime.

### 3.5 N players

`main.js` currently instantiates exactly one of everything. First work item:

```
World
  players: Map<id, Player>
  Player { controller, figure, sword, combat, health, effects, isLocal, lod }
  localId
```

At 4 players, LOD is a nicety rather than a necessity, but the tiers are cheap
insurance:

| Tier | Range | Cloth | Fur |
|---|---|---|---|
| 0 | local, and < 10 m | full | 22 shells |
| 1 | 10–30 m | 2 iterations | 8 shells |
| 2 | > 30 m or off-screen | kinematic, no solve | off |

---

## 4. Movement, slowed

Proposals, given the field is 620 m in radius (§7.1):

| | Original | First pass | **Now** | Reasoning |
|---|---|---|---|---|
| Walk | 2.5 | 2.3 | **1.9** | |
| Sprint | 5.4 | 4.4 | **3.6** | Legible at a fight's distance, still clearly a run |
| Ground accel | 26 | 12 | **8** | Where the weight actually comes from — a sidestep that starts instantly is free; one that takes a fifth of a second is a decision |
| Turn rate | 11 | 11 | **8** | A character that pivots instantly can answer an attack from any direction at no cost |
| Surf top speed | 19.5 | **13.0** | 13.0 | Still 3× sprint, so it stays the traversal tool |
| Surf thrust | 11.0 | **8.5** | 8.5 | Same feel of building speed, at the lower ceiling |

The second pass was for melee feel, and the arithmetic is worth recording because the
intuition is wrong: **slowing movement and lengthening wind-ups largely cancel.** The
finisher's wind-up went 0.38 → 0.50 s while the run went 4.4 → 3.6, so the ground an
opponent covers while it loads barely moved — 1.7 m to 1.8 m. Against a reach of 1.48 m
that is the number that matters, and it is why movement is only slowed a little: further
would not make fights more readable, it would make crossing a 240 m field take a minute.

What actually made the fighting deliberate was the phase split (§5.1a), not the speeds.

Surf stays available in combat. It cannot attack while surfing (already true in the
code), so it reads as a commitment: fast, and unarmed while you do it.

---

## 5. Combat

### 5.1a Attack phases — where "deliberate" comes from

Each phase does a different job, and the temptation is always to slow the wrong one:

| Phase | Job | Light | Heavy |
|---|---|---|---|
| Wind-up | **readability** — the only window an opponent can answer | 0.20 s | **0.50 s** |
| Strike | the hit, and the parry window. Stays fast: a slow strike reads as underwater, not restrained | 0.28 s | 0.44 s |
| Recovery | **commitment** — the price of having missed | 0.24 s | **0.42 s** |

The full string runs 2.89 s where it originally ran 1.84 s, and almost none of that is the
blade moving more slowly. Peak hand travel is 13–18°/frame at 30 fps, down from 35–42.

### 5.1 Core

| | Value |
|---|---|
| Health | 100 |
| Sword light (hits 1, 2) | **9** |
| Sword heavy (hit 3) | **15**, two-handed, 11 m/s shove, 0.35 s stagger |
| Full 3-hit string | 33 — three clean strings is a kill, ~10 hits mixed |
| Blade hurtbox | segment guard → tip, r 0.12 m (`bladePoint()` already gives this) |
| Player hurtbox | capsule, r 0.35 m, 1.75 m tall |
| Respawn | 4 s, ≥ 40 m from any living player |

### 5.2 The five spells — all on 45 s

Independent timers, so a full loadout is five casts per 45 s. At that rate spells
are *events*, not a rotation, and the sword carries the moment-to-moment fight. It
also retires my earlier worry that spell 4 would decide every engagement.

**1 · Wave** — `Sweep`, unchanged visually.
Cone 6 m, 70° · dmg 10 · knockback 8 m/s · **slow 40 % for 3 s** · parryable.

**2 · Snowball** — `Ribbon`, re-purposed with its look kept.
Ribbon's tendril becomes the *launch*: the same water-whip gesture, but the tip
detaches as a compact projectile and the tendril retracts. Reuses the ribbon mesh
and shader, so it still reads as bent water.
Projectile 22 m/s, gravity, r 0.25 m · dmg 15 · **blind 1.2 s, ~70 % white-out** ·
**unblockable** — ignores clash-parry *and* Vortex · shortest travel of the five.

**3 · Updraft** — `Bloom`, re-purposed with its look kept.
Bloom already erupts from the ground; it becomes a column that throws people.
Radius 4 m at the aim point · **launches anyone caught in it**, caster included ·
7 m/s vertical · **movement −75 % for 1.5 s while airborne** · dmg 8 · parryable.
Self-catch is a feature, not a bug: it is a mobility tool *and* an anti-air, and
standing in your own updraft is a choice with a cost.

**4 · Crystal field** — `Crystallise`, unchanged visually.
Impact 20 · **6 dmg/s while inside** · r 3 m · lifetime 5 s · terrain-following ·
impact parryable, the field is not. **Authoritative zone** (§3.4).

**5 · Vortex** — `Vortex`, unchanged visually.
No damage · pushes players within 3.5 m outward at 10 m/s · **deflects incoming
projectiles** except Snowball · active 0.6 s.

### 5.3 Parry by clash

No new input. **The strike phase of a swing is the parry window.**

- **Sword vs sword**: both blade segments intersect while both players are inside
  their strike phase → **clash**. No damage either side, both staggered 0.5 s, both
  blades bounce (the whip spring already gives us the recoil for free, and a hard
  velocity injection into it will look right immediately).
- **Sword vs parryable spell**: a spell reaches a player who is inside a strike
  phase, and the incoming direction is within 90° of their facing → **parried**,
  spell consumed, no damage, no stagger.
- **Snowball**: ignores all of the above.

Why this is the right call beyond just being what you asked for: the clash window
is 0.17–0.34 s depending on the attack, it is *already* the moment the blade is
travelling fastest, and it means aggression and defence are the same button. It
also needs no new animation — a stagger pose and a blade recoil are both things the
existing springs express.

Arbitration with trusted clients: the attacker's client detects the clash, because
the other player's `swingStage` and `swingArc` are in the snapshot it already has.
It sends `clash`, the server relays, both sides stagger. Rare disagreements
resolve as a normal hit, which at 4 players over a tunnel is a non-issue.

### 5.4 Status effects

One system, five uses:

```
Effect { type: slow | blind | airRestrict | stagger | dot, magnitude, endsAt, sourceId }
```

The controller already has the shape for this — `swingBlend` scales movement
authority exactly the way `slow` will. Replicated as a bitfield plus expiry times.

---

## 6. Plan

Estimates revised down from v1: trusted clients delete most of the netcode risk.

### Phase 0 — perf check — **not done**
Never measured with four real players. The LOD tiers were built pessimistically instead,
which is the wrong order but a safe one. Worth doing now that there is something to
measure with.

### Phase 1 — N players, local — **mostly done**

Done:
- `game/intent.js` — the seam. A controller is driven by an intent handed in, not by
  the global input singleton. Local play passes `input` unchanged; a script or a
  socket passes its own. **This is the single change the whole multiplayer plan rests
  on**, and it is verified: two controllers, two intents, one frame, independent.
- `game/player.js` — controller, figure, sword, combo and snow contact per player.
  One contact each rather than one shared, because it carries per-character history.
- `game/world.js` — the player table, spawn on a ring, update order preserved
  exactly, LOD by distance, combat-area clamp for everyone.
- LOD tiers in `cloth.js` / `character.js`: 6 → 2 → 0 cloth iterations, fur off past
  tier 0, skeleton never reduced.
- `dev/dummies.js` rewritten as a *driver* of real players rather than a parallel
  implementation. Up to 7, orbiting, sprinting, swinging on a timer.
- Movement retune (§4) and the 120 m combat area (§7.1) applied.

Left: **nameplates**, and pulling the spell system off its single-character
assumption (it takes one controller and one figure in its constructor).

### Phase 2 — combat, local — **done**

- `game/effects.js` — one table for slow / blind / air-restrict / stagger / burn.
  Strongest magnitude wins and refreshes the longer timer; no stacking to a standstill.
- `game/combat.js` — the resolver. Swept blade segments against body capsules,
  parry-by-clash, all five spell volumes, damage, knockback, launch, death. No
  rendering and no GPU resource, so it will run in Node unchanged on the authority.
- Health, cooldowns (45 s), respawn (4 s, furthest vacant spawn), `flash`, and the
  effect container on `Player`; the world owns the clock and the respawn queue.
- Controller reads one `moveScale` and knows nothing about what a Wave is. Stagger is
  a full lock; slow and air-restrict multiply.
- `ui/hud.js` — nameplates with health bars, local health, five cooldown pips, damage
  vignette, blind white-out, death countdown.
- Spell casting is gated by the resolver through a `gate` on the visual system, so
  cooldowns and being staggered or dead are gameplay rules rather than VFX rules.

**47 headless assertions pass** across two suites. Three real bugs were found by
writing them, all of which the build reported as fine:

1. Damage-over-time paid 5 points a second instead of 6 — floating-point drift from
   accumulating 0.1 sixty times. Now derived from elapsed time, which cannot drift.
2. The crystal field re-applied its *impact* every 0.5 s along with refreshing its
   burn: 80 damage a second out of a spell specced at 6.
3. Vortex shoved nobody, because knockback was applied inside `damage()` and Vortex
   does no damage.

Anyone can cast now, gameplay *and* visuals:
- `SpellSystem.castAs(id, owner, aim, at, trauma)` plays a spell for any caster. Sweep
  and Vortex are anchored to their caster rather than to the local player — Vortex
  holds its owner for its whole life, because the column follows them.
- `vfx/volumeFx.js` draws the Snowball, which had a hitbox and no picture at all. Out
  of the existing spray pool, because a snowball *is* a clump of powder.
- The dummies pick an off-cooldown spell, filter it by range, and fire both halves —
  the resolver first, so a refused cast never plays a picture of something that did
  not happen. Camera shake scales with distance.

Two bugs found by testing this: casting from outside the resolver raised events that
`combat.update` cleared before anything could read them (the network would have
dropped every cast message the same way — events are now drained by consumers in
`World.endFrame`), and the dummies faced their own sidestep so their blades swept
past the player entirely. Facing and aim are now per-player intent fields,
`faceYaw` / `aimYaw`, which is also exactly what a snapshot will carry.

**`npm test` — 52 assertions across 4 suites.** Kept in `test/` rather than written
and thrown away each time; between them they have caught nine real bugs that the
build reported as fine.

### Phase 3 — transport — **done**

- `net/protocol.js` — every message type as a constant, shared by browser and Node, so a
  key cannot be written one way and read another. JSON rather than a binary packing:
  four players at 20 Hz is ~16 KB/s either way, and a session that can be read in a
  network panel is worth more than the saving.
- `server/authority.mjs` — rooms, peers, rulings. **No sockets in it**, which is what
  makes the whole of Phase 4 testable without opening a port.
- `server/relay.mjs` — the socket wrapper, and a static file server for `dist/`, so one
  process and one link is the entire deployment.
- `net/remote.js` — snapshot history, 100 ms interpolation delay, clock offset tracked as
  a floor. Clamps to the newest frame rather than extrapolating: a disconnected player
  should stand still, not glide into the distance.
- `net/client.js` — join/leave, claims out, rulings in, reconnect with backoff.
- `controller.applyNetwork` — the seam for a remote body. Position, velocity, facing and
  the mode flags come off the wire; ground height, blends, lean and gait are derived
  locally, because both ends can work them out and sending them is eight more numbers per
  player per snapshot.

### Phase 4 — networked combat — **done**

- `combat.authoritative` and `combat.ownerId`. The client keeps detecting hits and stops
  applying their consequences. **Only the local blade and the local player's volumes are
  resolved** — without that, four clients each claim the same hit and nine damage lands
  as thirty-six.
- Knockback travels *with the claim* and is applied by the victim's own client. Applying
  it at the attacker would be overwritten by the victim's next snapshot: a rubber band
  rather than a shove.
- Effects are relayed as **absolute expiries**, not durations. A duration becomes three
  seconds *plus the latency*, differently for each of four clients.
- The welcome carries the server clock. Without it every ruling arriving before the first
  snapshot converts with an offset of zero — which is not a small error, it is the
  relay's entire uptime, and it made cooldowns look permanent.
- Relayed casts skip the local cooldown check: the authority has already made it, and a
  local timer disagreeing would leave one client unable to see a spell everyone else can.
- Spell zones are authoritative by construction — every client builds them from the one
  `cast` message, through the same two calls the local player uses.

### Phase 5 — around the game — **done**

- `ui/scoreboard.js` — scoreboard (hold TAB), kill feed, connection state, share link
  that copies on click. Pooled rows; nothing is created or destroyed mid-fight.
- `audio/audio.js` — every sound **synthesised at load** from noise and oscillators.
  There are no audio assets in the project and adding them would mean shipping megabytes
  or auditing licences; snow, ice and wind are broadband noise with envelopes on them,
  which is what synthesis is good at. Positional, because with four players on a 240 m
  field, hearing *where* a fight is matters more than what it sounds like. Wind gain
  follows speed, which doubles as the cue that makes surfing feel fast.
- Spawn selection: the client picks the vacant ring point furthest from anyone living,
  because a client already owns where it is and is the only party that can be sure it
  will not land inside somebody's swing.

Not done: spectate. A dead player watches from where they fell for four seconds, which
at that length is arguably better than a camera that moves.

**143 new assertions across three suites** (`authority`, `remote`, `net`), 551 in total.
Two real bugs found by the end-to-end suite, both invisible to the halves:

1. The clock offset was learned from snapshots, so every ruling that arrived before the
   first one converted with an offset of zero. A three second slow arrived as
   thirty-three seconds; cooldowns looked like they would never return.
2. The authority relays a cast to the whole room including the caster — correctly, it
   does not track who has already drawn what — so a local cast played twice: two volumes,
   two pictures, damage counted from both.

**~1.5–2 weeks to networked PvP**, down from 3–4. Phases 0–2 are about a week and
produce a complete single-player game worth playing on its own — and the game
should be fun before it is networked.

---

## 7. Open questions

### 7.1 Arena size — **resolved**

`PLAY_RADIUS` is 620 m, so the world is 1.24 km across: 1.2 million m² for four
players, who would essentially never meet — and slowing sprint and surf makes
crossing it slower still.

**Decision: clamp the combat area to a 120 m radius.** The far terrain still
renders, so nothing is lost visually, and four players in 45,000 m² find each other
in seconds. The slowed speeds from §4 stand.

Implementation: `clampToPlayArea` already exists and is already called every frame
on the character; it takes a radius. This is a constant and a soft boundary
treatment — a visible edge (a rising blizzard wall, or ice pillars) rather than an
invisible wall.

### 7.2 Smaller ones — proposed defaults

Taking these as my call unless you say otherwise. Flagged in the order they matter:

1. **Stagger on a normal hit: no.** Only a *clash* staggers. Two players can trade
   blows, which keeps aggression viable and means a fight is about spacing rather
   than about who swung first. Hit-stop plus the existing camera kick is enough
   feedback that a hit landed. **This is the one worth overruling if you disagree —
   it is the single biggest lever on how a fight feels.**
2. **Spell aim: crosshair ray against the terrain, capped at 25 m.** Reticle is
   already centred and already means what it points at, so the aim is free. Beyond
   the cap the spell lands at 25 m along the ray.
3. **Cooldowns reset on death.** Dying already costs 4 seconds and a position;
   losing a 45 s spell on top of that punishes the same mistake twice.
4. **Names: typed on join**, defaulting to a generated one so nobody has to type
   anything to play.
