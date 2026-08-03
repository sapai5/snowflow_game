/**
 * Sound, synthesised.
 *
 * There are no audio assets in this project and adding some would mean either shipping
 * megabytes of samples or picking licences to comply with; every sound here is generated
 * from noise and oscillators at load, into a handful of short buffers. That is a real
 * constraint rather than a preference, but it suits the material: snow, ice and wind are
 * broadband noise with envelopes on them, which is exactly what synthesis is good at, and
 * a sword made of ice has no recorded reference anyway.
 *
 * Everything is positional except the wind and the local player's own blade. Positional
 * audio is most of what tells you a fight is happening behind you — with four players on
 * a 240 m field, hearing where someone is matters more than what they sound like.
 *
 * Browsers refuse to start an audio context until the user has interacted with the page.
 * That is not an error to work around; it is the reason `resume()` exists and is called
 * from the same click that locks the pointer.
 */

/** Voices that can overlap. Beyond this the oldest is stolen. */
const VOICES = 24;

/** How far a sound can be heard, metres. Past this it is not scheduled at all. */
const EARSHOT = 120;

export class Audio {
    constructor() {
        /** @type {AudioContext|null} */
        this.ctx = null;
        this.master = null;
        this.buffers = {};
        this.enabled = true;
        this.volume = 0.7;
        this._voices = [];
        this._next = 0;
        this._windGain = null;
        this._started = false;
    }

    /**
     * Build the context and the buffers.
     *
     * Called on the first user gesture. Constructing an `AudioContext` before then
     * produces one stuck in `suspended`, and some browsers count it against a per-page
     * limit, so there is nothing to gain by doing it early.
     */
    start() {
        if (this._started) return;
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        this._started = true;
        this.ctx = new Ctx();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.volume;
        this.master.connect(this.ctx.destination);

        this.buffers = {
            step: crunch(this.ctx, 0.12, 900, 0.55),
            swing: whoosh(this.ctx, 0.26),
            hit: impact(this.ctx, 0.3, 320),
            clash: ring(this.ctx, 0.7, [1720, 2580, 3310]),
            cast: swell(this.ctx, 0.55),
            death: ring(this.ctx, 1.1, [180, 268, 402]),
            land: crunch(this.ctx, 0.24, 420, 0.9),
        };

        this._wind();
    }

    /** Browsers suspend the context when the tab is hidden; this brings it back. */
    resume() {
        this.start();
        if (this.ctx && this.ctx.state === "suspended") this.ctx.resume();
    }

    setVolume(v) {
        this.volume = v;
        if (this.master) this.master.gain.value = v;
    }

    /**
     * A continuous wind bed.
     *
     * One looping noise source through a band-pass, whose gain follows the local player's
     * speed. It does the job a music track would — filling the silence — without
     * competing with the fight for attention, and it doubles as the speed cue that makes
     * surfing feel fast.
     */
    _wind() {
        const ctx = this.ctx;
        const src = ctx.createBufferSource();
        src.buffer = noise(ctx, 3.0);
        src.loop = true;
        const band = ctx.createBiquadFilter();
        band.type = "bandpass";
        band.frequency.value = 520;
        band.Q.value = 0.6;
        const gain = ctx.createGain();
        gain.gain.value = 0.0;
        src.connect(band).connect(gain).connect(this.master);
        src.start();
        this._windGain = gain;
        this._windBand = band;
    }

    /**
     * @param {number} dt
     * @param {number} speed01 the local player's speed, normalised
     */
    update(dt, speed01) {
        if (!this.ctx || !this.enabled) return;
        if (this._windGain) {
            // Follows speed with a floor, so standing still is quiet but not silent.
            const want = 0.02 + 0.16 * speed01 * speed01;
            const g = this._windGain.gain;
            g.value += (want - g.value) * Math.min(1, dt * 4);
            this._windBand.frequency.value = 420 + 900 * speed01;
        }
    }

    /**
     * Play a buffer at a world position.
     *
     * @param {string} name
     * @param {{x:number,y:number,z:number}} at
     * @param {{x:number,y:number,z:number}} listener
     * @param {number} [gain]
     * @param {number} [rate] playback rate, for pitch variation
     */
    at(name, at, listener, gain = 1, rate = 1) {
        if (!this.ctx || !this.enabled) return;
        const buf = this.buffers[name];
        if (!buf) return;
        const dx = at.x - listener.x;
        const dy = at.y - listener.y;
        const dz = at.z - listener.z;
        const dist = Math.hypot(dx, dy, dz);
        if (dist > EARSHOT) return;

        const ctx = this.ctx;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.playbackRate.value = rate;

        const pan = ctx.createPanner();
        pan.panningModel = "equalpower";
        pan.distanceModel = "inverse";
        pan.refDistance = 4;
        pan.maxDistance = EARSHOT;
        // Rolloff well below the physical 1/r: a fight at forty metres should still be
        // audible enough to turn toward, and inverse-square puts it under the wind.
        pan.rolloffFactor = 0.7;
        pan.positionX.value = at.x;
        pan.positionY.value = at.y;
        pan.positionZ.value = at.z;

        const g = ctx.createGain();
        g.gain.value = gain;
        src.connect(pan).connect(g).connect(this.master);
        src.start();
        this._hold(src);
    }

    /** Play without a position — the local player's own actions. */
    flat(name, gain = 1, rate = 1) {
        if (!this.ctx || !this.enabled) return;
        const buf = this.buffers[name];
        if (!buf) return;
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        src.playbackRate.value = rate;
        const g = this.ctx.createGain();
        g.gain.value = gain;
        src.connect(g).connect(this.master);
        src.start();
        this._hold(src);
    }

