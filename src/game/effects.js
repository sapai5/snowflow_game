/**
 * Status effects on a player.
 *
 * Five things happen to you in this game — you get slowed, blinded, thrown, staggered
 * or burned — and every one of them is the same shape: a magnitude that lasts a
 * while and then stops. Writing them as five special cases scattered through the
 * controller is how a fighting game ends up unable to say whether a slowed player
 * mid-launch should also be staggered; writing them as one table means the answer is
 * always "yes, and here is the arithmetic".
 *
 * A slot per type rather than a list, because there is exactly one meaningful answer
 * to "how slowed am I". Two Waves landing together should not stack to a standstill —
 * the stronger one wins and refreshes the timer, which is `apply`'s whole rule.
 *
 * Allocation per frame: none. Allocation per effect: none — the slots are
 * pre-built and only their numbers change.
 */

/** The five, and the order they are packed into a network bitfield. */
export const SLOW = 0;
export const BLIND = 1;
export const AIR_RESTRICT = 2;
export const STAGGER = 3;
export const DOT = 4;
export const EFFECT_COUNT = 5;

/** Names, for the HUD and for debugging. Index matches the constants above. */
export const EFFECT_NAMES = ["slow", "blind", "airRestrict", "stagger", "dot"];

const NAME_TO_INDEX = Object.create(null);
for (let i = 0; i < EFFECT_NAMES.length; i++) NAME_TO_INDEX[EFFECT_NAMES[i]] = i;

export class Effects {
    constructor() {
        /** Seconds remaining, per type. Zero means absent. */
        this.time = new Float32Array(EFFECT_COUNT);
        /** How strong, per type. Meaning is per-effect; see `apply`. */
        this.magnitude = new Float32Array(EFFECT_COUNT);
        /** Who did it, per type. For kill credit on damage-over-time. */
        this.source = new Array(EFFECT_COUNT).fill(null);
        /**
         * Damage-over-time bookkeeping: how long the burn has run, and how much of it
         * has been paid. Tracked as elapsed-time-and-total rather than as a running
         * debt, because a debt accumulated at 0.1 a frame drifts: sixty additions of
         * six-sixtieths sums to 5.999999999999998 in binary floating point, which
         * silently pays 5 points for a second of burning instead of 6. Deriving the
         * total from elapsed time cannot drift no matter how long the field stands.
         */
        this._dotElapsed = 0;
        this._dotPaid = 0;
    }

    /**
     * Apply an effect, or refresh one already running.
     *
     * The stronger magnitude wins and takes the longer of the two remaining times.
     * Not additive: two slows landing together are still one slow, because a player
     * who can be chain-slowed to a standstill by two casters is not playing a game
     * any more. The same reasoning is why `magnitude` is a maximum rather than a sum.
     *
     * @param {number} type one of the constants above
     * @param {number} magnitude
     * @param {number} seconds
     * @param {string|null} [sourceId]
     */
    apply(type, magnitude, seconds, sourceId = null) {
        if (magnitude >= this.magnitude[type] || this.time[type] <= 0) {
            this.magnitude[type] = magnitude;
            this.source[type] = sourceId;
        }
        if (seconds > this.time[type]) this.time[type] = seconds;
    }

    /** @param {number} type */
    clear(type) {
        this.time[type] = 0;
        this.magnitude[type] = 0;
        this.source[type] = null;
        if (type === DOT) {
            this._dotElapsed = 0;
            this._dotPaid = 0;
        }
    }

    clearAll() {
        this.time.fill(0);
        this.magnitude.fill(0);
        for (let i = 0; i < EFFECT_COUNT; i++) this.source[i] = null;
        this._dotElapsed = 0;
        this._dotPaid = 0;
    }

    /** @param {number} dt */
    tick(dt) {
        for (let i = 0; i < EFFECT_COUNT; i++) {
            if (this.time[i] <= 0) continue;
            this.time[i] -= dt;
            if (this.time[i] <= 0) this.clear(i);
        }
    }

    /**
     * Damage owed since the last call, from a damage-over-time effect.
     *
     * Accumulated and returned in whole points rather than as a fraction per frame:
     * a health bar that ticks down in 0.1s at 60 Hz is unreadable, and a network
     * that carries a health update per frame per burning player is wasteful. Whole
     * points at roughly six a second reads as burning and costs six messages.
     *
     * @param {number} dt
     * @returns {number} whole points of damage to apply, 0 most frames
     */
    takeDotDamage(dt) {
        if (this.time[DOT] <= 0) return 0;
        this._dotElapsed += dt;
        const owed = Math.floor(this.magnitude[DOT] * this._dotElapsed);
        const pay = owed - this._dotPaid;
        if (pay <= 0) return 0;
        this._dotPaid = owed;
        return pay;
    }

    // ------------------------------------------------------------ read-only
    //
    // The HUD and the controller ask by name; everything inside asks by index. The
    // names exist because a HUD written against numeric indices is unreadable.

    /** @param {string|number} type */
    remaining(type) {
        const i = typeof type === "number" ? type : NAME_TO_INDEX[type];
        return i === undefined ? 0 : this.time[i];
    }

    /** @param {string|number} type */
    has(type) {
        return this.remaining(type) > 0;
    }

    /** @param {string|number} type */
    strength(type) {
        const i = typeof type === "number" ? type : NAME_TO_INDEX[type];
        return i === undefined || this.time[i] <= 0 ? 0 : this.magnitude[i];
    }

    /**
     * Movement multiplier, 0..1.
     *
     * One number for the controller to consult, so the controller never has to know
     * which effects exist. A stagger is a total lock rather than a slow, because a
     * parried attacker who can still shuffle away has not been punished.
     */
    get moveScale() {
        if (this.time[STAGGER] > 0) return 0;
        let s = 1;
        if (this.time[SLOW] > 0) s *= 1 - this.magnitude[SLOW];
        if (this.time[AIR_RESTRICT] > 0) s *= 1 - this.magnitude[AIR_RESTRICT];
        return s < 0 ? 0 : s;
    }

    /** True while the player may not start an attack or a cast. */
    get locked() {
        return this.time[STAGGER] > 0;
    }
}
