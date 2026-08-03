/**
 * The whole combat balance, in numbers, importable from anywhere.
 *
 * This exists because the authority runs in Node and the game runs in a browser, and
 * both have to agree on what a hit is worth. The alternative — the server keeping its
 * own copy of the damage table — is how a client comes to show "9" while the server
 * deducts 12, and there is no way to notice until someone survives a hit they should
 * not have.
 *
 * Nothing here imports anything that touches a GPU, a DOM or Babylon, so `node
 * server/relay.mjs` pulls in this file and nothing else from the game.
 *
 * Health is 100 and a light hit is 9, so a clean three-hit string is 33 and a kill is
 * about ten hits — the pace that was asked for, and slow enough that a fight is a
 * conversation rather than an ambush.
 */

import { SLOW, BLIND, AIR_RESTRICT, STAGGER, DOT } from "./effects.js";

export { SLOW, BLIND, AIR_RESTRICT, STAGGER, DOT };

// ------------------------------------------------------------------ the body

export const MAX_HEALTH = 100;
/** Seconds face-down before you are put back. */
export const RESPAWN_TIME = 4;

/** Player hurtbox: a capsule from the feet up. */
export const BODY_RADIUS = 0.35;
export const BODY_HEIGHT = 1.75;

// ----------------------------------------------------------------- the sword

/** Index is the combo stage, 1-based; stage 3 is the finisher. */
export const SWORD_DAMAGE = [0, 9, 9, 15];
/**
 * How far a hit shoves the victim, m/s, per stage.
 *
 * The two light strokes barely move anyone — 2.5 m/s decays to about a quarter of a metre
 * of travel, which is a flinch rather than a push, and that is right: a fast attack that
 * relocated its target would make the string impossible to continue.
 *
 * The finisher is the one strike that moves somebody. It is two-handed, it costs a second
 * and a half to throw, and it is the only reason to commit to the whole string rather than
 * cancelling out after two — so landing it has to *do* something beyond fifteen damage.
 * At 11 m/s the victim travels about a metre and a half, which is out of the attacker's
 * own reach: the shove ends the exchange and both sides have to close again.
 */
export const SWORD_KNOCKBACK = [0, 2.5, 3.0, 11.0];

/**
 * How long the finisher staggers whoever it lands on, seconds.
 *
 * Deliberately short. A stagger is a full input lock, and locks are the least forgiving
 * thing a fight can contain — the earlier decision that a normal hit does *not* stagger
 * stands, and this is the exception rather than a change of mind. A third of a second is
 * long enough that a landed finisher cannot be traded against, and short enough that being
 * on the receiving end is a setback rather than a spectator seat.
 */
export const FINISHER_STAGGER = 0.35;
/** Radius of the blade as a hurtbox. Generous: the mesh is a jagged shard. */
export const BLADE_RADIUS = 0.12;
/** A parried attacker is locked out for this long. */
export const CLASH_STAGGER = 0.5;

/**
 * The largest damage any single claim can carry.
 *
 * Not anti-cheat — clients are trusted by decision, and a determined one can lie all
 * it likes. This is a sanity bound: a client with a bug that claims 4000 damage takes
 * the fun out of everyone else's session, and clamping costs one comparison. A bug is
 * far more likely than an attacker here.
 */
export const MAX_CLAIM_DAMAGE = 40;

// ---------------------------------------------------------------- the spells

/** How long a spell takes to recharge, seconds. All five, by decision. */
export const SPELL_COOLDOWN = 45;

/**
 * The five spells.
 *
 * Cooldown is 45 s for all of them by decision, so what distinguishes them is entirely
 * shape and consequence. `kind` selects the volume geometry; the rest is what it does
 * on contact.
 */
export const SPELLS = [
    null,
    {
        id: 1, name: "Wave", kind: "cone",
        range: 6, halfAngle: 35 * Math.PI / 180,
        damage: 10, knockback: 8, life: 0.35, parryable: true, once: true,
        effect: { type: SLOW, magnitude: 0.4, seconds: 3 },
    },
    {
        id: 2, name: "Snowball", kind: "projectile",
        speed: 22, radius: 0.25, gravity: 9.0, life: 3.0,
        damage: 15, knockback: 3,
        // Unblockable, by design: it is the answer to a player who never drops their
        // guard, and a game where every attack can be parried has no reason to move.
        parryable: false, once: true,
        effect: { type: BLIND, magnitude: 1, seconds: 1.2 },
    },
    {
        id: 3, name: "Updraft", kind: "sphere",
        radius: 4, life: 0.4, damage: 8, launch: 7, parryable: true, once: true,
        // Anyone caught in it goes up, the caster included. Standing in your own
        // updraft is a mobility tool with a cost rather than a mistake.
        selfHit: true,
        effect: { type: AIR_RESTRICT, magnitude: 0.75, seconds: 1.5 },
    },
    {
        id: 4, name: "Crystal field", kind: "field",
        radius: 3, life: 5.0, damage: 20, knockback: 1.5, parryable: true, once: true,
        // The impact is parryable and the field is not: you can turn away the eruption,
        // but once ice is standing in the snow it does not care about your sword.
        effect: { type: DOT, magnitude: 6, seconds: 0.6 },
    },
    {
        id: 5, name: "Vortex", kind: "burst",
        radius: 3.5, life: 0.6, damage: 0, knockback: 10, parryable: false, once: true,
        deflects: true,
    },
];

/** Spell ids that exist, for validating anything arriving over a socket. */
export function isSpellId(id) {
    return Number.isInteger(id) && id >= 1 && id <= 5;
}
