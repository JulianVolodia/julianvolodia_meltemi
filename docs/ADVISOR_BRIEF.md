# Advisor brief — Meltemi Mold Studio

> **How to use:** paste everything below the line into a stronger reviewing model (e.g. "Fable")
> together with the files listed in §7 (or give it repository access). It is self-contained.

---

You are reviewing **Meltemi Mold Studio**, an open-source (MIT) web app + Node library that turns a
3D model into **print-ready mold-making infrastructure** for two-part silicone molds, and prints
**supports** (mother molds / cages) for existing silicone forms. I want a critical engineering
review: what is wrong or fragile, what a practitioner would miss, and which algorithmic choices
you would change. Be concrete (file, function, parameter, numbers). Units are millimetres.

## 1. Context — the physical process

* **Master** (positive) → printed **mold box** → pour platinum silicone (Shore 10A–30A) →
  two-part elastic **form** → close the form inside rigid **supports** → cast wax / PU resin /
  plaster / soap / concrete / chocolate → demold, repeat.
* Why printing helps prototyping: a conformal printed box uses 2–4× less silicone than a
  rectangular box, registers and clamps reproducibly (pins + clips, no tape), and the same shell
  doubles as the mother mold that keeps the floppy silicone in shape during casting.
* The user prints on hobby FDM printers (PLA/PETG, 0.4 mm nozzle, 0.2 mm layers) and has a
  Fusion 360 hobby license and Blender; the app exports STLs plus importers for both.

## 2. Reference product analysis (from nine screenshots of a commercial app)

Demonstrated on three decorative taper candles (vine relief, wax drips at the tip):

1. Import of three masters; progress overlay "Generating channels and funneler 6.9 s".
2. A red **planar parting surface** through the candle axes; labels "B01 Extraction / B02
   Extraction" with arrows = one pull direction per half; move/rotate gizmos.
3. Grey **U-shaped key ridges** around each cavity on the parting plane, open towards the pour
   side (tongue & groove between silicone halves).
4. Top view: gold **conformal shell** = constant offset of the union of the candles (wavy
   outline), split in halves A/B, green **flanges** with cyan **pins**, **clip tabs**.
5. Stats "Mold 211 g (A 105 g, B 105 g) · Casting 36 g", Export button.
6. Black printed box upright: external **ribs/fins** reaching the table (stand + stiffeners),
   **C-clips** on side flanges, a gold bar across the open top (edge of a **parting board**
   sandwiched between the halves), silicone poured into the open top.
7. Gold printed plate with three **half-candle reliefs** + raised U rims, and a blue silicone half
   with matching impressions (= one silicone half per board face).
8. Printed strips peeled off the blue silicone (demolding the rigid shell).
9. Gold **mother mold with windows** around the silicone, wicks out of the top, red wax poured,
   feet at the bottom, C-clips (= support/cage for casting). Finished red/black/orange candles.

## 3. Our architecture

* Plain ESM JavaScript, no build step, Node 22 + browser (module Web Worker).
* **manifold-3d 3.5.3 (WASM)** for every exact operation (booleans, extrude, slice, project,
  `trimByPlane`, `levelSet`, volumes); injected through `src/core/wasm.js` so core modules have no
  bare imports. **three.js 0.186** viewer, **fflate** ZIP export.
* **Mold frame**: Z up = pour direction (opening at `zTop`, shells print upright on a plinth at
  `zFloor`). Parting plane `y = y0` (bbox centre of masters + `partingOffset`); half A on `y < y0`
  pulled −Y, half B on `y > y0` pulled +Y. 2-D plane coordinates `(u, v) = (x, z)`.
