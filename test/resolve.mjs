/**
 * Resolve extensionless specifiers the way the bundler does.
 *
 * Vite rewrites `@babylonjs/core/Maths/math.scalar` to the real file; Node does not, and
 * the two failure modes look different enough to need handling separately:
 *
 *   the specifier fails to resolve at all — retry it with `.js` appended.
 *
 *   the specifier *resolves*, to a file URL that does not exist. This happens whenever a
 *   package's exports map is broad enough to answer the path without checking it, and it
 *   is the harder case, because resolution reported success and the module only fails
 *   later at load, by which point a try/catch around resolution has long since returned.
 *   So the resolved URL is checked here, on disk, before it is handed back.
 *
 * Without the second case, any suite importing a module that reaches Babylon's Scalar
 * dies at load — which silently kept the controller, the camera and the sword's own state
 * machine out of the tests.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Does a resolved URL point at something that is actually there? */
function present(url) {
    if (!url || !url.startsWith("file:")) return true;
    try {
        return existsSync(fileURLToPath(url));
    } catch {
        return true;
    }
}

export async function resolve(specifier, context, next) {
    const retry = !specifier.endsWith(".js") && !specifier.startsWith("node:");

    let resolved;
    try {
        resolved = await next(specifier, context);
    } catch (err) {
        if (retry) return next(specifier + ".js", context);
        throw err;
    }

    if (retry && !present(resolved.url)) {
        try {
            return await next(specifier + ".js", context);
        } catch {
            return resolved;
        }
    }
    return resolved;
}
