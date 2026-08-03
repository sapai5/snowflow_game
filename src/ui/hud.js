/**
 * Combat hud: nameplates, local vitals, and the three full-screen states.
 *
 * DOM, for the same reason the reticle is DOM (see `crosshair.js`): it sits
 * outside the post chain. A health bar drawn into the scene would be smeared by
 * the speed streaks, ghosted by TAA and tonemapped along with the snow, which is
 * a lot of machinery to fight for text that only ever needs to be legible.
 *
 * Everything here is built once. The elements live in `index.html`; the plates
 * are built on first sight of a player and cached. The update path writes only
 * transforms, opacities, class flags and text — no `innerHTML`, no element
 * creation, no layout properties. Values are quantised before they are written
 * and compared against the last write, so a player standing still or a spell at
 * full charge stops touching the DOM entirely.
 *
 * The one deliberate per-frame allocation is the transform string for a moving
 * nameplate. There is no string-free way to move a DOM element; custom
 * properties fed to `calc()` would build the same strings one layer down. It is
 * bounded by the roster and it is why positions are rounded to whole pixels —
 * which the plates want anyway, because subpixel placement makes 10px
 * letter-spaced type shimmer as it drifts.
 */

import { Vector3, Matrix } from "@babylonjs/core/Maths/math.vector";
import { Viewport } from "@babylonjs/core/Maths/math.viewport";
import { expDamp } from "../core/camera.js";

/** Metres from the feet to just above the head. Matches the 1.7 m figure. */
const HEAD_OFFSET = 1.9;

/** Plates vanish past this range, and fade across the last stretch below it. */
const PLATE_HIDE = 60;
const PLATE_FADE = 45;

/**
 * Distance scaling. Full size out to `PLATE_NEAR`, then down to
 * `PLATE_MIN_SCALE` at the hide range.
 *
 * Not true perspective scale — 1/d shrinks a plate to noise by 30 m, and the
 * point of a nameplate is to be read. This is a shallow linear taper that only
 * ranks the plates by depth.
 */
const PLATE_NEAR = 10;
const PLATE_MIN_SCALE = 0.62;

/** Full cooldown, seconds. The span the pip fill represents. */
const COOLDOWN_SPAN = 45;

/** Blind fades out over this long, and never gets closer to opaque than this. */
const BLIND_SPAN = 1.2;
const BLIND_MAX = 0.75;

/** Below this fraction of max health the local bar switches to the warning ink. */
const CRIT_FRACTION = 0.3;

// ------------------------------------------------------- module-scope scratch
const _head = new Vector3();
const _view = new Vector3();
const _proj = new Vector3();
const _identity = Matrix.Identity();
const _vp = new Viewport(0, 0, 1, 1);

/**
 * Floating damage numbers.
 *
 * The cue that was missing. A burst, a light, a hitmarker and a camera kick all say
 * *something connected*; none of them says *how much*, and without that a fight has no
 * arithmetic the player can follow — you cannot tell a light hit from a finisher, or
 * work out how many more you need. A number at the point of contact is the most direct
 * answer available and it costs a pooled DOM element.
 *
 * Pooled and never grown: at four players landing at most a few hits a second, twelve
 * is more than can ever be legible at once, and the oldest is recycled rather than a
 * thirteenth being created mid-fight.
 */
const DMG_POOL = 12;
/** How long a number stays up, seconds. */
const DMG_LIFE = 0.85;
/** How far it drifts upward over that life, metres. World space, so it stays put. */
const DMG_RISE = 0.75;

