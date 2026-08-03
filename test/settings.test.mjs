/**
 * The settings table against the widget schema.
 *
 * Every entry in `SCHEMA` names a key in `S`, and the overlay formats that key's value
 * — a float slider calls `toFixed` on it. So a schema row whose key does not exist in
 * `S` is not a missing slider, it is a `TypeError` thrown while the overlay is being
 * built, which happens during boot, which means the game does not start at all. The
 * message it produces ("Cannot read properties of undefined") names neither the
 * setting nor the file.
 *
 * That has now broken startup once, from an edit that added the schema row and missed
 * the value. This suite is here so it cannot do it again: it is a hundred times cheaper
 * to assert than to diagnose from a browser console.
 */
import { S, SCHEMA, PRESETS } from "../src/core/settings.js";
import { suite } from "./harness.mjs";

export async function run() {
    const { ok, result } = suite();

    const keys = new Set(Object.keys(S));
    let rows = 0;
    for (const group of SCHEMA) {
        ok(typeof group.group === "string" && group.group.length > 0, "every schema group is named");
        for (const item of group.items) {
            rows++;
            ok(keys.has(item.k), `schema row "${item.k}" (${group.group}) exists in S`);
            ok(typeof item.l === "string" && item.l.length > 0, `"${item.k}" has a label`);

            const v = S[item.k];
            if (item.t === "f") {
                ok(typeof v === "number" && Number.isFinite(v),
                    `"${item.k}" is a finite number, since the overlay calls toFixed on it`);
                ok(item.min !== undefined && item.max !== undefined && item.step !== undefined,
                    `float "${item.k}" has min, max and step`);
                ok(v >= item.min && v <= item.max,
                    `"${item.k}" default ${v} sits inside its own slider range ${item.min}..${item.max}`);
            } else if (item.t === "b") {
                ok(typeof v === "boolean", `"${item.k}" is a boolean`);
            } else if (item.t === "e") {
                ok(Array.isArray(item.opts) && item.opts.length > 0, `enum "${item.k}" has options`);
                ok(item.opts.includes(v), `"${item.k}" default "${v}" is one of its options`);
            } else {
                ok(false, `"${item.k}" has an unknown widget type "${item.t}"`);
            }
        }
    }
    ok(rows > 20, "the schema is actually populated, got " + rows + " rows");

    // A preset that names a setting which no longer exists silently does nothing, which
    // is a subtler version of the same bug: the quality level appears to apply and one
    // of its values is quietly ignored.
    for (const [name, preset] of Object.entries(PRESETS)) {
        for (const k of Object.keys(preset)) {
            ok(keys.has(k), `preset "${name}" key "${k}" exists in S`);
        }
    }

    return result();
}
