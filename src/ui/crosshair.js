/**
 * The aiming reticle.
 *
 * DOM rather than a draw. It costs nothing, it is crisp at any resolution scale,
 * and — the actual reason — it sits outside the post chain, where a reticle drawn
 * into the scene would be smeared by the speed streaks and pulled around by TAA.
 *
 * The only live part is the gap between the four ticks, which opens with speed.
 * That is written as a CSS custom property, eased here rather than by a CSS
 * transition because custom properties are not animatable without registering
 * them, and quantised to a half pixel so a steady speed stops touching the DOM
 * at all.
 */

import { expDamp } from "../core/camera.js";

/** Tick gap at a standstill, px. */
const GAP_REST = 5;
/** How much further the ticks travel at full tilt, px. */
const GAP_SPREAD = 9;

/** How long a hitmarker stays up, seconds. */
const HIT_LIFE = 0.22;

export class Crosshair {
    constructor() {
        this.el = /** @type {HTMLElement|null} */ (document.getElementById("crosshair"));
        this._gap = GAP_REST;
        this._written = -1;
        this._hit = 0;
        this._hitWeight = 0;
        this._hitShown = false;
    }

    /**
     * Confirm a hit.
     *
     * The most conventional cue in the genre and the most effective, for one reason
     * that has nothing to do with taste: it is the only feedback guaranteed to be where
     * the player is already looking. Everything else — the burst, the light, the health
     * bar — is at the victim, and in a fight the victim is not always the thing being
     * watched.
     *
     * @param {number} weight 0..1, how heavy the blow was
     */
    hit(weight = 1) {
        this._hit = HIT_LIFE;
        this._hitWeight = Math.max(this._hitWeight, weight);
    }

    /** @param {boolean} v shown only while the pointer is locked */
    setVisible(v) {
        this.el?.classList.toggle("show", !!v);
    }

    /**
     * @param {number} dt
     * @param {import("../character/controller.js").CharacterController} ch
     */
    update(dt, ch) {
        const el = this.el;
        if (!el) return;

        // Speed opens it; being airborne opens it further, because nothing about
        // a shot taken mid-somersault should look settled.
        const spread = Math.min(1, ch.speed01 * 1.6) * 0.8 + ch.air * 0.35;
        this._gap = expDamp(this._gap, GAP_REST + GAP_SPREAD * Math.min(1, spread), 7, dt);

        const q = Math.round(this._gap * 2) / 2;
        if (q !== this._written) {
            this._written = q;
            el.style.setProperty("--gap", q + "px");
        }

        // The marker: the reticle brightens, kicks outward and rotates, then settles.
        // Driven through two custom properties so the CSS owns what it looks like and
        // this owns when — and written only while it is up, so a session with no combat
        // in it never touches the DOM for this at all.
        if (this._hit > 0) {
            this._hit = Math.max(0, this._hit - dt);
            const t = this._hit / HIT_LIFE;
            // Snaps out and eases back, which is the shape of an impact rather than of
            // a pulse.
            const k = Math.pow(t, 0.45) * (0.45 + 0.55 * this._hitWeight);
            el.style.setProperty("--hit", k.toFixed(3));
            this._hitShown = true;
            if (this._hit === 0) this._hitWeight = 0;
        } else if (this._hitShown) {
            el.style.setProperty("--hit", "0");
            this._hitShown = false;
        }
    }
}