export class Hud {
    /**
     * @param {import("../game/world.js").World} world the player table; read
     *   only, never mutated here.
     */
    constructor(world) {
        this.world = world;

        this.plateRoot = document.getElementById("plates");
        this.el = document.getElementById("hud");
        this.hpEl = document.getElementById("hud-hp");
        this.hpFill = document.getElementById("hud-hp-fill");
        this.hpNum = document.getElementById("hud-hp-num");
        this.dmgEl = document.getElementById("hud-damage");
        /**
         * The damage-number pool. Positioned in *world* space and re-projected every
         * frame rather than being given a screen position on spawn: a number pinned to
         * the screen slides away from the body it belongs to the moment the camera
         * moves, and this camera moves constantly.
         */
        this._dmg = [];
        const plates = document.getElementById("plates");
        for (let i = 0; i < DMG_POOL; i++) {
            const el = document.createElement("div");
            el.className = "dmg";
            plates?.appendChild(el);
            this._dmg.push({
                el, age: Infinity, x: 0, y: 0, z: 0, text: "", cls: "",
                sx: -1, sy: -1, op: -1, stamp: 0,
            });
        }
        this._dmgNext = 0;

        /**
         * The live burn number per victim, so consecutive ticks merge into one figure
         * that climbs instead of six separate numbers a second.
         *
         * A crystal field pays out in whole points six times a second, and at one number
         * per tick a two second burn fills the entire pool on its own and pushes out the
         * sword hits — which are the numbers the player actually needs. Merging also
         * reads better: a single number counting up is legible where a column of ones is
         * noise. Keyed by victim, and the slot is checked with a stamp so a recycled
         * element is never hijacked by a stale burn.
         *
         * @type {Map<string, { rec: any, stamp: number, total: number }>}
         */
        this._burns = new Map();
        this._stamp = 0;

        this.blindEl = document.getElementById("hud-blind");
        this.deadEl = document.getElementById("hud-dead");
        this.deadNum = document.getElementById("hud-respawn");

        /**
         * One record per pip, with its children resolved up front.
         * `querySelector` in the update path would be a tree walk per frame for
         * elements that never move.
         * @type {{ el: HTMLElement, fill: HTMLElement|null, sec: HTMLElement|null,
         *          p: number, ready: boolean|null, secs: number }[]}
         */
        this.pips = [];
        const pipEls = this.el ? this.el.querySelectorAll(".pip") : [];
        for (let i = 0; i < pipEls.length; i++) {
            const el = /** @type {HTMLElement} */ (pipEls[i]);
            this.pips.push({
                el,
                fill: el.querySelector(".fill"),
                sec: el.querySelector(".s"),
                p: -1,
                ready: null,
                secs: -1,
            });
        }

        /**
         * Live nameplates, keyed by player id.
         * @type {Map<string, { el: HTMLElement, nm: HTMLElement, bar: HTMLElement,
         *                      name: string, x: number, y: number, s: number,
         *                      op: number, hp: number, hurt: boolean|null }>}
         */
        this._plates = new Map();

        /**
         * Health the bar is actually drawn at, 0..1.
         *
         * Eased, while the number beside it is printed raw. The disagreement is
         * the point: the digits are the truth you read, the bar is the motion you
         * notice out of the corner of your eye, and a bar that snaps gives you
         * nothing to notice. 18/s closes it in about a fifth of a second, so it
         * never lies for long.
         */
        this._hp01 = 1;
        this._hpPrimed = false;

        // Last written values. -1 / null mean "nothing written yet", which is why
        // opacities and fractions are compared as quantised numbers rather than
        // against the raw floats they came from.
        this._wHp = -1;
        this._wHpNum = -1;
        this._wCrit = /** @type {boolean|null} */ (null);
        this._wDmg = -1;
        this._wBlind = -1;
        this._wDeadShown = /** @type {boolean|null} */ (null);
        this._wRespawn = -1;

        this._shown = false;
        /** Explicit override from `setVisible`; null means the hud decides. */
        this._forced = /** @type {boolean|null} */ (null);
    }

    /**
     * Force the local readouts visible or hidden — for a cutscene, a menu, or a
     * screenshot. Left alone, the hud shows itself as soon as there is a local
     * player, which is the only condition under which it has anything to say.
     *
     * Nameplates are not covered: they are diegetic, and hiding the local
     * readouts is not a reason to lose track of where three other people are.
     *
     * @param {boolean|null} v null hands control back to the hud
     */
    setVisible(v) {
        this._forced = v === null ? null : !!v;
        if (this._forced !== null) this._show(this._forced);
    }

    /**
     * @param {number} dt seconds
     * @param {import("../core/camera.js").CameraRig} rig
     */
    update(dt, rig) {
        const world = this.world;
        const local = world && world.local ? world.local : null;
        const now = world && typeof world.now === "number" ? world.now : 0;

        if (this._forced === null) this._show(!!local);

        this._updatePlates(rig, local);
        this._updateLocal(dt, local, now);
        this._readHits(local);
        this._updateDamage(dt, rig);
    }

