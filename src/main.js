/**
 * SNOWFLOW — entry point and frame orchestration.
 *
 * WebGPU only, by design. No WebGL path, no feature-detect branches: if the
 * adapter isn't there we say so once and stop.
 */

import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
// Side-effect import: installs `captureGPUFrameTime` / `getGPUFrameTimeCounter`
// onto the engine prototype, which is what makes the overlay's GPU row a real
// GPU number rather than the presentation cadence.
import "@babylonjs/core/Engines/AbstractEngine/abstractEngine.timeQuery";
import { Scene } from "@babylonjs/core/scene";
import { Vector3, Color3, Color4 } from "@babylonjs/core/Maths/math";

import { registerShaders } from "./shaders/registry.js";
import { S, onChange } from "./core/settings.js";
import {
    sample, checkSpike, stats, mark, installDrawCounter, endFrameDraws,
} from "./core/perf.js";
import { initInput, pollInput, endFrame, input } from "./core/input.js";
import { CameraRig } from "./core/camera.js";
import { World } from "./game/world.js";
import { SPELLS } from "./game/combat.js";
import { SprayField } from "./vfx/particles.js";
import { SurfWake } from "./vfx/surfWake.js";
import { VolumeFx } from "./vfx/volumeFx.js";
import { ImpactFx } from "./vfx/impactFx.js";
import { Scoreboard } from "./ui/scoreboard.js";
import { NetClient, roomFromUrl, shareLink } from "./net/client.js";
import { makeRoomCode } from "./net/protocol.js";
import { Audio } from "./audio/audio.js";
import { SpellSystem } from "./spells/spellSystem.js";
import { Overlay } from "./ui/overlay.js";
import { DummyCrowd } from "./dev/dummies.js";
import { Crosshair } from "./ui/crosshair.js";
import { Hud } from "./ui/hud.js";
import { Sky } from "./render/sky.js";
import { ShadowSystem } from "./render/shadows.js";
import { Terrain } from "./terrain/terrain.js";
import { DepthPass } from "./render/depthPass.js";
import { PostChain } from "./post/postChain.js";
import { whenReady } from "./core/gpuUtil.js";
import * as loading from "./core/loading.js";

// ------------------------------------------------------- module-scope scratch
const _vel = new Vector3();
const _handOut = new Float32Array(3);

