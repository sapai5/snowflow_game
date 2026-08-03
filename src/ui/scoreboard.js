/**
 * Scoreboard, kill feed, and the join link.
 *
 * The three pieces of a match that are not the fight itself. All DOM, all driven from
 * the net client's own bookkeeping, and all written only when something changed — a
 * scoreboard rebuilt every frame is sixty layout passes a second to display four rows
 * that change once a minute.
 *
 * The kill feed is a fixed pool of rows rather than a list that grows and shrinks. The
 * usual approach — append a row, remove it on a timer — churns the DOM at exactly the
 * moment the frame is busiest, which is the instant somebody died.
 */

/** Rows in the feed. Four players cannot produce more than a few at once. */
const FEED_ROWS = 5;
/** How long a feed line stays, seconds. */
const FEED_LIFE = 6;

export class Scoreboard {
    /**
     * @param {import("../game/world.js").World} world
     * @param {() => (import("../net/client.js").NetClient|null)} getNet
     */
    constructor(world, getNet) {
        this.world = world;
        this.getNet = getNet;

        this.el = document.getElementById("score");
        this.rowsEl = document.getElementById("score-rows");
        this.feedEl = document.getElementById("feed");
        this.statusEl = document.getElementById("net-status");
        this.linkEl = document.getElementById("share-link");

        /** One record per scoreboard row, pooled. */
        this._rows = [];
        for (let i = 0; i < 4; i++) {
            const row = document.createElement("div");
            row.className = "score-row";
            const name = document.createElement("span");
            name.className = "score-name";
            const k = document.createElement("span");
            k.className = "score-k";
            const d = document.createElement("span");
            d.className = "score-d";
            row.append(name, k, d);
            this.rowsEl?.appendChild(row);
            this._rows.push({ row, name, k, d, shown: false, txt: "", kv: -1, dv: -1, me: false });
        }

        /** One record per feed line, pooled. */
        this._feed = [];
        for (let i = 0; i < FEED_ROWS; i++) {
            const line = document.createElement("div");
            line.className = "feed-line";
            this.feedEl?.appendChild(line);
            this._feed.push({ el: line, age: Infinity, text: "", op: -1 });
        }
        this._feedNext = 0;

        this._status = "";
        this._open = false;
    }

    /** Show or hide the full table. Held open by a key rather than toggled. */
    setOpen(v) {
        if (v === this._open) return;
        this._open = v;
        this.el?.classList.toggle("open", v);
    }

    /**
     * A line for the feed.
     *
     * @param {string} text
     * @param {boolean} [mine] true if the local player did it or it happened to them
     */
    say(text, mine) {
        const rec = this._feed[this._feedNext];
        this._feedNext = (this._feedNext + 1) % FEED_ROWS;
        rec.age = 0;
        if (rec.text !== text) {
            rec.text = text;
            rec.el.textContent = text;
        }
        rec.el.className = "feed-line" + (mine ? " mine" : "");
        rec.op = -1;
    }

    /** @param {number} dt */
    update(dt) {
        this._ageFeed(dt);
        this._drawScores();
        this._drawStatus();
    }

    _ageFeed(dt) {
        for (const rec of this._feed) {
            if (rec.age === Infinity) continue;
            rec.age += dt;
            if (rec.age >= FEED_LIFE) {
                rec.age = Infinity;
                if (rec.op !== 0) {
                    rec.op = 0;
                    rec.el.style.opacity = "0";
                }
                continue;
            }
            // Full for most of its life, then out. A line that fades the whole way is
            // unreadable for the second half of it.
            const t = rec.age / FEED_LIFE;
            const op = t < 0.75 ? 1 : 1 - (t - 0.75) * 4;
            const q = Math.round(op * 16) / 16;
            if (q !== rec.op) {
                rec.op = q;
                rec.el.style.opacity = String(q);
            }
        }
    }

    /**
     * The table.
     *
     * Falls back to the local world when there is no network, so the same panel works in
     * single player against the dummies — where kills are still worth counting, and where
     * this is the only way to find out whether that last exchange went your way.
     */
    _drawScores() {
        const net = this.getNet();
        let list;
        if (net && net.scores.length > 0) {
            list = net.scores;
        } else {
            list = [];
            for (const p of this.world.players.values()) {
                list.push({ id: p.id, name: p.name || p.id, kills: p.kills | 0, deaths: p.deaths | 0 });
            }
            list.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
        }

        const myId = this.world.local ? this.world.local.id : null;
        for (let i = 0; i < this._rows.length; i++) {
            const rec = this._rows[i];
            const item = list[i];
            const show = !!item;
            if (show !== rec.shown) {
                rec.shown = show;
                rec.row.style.display = show ? "" : "none";
            }
            if (!show) continue;

            const label = (net ? net.names.get(item.id) : null) || item.name || item.id;
            if (label !== rec.txt) {
                rec.txt = label;
                rec.name.textContent = label;
            }
            if (item.kills !== rec.kv) {
                rec.kv = item.kills;
                rec.k.textContent = String(item.kills);
            }
            if (item.deaths !== rec.dv) {
                rec.dv = item.deaths;
                rec.d.textContent = String(item.deaths);
            }
            const mine = item.id === myId;
            if (mine !== rec.me) {
                rec.me = mine;
                rec.row.classList.toggle("me", mine);
            }
        }
    }

    _drawStatus() {
        const net = this.getNet();
        let s;
        if (!net) s = "";
        else if (net.rejected) s = "refused: " + net.rejected;
        else if (!net.connected) s = "reconnecting…";
        else if (!net.ready) s = "joining…";
        else {
            const n = this.world.players.size;
            s = net.room + " · " + n + "/4 · " + Math.round(net.rtt * 1000) + " ms";
        }
        if (s !== this._status) {
            this._status = s;
            if (this.statusEl) {
                this.statusEl.textContent = s;
                this.statusEl.classList.toggle("show", s.length > 0);
            }
        }
    }

    /** Put the shareable link on screen, and make clicking it copy it. */
    showLink(url) {
        if (!this.linkEl) return;
        this.linkEl.textContent = url;
        this.linkEl.classList.add("show");
        this.linkEl.onclick = () => {
            // `navigator.clipboard` needs a secure context, which a tunnel has and plain
            // localhost also counts as. If it is missing there is nothing useful to fall
            // back to, and the text is selectable anyway.
            navigator.clipboard?.writeText(url).then(
                () => {
                    this.linkEl.classList.add("copied");
                    setTimeout(() => this.linkEl.classList.remove("copied"), 1200);
                },
                () => {}
            );
        };
    }

    dispose() {
        for (const r of this._rows) r.row.remove();
        for (const f of this._feed) f.el.remove();
        this._rows.length = 0;
        this._feed.length = 0;
    }
}