    /**
     * Turn this frame's combat events into damage numbers.
     *
     * Read from the event list rather than from health deltas, because a delta cannot
     * tell one source from another: a player standing in a crystal field while being hit
     * takes two different amounts from two different things, and the events know which
     * is which where the health bar only knows the total.
     *
     * @param {import("../game/player.js").Player|null} local
     */
    _readHits(local) {
        const combat = this.world && this.world.combat;
        if (!combat || !local) return;
        const events = combat.events;

        for (let i = 0; i < events.length; i++) {
            const e = events[i];
            if (e.x === undefined) continue;
            const dealt = e.by === local.id;
            const taken = e.on === local.id;
            if (!dealt && !taken) continue;

            // The amount comes from the event, so the resolver stays the only place a
            // damage number is written down.
            if (e.kind === "hit") {
                this._spawnDamage(e, e.amount, dealt, e.stage >= 3);
            } else if (e.kind === "spellHit") {
                // Vortex does no damage; a "0" floating off someone is worse than
                // nothing, and the shove is already visible.
                if (e.amount > 0) this._spawnDamage(e, e.amount, dealt, false, null, "spell");
            } else if (e.kind === "burn") {
                this._addBurn(e, dealt);
            } else if (e.kind === "clash") {
                this._spawnDamage(e, null, true, false, "parry");
            }
        }
    }

    /**
     * A burn tick, merged into the victim's live number if there is one.
     *
     * @param {{on:string,amount:number,x:number,y:number,z:number}} e
     * @param {boolean} dealt
     */
    _addBurn(e, dealt) {
        const live = this._burns.get(e.on);
        // Still the same element, still ours, and still young enough that a climbing
        // number reads as one event rather than as a number that refuses to leave.
        if (live && live.rec.stamp === live.stamp && live.rec.age < 0.55) {
            live.total += e.amount;
            live.rec.age = Math.min(live.rec.age, 0.35);
            live.rec.x = e.x;
            live.rec.y = e.y;
            live.rec.z = e.z;
            const text = String(live.total);
            if (live.rec.text !== text) {
                live.rec.text = text;
                live.rec.el.textContent = text;
            }
            return;
        }
        const rec = this._spawnDamage(e, e.amount, dealt, false, null, "burn");
        this._burns.set(e.on, { rec, stamp: rec.stamp, total: e.amount });
    }

    /**
     * @param {{x:number,y:number,z:number}} at
     * @param {number|null} amount
     * @param {boolean} dealt true if the local player dealt it
     * @param {boolean} heavy
     * @param {string|null} [label] shown instead of a number
     * @param {string} [extra] an extra class, for styling by source
     * @returns {any} the pool record, so a caller can merge into it later
     */
    _spawnDamage(at, amount, dealt, heavy, label, extra) {
        // Take the oldest slot. A ring is right here: the alternative is searching for a
        // free one and dropping the number when none is, and a dropped number during a
        // flurry is exactly when the player most wants to see it.
        const rec = this._dmg[this._dmgNext];
        this._dmgNext = (this._dmgNext + 1) % DMG_POOL;

        rec.age = 0;
        rec.x = at.x;
        rec.y = at.y;
        rec.z = at.z;
        const text = label || String(amount);
        const cls = "dmg" +
            (dealt ? "" : " taken") +
            (heavy ? " heavy" : "") +
            (label ? " " + label : "") +
            (extra ? " " + extra : "");
        if (rec.text !== text) {
            rec.text = text;
            rec.el.textContent = text;
        }
        if (rec.cls !== cls) {
            rec.cls = cls;
            rec.el.className = cls;
        }
        rec.sx = -1;
        rec.sy = -1;
        rec.op = -1;
        rec.stamp = ++this._stamp;
        return rec;
    }