    /** Where the ears are. */
    listener(pos, forward) {
        if (!this.ctx) return;
        const l = this.ctx.listener;
        if (l.positionX) {
            l.positionX.value = pos.x;
            l.positionY.value = pos.y;
            l.positionZ.value = pos.z;
            l.forwardX.value = forward.x;
            l.forwardY.value = forward.y;
            l.forwardZ.value = forward.z;
            l.upX.value = 0;
            l.upY.value = 1;
            l.upZ.value = 0;
        } else if (l.setPosition) {
            // Safari, until recently.
            l.setPosition(pos.x, pos.y, pos.z);
            l.setOrientation(forward.x, forward.y, forward.z, 0, 1, 0);
        }
    }

    /**
     * Keep a reference until the source has finished.
     *
     * Without this, a source whose only reference was local can be collected mid-play in
     * some engines. The ring also caps how many can overlap: twenty-four voices of ice
     * shattering at once is noise, and stealing the oldest is what a mixer would do.
     */
    _hold(src) {
        const old = this._voices[this._next];
        if (old) {
            try { old.stop(); } catch { /* already finished */ }
        }
        this._voices[this._next] = src;
        this._next = (this._next + 1) % VOICES;
        src.onended = () => {
            const i = this._voices.indexOf(src);
            if (i >= 0) this._voices[i] = null;
        };
    }
}

// ------------------------------------------------------------------ synthesis
//
// Each of these renders one short buffer once, at load. Nothing here runs per frame.

function noise(ctx, seconds) {
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    // Slightly correlated rather than white: pure white noise reads as static, and a
    // one-pole low-pass on it reads as air and snow.
    let last = 0;
    for (let i = 0; i < n; i++) {
        const w = Math.random() * 2 - 1;
        last = last * 0.72 + w * 0.28;
        d[i] = last * 1.8;
    }
    return buf;
}

/** A footfall in snow: filtered noise with a fast decay. */
function crunch(ctx, seconds, cutoff, punch) {
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let lp = 0;
    const k = Math.min(1, cutoff / (ctx.sampleRate * 0.5));
    for (let i = 0; i < n; i++) {
        const t = i / n;
        lp += ((Math.random() * 2 - 1) - lp) * k;
        // Two envelopes multiplied: a click at the front and a granular tail. One
        // exponential alone sounds like a drum rather than like compacting snow.
        const env = Math.pow(1 - t, 2.4) * (1 - 0.5 * Math.sin(t * 40) * t);
        d[i] = lp * env * punch;
    }
    return buf;
}

/** A blade through air: band-passed noise that rises then falls. */
function whoosh(ctx, seconds) {
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let bp = 0;
    let lp = 0;
    for (let i = 0; i < n; i++) {
        const t = i / n;
        // The sweep is the whole sound: a fixed filter is a hiss, a moving one is motion.
        const k = 0.04 + 0.5 * Math.sin(Math.PI * t);
        lp += ((Math.random() * 2 - 1) - lp) * k;
        bp = lp - bp * 0.5;
        const env = Math.sin(Math.PI * Math.pow(t, 0.7));
        d[i] = bp * env * 0.5;
    }
    return buf;
}

/** A blow landing: a low thud with ice grit over it. */
function impact(ctx, seconds, freq) {
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let lp = 0;
    for (let i = 0; i < n; i++) {
        const t = i / n;
        const env = Math.pow(1 - t, 3.2);
        // A pitch that falls, which is what makes it read as weight rather than as a beep.
        const body = Math.sin(2 * Math.PI * freq * (1 - 0.45 * t) * (i / ctx.sampleRate));
        lp += ((Math.random() * 2 - 1) - lp) * 0.45;
        d[i] = (body * 0.55 + lp * 0.45) * env;
    }
    return buf;
}

/** Ice ringing: a few inharmonic partials decaying at different rates. */
function ring(ctx, seconds, partials) {
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let p = 0; p < partials.length; p++) {
        const f = partials[p];
        // Higher partials die first, which is what separates ice from a bell.
        const decay = 3.0 + p * 2.2;
        const amp = 0.42 / (p + 1);
        for (let i = 0; i < n; i++) {
            const t = i / ctx.sampleRate;
            d[i] += Math.sin(2 * Math.PI * f * t) * Math.exp(-decay * t) * amp;
        }
    }
    // A noise transient at the front: the strike itself, before anything resonates.
    let lp = 0;
    const click = Math.floor(ctx.sampleRate * 0.02);
    for (let i = 0; i < click; i++) {
        lp += ((Math.random() * 2 - 1) - lp) * 0.6;
        d[i] += lp * (1 - i / click) * 0.5;
    }
    return buf;
}

/** A spell being cast: noise swelling upward under a rising tone. */
function swell(ctx, seconds) {
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let lp = 0;
    for (let i = 0; i < n; i++) {
        const t = i / n;
        const sec = i / ctx.sampleRate;
        lp += ((Math.random() * 2 - 1) - lp) * (0.05 + 0.3 * t);
        const tone = Math.sin(2 * Math.PI * (180 + 520 * t * t) * sec);
        const env = Math.pow(t, 0.6) * Math.pow(1 - t, 1.1) * 2.4;
        d[i] = (lp * 0.5 + tone * 0.35) * env;
    }
    return buf;
}