* **Pipeline** (`src/core/pipeline.js`, spec in `docs/DESIGN.md` §4):
  1. Validate / weld / union masters → `M` (non-manifold input repaired by voxel remesh).
  2. Pour channels → cast cavity `Mp`: *extend* the flat top face up to `zTop + 1` (auto when the
     top slice area ≥ 25 % of the max slice area) or a *funnel sprue* at the highest point with
     the axis in the parting plane; optional *wick* rod; *air vents* from a merge-tree analysis.
  3. Silicone envelope `phiS = phiM − d1` on a voxel **SDF** (scan-line parity voxelization →
     exact separable Euclidean distance transform → signed distance with ±h/2 correction).
  4. Shell halves: straight-pull sweeps `phiCavA = prefixMin_y(phiS)`,
     `phiCavB = suffixMin_y(phiS)`; plinth via `suffixMin_z(phiCav − w)`; surfaces with
     `Manifold.levelSet` on trilinear-interpolated φ; exact `trimByPlane` for the parting plane,
     rim and floor so mating faces are perfectly flat.
  5. Flanges from `hull(planeSlice(outerA ∪ outerB, y0)).offset(f)`; pin holes along an inner
     offset curve by arclength; clip stations on straight flange edges.
  6. Ribs: YZ plates in the valleys of the top-view outline + evenly spaced, from the flange back
     face to the half's back plane and down to `zFloor` (stand upright and lie flat on the back).
  7. Parting board (double-sided default, `T` thick): slab with `Mp ∩ {y ≤ y0}` relief on face A
     and `Mp ∩ {y ≥ y0}` on face B; key ring `offset(S, k ± kw/2)` of the master's plane section
     `S` (k = 0.45·d1), clipped open at the top; ridge on face A, groove (+clearance) on face B.
  8. C-clips (two sandwich sizes: silicone stage `2tf + T`, cast stage `2tf`), tapered pins (two
     lengths), optional windowed cage; masses, silicone volume and A/B mix weights.
  9. Mode B (support for an existing form): steps 3–6 and 8 with `d1 = cageClearance`.
* **Air traps** (`src/core/analysis.js#findAirTraps`): sweep voxel layers from top to bottom,
  union–find of connected components per layer, elder rule; a component born at a local maximum
  whose persistence (birth z − merge z) ≥ `ventMinDepth` and that is not connected to the opening
  gets a vent: Y rod from the ceiling to the plane + vertical rod in the plane to the rim (formed as
  half channels by the board reliefs, so it is demoldable along ±Y).
* **Auto-orient**: PCA long axis → Z; pour end = the end with the larger 3 %-slice area; rotation
  about Z maximising silhouette area / pull depth on the parting plane.
* Voxel size `h = max(minVoxel, cbrt(boxVolume / maxVoxels))`, presets draft 1.2 M / normal 4 M /
  fine 10 M voxels.

## 4. Open design questions — please give a recommendation for each

1. **Parting surface beyond planar.** Parts whose silhouette edge is not planar (e.g. a figurine,
   a twisted handle) leave undercuts on a flat parting plane. Options: stepped planes (piecewise
   planar along X), a height-field parting surface `y = g(x, z)` computed from the silhouette
   curve and smoothed (Laplace) away from it, or the user drawing a parting polyline. What is the
   most robust approach for an SDF + exact-boolean stack? How should the board then be printed?
2. **Multi-part molds** (3+ pieces) for parts with undercuts in every direction: how to choose
   pull directions (visibility / accessibility cones on the Gauss sphere?), and how to keep
   pieces printable and clampable.
3. **Automatic sprue / vent placement.** Our vents come from a voxel merge tree; sprue = highest
   point or extended flat face. Is persistence-based venting sufficient, or do we need a fill
   simulation (e.g. level-by-level flood from the sprue with gravity)? How to choose vent
   diameter vs. viscosity (wax ≈ 3–10 mPa·s, PU resin ≈ 100–1000 mPa·s, silicone itself ≈ 3–30 Pa·s
   when vents matter for the *silicone* pour)?
4. **Draft analysis.** The silicone tolerates undercuts, the rigid shell doesn't (straight-pull
   sweep avoids rigid locks). Should we report silicone stretch needed to demold the cast
   (depth of undercut vs. silicone thickness and Shore) and colour the master by it?
5. **Cut-mold alternative.** A one-piece "block" silicone mold slit open with a knife along a
   zigzag after curing needs no board and no keys (zigzag self-registers). When is it better than
   the two-part board approach, and should the app offer it (box = one piece, cut guide printed)?
