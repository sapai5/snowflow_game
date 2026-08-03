/**
 * Hitboxes.
 *
 * Written because the spell hitboxes were reported as "weird", and they were: the sword
 * tested a capsule and every spell tested a single point at mid-chest — a sphere of radius
 * 0.35 floating at 0.875 m. Two bodies for one player.
 *
 * What that produced, and what is asserted here:
 *
 *   a snowball aimed at the head or the shins passed straight through
 *   a snowball at 22 m/s could cross a player between two frames without touching them
 *   a crystal field's horizontal reach shrank as the person in it got further up a slope,
 *     from three metres on the flat to nothing at all three metres up
 *   a wave that caught only the legs caught nobody
 *
 * None of these were visible in the code. All of them are arithmetic, so all of them are
 * checkable.
 */
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CombatResolver } from "../src/game/combat.js";
import { SPELLS, BODY_RADIUS, BODY_HEIGHT } from "../src/game/rules.js";
import { suite, mkPlayer, mkWorld } from "./harness.mjs";

const dt = 1 / 60;

/** A resolver with two players in it. `b` is the target, at (x, z). */
function arena(bx = 0, bz = 4) {
    const a = mkPlayer("a", 0, 0);
    const b = mkPlayer("b", bx, bz);
    const w = mkWorld([a, b]);
    const r = new CombatResolver(w);
    w.combat = r;
    return { a, b, w, r };
}

/** Cast, step once, and report whether `b` was hit. */
function hits(r, w, a, b, spellId, origin, aim, steps = 1) {
    r.cast(a, spellId, origin, aim);
    for (let i = 0; i < steps; i++) {
        r.update(dt);
        if (r.events.some((e) => e.kind === "spellHit" && e.on === b.id)) return true;
        r.events.length = 0;
    }
    return false;
}

