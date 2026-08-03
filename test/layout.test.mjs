/**
 * Screen furniture: does anything sit on top of anything else?
 *
 * There are eight fixed panels now — HUD, kill feed, scoreboard, connection state, invite
 * link, hint, crosshair, nameplates — and they were each placed correctly at the moment
 * they were written and without reference to each other. That is how the invite link ended
 * up underneath the HUD: bottom left was free when the HUD was the only thing there.
 *
 * A browser would answer this in one line and there is no browser here, so the geometry is
 * read out of the stylesheet and the stack heights are derived from the same rules that
 * produce them. It is cruder than a layout engine and it catches the only mistake that has
 * actually happened: two panels claiming one corner.
 */
import { readFileSync } from "node:fs";
import { suite } from "./harness.mjs";

const HTML = readFileSync(new URL("../index.html", import.meta.url), "utf8");

/** The declarations of one selector. */
function rule(sel) {
    const m = HTML.match(
        new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}")
    );
    return m ? m[1] : "";
}

const px = (body, prop) => {
    const m = body.match(new RegExp("(?:^|[;\\s])" + prop + ":\\s*(-?[0-9.]+)px"));
    return m ? parseFloat(m[1]) : null;
};

/** Which corner a fixed panel is pinned to, and how far in. */
function corner(sel) {
    const body = rule(sel);
    if (!/position:\s*fixed/.test(body)) return null;
    const centred = /left:\s*50%/.test(body);
    return {
        left: centred ? null : px(body, "left"),
        right: px(body, "right"),
        top: px(body, "top"),
        bottom: px(body, "bottom"),
        centred,
    };
}

export async function run() {
    const { ok, result } = suite();

    const hud = corner("#hud");
    const feed = corner("#feed");
    const link = corner("#share-link");
    const status = corner("#net-status");
    const score = corner("#score");
    const hint = corner("#hint");

    ok(hud && feed && link && status && score, "every panel is pinned");

    // ---- the invite link is not under the HUD ------------------------------
    {
        // The bug: the link was at bottom left with an 18 px offset and the HUD is at
        // bottom left with a 24 px offset and about 67 px of content above it.
        const bothBottomLeft =
            link.bottom !== null && link.left !== null &&
            hud.bottom !== null && hud.left !== null;
        ok(!bothBottomLeft,
            "the invite link does not share the HUD's corner");
        ok(link.top !== null && link.left !== null,
            "it is top left, which is the corner nothing else claims — the HUD and feed " +
            "are bottom left, the hint is bottom centre, and the settings panel is the " +
            "full height of the right edge");
    }

    // ---- the kill feed clears the HUD -------------------------------------
    {
        // Derived from the same declarations the browser uses, rather than guessed: a
        // caption line, a bar with its margin, and a row of pips with theirs.
        const capFont = px(rule("#hud .cap"), "font-size") || 9;
        const capLine = Math.round(capFont * 1.4);
        const barTop = px(rule("#hud .hp"), "margin-top") || 0;
        const barH = px(rule("#hud .hp"), "height") || 0;
        const pipsTop = px(rule("#hud .pips"), "margin-top") || 0;
        const pipH = px(rule("#hud .pip"), "height") || 0;
        const hudH = capLine + barTop + barH + pipsTop + pipH;
        const hudTopEdge = hud.bottom + hudH;

        ok(feed.bottom > hudTopEdge,
            `the feed starts above the HUD: feed at ${feed.bottom}, HUD reaches ` +
            `${hudTopEdge}`);
        ok(feed.bottom - hudTopEdge >= 12,
            `with enough margin to survive the HUD gaining a row, ` +
            `${(feed.bottom - hudTopEdge).toFixed(0)} px — it was five`);
    }

    // ---- the two right-hand panels do not collide ------------------------
    {
        const statusFont = px(rule("#net-status"), "font-size") || 11;
        const statusH = Math.round(statusFont * 1.4);
        ok(score.top >= status.top + statusH,
            `the scoreboard hangs below the connection line: ${score.top} against ` +
            `${status.top} + ${statusH}`);
    }

    // ---- nothing is pinned to two opposite edges at once -----------------
    {
        for (const [name, c] of [["hud", hud], ["feed", feed], ["link", link],
            ["status", status], ["score", score]]) {
            ok(!(c.left !== null && c.right !== null),
                name + " is pinned horizontally to one edge");
            ok(!(c.top !== null && c.bottom !== null),
                name + " is pinned vertically to one edge");
        }
    }

    // ---- the hint stays out of the reticle -------------------------------
    {
        ok(hint.centred && hint.bottom !== null && hint.bottom > 24,
            "the hint is bottom centre and clear of the bottom edge");
    }

    // ---- the invite link says what it is ---------------------------------
    {
        ok(/#share-link::before[\s\S]*?content:\s*"invite/.test(HTML),
            "the link is labelled — a bare URL in a corner does not say what it is for");
        ok(/#share-link\.copied::before[\s\S]*?content:\s*"copied/.test(HTML),
            "and it says so when it has been copied");
        ok(/max-width:\s*\d+vw/.test(rule("#share-link")),
            "and it is width-capped, because a tunnel URL is long");
    }

    return result();
}
