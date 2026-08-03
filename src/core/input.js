/**
 * Raw input state. Everything lands in one mutable struct that systems poll —
 * no events fired into game code, no per-frame allocation.
 *
 * Mouse look uses pointer lock, which frees the right button for snow-surf.
 */

export const input = {
    // Movement axes, camera-relative, already normalised to a unit disc.
    moveX: 0,
    moveZ: 0,
    moving: false,

    // Accumulated mouse delta since last `endFrame()`, in radians.
    lookX: 0,
    lookY: 0,

    // Zoom, consumed by the camera rig.
    zoomDelta: 0,

    surf: false, // RMB held
    sprint: false, // shift
    /** Held, not toggled: the scoreboard is something you glance at mid-fight. */
    scoreboard: false, // tab

    /** Space held — keeps a jump rising while the key is down. */
    jump: false,
    /** True for the one frame Space goes down. Buffered by the controller. */
    jumpPressed: false,

    /** True for the one frame the left button goes down. Buffered by the combo. */
    attackPressed: false,

    /** @type {number} 0 = none, else 1..5 — set on keydown, cleared each frame */
    spellPressed: 0,
    /** @type {boolean} spell 2 (Ribbon) is a held cast */
    spellHeld2: false,

    locked: false,
};

const keys = Object.create(null);

const LOOK_SCALE = 0.0022;

/** @type {(() => void)|null} */
let onToggleOverlay = null;
/** @type {((locked: boolean) => void)|null} */
let onLockChange = null;

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{ onToggleOverlay?: () => void, onLockChange?: (locked: boolean) => void }} [hooks]
 */
export function initInput(canvas, hooks) {
    onToggleOverlay = hooks?.onToggleOverlay ?? null;
    onLockChange = hooks?.onLockChange ?? null;

    canvas.addEventListener("click", () => {
        if (!input.locked) canvas.requestPointerLock();
    });

    document.addEventListener("pointerlockchange", () => {
        input.locked = document.pointerLockElement === canvas;
        if (!input.locked) {
            // Drop held state so the character doesn't run off while unfocused.
            for (const k in keys) keys[k] = false;
            input.surf = false;
            input.spellHeld2 = false;
            input.jump = false;
            input.jumpPressed = false;
            input.attackPressed = false;
        }
        onLockChange?.(input.locked);
    });

    document.addEventListener("mousemove", (e) => {
        if (!input.locked) return;
        input.lookX += e.movementX * LOOK_SCALE;
        input.lookY += e.movementY * LOOK_SCALE;
    });

    canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    document.addEventListener("mousedown", (e) => {
        if (!input.locked) return;
        if (e.button === 0) input.attackPressed = true;
        if (e.button === 2) input.surf = true;
    });

    document.addEventListener("mouseup", (e) => {
        if (e.button === 2) input.surf = false;
    });

    document.addEventListener(
        "wheel",
        (e) => {
            if (!input.locked) return;
            e.preventDefault();
            input.zoomDelta += e.deltaY * 0.0016;
        },
        { passive: false }
    );

    window.addEventListener("keydown", (e) => {
        // Overlay toggle works whether or not the pointer is locked.
        if (e.code === "F1" || e.code === "Backquote") {
            e.preventDefault();
            onToggleOverlay?.();
            return;
        }
        // Space scrolls the page, and the page is the game. Tab moves focus out of it,
        // which silently breaks every other key until the canvas is clicked again.
        if (e.code === "Space" || e.code === "Tab") e.preventDefault();
        if (e.repeat) return;
        keys[e.code] = true;

        // Edge-triggered, so a jump survives a frame that lands between the
        // keydown and the poll. The controller buffers it from here.
        if (e.code === "Space") input.jumpPressed = true;

        const n = SPELL_KEYS[e.code];
        if (n) {
            input.spellPressed = n;
            if (n === 2) input.spellHeld2 = true;
        }
    });

    window.addEventListener("keyup", (e) => {
        keys[e.code] = false;
        if (SPELL_KEYS[e.code] === 2) input.spellHeld2 = false;
    });

    window.addEventListener("blur", () => {
        for (const k in keys) keys[k] = false;
        input.scoreboard = false;
        input.surf = false;
        input.spellHeld2 = false;
        input.jump = false;
        input.jumpPressed = false;
        input.attackPressed = false;
    });
}

const SPELL_KEYS = {
    Digit1: 1,
    Digit2: 2,
    Digit3: 3,
    Digit4: 4,
    Digit5: 5,
};

/** Resolve held keys into movement axes. Called once per frame before update. */
export function pollInput() {
    let x = 0;
    let z = 0;
    if (keys.KeyW || keys.ArrowUp) z += 1;
    if (keys.KeyS || keys.ArrowDown) z -= 1;
    if (keys.KeyD || keys.ArrowRight) x += 1;
    if (keys.KeyA || keys.ArrowLeft) x -= 1;

    // Clamp to a unit disc so diagonals aren't faster.
    const len = Math.sqrt(x * x + z * z);
    if (len > 1) {
        x /= len;
        z /= len;
    }
    input.moveX = x;
    input.moveZ = z;
    input.moving = len > 0.001;
    input.sprint = !!(keys.ShiftLeft || keys.ShiftRight);
    input.jump = !!keys.Space;
    input.scoreboard = !!keys.Tab;
}

/** Clear per-frame accumulators. Called at the very end of the frame. */
export function endFrame() {
    input.lookX = 0;
    input.lookY = 0;
    input.zoomDelta = 0;
    input.spellPressed = 0;
    input.jumpPressed = false;
    input.attackPressed = false;
}

export function isDown(code) {
    return !!keys[code];
}