    /**
     * Age, rise and re-project the live numbers.
     *
     * @param {number} dt
     * @param {import("../core/camera.js").CameraRig} rig
     */
    _updateDamage(dt, rig) {
        const cam = rig && rig.camera;
        if (!cam) return;
        const scene = cam.getScene();
        const engine = scene.getEngine();
        const px = engine.getHardwareScalingLevel();
        _vp.width = engine.getRenderWidth();
        _vp.height = engine.getRenderHeight();
        const xform = scene.getTransformMatrix();
        const viewM = cam.getViewMatrix();
        const near = cam.minZ || 0.1;

        for (let i = 0; i < this._dmg.length; i++) {
            const rec = this._dmg[i];
            if (rec.age === Infinity) continue;
            rec.age += dt;
            if (rec.age >= DMG_LIFE) {
                rec.age = Infinity;
                if (rec.op !== 0) {
                    rec.op = 0;
                    rec.el.style.opacity = "0";
                }
                continue;
            }

            const t = rec.age / DMG_LIFE;
            _head.set(rec.x, rec.y + DMG_RISE * Math.sqrt(t), rec.z);

            Vector3.TransformCoordinatesToRef(_head, viewM, _view);
            if (!(_view.z > near)) {
                if (rec.op !== 0) { rec.op = 0; rec.el.style.opacity = "0"; }
                continue;
            }
            Vector3.ProjectToRef(_head, _identity, xform, _vp, _proj);
            if (!(_proj.z >= 0 && _proj.z <= 1) || !Number.isFinite(_proj.x)) {
                if (rec.op !== 0) { rec.op = 0; rec.el.style.opacity = "0"; }
                continue;
            }

            // Holds full opacity for the first half, then fades. A number that starts
            // fading immediately is hard to read at the moment it matters most.
            const op = t < 0.5 ? 1 : 1 - (t - 0.5) * 2;
            const qx = Math.round(_proj.x * px);
            const qy = Math.round(_proj.y * px);
            const qo = Math.round(op * 32) / 32;
            if (qx !== rec.sx || qy !== rec.sy) {
                rec.sx = qx;
                rec.sy = qy;
                rec.el.style.transform =
                    "translate3d(" + qx + "px," + qy + "px,0) translate(-50%,-50%)";
            }
            if (qo !== rec.op) {
                rec.op = qo;
                rec.el.style.opacity = String(qo);
            }
        }
    }

    /** Drop every plate. Called on teardown; the elements are ours to remove. */
    dispose() {
        for (const rec of this._plates.values()) rec.el.remove();
        this._plates.clear();
        for (const rec of this._dmg) rec.el.remove();
        this._dmg.length = 0;
        this._burns.clear();
    }

    // ------------------------------------------------------------- internals

    /** @param {boolean} v */
    _show(v) {
        if (v === this._shown) return;
        this._shown = v;
        this.el?.classList.toggle("show", v);
    }

    /**
     * Project and place every remote player's plate.
     *
     * @param {import("../core/camera.js").CameraRig} rig
     * @param {import("../game/player.js").Player|null} local
     */
    _updatePlates(rig, local) {
        const world = this.world;
        const root = this.plateRoot;
        const cam = rig ? rig.camera : null;
        if (!root || !cam || !world) return;

        const scene = cam.getScene();
        const engine = scene.getEngine();
        const rw = engine.getRenderWidth();
        const rh = engine.getRenderHeight();

        // The projection lands in *render* pixels; the plates are positioned in
        // CSS pixels. Those differ whenever the resolution scale is not 1 — and
        // it is a slider in the settings panel, so it is not 1 for most players.
        // The hardware scaling level is exactly that ratio, and reading it costs
        // nothing, where measuring the canvas would force a layout every frame.
        const px = engine.getHardwareScalingLevel();

        _vp.x = 0;
        _vp.y = 0;
        _vp.width = rw;
        _vp.height = rh;

        const xform = scene.getTransformMatrix();
        const viewM = cam.getViewMatrix();
        const near = cam.minZ || 0.1;

        for (const p of world.players.values()) {
            if (p === local || p.isLocal) continue;

            let rec = this._plates.get(p.id);
            if (!rec) {
                rec = this._makePlate(root);
                this._plates.set(p.id, rec);
            }

            if (p.alive === false) {
                this._hidePlate(rec);
                continue;
            }

            _head.copyFrom(p.controller.position);
            _head.y += HEAD_OFFSET;

            // View space first, for two answers from one transform: z is the
            // signed distance along the view axis, which is the only reliable
            // behind-the-camera test — a projected point with a negative w comes
            // back from the divide looking like a perfectly ordinary point in
            // front of you, mirrored through the centre of the screen. The length
            // is the range the fade and the scale want.
            Vector3.TransformCoordinatesToRef(_head, viewM, _view);
            if (!(_view.z > near)) {
                this._hidePlate(rec);
                continue;
            }

            const dist = _view.length();
            if (dist > PLATE_HIDE) {
                this._hidePlate(rec);
                continue;
            }

            Vector3.ProjectToRef(_head, _identity, xform, _vp, _proj);
            // Depth outside the unit range means clipped by near or far; NaN means
            // a degenerate matrix on the frame the engine resized.
            if (!(_proj.z >= 0 && _proj.z <= 1) || !Number.isFinite(_proj.x)) {
                this._hidePlate(rec);
                continue;
            }

            const fade = dist <= PLATE_FADE
                ? 1
                : 1 - (dist - PLATE_FADE) / (PLATE_HIDE - PLATE_FADE);

            const scale = dist <= PLATE_NEAR
                ? 1
                : Math.max(
                    PLATE_MIN_SCALE,
                    1 - (dist - PLATE_NEAR) * ((1 - PLATE_MIN_SCALE) / (PLATE_HIDE - PLATE_NEAR))
                );

            const qx = Math.round(_proj.x * px);
            const qy = Math.round(_proj.y * px);
            const qs = Math.round(scale * 32) / 32;
            if (qx !== rec.x || qy !== rec.y || qs !== rec.s) {
                rec.x = qx;
                rec.y = qy;
                rec.s = qs;
                rec.el.style.transform =
                    "translate3d(" + qx + "px," + qy + "px,0) scale(" + qs + ") translate(-50%,-100%)";
            }

            const qop = Math.round(fade * 16) / 16;
            if (qop !== rec.op) {
                rec.op = qop;
                rec.el.style.opacity = String(qop);
            }

            if (p.name !== rec.name) {
                rec.name = p.name;
                rec.nm.textContent = p.name;
            }

            const max = p.maxHealth > 0 ? p.maxHealth : 100;
            const hp01 = clamp01(p.health / max);
            const qhp = Math.round(hp01 * 64) / 64;
            if (qhp !== rec.hp) {
                rec.hp = qhp;
                rec.bar.style.transform = "scaleX(" + qhp + ")";
            }
            const hurt = hp01 <= CRIT_FRACTION;
            if (hurt !== rec.hurt) {
                rec.hurt = hurt;
                rec.el.classList.toggle("hurt", hurt);
            }
        }

        // Sweep on every frame rather than on a roster-changed signal. The world
        // has no such signal, a size comparison misses a despawn and a spawn in
        // the same frame, and iterating four entries is not worth defending
        // against. Deleting during a Map iteration is well-defined.
        if (this._plates.size > 0) {
            for (const id of this._plates.keys()) {
                if (world.players.has(id)) continue;
                const rec = this._plates.get(id);
                if (rec) rec.el.remove();
                this._plates.delete(id);
            }
        }
    }