6. **Silicone volume minimisation.** Our skin is a constant offset `d1` (straight-pull sweep adds
   volume in the shadow regions). Would a variable thickness (thicker only where the cast needs
   stretch or where the shell is far from the master) or a conformal shell with a split into more
   pieces be worth it? Typical silicone costs ~30–50 €/kg.
7. **Clip force.** C-clip with interference `δ`, wall `t`, jaw `a`, width `b` in PLA
   (E ≈ 3.5 GPa, yield ≈ 50 MPa): estimate clamp force and whether 0.15 mm interference with a
   2.8 mm wall and 5 mm jaw yields. How many clips per 100 mm of flange to resist the hydrostatic
   pressure of silicone (ρ 1.1) and wax (ρ 0.9) columns of 150 mm?
8. **Key design.** U-shaped tongue & groove at 0.45·d1 from the cavity, 1.8 × 1.4 mm, open at the
   pour side. Better: hemispherical "Lego" keys, a continuous ring, or both? Effect on flash.
9. **Numerical robustness.** Voxel SDF + levelSet + exact planar trims: any failure modes you
   expect (thin features < 2h, levelSet slivers at the trims, parity voxelization of
   non-watertight scans, EDT ±h/2 correction bias)? Better alternatives within WASM (e.g.
   Manifold's own `minkowskiSum` / offset when it becomes available, dual contouring)?
10. **Printability.** Shells print upright; flanges are in the XZ plane (vertical) — fine. Is
    anything we generate not printable without supports (ribs ending in overhangs, clip jaws,
    board reliefs printed on edge)? Should the double-sided board print upright or be split?

## 5. What to review

* Correctness of the geometry contracts (frame conventions, which side is A/B, orientation of
  exported STLs, `printMatrix` placing each part flat on the bed).
* Whether the generated kit can actually be assembled and demolded in the order of the
  instructions (pins/holes coincide across A, board, B; clip sandwich sizes per stage; nothing
  locks; the board can be pulled out after curing).
* Defaults vs. practice (`siliconeThickness 5`, `wallThickness 2.4`, `flangeWidth 14`,
  `flangeThickness 4`, `boardThickness 4`, `pinDiameter 3 / clearance 0.25`,
  `clipInterference 0.15`, `keyWidth 1.8 / keyHeight 1.4`, `topExtension 2`, `ventMinDepth 1.5`).
* Material estimates (silicone volume = shell cavities minus `Mp`; cast = `Mp`).
* The user-facing instructions and `docs/WORKFLOW.md` (anything unsafe or wrong?).
* Performance: normal quality should finish the three-candle demo in well under a minute in a
  browser worker.

Please answer with: (a) top 10 issues ranked by impact with concrete fixes, (b) a recommendation
for each open question in §4, (c) any parameter default you would change and why, (d) a short
roadmap (what to build next, in order).

## 6. Constraints

* Client-side only, MIT-compatible dependencies, no build step; must run in Node 22 for tests/CLI.
* manifold-3d is the only geometry kernel (no OpenCascade); voxel budget ≤ ~10 M.
* Outputs are STL meshes (binary, mm) in print orientation + previews in the mold frame.

## 7. Files to read (in this order)

1. `docs/DESIGN.md` — the full spec (problem analysis, frame, engine, pipeline, contracts, tests)
2. `src/core/params.js` — every parameter, default and UI schema
3. `src/core/pipeline.js` — orchestration, stats, instructions
4. `src/core/sdf.js` — voxelization, EDT, sweeps, level sets
5. `src/core/analysis.js` — auto-orient, air traps, pour mode
6. `src/core/features/` — `channels.js`, `shell.js`, `flanges.js`, `ribs.js`, `board.js`,
   `clips.js`, `pins.js`, `windows.js`
7. `src/core/frame.js`, `src/core/meshio.js` — frame helpers, mesh I/O
8. `docs/WORKFLOW.md` — the physical procedure the kit must support
9. `test/*.test.mjs` — what is verified today
10. `src/demo/candles.js` — the demo masters (watertight procedural tapers)

Repository layout and quick start: `README.md`. Run `npm install && npm test`, and
`npm run cli -- --demo candles --out out/candles` to produce a kit + `report.json` you can inspect.
