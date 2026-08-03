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

/**
 * The finisher, as a heavy attack.
 *
 * A heavy attack is a contract: it costs commitment and it pays consequence. Both halves
 * are asserted here because either alone is a worse attack than the light strokes it is
 * supposed to escalate from — a slow strike with no payoff is a mistake, and a fast one
 * with a big payoff is the only move anyone would ever use.
 */
export async function runHeavy() {
    const { ok, result } = suite();

    const combat = readFileSync(new URL("../src/character/swordCombat.js", import.meta.url), "utf8");
    const rules = readFileSync(new URL("../src/game/rules.js", import.meta.url), "utf8");
    const figure = SRC;

    const stages = [...combat.matchAll(/windup:\s*([0-9.]+),\s*strike:\s*([0-9.]+),\s*recover:\s*([0-9.]+)/g)]
        .map((m) => ({ windup: +m[1], strike: +m[2], recover: +m[3] }));
    ok(stages.length === 3, "three stages, got " + stages.length);

    const total = (s) => s.windup + s.strike + s.recover;
    const heavy = stages[2];

    // ---- commitment --------------------------------------------------------
    {
        ok(total(heavy) > total(stages[0]) * 1.8,
            "the finisher costs far longer than a light stroke: " +
            total(heavy).toFixed(2) + " s against " + total(stages[0]).toFixed(2));
        ok(heavy.windup >= 0.45,
            "with a wind-up long enough to be seen and answered, " + heavy.windup + " s");
        ok(heavy.recover >= 0.35,
            "and a recovery long enough that missing costs something, " + heavy.recover + " s");
        // The strike itself must stay quick. A slow strike does not read as restrained,
        // it reads as underwater — and it is also the parry window.
        ok(heavy.strike < heavy.windup,
            "while the strike stays shorter than the wind-up that loads it");
    }

    // ---- readability, which is a ratio and not a speed --------------------
    {
        const controller = readFileSync(new URL("../src/character/controller.js", import.meta.url), "utf8");
        const run = parseFloat(controller.match(/const RUN_SPEED = ([0-9.]+)/)[1]);
        const covered = heavy.windup * run;
        // Reach is about 1.48 m: blade tip from body centre, accounting for carry tilt.
        ok(covered > 1.6,
            "an opponent can cover more than a reach's worth of ground while the " +
            "finisher loads, so it can be walked out of: " + covered.toFixed(1) + " m");
        ok(covered < 4,
            "but not so much that it could never land: " + covered.toFixed(1) + " m");
    }

    // ---- consequence ------------------------------------------------------
    {
        const kb = rules.match(/SWORD_KNOCKBACK = \[([^\]]*)\]/)[1].split(",").map(Number);
        ok(kb[3] > kb[1] * 3,
            "the finisher shoves far harder than a light hit: " + kb[3] + " against " + kb[1]);
        ok(kb[3] >= 9,
            "hard enough to push the victim out of the attacker's own reach, " + kb[3] + " m/s");
        ok(/FINISHER_STAGGER/.test(rules), "and it staggers");
        const st = parseFloat(rules.match(/FINISHER_STAGGER = ([0-9.]+)/)[1]);
        ok(st > 0.2 && st < 0.6,
            "briefly — a stagger is a full input lock and it must not be a spectator " +
            "seat: " + st + " s");
        ok(/stage >= 3/.test(readFileSync(new URL("../src/game/combat.js", import.meta.url), "utf8")),
            "and only the finisher does, so the earlier decision that a normal hit does " +
            "not stagger still stands");
    }

    // ---- two hands ---------------------------------------------------------
    {
        ok(/twoHand: 1/.test(combat), "the finisher is flagged two-handed");
        const flags = [...combat.matchAll(/twoHand:/g)];
        ok(flags.length === 1,
            "and it is the only one — a light stroke that needed both hands would not be " +
            "a light stroke");
        ok(/ch\.swingGrip = expDamp/.test(combat), "the grip is a blend, not a switch");
        ok(/gripWant > ch\.swingGrip \? 7 : 14/.test(combat),
            "and it takes hold more slowly than it lets go: reaching across is part of " +
            "the anticipation, releasing is the follow-through pulling the arms apart");

        ok(/const a = 1 - ai/.test(figure),
            "the sword arm is solved first, so the off hand has a handle to reach for");
        ok(/GRIP_DROP/.test(figure), "the off hand takes hold below the sword hand");
        const drop = parseFloat(figure.match(/const GRIP_DROP = ([0-9.]+)/)[1]);
        ok(drop > 0.05 && drop < 0.21,
            "by about a hand's width, and inside the 21 cm the grip actually is: " + drop);
        ok(/a === 0 && ch\.swingGrip > 0\.002/.test(figure),
            "only the off arm is redirected");
    }

    // ---- the coil is not so high that the top of the arc is a hold -------
    {
        const fin = [...figure.matchAll(/hand:\s*\{([^}]*)\}/g)][1][1];
        const elev = parseFloat(fin.match(/fromElev:\s*(-?[0-9.]+)/)[1]);
        ok(elev < 70,
            "the finisher's coil clears the head without going straight above it, where " +
            "the blade has to come back down through the space it went up through: " + elev);
        ok(elev > 45, "but is still overhead rather than a shoulder-height swipe: " + elev);
    }

    return result();
}