    /** @param {HTMLElement} root */
    _makePlate(root) {
        const el = document.createElement("div");
        el.className = "plate";

        const nm = document.createElement("span");
        nm.className = "nm";

        const hb = document.createElement("i");
        hb.className = "hb";
        const bar = document.createElement("b");
        hb.appendChild(bar);

        el.appendChild(nm);
        el.appendChild(hb);
        root.appendChild(el);

        return { el, nm, bar, name: "", x: NaN, y: NaN, s: -1, op: -1, hp: -1, hurt: null };
    }

    /**
     * Fade out rather than `display: none`. A hidden plate keeps its last
     * transform, so a player stepping back into view does not appear at the
     * origin for one frame before the next projection lands.
     */
    _hidePlate(rec) {
        if (rec.op !== 0) {
            rec.op = 0;
            rec.el.style.opacity = "0";
        }
    }

    /**
     * @param {number} dt
     * @param {import("../game/player.js").Player|null} p
     * @param {number} now
     */
    _updateLocal(dt, p, now) {
        if (!p) {
            // No local player — spectating, or the world has not spawned one yet.
            // Nothing below has a meaningful value, and a stale vignette left over
            // from the last life would be worse than a blank screen.
            this._setOpacity(this.dmgEl, 0, "_wDmg", 32);
            this._setOpacity(this.blindEl, 0, "_wBlind", 32);
            this._setDead(false, 0);
            this._hpPrimed = false;
            return;
        }

        // -------------------------------------------------------------- health
        const max = p.maxHealth > 0 ? p.maxHealth : 100;
        const hp01 = clamp01(p.health / max);

        // First frame — and the first frame of a new life — snaps. Easing up from
        // whatever the corpse was left at would play a little animation of the
        // player healing, which they did not do; they respawned.
        if (!this._hpPrimed) {
            this._hp01 = hp01;
            this._hpPrimed = true;
        } else {
            this._hp01 = expDamp(this._hp01, hp01, 18, dt);
        }

        const qhp = Math.round(this._hp01 * 256) / 256;
        if (qhp !== this._wHp) {
            this._wHp = qhp;
            if (this.hpFill) this.hpFill.style.transform = "scaleX(" + qhp + ")";
        }

        // Ceil, not round: 0.4 health left is not "0 health", and the only reading
        // that may print as zero is actually being dead.
        const shown = p.alive === false ? 0 : Math.max(0, Math.ceil(p.health));
        if (shown !== this._wHpNum) {
            this._wHpNum = shown;
            if (this.hpNum) this.hpNum.textContent = String(shown);
        }

        const crit = hp01 <= CRIT_FRACTION;
        if (crit !== this._wCrit) {
            this._wCrit = crit;
            this.hpEl?.classList.toggle("crit", crit);
        }

        // ----------------------------------------------------------- cooldowns
        const cds = p.cooldowns;
        for (let i = 0; i < this.pips.length; i++) {
            const pip = this.pips[i];
            const until = cds && i < cds.length ? cds[i] : 0;
            const left = until - now;

            if (!(left > 0)) {
                // Ready. The fill is driven to zero rather than left where it was,
                // so the pip is not still showing a sliver of charge it has spent.
                if (pip.ready !== true) {
                    pip.ready = true;
                    pip.el.classList.add("ready");
                }
                if (pip.p !== 0) {
                    pip.p = 0;
                    if (pip.fill) pip.fill.style.transform = "scaleY(0)";
                }
                if (pip.secs !== 0) {
                    pip.secs = 0;
                    if (pip.sec) pip.sec.textContent = "";
                }
                continue;
            }

            if (pip.ready !== false) {
                pip.ready = false;
                pip.el.classList.remove("ready");
            }

            // Progress toward ready, so the pip fills as the spell recharges. The
            // inverse — draining as it recharges — was tried and read backwards:
            // a full pip has to mean a usable spell.
            const q = Math.round(clamp01(1 - left / COOLDOWN_SPAN) * 64) / 64;
            if (q !== pip.p) {
                pip.p = q;
                if (pip.fill) pip.fill.style.transform = "scaleY(" + q + ")";
            }

            const secs = Math.ceil(left);
            if (secs !== pip.secs) {
                pip.secs = secs;
                if (pip.sec) pip.sec.textContent = String(secs);
            }
        }

        // -------------------------------------------------------------- damage
        // `flash` is decayed by whoever owns the hit, so the vignette is a plain
        // read of it. Scaled down slightly because the gradient's own alpha is
        // already tuned for a full-strength hit.
        this._setOpacity(this.dmgEl, clamp01(p.flash) * 0.92, "_wDmg", 32);

        // --------------------------------------------------------------- blind
        const blind = effectLeft(p, "blind");
        this._setOpacity(
            this.blindEl,
            Math.min(BLIND_MAX, (blind / BLIND_SPAN) * BLIND_MAX),
            "_wBlind",
            32
        );

        // --------------------------------------------------------------- death
        this._setDead(
            p.alive === false,
            Math.max(0, Math.ceil((p.respawnAt || 0) - now))
        );
    }

