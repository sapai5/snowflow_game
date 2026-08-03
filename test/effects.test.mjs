/** Status effects: stacking rules, expiry, and the burn's arithmetic. */
import { Effects, SLOW, AIR_RESTRICT, STAGGER, DOT } from "../src/game/effects.js";
import { suite } from "./harness.mjs";

export async function run() {
    const { ok, result } = suite();
    const near = (a, b) => Math.abs(a - b) < 1e-6;

    const e = new Effects();
    e.apply(SLOW, 0.4, 3, "a");
    ok(near(e.moveScale, 0.6), "slow 40% gives moveScale 0.6");
    e.apply(SLOW, 0.2, 5, "b");
    ok(near(e.moveScale, 0.6), "a weaker slow does not stack the multiplier down");
    ok(e.remaining("slow") === 5, "but it does refresh to the longer timer");

    e.apply(STAGGER, 1, 0.5);
    ok(e.moveScale === 0 && e.locked, "stagger is a total lock, not a slow");
    e.tick(0.6);
    ok(!e.locked && near(e.moveScale, 0.6), "stagger expires and leaves the slow behind");

    e.apply(AIR_RESTRICT, 0.75, 1.5);
    ok(near(e.moveScale, 0.6 * 0.25), "slow and air-restrict multiply rather than max");

    // Six a second must pay six points in a second. Accumulating magnitude*dt drifts:
    // sixty additions of 0.1 sum to 5.999999999999998 and quietly pay five.
    const d = new Effects();
    d.apply(DOT, 6, 10);
    let paid = 0;
    for (let i = 0; i < 60; i++) paid += d.takeDotDamage(1 / 60);
    ok(paid === 6, "burn pays exactly 6 whole points in a second, got " + paid);
    let paid10 = paid;
    for (let i = 0; i < 540; i++) paid10 += d.takeDotDamage(1 / 60);
    ok(paid10 === 60, "and 60 over ten seconds with no drift, got " + paid10);

    d.clear(DOT);
    d.apply(DOT, 6, 1);
    ok(d.takeDotDamage(1 / 60) === 0, "a fresh burn does not pay out on its first frame");

    return result();
}