async function boot() {
    const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById("view"));

    if (!navigator.gpu) {
        loading.fail("WebGPU is not available in this browser.");
        return;
    }

    await loading.phase("creating device", 0.05);

    const engine = new WebGPUEngine(canvas, {
        antialias: false, // TAA handles edges; MSAA here would just cost bandwidth
        stencil: false,
        powerPreference: "high-performance",
        enableAllFeatures: true,
        setMaximumLimits: true,
    });

    try {
        await engine.initAsync();
    } catch (err) {
        console.error(err);
        loading.fail("WebGPU device initialisation failed.");
        return;
    }

    // The heightfield is R32F and is filtered in the vertex shader, which needs
    // this feature. Every desktop GPU that can run this demo has it.
    const filterable = engine.getCaps().textureFloatLinearFiltering;
    if (!filterable) {
        console.warn("[snowflow] float32-filterable unavailable; height will step");
    }

    const applyScale = () => engine.setHardwareScalingLevel(1 / S.resolutionScale);
    applyScale();
    onChange("resolutionScale", applyScale);
    window.addEventListener("resize", () => engine.resize());

    installDrawCounter(engine);
    // WebGPU timestamp queries. The engine is created with `enableAllFeatures`,
    // so `timestamp-query` is on wherever the adapter has it; if it does not,
    // the counter simply stays at zero and the overlay shows a dash.
    engine.captureGPUFrameTime(true);
    registerShaders();

    await loading.phase("building scene", 0.12);

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.02, 0.03, 0.05, 1);
    scene.autoClear = true;
    // Do NOT clear depth between rendering groups. Babylon clears depth before
    // every group by default; here group 1 is the opaque scene and group 2 is
    // the alpha-blended water and spray, which must depth-test against it.
    scene.setRenderingAutoClearDepthStencil(1, false);
    scene.setRenderingAutoClearDepthStencil(2, false);
    // No stock lights: every material here computes its own lighting.
    scene.ambientColor = new Color3(0, 0, 0);

    const rig = new CameraRig(scene, canvas);
    scene.activeCamera = rig.camera;

    // ------------------------------------------------------------------ sky
    await loading.phase("integrating atmosphere", 0.2);
    const sky = new Sky(scene);
    sky.mesh.renderingGroupId = 0;
    await sky.solve();

    // -------------------------------------------------------------- shadows
    const shadows = new ShadowSystem(scene);

    // The camera-space depth prepass. It is a custom render target, and the
    // scene renders those in registration order — so creating it here, after
    // the cascades and before anything that draws, is the whole of the
    // scheduling.
    const depthPass = new DepthPass(scene);

    // -------------------------------------------------------------- terrain
    await loading.phase("baking heightfield", 0.34);
    const terrain = new Terrain(scene, sky, shadows);
    terrain.mesh.renderingGroupId = 1;
    await terrain.build();
    onChange("showTerrain", (v) => (terrain.mesh.isVisible = v));
    depthPass.registerCaster(terrain.mesh, terrain.makePrepassMaterial());

    await loading.phase("placing character", 0.62);

    // Airborne snow: footfall kick, the surf plume, spell spray, and every
    // character's footfalls and blade. One pool, shared by the whole world.
    const spray = new SprayField(scene, terrain, sky, shadows);

    // The player table. Each player owns its own controller, figure, sword, combo
    // and snow contact — see `game/player.js`. Adding the other three is a
    // `spawn()` call; the network will be a driver that writes their intents.
    const world = new World({ scene, terrain, sky, shadows, spray, deform: terrain.deform });
    const me = world.spawn({ name: "you", isLocal: true });
    me.figure.registerPrepass(depthPass);
    me.sword.registerPrepass(depthPass);

    // Kept as names because a great deal of code below still reads the local
    // player's parts directly — the camera, the wake, the spells and the overlay all
    // follow *you*, not the world.
    const character = me.controller;
    const figure = me.figure;
    const sword = me.sword;
    const combat = me.combat;

    onChange("showCharacter", (v) => {
        figure.setVisible(v);
        sword.setVisible(v && S.showSword !== false);
    });
    onChange("showSword", (v) => sword.setVisible(v && S.showCharacter !== false));

    // Extra players, driven by a script rather than by input or by a socket. The
    // same `Player` the local one is, so what this measures and what it looks like
    // are both the real thing.
    const crowd = new DummyCrowd(world, depthPass);
    onChange("dummyCount", (v) => crowd.setCount(v));

    // The breaking wave, its bow crest and the plume it sheds.
    const wake = new SurfWake(scene, sky, shadows, character, spray, terrain);
    onChange("showWake", (v) => wake.setEnabled(v));
    wake.registerPrepass(depthPass);

    // The five spells, the water body they bend and the ice they leave. Every
    // one of them writes into the same terrain state buffer the feet and the
    // wake do, and lights the snow through the same four-slot pool.
    const spells = new SpellSystem(
        scene, sky, shadows, terrain, character, figure.figure, rig, spray
    );
    // Every surface a spell can light.
    spells.addConsumers(
        terrain.material, figure.bodyMat, figure.clothMat,
        wake.material, spray.material, sword.material
    );
    spells.registerPrepass(depthPass);

    // Anyone can cast, so anyone needs the visuals. Hung on the world rather than
    // passed down: the dummies reach for it, and a networked player's cast will too.
    world.spellFx = spells;

    // The visible half of a gameplay volume — currently the Snowball, which had a
    // hitbox and no picture. See `vfx/volumeFx.js`.
    const volumeFx = new VolumeFx(world.combat, spray);

    // The visual spell system asks permission and reports what it played; the combat
    // resolver owns the rules and spawns the volume that actually hurts people. The
    // split is deliberate: the visuals hold shared GPU pools and cannot sensibly exist
    // per player, while a gameplay volume must. If they ever disagree, the volume wins.
    const _castOrigin = new Vector3();
    const _castAim = new Vector3();
    const _audioFwd = new Vector3();
    spells.gate = {
        allow: (id) => me.alive && !me.effects.locked && me.spellReady(id, world.now),
        cast: (id) => {
            const spell = SPELLS[id];
            _castAim.copyFrom(spells.aim);
            // Cone and burst come off the caster; sphere and field land where the
            // reticle points, capped so a spell cannot be dropped across the map.
            if (spell && (spell.kind === "sphere" || spell.kind === "field")) {
                const reach = Math.min(25, spell.aimRange || 25);
                _castOrigin.copyFrom(me.controller.position);
                _castOrigin.addInPlace(_castAim.scale(reach));
                _castOrigin.y = terrain.heightAt(_castOrigin.x, _castOrigin.z);
                _castAim.copyFrom(spells.aim);
            } else {
                me.figure.figure.handPosition(0, _handOut, 0);
                _castOrigin.set(_handOut[0], _handOut[1], _handOut[2]);
            }
            world.combat.cast(me, id, _castOrigin, _castAim);
        },
    };

    // The rig needs ground heights to keep the spring arm above the snow.
    rig.groundAt = (x, z) => terrain.heightAt(x, z);

    const post = new PostChain(scene, rig.camera, depthPass, sky);

    const overlay = new Overlay({ rig, character });
    const hud = new Hud(world);
    const crosshair = new Crosshair();

    // What a hit looks like: a burst, a light, a hitmarker and a kick. Reads the combat
    // events, so it answers hits from anyone against anyone.
    const impactFx = new ImpactFx(world, spray, spells.lights, rig, crosshair);

    // ------------------------------------------------------------------- network
    //
    // A room in the URL means multiplayer; no room means single player, unchanged. The
    // game is fully playable before the socket connects and stays playable if it drops,
    // which is the only sane arrangement when the transport is a free tunnel.
    /** @type {NetClient|null} */
    let net = null;
    const scoreboard = new Scoreboard(world, () => net);

    /**
     * A name for the nameplate.
     *
     * Remembered across sessions, because being asked to type a name every time you
     * reload is worse than a name you did not choose. `?name=` wins if it is there, which
     * is what makes it possible to hand someone a link that names them.
     */
    function playerName() {
        const fromUrl = new URLSearchParams(location.search).get("name");
        if (fromUrl) {
            try { localStorage.setItem("snowflow.name", fromUrl); } catch { /* private mode */ }
            return fromUrl;
        }
        try {
            const saved = localStorage.getItem("snowflow.name");
            if (saved) return saved;
        } catch { /* private mode: fall through to a default */ }
        return "rider";
    }

    const room = roomFromUrl();
    if (room) {
        net = new NetClient(world, {
            room,
            name: playerName(),
            onStatus: (kind, detail) => {
                if (kind === "joined") scoreboard.say("joined " + room);
                else if (kind === "lost") scoreboard.say("connection lost — retrying");
                else if (kind === "rejected") {
                    scoreboard.say(detail && detail.why === "full"
                        ? "that room is full"
                        : "could not join: " + (detail && detail.why));
                }
            },
            onEvent: (kind, data) => {
                if (kind === "joined") scoreboard.say(data.name + " joined");
                else if (kind === "left") scoreboard.say(data.name + " left");
                else if (kind === "died") {
                    const mine = data.by === net.localId || data.id === net.localId;
                    scoreboard.say(
                        data.killer ? data.killer + " → " + data.name : data.name + " died",
                        mine
                    );
                } else if (kind === "cast") {
                    // Somebody else's spell, replayed through the same two calls the local
                    // player's cast makes: the resolver for the volume that hurts people,
                    // the visual system for the picture. Both are needed — a spell that is
                    // only drawn does nothing and a spell that is only resolved is
                    // invisible — and going through the same entry points is what makes an
                    // authoritative zone identical on all four clients.
                    //
                    // Not our own. The authority relays a cast to the whole room including
                    // the caster, which is the right thing for it to do — it does not know
                    // or care which clients have already drawn it — so the filtering
                    // belongs here. Without it a local cast plays twice: two volumes, two
                    // pictures, and the damage counted from both.
                    if (data.by === net.localId) return;
                    const caster = world.players.get(data.by);
                    if (!caster) return;
                    _castOrigin.set(data.o[0], data.o[1], data.o[2]);
                    _castAim.set(data.a[0], data.a[1], data.a[2]);
                    world.combat.cast(caster, data.s, _castOrigin, _castAim, true);
                    spells.castAs(data.s, caster, _castAim, _castOrigin, 0.3);
                }
            },
        });
        net.connect();
        scoreboard.showLink(shareLink(room));
    } else {
        // Offline, but the link is still worth showing: it is how a session becomes a
        // game with other people in it, and inventing the code here means the host never
        // has to think of one.
        scoreboard.showLink(shareLink(makeRoomCode()));
    }
    // Declared inside the spell system's own light window — see `extraLights`. Declaring
    // them from the frame loop instead put them either side of it: cleared before they
    // were seen, or added after the materials had the frame's pool.
    spells.extraLights = (dt) => impactFx.update(dt);
    // Sound. Every buffer is synthesised at start, and start cannot happen before a user
    // gesture — a browser will hand back a context stuck in `suspended` otherwise — so it
    // hangs off the same click that locks the pointer.
    const audio = new Audio();
    initInput(canvas, {
        onToggleOverlay: () => overlay.toggle(),
        onLockChange: (locked) => {
            crosshair.setVisible(locked);
            if (locked) audio.resume();
        },
    });
    onChange("volume", (v) => audio.setVolume(v));
    onChange("sound", (v) => { audio.enabled = v; });

    // ------------------------------------------------------------- warm-up
    // Everything that can compile, compiles here — behind the loading screen.
    await loading.phase("compiling pipelines", 0.78);
    shadows.update(rig.camera, sky.sunDir);
    sky.render(rig, 0);
    await terrain.warmUp();
    terrain.update(rig.camera.position, character.position, 0);
    figure.update(0);
    figure.sync(rig.camera.position);
    await figure.warmUp();
    await sword.warmUp();
    await me.trail.warmUp();
    spray.update(0, rig.camera.position);
    await spray.warmUp();
    await wake.warmUp();
    await spells.warmUp(
        character.position.x + 3, character.position.y, character.position.z + 3
    );
    await whenReady(sky.material, "sky material", [sky.mesh, false]);
    await depthPass.warmUp();
    post.update(0, 0, rig.distance);
    const passes = post.passes;
    for (let i = 0; i < passes.length; i++) {
        await whenReady(passes[i], "post:" + passes[i].name);
    }

    await loading.phase("warming render targets", 0.92);
    // A few real frames so every render target is allocated and every pipeline
    // has actually been bound at least once.
    for (let i = 0; i < 3; i++) {
        scene.render();
        await loading.nextFrame();
    }
    // Only now: the spell meshes had to be standing *through* those frames for
    // their render pipelines to exist. See `WaterBody.warmUp`.
    spells.finishWarmUp();

    // ------------------------------------------------------------- run loop
    let prev = performance.now();
    let time = 0;

    engine.runRenderLoop(() => {
        const now = performance.now();
        let dtMs = now - prev;
        prev = now;
        if (dtMs > 100) dtMs = 100;
        const dt = S.freezeTime ? 0 : dtMs / 1000;
        time += dt;

        pollInput();

        // Per-system CPU timing. Babylon's WebGPU timestamp queries are
        // whole-frame, so the GPU row is a total and these are not subdivisions
        // of it — the overlay labels them `cpu` for that reason.
        const tFrame = performance.now();

        // Every player: locomotion, combo, figure, sword, contact — the order the
        // single-player path used, now run per player. See `World.update`.
        crowd.drive(dt, rig);
        me.intent = input;
        // Remote positions land *before* the world updates, so a remote figure is posed
        // from where it is meant to be this frame rather than one frame behind. At four
        // players in a fight that frame is a visible lag on everyone else's blade.
        if (net) net.applyRemotes(world.now);
        world.update(dt, rig, rig.camera.position);
        const tChar = performance.now();

        _vel.copyFrom(character.velocity);
        rig.update(dt, character.position, _vel, character.lean, character.speed01);
        crosshair.update(dt, character);
        hud.update(dt, rig);
        // After the world, so this frame's hits are in the event list; before
        // `endFrame`, which is what clears it.
        if (net) net.update(dt);
        scoreboard.setOpen(input.scoreboard);
        scoreboard.update(dt);

        // Sound reads the same event list the HUD and the impact effects do, and for the
        // same reason: a hit is one thing that happened, and three systems answering it
        // separately from three different sources would eventually disagree about whether
        // it did.
        audio.update(dt, character.speed01);
        rig.getFlatForward(_audioFwd);
        audio.listener(rig.camera.position, _audioFwd);
        for (const e of world.combat.events) {
            const mine = world.local && e.by === world.local.id;
            if (e.kind === "hit") {
                if (mine) audio.flat("hit", 0.55, 0.9 + Math.random() * 0.2);
                else if (e.x !== undefined) audio.at("hit", e, rig.camera.position, 0.6);
            } else if (e.kind === "clash") {
                if (e.x !== undefined) audio.at("clash", e, rig.camera.position, 0.8);
            } else if (e.kind === "spellHit" && e.x !== undefined) {
                audio.at("hit", e, rig.camera.position, 0.45, 0.7);
            } else if (e.kind === "cast") {
                const caster = world.players.get(e.by);
                if (mine) audio.flat("cast", 0.5);
                else if (caster) audio.at("cast", caster.controller.position, rig.camera.position, 0.6);
            } else if (e.kind === "death") {
                const who = world.players.get(e.on);
                if (who) audio.at("death", who.controller.position, rig.camera.position, 0.7);
            }
        }
        // Footfalls and landings come off the controllers rather than off events, because
        // they are not combat and nothing else needs to know about them.
        for (const p of world.players.values()) {
            const c = p.controller;
            if (c.footfall) {
                const g = 0.16 + 0.34 * c.footImpact;
                if (p === world.local) audio.flat("step", g, 0.92 + Math.random() * 0.16);
                else audio.at("step", c.footPos, rig.camera.position, g * 1.4, 0.92 + Math.random() * 0.16);
            }
            if (c.landed) {
                if (p === world.local) audio.flat("land", 0.5);
                else audio.at("land", c.position, rig.camera.position, 0.6);
            }
            // The swing, on the frame the strike opens.
            if (p.combat.stage > 0 && p.combat.t > 0 && p._sfxStage !== p.combat.stage) {
                p._sfxStage = p.combat.stage;
                const heavy = p.combat.stage >= 3;
                if (p === world.local) audio.flat("swing", heavy ? 0.4 : 0.3, heavy ? 0.82 : 1.05);
                else audio.at("swing", c.position, rig.camera.position, 0.45, heavy ? 0.82 : 1.05);
            } else if (p.combat.stage === 0) {
                p._sfxStage = 0;
            }
        }

        // Jitters the projection and republishes everything the screen-space
        // passes derive from the camera. Must be after the rig has moved and
        // before anything reads `scene.getTransformMatrix()` — which the depth
        // prepass and the beauty pass both do.
        post.update(dt, character.streak01, rig.distance);
        sky.update();
        sky.render(rig, time);
        shadows.update(rig.camera, sky.sunDir);
        // After the shadow refit, so the water and the ice carry this frame's
        // cascade matrices; before the terrain, so the brushes every spell
        // writes are in the staging array when the simulation pass runs.
        spells.update(dt, rig.camera.position);
        volumeFx.update(dt);
        const tSpells = performance.now();
        terrain.update(rig.camera.position, character.position, dt);
        const tTerrain = performance.now();
        // After the shadow refit, so the figure's uniforms carry this frame's
        // cascade matrices rather than last frame's.
        world.sync(rig.camera.position);
        // Before the spray: the wake decides where its own lip is, and the
        // grains it sheds have to be in the pool before the pool is uploaded.
        wake.update(dt, rig.camera.position);
        spray.update(dt, rig.camera.position);
        const tVfx = performance.now();

        scene.render();
        post.endFrame();
        const tRender = performance.now();

        mark("cpu character", tChar - tFrame);
        mark("cpu spells", tSpells - tChar);
        mark("cpu terrain", tTerrain - tSpells);
        mark("cpu wake+spray", tVfx - tTerrain);
        mark("cpu submit", tRender - tVfx);
        mark("cpu total", tRender - tFrame);
        stats.gpuMs = engine.getGPUFrameTimeCounter().lastSecAverage / 1e6;

        endFrameDraws();
        stats.triangles =
            (terrain.mesh.metadata ? terrain.mesh.metadata.triangles : 0) +
            (S.showCharacter ? world.triangles : 0) +
            (wake.mesh.isVisible ? wake.mesh.metadata.triangles : 0) +
            spells.triangles +
            spray.liveCount * 2;

        sample(dtMs);
        checkSpike(dtMs);
        overlay.update(dtMs, engine);

        world.endFrame();
        endFrame();
    });

    await loading.done();
    setTimeout(() => overlay.resetSpikes(), 800);

    globalThis.SNOWFLOW = {
        engine, scene, rig, spray, wake, spells,
        overlay, hud, terrain, sky, shadows, post, depthPass, crowd, world, volumeFx, impactFx,
        scoreboard, audio, get net() { return net; },
        // The local player's parts, for the console. `world.players` has everyone.
        me, character, figure, sword, combat, contact: me.contact,
        S, input, perfStats: stats,
    };
}

boot().catch((err) => {
    console.error(err);
    // Say what actually went wrong. The generic message this used to show sent the
    // reader looking for a WebGPU problem whenever any part of boot threw, which is
    // the opposite of helpful.
    const what = err && err.message ? err.message : String(err);
    loading.fail("Startup failed: " + what);
});