export async function run() {
    const { ok, result } = suite();

    // ---- the two weapons agree about where a body is ----------------------
    {
        const src = (await import("node:fs")).readFileSync(
            new URL("../src/game/combat.js", import.meta.url), "utf8"
        );
        ok(/function bodyCapsule/.test(src),
            "there is one body definition");
        const uses = [...src.matchAll(/bodyCapsule\(/g)].length;
        ok(uses >= 3,
            "and both the sword and the spells use it, " + uses + " references");
        ok(!/_a\.set\(p\.x, p\.y \+ BODY_HEIGHT \* 0\.5/.test(src),
            "the mid-chest point test is gone — that was the sphere floating at 0.875 m");
    }

    // ---- a snowball hits a head and a pair of shins ------------------------
    {
        const ball = SPELLS[2];
        const reach = ball.radius + BODY_RADIUS;
        // Fired flat at each height, from four metres away. Aimed with no gravity drop over
        // the first frame, so the height under test is the height it arrives at.
        for (const [where, y] of [
            ["head", BODY_HEIGHT - 0.15],
            ["chest", 1.2],
            ["waist", 0.9],
            ["knee", 0.45],
            ["shin", 0.22],
        ]) {
            const { a, b, w, r } = arena(0, 3);
            const origin = new Vector3(0, y, 0.5);
            const aim = new Vector3(0, 0, 1);
            const got = hits(r, w, a, b, 2, origin, aim, 12);
            ok(got, `a snowball at ${where} height (y=${y.toFixed(2)}) connects`);
        }
        // And it still misses what it should miss.
        {
            const { a, b, w, r } = arena(0, 3);
            const got = hits(r, w, a, b, 2, new Vector3(0, 1.2, 0.5), new Vector3(1, 0, 0), 12);
            ok(!got, "a snowball fired at ninety degrees to the target does not");
        }
        {
            const { a, b, w, r } = arena(0, 3);
            const got = hits(r, w, a, b, 2, new Vector3(0, 3.4, 0.5), new Vector3(0, 0, 1), 6);
            ok(!got,
                "nor one passing well over their head, " +
                `${(3.4 - BODY_HEIGHT).toFixed(2)} m of clearance against a ` +
                `${reach.toFixed(2)} m reach`);
        }
    }

    // ---- and it cannot cross a player between frames ---------------------
    {
        // The tunnelling case, forced: one step large enough to put the projectile on the
        // far side of the target. A static overlap test passes this and a swept one does not.
        const { a, b, w, r } = arena(0, 3);
        const ball = SPELLS[2];
        r.cast(a, 2, new Vector3(0, 1.0, 0), new Vector3(0, 0, 1));
        const v = r.volumes.find((x) => x.alive && x.spell === ball);
        ok(v !== undefined, "the snowball spawned");
        // Place it a whole body-width short and step it clean past.
        v.pos.set(0, 1.0, 2.2);
        v.prevPos.copyFrom(v.pos);
        v.vel.set(0, 0, 22);
        // 22 m/s at 30 fps is 0.73 m; the target region is 0.6 m across.
        r.update(1 / 30);
        ok(r.events.some((e) => e.kind === "spellHit" && e.on === "b"),
            "a snowball stepping straight through a player registers the hit it made");
    }

    // ---- a crystal field is a cylinder, not a ball ------------------------
    {
        const field = SPELLS[4];
        const reach = field.radius + BODY_RADIUS;
        // On the flat, at the rim.
        {
            const { a, b, w, r } = arena(0, reach - 0.1);
            ok(hits(r, w, a, b, 4, new Vector3(0, 0, 0), new Vector3(0, 0, 1), 3),
                "a player just inside the rim is caught");
        }
        {
            const { a, b, w, r } = arena(0, reach + 0.5);
            ok(!hits(r, w, a, b, 4, new Vector3(0, 0, 0), new Vector3(0, 0, 1), 3),
                "one outside it is not");
        }
        // Uphill: the same horizontal distance, two metres higher. As a sphere this fell
        // from 3.23 m of reach to 1.72 m for no reason a player could see.
        {
            const { a, b, w, r } = arena(0, reach - 0.3);
            b.controller.position.y = 2;
            ok(hits(r, w, a, b, 4, new Vector3(0, 0, 0), new Vector3(0, 0, 1), 3),
                "and a player standing two metres up a slope is caught at the same " +
                "horizontal distance — the reach no longer shrinks with height");
        }
        // But being thrown clear of it does work, which is what the low column is for.
        {
            const { a, b, w, r } = arena(0, 1);
            b.controller.position.y = field.column + 0.6;
            ok(!hits(r, w, a, b, 4, new Vector3(0, 0, 0), new Vector3(0, 0, 1), 3),
                "while somebody launched above the column escapes it");
        }
    }

    // ---- updraft reaches high enough to be an anti-air -------------------
    {
        const up = SPELLS[3];
        ok(up.column > 4,
            "the updraft is a tall column, " + up.column + " m — as a sphere of radius " +
            up.radius + " it stopped catching anyone about " + up.radius +
            " m up, which is the height its own launch reaches");
        const { a, b, w, r } = arena(0, 1);
        b.controller.position.y = 3.5;
        ok(hits(r, w, a, b, 3, new Vector3(0, 0, 0), new Vector3(0, 0, 1), 3),
            "so a player already in the air is thrown again");
    }

    // ---- a wave that catches the legs catches the player ------------------
    {
        const wave = SPELLS[1];
        // Cast from chest height, aimed flat, at a target close enough that the cone's
        // rim passes through their legs but not their centre.
        const { a, b, w, r } = arena(0, 1.2);
        // Aim downward so the axis passes below the body centre.
        const aim = new Vector3(0, -0.55, 1);
        aim.normalize();
        ok(hits(r, w, a, b, 1, new Vector3(0, 1.35, 0), aim, 3),
            "a wave angled at the legs connects — it used to test the chest only, so an " +
            "attack that visibly swept somebody's feet did nothing");
    }

    // ---- the shapes are declared, not implied ----------------------------
    {
        for (const id of [3, 4, 5]) {
            ok(SPELLS[id].column !== undefined,
                SPELLS[id].name + " declares a column height rather than defaulting to a " +
                "ball, whose horizontal reach varies with the target's height");
        }
        ok(SPELLS[4].column < SPELLS[3].column,
            "the field is lower than the updraft: one is an area to stand in, the other " +
            "is an anti-air");
        ok(SPELLS[2].column === undefined,
            "the snowball has no column — it is a swept sphere, not an area");
    }

    return result();
}
