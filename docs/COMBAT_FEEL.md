# Combat feel — where the clunk is, measured, and what to do about it

The complaint is "clunky". That word usually means one of three specific failures: the
game ignored an input, the game took control away for longer than the player expected, or
the game hitched. All three are present, all three are measurable, and none of them is
the *speed* of the combat — the pacing changes (long wind-ups, committed recoveries) are
doing their job. The problem is what happens around them.

Every number below was measured from the code, not estimated.

---

## Findings, ranked by contribution

### 1. A third of the combo string ignores the attack button

Clicks during a wind-up are **dropped**, by design: the original comment reads "before
the strike has released, 'again' is not yet a meaningful instruction." That was written
when wind-ups were 0.12–0.14 s. They are now 0.20 / 0.23 / 0.50 s — lengthened
deliberately for readability — which means **0.93 s of the 2.89 s string (32%) is
input-dead**. A player who clicks during the finisher's half-second wind-up gets nothing,
concludes the click didn't register, and clicks again — and whether the string continues
now depends on whether their second click happened to land after the strike began. That
is the textbook mechanism of "feels unresponsive": not slowness, but inputs that
sometimes count and sometimes don't, with nothing distinguishing the two cases visibly.

The original worry (a double-click producing an attack the player never saw start) does
not apply to a single-flag buffer consumed at strike-end: double-click = this attack plus
the next one queued, which is what a double click means in every action game.

**Fix: buffer wind-up clicks into the existing `queued` flag.** One condition changes
(`t >= windup` becomes unconditional while an attack runs). No balance change — the
buffered attack still starts at the same instant it does today.

### 2. Every whiffed swing has a hitch in it

`_impact()` fires at the strike's velocity peak on **every** swing, hit or miss, and
applies 45–75 ms of 0.35× slow-motion (`ch.hitstop = s.hitstop`). It predates the
resolver's contact hit-stop, which now does the job properly — fires only when a blade
actually meets a body, and holds both fighters.

So today: a **whiffed** swing hiccups for no visible reason (three hitches per whiffed
string), and a **landed** hit stacks two hit-stops on top of each other. Whiff-hitch is
indistinguishable from a frame drop, which is likely a literal component of "feels
choppy/clunky".

**Fix: delete the phase-timed hit-stop; keep the contact one.** The terrain cut and
camera kick at the impact point stay — the blade does cut snow on a whiff. Also stops
landed hits double-dipping.

### 3. Mud after every swing

Three delays stack after an attack ends, and each is individually reasonable:

| Layer | Cost |
|---|---|
| Movement authority during the attack | flat **20%** (0.80 lock × swingBlend), all phases |
| swingBlend release after the attack | 0.19 s to reach 10% (rate 12) |
| Re-acceleration to run speed | 0.45 s (accel 8) |

Whiff one jab and you are below half speed for **~0.8 s**. Whiff the string and it's
well over a second of wading. The flat 20% is the design problem: the same authority is
applied to the wind-up (where you're *aiming*), the strike (where commitment is the
point), and the recovery (where the fight most needs footwork back).

**Fix: shape movement authority by phase** — roughly 50% during wind-up, 20% during
strike, ramping 35%→80% across the recovery — and release the blend at 20 rather than 12
once the attack is over. Recovery keeps costing you (you cannot sprint out of a whiff),
but you can *drift*, which is the difference between commitment and mud. The chain
cancel already skips recovery entirely, so this only affects strings that end.

### 4. Long wind-ups aim at the camera, not at the opponent

During a wind-up, facing snaps toward camera yaw at 16/s and nothing tracks the target.
A strafing opponent at 3.6 m/s moves **0.72 m during a jab wind-up and 1.80 m during the
finisher's** — against a reach of 1.48 m. So the deliberate wind-ups convert directly
into whiffs unless the player mouse-tracks the strafe by hand, frame by frame. Elden
Ring solves exactly this with soft rotation toward the locked/nearest target during
start-up; without something like it, long wind-ups read as "my attacks miss for no
reason", which lands as clunk rather than as skill.

**Fix: soft tracking during wind-up only.** If a living player is within ~5 m and within
~35° of camera forward, steer facing toward *them* (capped ~4 rad/s, on top of the
camera snap). No tracking during the strike — the swept blade stays honest, the parry
geometry stays honest, and side-stepping a committed swing still works, which is the
Elden Ring contract: attacks track their start-up and commit their active frames.

### 5. A stagger is 0.5 s of being a statue with no explanation

A clash/finisher stagger substitutes `IDLE_INTENT` — full input lock — and the *body*
shows nothing: the blade kicks (whip spring) and the HUD says PARRY, but the figure
stands in its idle pose while ignoring half a second of input. Locked-and-idle is the
same picture as "game stopped responding". The lock is the right mechanic (it's the
parry reward); the missing part is the body *saying* it's staggered.

**Fix: a flinch, from systems that already exist** — inject a one-shot kick into the
figure's chest/shoulder lag springs (they already express exactly this shape of motion)
plus the existing hit-stop for the first beat. No new animation system; roughly a
"stagger kick" field on the controller consumed by the figure the way `swingShift`
already is.

### 6. Victims don't react in the body to light hits

A light hit produces flash, damage number, burst, knockback (2.5 m/s ≈ a quarter-metre
drift) — all *around* the body, nothing *in* it. Two fighters trading jabs look like
mannequins exchanging particle effects. Same fix as #5, smaller magnitude, driven from
the existing `hit` event.

---

## What I am deliberately not proposing

- **Faster attacks / shorter recoveries.** The pacing was chosen for readability and
  commitment (the wind-up is the answer window; the recovery is the miss price). The
  findings above are all *around* that design, not against it.
- **A dodge/roll.** The genre reference implies one, and jump/double-jump only partly
  covers it. But it's a scope addition with balance consequences (i-frames? stamina?),
  not a smoothness fix. Flagging it as an open question rather than smuggling it in.
- **Tracking during the strike.** Homing active frames would break parry geometry and
  make spacing pointless. Start-up only.
- **Touching the netcode.** Everything above is client-local feel; claims and snapshots
  are unaffected.

## Interactions checked

- Buffering wind-up clicks does not change when attacks *start*, so strike windows,
  parry windows, and the network claim timing are unchanged.
- Removing whiff hit-stop removes a `ch.hitstop` writer; the resolver's contact hit-stop
  and hold-both-fighters behaviour is already tested (`impact` suite).
- Phase-shaped movement uses the phase the combo already publishes; the figure and gait
  read speed, so they follow automatically.
- Soft tracking writes `ch.facing` in the same place the camera snap already does — one
  steering source, no fight between two.
- Mid-swing spell casting is currently allowed (`gate.allow` doesn't check `attacking`)
  and fights the swing arm visually. One-line gate; included in P2 as a tidy-up.

## Plan

| Priority | Change | Size |
|---|---|---|
| **P0** | Buffer wind-up clicks | ~3 lines + tests |
| **P0** | Remove whiff hit-stop, keep contact hit-stop | ~5 lines + tests |
| **P0** | Phase-shaped movement authority + faster release | ~20 lines + tests |
| **P1** | Soft target tracking during wind-up | ~40 lines + tests |
| **P1** | Stagger flinch through the lag springs | ~30 lines |
| **P2** | Victim flinch on hits; gate casting while swinging | ~20 lines |

Each lands as its own commit, testable headlessly (input-window arithmetic, hit-stop
sources, authority-by-phase curves, tracking cone geometry). The three P0s are where
"clunky" mostly lives: dead inputs, phantom hitches, and mud.
