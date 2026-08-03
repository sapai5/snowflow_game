/**
 * Hit feedback: does a connected hit differ from a whiffed one?
 *
 * The complaint this suite exists for was "there are no visual cues for hitting them",
 * and the underlying cause was that a hit and a miss produced identical output except
 * for a number on a health bar. So what is asserted is the *difference*: an event with
 * a contact point, a hitmarker, a light, and hit-stop — none of which a whiff produces.
 */
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CombatResolver } from "../src/game/combat.js";
import { ImpactFx } from "../src/vfx/impactFx.js";
import { suite, mkPlayer, mkWorld, aimBlade, STAGE } from "./harness.mjs";

const dt = 1 / 60;

export async function run() {
    const { ok, result } = suite();

    const mkFx = (world) => {
        const grains = [];
        const lights = [];
        const marks = [];
        const spray = { emit: (...a) => grains.push(a) };
        const pool = { add: (...a) => lights.push(a) };
        const rig = { trauma: 0, addTrauma(t) { this.trauma += t; } };
        const cross = { hits: [], hit(w) { this.hits.push(w); marks.push(w); } };
        return { fx: new ImpactFx(world, spray, pool, rig, cross), grains, lights, marks, rig, cross };
    };

    // ---- a connected hit produces every cue -------------------------------
    {
        const a = mkPlayer("a", 0, 0), b = mkPlayer("b", 0, 1);
        a.isLocal = true;
        const w = mkWorld([a, b]);
        const r = new CombatResolver(w);
        w.combat = r;
        const t = mkFx(w);
        r.update(dt);
        a.combat.stage = 1; a.combat.stageTiming = STAGE; a.combat.t = 0.2;
        aimBlade(a, 0, 1);
        r.update(dt);

        const hit = r.events.find((e) => e.kind === "hit");
        ok(hit !== undefined, "a hit is reported");
        ok(hit && hit.x !== undefined && hit.y !== undefined,
            "with a contact point, so the burst can be placed on the victim");
        ok(a.controller.hitstop > 0, "the attacker's time stops briefly on contact");
        ok(b.controller.hitstop > 0, "and so does the victim's — the moment is shared");

        t.fx.update(dt);
        ok(t.grains.length > 10, "a burst is thrown, got " + t.grains.length + " grains");
        ok(t.marks.length === 1, "the reticle confirms the hit");
        ok(t.rig.trauma > 0, "and the camera kicks");
        // The light is declared over the following frames as it fades.
        t.fx.update(dt);
        ok(t.lights.length > 0, "a light is declared at the contact point");
        if (t.lights.length) {
            const [x, y, z] = t.lights[0];
            ok(Math.abs(x - hit.x) < 1e-6 && Math.abs(y - hit.y) < 1e-6 && Math.abs(z - hit.z) < 1e-6,
                "at the contact point rather than at either fighter's feet");
        }
    }

    // ---- a whiff produces none of it --------------------------------------
    {
        const a = mkPlayer("a", 0, 0), b = mkPlayer("b", 0, 12);
        a.isLocal = true;
        const w = mkWorld([a, b]);
        const r = new CombatResolver(w);
        w.combat = r;
        const t = mkFx(w);
        r.update(dt);
        a.combat.stage = 1; a.combat.stageTiming = STAGE; a.combat.t = 0.2;
        aimBlade(a, 0, 1); // swings at nothing; b is twelve metres away
        r.update(dt);
        t.fx.update(dt);
        ok(!r.events.some((e) => e.kind === "hit"), "a whiff reports no hit");
        ok(t.grains.length === 0, "throws nothing");
        ok(t.marks.length === 0, "does not mark the reticle");
        ok(a.controller.hitstop === 0, "and does not stop time");
    }

    // ---- a clash is louder than a hit -------------------------------------
    {
        const a = mkPlayer("a", 0, 0), b = mkPlayer("b", 0, 1);
        a.isLocal = true;
        const w = mkWorld([a, b]);
        const r = new CombatResolver(w);
        w.combat = r;
        const t = mkFx(w);
        r.update(dt);
        a.combat.stage = 1; a.combat.stageTiming = STAGE; a.combat.t = 0.2;
        b.combat.stage = 1; b.combat.stageTiming = STAGE; b.combat.t = 0.2;
        aimBlade(a, 0, 1);
        aimBlade(b, 0, 0);
        r.update(dt);
        const clash = r.events.find((e) => e.kind === "clash");
        ok(clash && clash.x !== undefined, "a clash reports where the blades met");
        t.fx.update(dt);
        ok(t.rig.trauma > 0.1, "and shakes harder than a hit does, got " + t.rig.trauma.toFixed(2));
    }

    return result();
}

/**
 * Damage numbers.
 *
 * The HUD needs a DOM, so this drives the parts that decide *what* to show against a
 * minimal fake document rather than trying to stand up a real one. What is under test is
 * the bookkeeping — which number, from which event, merged with which — not the CSS.
 */
