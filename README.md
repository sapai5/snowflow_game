# SNOWFLOW

A real-time snow rendering tech demo. WebGPU, Babylon.js, hand-written WGSL.
Everything you see is generated on the GPU at load time — there are no textures,
no meshes, no HDRIs and no animation data in this repository.

**▶ [snowflow-lilac.vercel.app](https://snowflow-lilac.vercel.app/)**

> Requires a WebGPU-capable desktop browser (Chrome/Edge 113+, Firefox 141+,
> Safari 26+) and a discrete or recent integrated GPU. There is no WebGL
> fallback by design — if `navigator.gpu` is missing the page says so and stops.

---

## Controls

| | |
|---|---|
| Click | capture the pointer |
| `W` `A` `S` `D` | move, relative to the camera |
| Mouse | look · **Wheel** zoom |
| `Shift` | sprint |
| `Space` | jump — tap for a hop, hold for height |
| `Space` (again, in the air) | double jump into a front somersault |
| **Left mouse** | slash — keep clicking to chain: right, left, then the heavy finisher |
| **Right mouse (hold)** | snow-surf — carve across the field and throw a wake |
| `1` – `5` | the five spells (`2` is a held cast) |
| `Tab` (hold) | scoreboard |
| `F1` or `` ` `` | settings and performance overlay |

The overlay exposes every art parameter as a live slider — sun angle, wind
bearing, subsurface radius, deformation depth, tonemap curve, exposure — plus a
frame-time graph with median / 95th / 1% low, draw calls, triangles and a
per-system CPU breakdown. Every system can be toggled off individually, and
there are debug views for normals, depth, cascade coverage, the deformation
buffer and the raw shadow map.

---

## What it does

### Terrain

A nested-ring geometry clipmap: 8 rings, 8.5 cm inner spacing, ~870 m radius,
333k triangles — **one static mesh, one draw call**. Vertices carry only
`(gridIndex, ringLevel)`; world placement, CDLOD morphing and displacement all
happen in the vertex shader, so there is no CPU rebuild and no per-frame upload.

The heightfield underneath it is layered gradient noise with analytic
derivatives, anisotropic about a single prevailing wind: broad transverse dune
ridges, a long low swell, medium drifts sheared along the wind for lee-face
asymmetry, and sparse rock outcrops. It bakes once into a 4096² RG32F texture
and is mirrored back to the CPU, so character grounding samples exactly the
surface that is drawn rather than a re-implementation of it.

### Snow shading

Multi-scale normals — baked macro slope, analytic sastrugi and ripples, three
tiled detail scales, triplanar on steep faces — over wrapped diffuse, a
back-scatter subsurface term with depth-dependent blue tint, GGX specular, SH
ambient with a solved snow bounce, and procedural view-dependent glints gated on
grazing angle. Compression, wetness and ice are surface state channels the
material reads rather than separate materials.

Shadows are three hand-rolled cascades with world-space PCSS — blocker search,
penumbra estimate, rotated Poisson filter — texel-snapped in world space and
stabilised against a rotation-invariant bounding sphere. Babylon's own cascade
generator can't be used here: the terrain has no CPU geometry matching what is
drawn, so every caster registers the vertex program it is actually rendered
with.

### Deformation

A persistent, additive terrain state buffer: two 2048² RGBA16F targets covering
80 m (3.9 cm texels), ping-ponged by a single full-screen pass per frame that
scrolls, relaxes and splats in one dispatch. Addressing is toroidal — a texel's
UV is `fract(worldXZ / size)` — so the window follows the player without ever
copying the buffer, and newly exposed texels are detected and zeroed by the same
pass.

Channels are depression depth, displaced mass, compression and ice. That second
channel is what separates a trail with raised berms from a flat footprint decal.
Refill is anisotropic diffusion (loose berms slump three times faster than a
packed trench floor) plus berm-into-depression slump, wind-driven infill from
upwind, and slow exponential decay: **~71% of trail depth survives a minute**,
visibly spreading and softening as it goes.

The displacement is real geometry in the beauty pass *and* in all three shadow
cascades through one shared include, so trails self-shadow and berms break the
silhouette. Feet, the surf wake and all five spells write through one `brush()`
call into the same buffer.

### The character

Fully procedural — no rig file, no animation clips, no authored mesh. An 18-bone
skeleton whose bind pose is a table of numbers, geometry lofted from that table
at load (cowl, torso, arms, trousers, boots, belt), and locomotion solved from
the motion state rather than played back.

Feet plant. A distance-driven stance/swing machine writes a foot's world
position exactly once, on touchdown, and holds it absolutely fixed while
two-bone IK reaches for it — a planted foot cannot slide because nothing in the
code is able to move it. Gait phase advances with ground travelled, so stride
length and ground speed are the same number by construction.

The garments are Verlet cloth on four panels with distance, bending and
shape-memory constraints, nine body collision capsules, and a hem that rides the
snow surface. Folds live in the rest shape rather than in a normal map. The
36×12 solve renders as a 72×32 surface through Catmull-Rom reconstruction in the
vertex shader, so tessellation and simulation cost are fully decoupled. Shell
fur at the hood rim and cuffs is a partial torus emitted 22 times and
alpha-tested against a hashed strand field.

One small texture carries everything to the GPU: rows 0–3 are bone matrices,
rows 4+ are simulated cloth nodes. One upload per frame, no allocation.

Jumping runs on top of both locomotion modes, and keeps the mode it launched in:
a walking jump steers and converts a run into distance, an ollie off the board
holds its heading. Neither holds its speed — nothing drives the board in the air,
so drag has the flight to itself, and the landing scrubs in proportion to the
vertical speed that arrived. A second press in the air spends the one air jump on
a front somersault, rotating the finished pose about the body's centre of mass and
timed against the remaining flight so the figure is upright and extended before it
lands; on the board that second jump is paid for out of forward speed, because
there is nothing up there to push against. Nothing marks the snow while airborne;
the touchdown stamps one wide crater and throws a radial burst of powder.

The **ice sword** in the right hand is a 443-triangle CC0 asset carried by one
rigid matrix — the hand bone's frame times a fixed grip offset — and it is two
materials in one draw. The blade, guard wings and grip body are ice, shaded by the
same model as the Crystallise prisms: flat facets from screen-space derivatives,
wavelength-dependent absorption through the thickness, dispersive refraction
against the sky LUT, and a cold light along the cutting edges with internal
fractures picking it up from inside. The guard band and set gem
are brushed gold — environment-lit metal with engraved rings — and the blade
carries a gold inlay, a fuller rail and a chevron chain, engraved in the shader
at no geometry cost. No textures, no refraction pass.

The blade is swung as a fixed escalating string — no plane repeats. Click one is a
Quick Slash, a tight 110-degree diagonal from high-left with a wind-up that barely
passes the hip. Click two is the Return Slash, the mirror stroke: the blade is
already low-right where the jab's overrotation left it, and it cuts back up the
opposite diagonal, slightly wider and heavier. Click three is the Heavy Finisher —
coiled high-left where the return ended, a hitch at the top, then the big
descending cross-body cut with five times the drive, a stomped front foot,
hit-stop at full extension and a held overrotated finish. Each stroke's
follow-through is the next stroke's coil, so chaining redirects momentum instead of
rewinding it.

Neither is an animation. The combo writes a phase and three weights onto the
controller; the figure runs that phase through a four-link spring chain — hips,
chest, shoulders, hand, each overshooting the one before it — and slerps the hand
along a great circle defined by two angles per end of the arc. The sword adds a
fifth link: its direction is a spring chasing the grip, so the blade trails the
hand into the swing, whips past it when the hand slows, and rings briefly
afterwards. A strike whose point reaches the snow opens a narrow packed cut and
throws a fan of powder along the edge; held high it leaves nothing.

### Snow-surf

The wake is a **swept mesh, not a particle effect**. Its spine is the path the
board has taken, resampled every 30 cm into a 96×3 data texture; the mesh itself
is a static lattice of `(column, row, side)` and every vertex is placed in the
vertex shader, so a 19-metre wake and a 2-metre one cost the same buffer and the
same 4.6 KB upload.

The cross-section is a breaking wave integrated from a turning tangent — the
tangent sweeps from just below horizontal at the base to 284° at the tip, so one
`curl` parameter runs continuously from a low heaped bank to a lip that hangs
back across its own face. Amplitude and curl resolve per side from the carve, so
the outside of a turn takes nearly all the snow. Peak wall is 2.4 m at a
full-speed carve and collapses 0.88 s after it is laid, which makes wake length
`life × speed` with no second constant. Normals are differenced out of the same
`wakePoint` the geometry uses, so they cannot disagree with it.

Two spray populations come off the same spine — a dense slow curtain hugging the
crest and ballistic grains flung clear — emitted at *fractional* positions along
it, plus screen-space speed streaks and camera shake on a loaded edge.

### The five spells

One water material, one mesh, one draw, eight strands. Four of the five move a
coherent body of water and are structurally the same object: a swept surface
along a spine with a radius, a parallel-transported frame and a foam channel —
the same construction as the surf wake. A strand that is not in use is switched
off by zeroing its rows, so the draw count does not depend on how many spells
are up.

1. **Sweep** — a crescent of slush rises out of the ground and runs outward,
   ploughing a channel and throwing berms.
2. **Ribbon** — a held stream tracking the hand and camera aim, drawing
   precessing figure-eights and scoring thin curved lines into any snow it
   skims. Released, the head steers onto the aim and accelerates, so the water
   arcs onto the target with the bend it had at release still travelling out
   along the tail.
3. **Bloom** — a targeted eruption: a crater with a raised rim, a waisted column
   that rises and withdraws down its own axis, and four seconds of fallout
   curtain lit from below.
4. **Crystallise** — hexagonal prisms grown along a golden-angle spiral,
   alpha-blended *and* depth-writing, so you see the snow through the ice but
   never one prism through another. Facet normals come from screen-space
   derivatives, so every facet is exactly flat and every edge exactly hard.
5. **Vortex** — three helices of lifted snow winding around the player, with the
   airborne mass emitted along those same helices at their own tangential
   velocity. The only system here that writes a *negative* depression.

Refraction needs no scene copy and no second opaque pass: the sky LUT already
stores the solved snow bounce below the horizon, so one lookup along the
refracted ray is a physically-derived estimate of what is behind the water in
any direction. Three lookups at three indices of refraction give the chromatic
dispersion, and absorption over the path length gives the tint.

Four pooled dynamic lights are declared per frame, and every one of them runs
the identical `snowSubsurface` the sun runs — so a spell lights the snow
*through* a berm crest rather than putting a bright patch on the near face of
it. The snow, the robe, the wake, the airborne spray, the water and the ice all
read the same pool out of one include.

### Sky and atmosphere

A Nishita single-scattering integration with a multiple-scattering
approximation and an iteratively-solved snow bounce, baked into an
equirectangular LUT plus SH irradiance and mip-based specular. Analytic rather
than a captured HDRI because the whole look hangs on a sun 10–15° up: with a
model, the elevation slider correctly drags the horizon warmth, the zenith
gradient, the ambient tint and the direct sun colour along with it.

The far range is a heightfield raymarched on the skybox — no geometry, behind
everything by construction, with analytic normals, ridges occluding ridges, and
a second short march toward the sun for its own cast shadows. It is lit by the
snow field's own material logic and hazed by the same single atmosphere, so the
two meet at one colour instead of two.

### Post-processing

A camera-space depth prepass (linear view depth carried as a varying, plus a
specular mask) feeds the whole chain:

- **TAA** — Halton(2,3) jitter written straight into the projection and frozen
  for the frame, so the prepass and the beauty pass agree to the subpixel.
  Depth-based reprojection, variance clipping, and a five-tap Catmull-Rom
  history fetch.
- **Bloom** — three levels, thresholded in *exposed* units so only the sun disc,
  the glints and lit spray reach it. Karis-averaged on the prefilter.
- **Volumetric light shafts** — integrating sky visibility out of the prepass
  along the ray to the sun. They fade themselves out entirely at a high sun.
- **Depth of field** — deliberately slight, focal plane tracking the spring
  arm's own length, weighted by each tap's own circle of confusion.
- **Screen-space reflections** — on ice only, gated on the prepass mask, so the
  pass is a fetch and a branch on any frame where nobody has cast Crystallise.
- **AgX / ACES tonemapping**, contrast-adaptive sharpen, grain, vignette.

---

## Performance

Measured with WebGPU timestamp queries at 2560×1440 on Chrome / Windows 11 /
RTX 5070 Ti, with every system running:

| | |
|---|---|
| GPU frame | **3.22 ms** |
| — base scene (clipmap, snow, 3 cascades, sky, character, deformation, prepass) | 1.64 ms |
| — post chain | ~1.1 ms |
| — far range | ~1.2 ms |
| — character (skeleton, cloth, fur, spray) | < 0.02 ms |
| Draw calls | 15–19 |
| Triangles | ~353,000 |
| Headroom against a 90 FPS budget | **7.9 ms** |

Nothing allocates in the render loop. Every buffer is sized at construction,
every per-frame write goes into a pre-allocated typed array, and every material,
procedural texture and render pipeline is explicitly `isReady()`-gated and
exercised with real geometry behind the loading screen — so the first cast of a
spell does not compile a pipeline mid-frame.

VRAM is roughly 350 MB: a 4096² height texture, two 2048² deformation targets,
three 2048² shadow cascades, and the sky and detail LUTs.

---

## Running locally

```bash
npm install
npm run dev      # vite dev server on :5173
npm run build    # production build into dist/
npm run preview  # serve the production build
npm test         # 551 headless assertions, no GPU needed
```

## Multiplayer

Four players, free-for-all, join by link. The relay is a single Node process that also
serves the built client, so one process and one URL is the whole deployment.

```bash
npm run host                 # build, then serve game + relay on :8787
# or, while developing:
npm run relay                # relay only, on :8787; use `npm run dev` for the client
```

Then open `http://localhost:8787/?room=SNOW-TEST`. The room code creates the room — there
is nothing to "open" first, and whoever arrives first makes it.

To let other people in, put a tunnel in front of it. Cloudflare's needs no account:

```bash
cloudflared tunnel --url http://localhost:8787
```

That prints an `https://<something>.trycloudflare.com` URL. Append the room and that is
the shareable link:

```
https://<something>.trycloudflare.com/?room=SNOW-4KQ2
```

The game shows the link bottom-left and copies it when clicked. `?name=` sets your
nameplate; it is remembered afterwards.

The same process deploys unmodified to any free tier that supports WebSockets — Fly,
Render, Deno Deploy — when the URL needs to stop changing.

### How it is split

Clients are **trusted**: this is a dev build with no anti-cheat, which buys away
prediction, reconciliation and rollback entirely. Each client owns where it is and does
its own hit detection. The relay owns only the facts four clients cannot be allowed to
disagree about — health, who is dead, who got the credit, when a spell is ready, and the
terrain seed. Snapshots are 20 Hz and remote players are drawn 100 ms behind, interpolated
between two known positions rather than extrapolated forward from the newest one.

The consequence worth knowing: **only your own client resolves your blade**. Without that
rule all four clients claim the same hit and nine damage lands as thirty-six.

## Layout

```
src/
  main.js            entry point and frame orchestration
  core/              settings, input, camera rig, perf, loading, GPU helpers
  terrain/           heightfield, clipmap mesh, deformation state buffer
  render/            sky + IBL, shadow cascades, depth prepass
  character/         skeleton, procedural geometry, cloth solver, snow contact
  vfx/               pooled particles, the snow-surf wake
  spells/            the five spells, the shared water body, the light pool
  post/              the post-processing chain
  ui/                settings and performance overlay
  shaders/           all WGSL — lib/ holds the shared includes
```

## Assets and licences

One third-party asset: the ice sword's silhouette is **"Crystal"** from the
[Swordtember 2022 CC0 pack](https://opengameart.org/content/30-unique-lowpoly-swords-cc0-swordtember2022)
by *CC0 Game Assets* (public domain, no attribution required — given anyway).
Only the geometry survives the import: it was converted offline into
`src/character/swordMesh.js`, re-scaled into the rig's sword space, and the
shader's own attributes were derived in place of the asset's texture, so it is
lit by the same glacier-ice and silver material as everything else.

Everything else — every texture, environment map and piece of geometry in the
running demo — is generated at load time on the GPU: the sky is an atmosphere
integral, the snow grain and terrain are noise, the character is lofted from a
table of numbers, and the fabric weave and fur strands are evaluated in the
fragment shader.

Runtime dependencies are `@babylonjs/core` and `@babylonjs/materials`
(Apache-2.0). The only build dependency is Vite (MIT), which does not ship in
the output.

This project is released under the [MIT licence](LICENSE).
