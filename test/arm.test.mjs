/**
 * The sword arm's reachable envelope.
 *
 * Two-bone IK solves for any target within reach, including targets a shoulder cannot
 * present a hand to. It has no concept of a joint limit, so an impossible target does not
 * fail — it returns a pose that is merely wrong, which is how the finisher came to have
 * the arm wrapping over the head. Its coil was authored at 98 degrees across the body and
 * 46 degrees up, and nothing anywhere objected.
 *
 * The envelope is a plain function of two angles, so it is checked here rather than
 * looked at. `figure.js` cannot be imported — it builds meshes at construction — so the
 * geometry is re-derived from the source's own constants. That is weaker than importing
 * it and is the reason the arc *mesh* maths was split into its own module; this table is
 * too entangled with the rig to follow.
 */
import { readFileSync } from "node:fs";
import { suite } from "./harness.mjs";

const SRC = readFileSync(new URL("../src/character/figure.js", import.meta.url), "utf8");
const num = (name) => {
    const m = SRC.match(new RegExp("const " + name + "\\s*=\\s*(-?[0-9.]+)"));
    if (!m) throw new Error("missing " + name);
    return parseFloat(m[1]);
};

/** The envelope, mirrored from `shoulderYawRange`. */
function yawRange(elev) {
    const rise = Math.max(0, elev) / 90;
    const drop = Math.max(0, -elev) / 90;
    return [-58 + 46 * rise - 24 * drop, 122 - 44 * rise - 18 * drop];
}

/** Every authored arc: `{ fromYaw, fromElev, toYaw, toElev, viaYaw?, viaElev?, bow? }`. */
function arcs() {
    const block = SRC.slice(SRC.indexOf("const SWING_ARCS = ["), SRC.indexOf("];", SRC.indexOf("const SWING_ARCS = [")));
    return [...block.matchAll(/hand:\s*\{([^}]*)\}/g)].map((m) => {
        const o = {};
        for (const kv of m[1].split(",")) {
            const [k, v] = kv.split(":").map((x) => x && x.trim());
            if (k && v !== undefined) o[k] = parseFloat(v);
        }
        return o;
    });
}

const d2r = Math.PI / 180;
const dir = (y, e) => {
    const ce = Math.cos(e * d2r);
    return [ce * Math.sin(y * d2r), Math.sin(e * d2r), ce * Math.cos(y * d2r)];
};
const between = (a, b) =>
    Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) / d2r;

