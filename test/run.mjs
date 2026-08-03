/**
 * The test runner.
 *
 * Node cannot resolve the extensionless deep imports Babylon is written with and the
 * bundler handles in the browser, so every suite is loaded through a resolver hook
 * that retries with `.js`. That is the whole reason this file exists rather than
 * `node --test`.
 *
 * What is testable here is the simulation: combat rules, status effects, spell
 * volumes, and the character controller, none of which touch a GPU. What is not is
 * anything that needs a device — there is no WebGPU in Node, and headless Chromium
 * does not ship an adapter either, so rendering is verified by reading it.
 *
 *   npm test
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

register("./resolve.mjs", pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "/")));

const here = dirname(fileURLToPath(import.meta.url));
const suites = readdirSync(here).filter((f) => f.endsWith(".test.mjs")).sort();

let total = 0;
let failed = 0;
for (const s of suites) {
    const mod = await import(join(here, s));
    // A suite may export more than one entry point when part of it needs different
    // fixtures — the spline, for instance, needs no Babylon scene and the rest does.
    for (const name of Object.keys(mod).filter((k) => k.startsWith("run"))) {
        const r = await mod[name]();
        total += r.total;
        failed += r.failed;
        const label = r.failed ? `FAIL ${r.failed}/${r.total}` : `ok   ${r.total}`;
        const suffix = name === "run" ? "" : " · " + name.slice(3).toLowerCase();
        console.log(`${label.padEnd(14)} ${s.replace(".test.mjs", "")}${suffix}`);
        for (const m of r.messages) console.log("               " + m);
    }
}
console.log(`\n${total - failed}/${total} assertions passed across ${suites.length} suites`);
process.exit(failed ? 1 : 0);