    /**
     * @param {HTMLElement|null} el
     * @param {number} v 0..1
     * @param {string} key field holding the last written value
     * @param {number} steps quantisation, in steps across the full range
     */
    _setOpacity(el, v, key, steps) {
        if (!el) return;
        const q = Math.round(clamp01(v) * steps) / steps;
        if (q === this[key]) return;
        this[key] = q;
        el.style.opacity = String(q);
    }

    /** @param {boolean} dead @param {number} secs */
    _setDead(dead, secs) {
        if (dead !== this._wDeadShown) {
            this._wDeadShown = dead;
            this.deadEl?.classList.toggle("show", dead);
            // Re-arm the health snap, so coming back does not animate a heal.
            if (dead) this._hpPrimed = false;
        }
        if (!dead) return;
        if (secs !== this._wRespawn) {
            this._wRespawn = secs;
            if (this.deadNum) this.deadNum.textContent = String(secs);
        }
    }
}

// ------------------------------------------------------------------ helpers

function clamp01(v) {
    // NaN falls through both comparisons, so the guard is on the way out rather
    // than a separate isFinite call: a missing health field must not leave a bar
    // at `scaleX(NaN)`, which renders as full.
    return v > 0 ? (v < 1 ? v : 1) : 0;
}

/**
 * Seconds left on an effect, tolerant of a player that has no effect table.
 *
 * The tolerance is not defensive style for its own sake — the hud is built
 * before the world spawns anyone and outlives every player in it, and a
 * scripted dummy is a legitimate player with nothing on it.
 *
 * @param {import("../game/player.js").Player} p
 * @param {string} type
 */
function effectLeft(p, type) {
    const fx = p.effects;
    if (!fx || typeof fx.remaining !== "function") return 0;
    const v = fx.remaining(type);
    return v > 0 ? v : 0;
}