export async function runNumbers() {
    const { ok, result } = suite();

    // A document just real enough for the pool.
    const mkEl = () => {
        const el = {
            className: "", textContent: "",
            classList: { toggle() {}, add() {}, remove() {} },
            appendChild() {}, remove() {},
            // The HUD resolves its pip children up front rather than walking the tree
            // every frame, so the fake has to answer a query with something iterable.
            querySelectorAll: () => [],
            querySelector: () => mkEl(),
        };
        el.style = new Proxy({}, { set: () => true, get: () => "" });
        return el;
    };
    globalThis.document = {
        getElementById: () => mkEl(),
        createElement: () => mkEl(),
    };

    const { Hud } = await import("../src/ui/hud.js");

    const a = mkPlayer("a", 0, 0), b = mkPlayer("b", 0, 1);
    a.isLocal = true;
    const w = mkWorld([a, b]);
    w.combat = { events: [] };
    const hud = new Hud(w);
    const live = () => hud._dmg.filter((r) => r.age !== Infinity);

    // ---- a sword hit shows the resolver's own number ----------------------
    w.combat.events = [{ kind: "hit", by: "a", on: "b", stage: 1, amount: 9, x: 0, y: 1, z: 1 }];
    hud._readHits(a);
    ok(live().length === 1, "a hit I landed makes one number");
    ok(live()[0].text === "9", "showing the amount the resolver reported, got " + live()[0].text);
    ok(!live()[0].cls.includes("taken"), "styled as damage dealt");

    // ---- the finisher is marked heavy -------------------------------------
    w.combat.events = [{ kind: "hit", by: "a", on: "b", stage: 3, amount: 15, x: 0, y: 1, z: 1 }];
    hud._readHits(a);
    ok(hud._dmg.some((r) => r.text === "15" && r.cls.includes("heavy")),
        "the finisher is marked heavy");

    // ---- damage taken is distinguishable ---------------------------------
    w.combat.events = [{ kind: "hit", by: "b", on: "a", stage: 1, amount: 9, x: 0, y: 1, z: 0 }];
    hud._readHits(a);
    ok(hud._dmg.some((r) => r.cls.includes("taken")), "damage taken is styled apart");

    // ---- a hit between two other players is not my business --------------
    const c = mkPlayer("c", 5, 5);
    w.players.set("c", c);
    const before = live().length;
    w.combat.events = [{ kind: "hit", by: "b", on: "c", stage: 1, amount: 9, x: 5, y: 1, z: 5 }];
    hud._readHits(a);
    ok(live().length === before, "a hit I neither dealt nor took shows nothing");

    // ---- a zero-damage spell shows nothing rather than a "0" -------------
    const b2 = live().length;
    w.combat.events = [{ kind: "spellHit", by: "a", on: "b", spell: "vortex", amount: 0, x: 0, y: 1, z: 1 }];
    hud._readHits(a);
    ok(live().length === b2, "vortex does no damage, so it floats no number");

    // ---- burn ticks merge into one climbing number -----------------------
    {
        const fresh = new Hud(w);
        for (let i = 0; i < 9; i++) {
            w.combat.events = [{ kind: "burn", by: "a", on: "b", amount: 1, x: 0, y: 1, z: 1 }];
            fresh._readHits(a);
        }
        const burns = fresh._dmg.filter((r) => r.age !== Infinity && r.cls.includes("burn"));
        ok(burns.length === 1,
            "nine ticks make one number, not nine, got " + burns.length);
        ok(burns[0].text === "9", "and it counts up to the total, got " + burns[0].text);
    }

    // ---- but a fresh burn after a gap starts a new number ----------------
    {
        const fresh = new Hud(w);
        w.combat.events = [{ kind: "burn", by: "a", on: "b", amount: 1, x: 0, y: 1, z: 1 }];
        fresh._readHits(a);
        // Age it past the merge window the way the frame loop would.
        fresh._dmg.forEach((r) => { if (r.age !== Infinity) r.age = 0.6; });
        w.combat.events = [{ kind: "burn", by: "a", on: "b", amount: 1, x: 0, y: 1, z: 1 }];
        fresh._readHits(a);
        const burns = fresh._dmg.filter((r) => r.age !== Infinity && r.cls.includes("burn"));
        ok(burns.length === 2, "a tick after the window starts a new number, got " + burns.length);
    }

    // ---- the pool never grows --------------------------------------------
    {
        const fresh = new Hud(w);
        const size = fresh._dmg.length;
        for (let i = 0; i < 200; i++) {
            w.combat.events = [{ kind: "hit", by: "a", on: "b", stage: 1, amount: 9, x: 0, y: 1, z: 1 }];
            fresh._readHits(a);
        }
        ok(fresh._dmg.length === size,
            "two hundred hits allocate no thirteenth element, still " + fresh._dmg.length);
    }

    delete globalThis.document;
    return result();
}