export async function run() {
    const { ok, result } = suite();

    const ELEV_MIN = num("SH_ELEV_MIN");
    const ELEV_MAX = num("SH_ELEV_MAX");
    const list = arcs();

    ok(list.length === 3, "three arcs are authored, got " + list.length);

    // ---- the envelope has the shape a shoulder has -------------------------
    {
        ok(ELEV_MAX < 100,
            "the hand cannot go past the vertical, or it is behind the head: max is " +
            ELEV_MAX);
        ok(ELEV_MIN > -90, "nor straight through the floor: min is " + ELEV_MIN);

        const atLevel = yawRange(0);
        const overhead = yawRange(85);
        ok(overhead[0] > atLevel[0],
            "crossing the midline is more restricted overhead than at shoulder height: " +
            overhead[0].toFixed(0) + " against " + atLevel[0].toFixed(0));
        ok(overhead[1] < atLevel[1],
            "and so is reaching behind: " + overhead[1].toFixed(0) + " against " +
            atLevel[1].toFixed(0));
        // A hand can touch the opposite hip and cannot touch the opposite ear.
        ok(yawRange(-60)[0] < -60, "a low hand crosses the body freely");
        ok(overhead[0] > -25, "a raised hand barely crosses it at all");
        ok(atLevel[1] > 90,
            "and the arm reaches behind the frontal plane at shoulder height");
    }

    // ---- every authored angle is inside it --------------------------------
    {
        for (let i = 0; i < list.length; i++) {
            const h = list[i];
            const pairs = [["from", h.fromYaw, h.fromElev], ["to", h.toYaw, h.toElev]];
            if (h.viaYaw !== undefined) pairs.push(["via", h.viaYaw, h.viaElev]);
            for (const [name, yaw, elev] of pairs) {
                const [lo, hi] = yawRange(elev);
                ok(elev >= ELEV_MIN && elev <= ELEV_MAX,
                    `arc ${i + 1} ${name} elevation ${elev} is reachable`);
                ok(yaw >= lo - 1e-9 && yaw <= hi + 1e-9,
                    `arc ${i + 1} ${name} yaw ${yaw} is inside [${lo.toFixed(0)}, ${hi.toFixed(0)}] at elevation ${elev}`);
            }
        }
    }

    // ---- the specific pose that was broken --------------------------------
    {
        const [lo] = yawRange(46);
        ok(-98 < lo,
            "the old finisher coil — 98 degrees across the body at 46 up — is outside " +
            "the envelope, which is the whole point: the limit is " + lo.toFixed(0));
    }

    // ---- no plane is repeated --------------------------------------------
    {
        // Each stroke must travel a different way through space, or the string reads as
        // the same swing three times.
        const dirs = list.map((h) => {
            const a = dir(h.fromYaw, h.fromElev);
            const b = dir(h.toYaw, h.toElev);
            return [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        });
        for (let i = 0; i < dirs.length; i++) {
            for (let j = i + 1; j < dirs.length; j++) {
                const a = dirs[i];
                const b = dirs[j];
                const la = Math.hypot(...a);
                const lb = Math.hypot(...b);
                const cos = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb);
                ok(cos < 0.9,
                    `arcs ${i + 1} and ${j + 1} sweep in different directions, cos ` +
                    cos.toFixed(2));
            }
        }
    }

    // ---- the string is continuous -----------------------------------------
    {
        // Stage order is 1, then the return, then the finisher — which is arc indices
        // 0, 2, 1, because `plane` in STAGES selects the arc. Each stroke should begin
        // near where the last one ended, or the hand teleports between strokes.
        const order = [0, 2, 1];
        for (let i = 0; i + 1 < order.length; i++) {
            const end = list[order[i]];
            const next = list[order[i + 1]];
            const gap = between(
                dir(end.toYaw, end.toElev),
                dir(next.fromYaw, next.fromElev)
            );
            // The finisher deliberately raises overhead first, so its gap is larger — it
            // is the anticipation, and it has 0.38 s of wind-up to travel in.
            const limit = order[i + 1] === 1 ? 70 : 20;
            ok(gap < limit,
                `stroke ${i + 2} coils near where stroke ${i + 1} finished, ${gap.toFixed(0)} deg apart`);
        }
    }

    // ---- the raised-arm elbow does not point up --------------------------
    {
        // A vertical pole on a vertical limb axis leaves the elbow direction undefined.
        // The pole must go lateral as the hand rises.
        ok(/lat \+= high \* /.test(SRC),
            "the elbow pole is pushed lateral for a raised arm");
        ok(/vert = vert \* \(1 - high\) - high \*/.test(SRC),
            "and its vertical component is removed, not just reduced");
        ok(/const high = clamp\(\(hu - /.test(SRC),
            "driven by how high the hand actually is, not by the phase alone");
    }

    // ---- the IK fallback is basis-free ----------------------------------
    {
        const solve = SRC.slice(SRC.indexOf("function solveTwoBone"));
        ok(!/ox = 0; oy = 0; oz = 1;/.test(solve),
            "the degenerate-pole fallback is no longer world +z, which is wrong for a " +
            "character facing any other direction");
        ok(/least aligned/.test(solve),
            "and is derived from the limb axis instead");
    }

    // ---- the swing is sampled densely enough to look smooth -------------
    {
        const combat = readFileSync(new URL("../src/character/swordCombat.js", import.meta.url), "utf8");
        const strikes = [...combat.matchAll(/strike:\s*([0-9.]+)/g)].map((m) => parseFloat(m[1]));
        const power = parseFloat(combat.match(/const STRIKE_POWER = ([0-9.]+)/)[1]);
        const floor = parseFloat(combat.match(/const STRIKE_FLOOR = ([0-9.]+)/)[1]);

        const ss = (t) => t * t * (3 - 2 * t);
        const curve = (t) => floor * t + (1 - floor) * Math.pow(ss(t), power);
        const peakStep = (arcDeg, strike, fps) => {
            const frames = strike * fps;
            let peak = 0;
            for (let i = 0; i < frames; i++) {
                peak = Math.max(peak, (curve((i + 1) / frames) - curve(i / frames)) * arcDeg);
            }
            return peak;
        };

        // Stage order again: 1, return, finisher.
        const order = [0, 2, 1];
        for (let i = 0; i < 3; i++) {
            const h = list[order[i]];
            const arcDeg = between(dir(h.fromYaw, h.fromElev), dir(h.toYaw, h.toElev));
            // Thirty is the frame rate to design for, not sixty: it is what the game
            // actually runs at on this machine, and it is where undersampling shows.
            const step = peakStep(arcDeg, strikes[i], 30);
            ok(step < 20,
                `stroke ${i + 1} moves ${step.toFixed(1)} deg per frame at its fastest ` +
                `(30 fps) — above about twenty the pose reads as skipping rather than ` +
                `as fast`);
        }
        ok(power < 1.6,
            "the velocity curve is not so peaked that the travel lands in three frames, " +
            "power " + power);
        ok(floor > 0.25,
            "and keeps a floor, so the blade leaves the coil and arrives with speed " +
            "rather than easing to a stop at both ends: " + floor);
    }

    return result();
}
