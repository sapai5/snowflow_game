/**
 * What a character is being told to do this frame.
 *
 * The controller used to read the global input singleton directly, which is exactly
 * right for a game with one character in it and impossible for a game with four.
 * This is the same set of fields, as a value a caller supplies:
 *
 *   - the local player passes the real `input`, so nothing changes for them
 *   - a scripted character passes one of these, written by whatever is driving it
 *   - a *remote* player passes one reconstructed from the network, which is the
 *     whole reason the seam exists
 *
 * The field names match `core/input.js` deliberately, so `input` itself satisfies
 * this shape and no adapter is needed for the case that matters most.
 */
export function makeIntent() {
    return {
        /** Movement, camera-relative, already inside a unit disc. */
        moveX: 0,
        moveZ: 0,
        sprint: false,
        surf: false,
        /** Held, for variable jump height. */
        jump: false,
        /** Edge-triggered, one frame. */
        jumpPressed: false,
        attackPressed: false,
        /**
         * Where to point, radians, or null to face the direction of travel.
         *
         * A player faces where they are going, which is why this is null for them.
         * Anything that has a *target* — an NPC circling you, a networked player whose
         * facing arrived in a snapshot, a lock-on mode — needs to strafe while pointed
         * somewhere else, and without this it cannot: the controller would turn them to
         * face their sidestep and their blade would sweep empty air. That was exactly
         * the bug that made the practice dummies unable to land a hit.
         */
        faceYaw: null,
        /**
         * Where an attack should aim, radians. Null means "wherever the camera looks",
         * which is right for the local player and meaningless for everyone else.
         */
        aimYaw: null,
        /** 0 = none, else 1..5. Edge-triggered. */
        spellPressed: 0,
        spellHeld2: false,
    };
}

/** A shared do-nothing intent, for characters that are not being driven at all. */
export const IDLE_INTENT = makeIntent();
