# Meltemi Mold Studio — problem analysis & design spec

> Purpose of this document: a self-contained spec that implementers (human or AI) and
> reviewers/advisors (e.g. stronger models) can critique without seeing the original
> screenshots. Units are **millimetres** everywhere.

## 1. What the reference footage shows (analysis)

Nine screenshots of a commercial "turn any 3D model into a print-ready mold box" web app,
demonstrated on three decorative taper candles (textured relief, drips at the tip):

| # | Observation | Interpretation |
|---|---|---|
| 8 | Three candle masters imported, overlay *"Generating channels and funneler 6.9 s"* | Pipeline step: pour channels / funnel generation |
| 6,7 | Parting plane (red) through the candle axes; labels **B01 Extraction / B02 Extraction** with arrows; gizmo *"Enabling movement gizmos 53.1 s"* | Planar parting surface, one extraction (pull) direction per half; masters can be moved/rotated |
| 6 | Grey U-shaped tubes around each candle *on the parting plane*, cyan wavy line along the base | Seal/registration "key" ridges around each cavity (tongue & groove between silicone halves), open at the pour side |
| 5 | Top view: gold **conformal** shell whose outline is the offset of the union of the three candles (wavy), red parting plane across, green flanges with cyan pins at the ends, green clip tabs | Mother-mold = constant-thickness offset shell, split in halves A/B, flanges + alignment pins + clip tabs |
| 5,6 | *"Mold 211 g (A 105 g, B 105 g) · Casting 36 g"*, **Export** button | Mass estimate per printed half and of the cast part |
| 4 | Black printed box standing upright, external **ribs/fins** in the valleys that reach the table, C-clips on side flanges, a gold bar across the open top between the halves, silicone poured into the open top | Mold box for the silicone pour: open top, a *parting board* sandwiched between the halves (its edge is the bar), ribs = stiffeners + stand |
| 3 | Gold printed plate with three **half-candle reliefs** and raised U-rims + a blue silicone half with matching impressions | Parting board with master-half reliefs and key ridges; one silicone half per board face |
| 2 | Printed strips being peeled off the blue silicone | Demolding the rigid shell from the flexible silicone |
| 1 | Gold mother mold with windows showing blue silicone, wicks out of the top, red wax poured in, feet at the bottom, C-clips | **Support** (mother mold / cage) holding the finished silicone form during the wax cast |
| 9 | Finished candles (red/black/orange) | Casting result |

### The workflow the app must support

1. **Positive (master)** — the object to reproduce (STL/OBJ/3MF). Optionally printed.
2. **Mold-making infrastructure** (printed): conformal mold-box halves A & B, parting board
   carrying the master-half reliefs and key ridges, alignment pins, C-clips, pour
   opening/funnel, wick channel, air vents, ribs/feet.
3. Pour silicone → two-part silicone form (each half is a conformal skin of thickness `d1`).
4. **Supports for the finished form** (printed): the same halves (or a lighter windowed cage)
   clipped around the silicone halves while the casting material (wax, resin, plaster,
   soap, chocolate…) is poured. Mode B: generate such a support for a *previously made*
   form imported as a mesh.

## 2. Coordinate frame ("mold frame")

* **Z up** = pour direction. The pour opening is at the top (`zTop`), the mold stands on
  its ribs/feet at `zFloor`. Shells are printed in this orientation (upright).
* **Parting plane** is `y = y0` (default: centroid of the masters' bounding box).
  Half **A** is on the `y < y0` side and is pulled off in `-Y`; half **B** on `y > y0`,
  pulled in `+Y`.
* Plane 2-D coordinates are `(u, v) = (x, z)`. Helpers in `src/core/frame.js`:
  * `planeExtrude(cs, yA, yB)` — extrude a CrossSection in (x,z) along Y over `[yA,yB]`
    (implemented as `cs.extrude(yB-yA).rotate([90,0,0]).translate([0,yB,0])`, verified).
  * `planeSlice(solid, y)` — `solid.rotate([-90,0,0]).slice(-y)` → CrossSection in (x,z).
  * `planeProject(solid)` — `solid.rotate([-90,0,0]).project()` → silhouette in (x,z).
* Users orient masters in the UI (move/rotate gizmo) or press **Auto-orient**.

## 3. Geometry engine

* **manifold-3d (WASM)** for all exact booleans / extrusions / slices / volumes — guaranteed
  manifold output. Loaded once and injected via `setManifoldModule()` (`src/core/wasm.js`) so
  the same core runs in Node tests, a Web Worker and the main thread (no bare imports in core).
* **Offsets of arbitrary meshes** use a voxel signed-distance field (SDF):
  1. Scan-line parity voxelization along Z (column centres jittered by a tiny irrational
     offset to avoid edge/vertex hits) → occupancy `occ` (1 = inside).
  2. Exact Euclidean distance transform (Felzenszwalb–Huttenlocher, separable, O(N)) of
     inside and outside → `phi` (negative inside, positive outside, mm), with ±h/2 correction.
  3. Column operations on `phi` (cheap, exact for the outside distance of a swept set):
     * straight-pull sweep for half A: `phiCavA = prefixMin_y(phiS)` (min over y' ≤ y)
     * for half B: `phiCavB = suffixMin_y(phiS)` (min over y' ≥ y)
     * plinth (flat printable base): `phiOut = suffixMin_z(phiCav - w)` (min over z' ≥ z)
  4. Surfaces are extracted with `Manifold.levelSet(p => level - trilinear(phi,p), bounds,
     edge)` (positive-inside convention). Benchmark: 1.6 M lattice points ≈ 0.5 s.
  5. All **planar** cuts (parting plane, top rim, floor) are exact `trimByPlane` booleans so
     faces that must mate are perfectly flat.
* Voxel size `h` is automatic: `h = max(minVoxel, cbrt(boxVolume / maxVoxels))`
  (`quality` preset: draft 1.2 M, normal 4 M, fine 10 M voxels; `minVoxel` 0.35).
* The original master mesh is **never** re-meshed for surfaces that touch the cast
  (reliefs on the board use exact booleans on the master), only offsets come from the SDF.
* Broken input meshes (non-manifold scans) fall back to "repair by remesh": voxel occupancy
  → levelSet at 0.

## 4. Pipeline (`generateMoldBox(masters, params, onProgress)`)

Notation: `M` = union of masters, `d1` = silicone thickness, `w` = shell wall, `T` = board
thickness, `tf` = flange thickness, `f` = flange width.

1. **Validate / union** masters → `M`. Warn if not manifold (repair), if tiny/huge.
2. **Pour opening & channels** (`channels.js`), producing `Mp` = "cast cavity" master:
   * `zTop = M.max.z + topExtension` (default `topExtension = 2`).
   * per connected component `c` (`M.decompose()`):
     * *extend* mode (flat pour face, e.g. candle base; auto when top slice area ≥ 25 % of
       max slice area): extrude `c.slice(c.max.z - 0.25)` from `c.max.z - 0.5` to `zTop + 1`.
     * *sprue* mode (pointy tops): funnel cone at the highest point, axis in the parting
       plane (x of highest point, `y0`), `sprueR1` at the part → `sprueR2` at `zTop + 1`,
       plus a Y-runner rod from the plane to the highest point if it is off-plane.
   * optional **wick channel** (candles): vertical rod radius `wickR` through the component's
     top-slice centroid (snapped to `y0` if within 2 mm; warn otherwise) from below the
     shell floor up to 60 % of the part height.
   * **air vents** (`analysis.findAirTraps` on the voxelized `M ∪ sprues`): merge-tree /
     persistence sweep from top to bottom with union–find and the elder rule; every local
     maximum whose pocket depth (birth z − merge z) ≥ `ventMinDepth` gets a vent: a Y rod
     from the trap ceiling to the plane plus a vertical rod in the parting plane up to
     `zTop + 1` (so vents are formed as half-channels by the board reliefs and are
     demoldable along ±Y).
   * The SDF for offsets uses `M ∪ pour extensions` only (not wick/vents).
3. **Silicone envelope** `phiS = phiM - d1`.
4. **Shell halves** (`shell.js`), `demold = 'straight'` (default) or `'conformal'`:
   * `phiCavA`, `phiCavB` (straight-pull sweeps; conformal ⇒ `phiS`).
   * `outerX = levelSet(phiOutX < 0)` with plinth sweep (if `base='plinth'`), `cavX =
     levelSet(phiCavX < 0)`.
   * `zFloor = M.min.z - d1 - w - baseExtra` (wick excluded).
   * `shellA = outerA ∩ {y ≤ y0} ∩ {zFloor ≤ z ≤ zTop} − cavA` (exact planar trims).
5. **Flanges** (`flanges.js`): `O = planeSlice(outerA ∪ outerB, y0)`;
   `F = hull(O).offset(f)` clipped to `zFloor ≤ z ≤ zTop`; flange A = `planeExtrude(F,
   y0 - tf, y0)` ∪ shellA, then `− cavA` again. Flange B mirrored.
   * **Pin holes** (through flanges and board) at points of the mid-curve
     `offset(hull(O), 0.45 f)` spread by arclength (`pinsPerSide`), avoiding the top rim.
   * **Clip positions** on the straight left/right flange edges (`clipsPerSide`) and
     optionally the bottom edge; jaw depth ≤ distance edge→pin − 0.6 mm.
6. **Ribs / feet** (`ribs.js`): plates of thickness `ribT` in YZ planes at x positions
   (valleys of the top-view outline, plus evenly spaced to max spacing `ribSpacing`), from
   the flange back face to the half's back plane (`yBackA = min y of shellA`), and from
   `zFloor` to `zTop - ribTopInset`; `− cav`. Every rib ends on `zFloor` and on the back
   plane, so a half stands upright *and* lies flat on its back.
7. **Parting board** (`board.js`), `boardStyle`:
   * `double` (default, one pour for both silicone halves): slab `planeExtrude(F', y0 - T/2,
     y0 + T/2)` where `F'` = F extended `boardTopExtra` above `zTop` (handle);
     reliefs `(Mp ∩ {y ≤ y0}).translate(0,-T/2,0)` and `(Mp ∩ {y ≥ y0}).translate(0,T/2,0)`;
     key **ridge** on face A, matching **groove** (+clearance) on face B. In this
     configuration shell A is placed at `-T/2` and shell B at `+T/2`.
   * `single` (two boards, each printable flat, two separate pours): board A slab on
     `[y0, y0+T]` with relief `Mp ∩ {y ≤ y0}` and ridge; board B slab `[y0-T, y0]` with
     relief `Mp ∩ {y ≥ y0}` and groove.
   * Key ring: `R = offset(S, k + kw/2) − offset(S, k − kw/2)` with `S = planeSlice(Mp, y0)`,
     `k = keyOffset (default 0.45 d1)`, clipped to the silicone face region shrunk by
     `kw` and to `z ≤ zTop − keyTopGap` (U-shape, open at the pour side).
   * Pin holes through the board.
8. **Clips** (`clips.js`): C-clip profile for sandwich thickness `s`, gap `s − clipInterference`,
   wall `clipWall`, jaw depth `clipJaw`, width `clipWidth`, lead-in chamfers. Two sets:
   `clip_silicone` (s = 2 tf + T for double, tf + T for single) and `clip_cast` (s = 2 tf).
9. **Pins** (`pins.js`): tapered dowels, `pinD` with `pinClearance`; two lengths
   (cast: 2 tf − 0.4; silicone pour: 2 tf + T − 0.4 or tf + T − 0.4).
10. **Support cage** (optional / mode B): same shells built around the silicone outer
    surface + `cageClearance`, with **windows** (`windows.js`, rounded slots extruded along Y,
    kept clear of flanges/rim/floor/ribs).
11. **Stats**: volumes → masses (`densityPrint` 1.24 PLA, `densitySilicone` 1.10,
    `densityCast` wax 0.90 / resin 1.10 / plaster 1.00 / soap 1.06 / concrete 2.3),
    silicone volume = `(cavA∩{y≤y0} ∪ cavB∩{y≥y0}) − Mp`, mix split per ratio.
12. **Parts** returned to UI/CLI:
    `{ id, name, role, color, mesh: {positions, indices}, quantity, stage: 'silicone'|'cast'|'both',
       placements: Mat4[] (poses in mold frame for display, per stage), printMatrix: Mat4,
       volume, mass }`.

### Mode B — support for an existing form

Input mesh = outer surface of an existing (silicone) form. Pipeline = steps 3–6, 8–11 with
`d1 = cageClearance`, no board/channels/silicone; windows optional.

## 5. Modules & contracts

```
src/core/wasm.js       setManifoldModule(w), mf() -> {Manifold, CrossSection, Mesh}
src/core/params.js     DEFAULTS, PARAM_SCHEMA (grouped, for auto UI), resolveParams(p)
src/core/frame.js      planeExtrude, planeSlice, planeProject, mat4 helpers, bbox utils
src/core/meshio.js     MeshData <-> Manifold (weld+merge), parseSTL, writeSTL (binary), repair
src/core/sdf.js        Grid, makeGrid, voxelize, signedDistance(EDT), sweepMin, sampler, levelSetSolid
src/core/analysis.js   autoOrient, findAirTraps, sliceAreaProfile
src/core/features/{channels,shell,flanges,ribs,board,clips,pins,windows}.js
src/core/pipeline.js   generateMoldBox(masters, params, onProgress), generateSupport(form, params, onProgress)
src/demo/candles.js    procedural textured taper candle (MeshData / Manifold)
src/ui/*               three.js viewer, panel, worker, export (zip of STLs + README)
cli/moldbox.mjs        node CLI: input STL(s) -> output folder of STLs + report.json
test/*.test.mjs        node:test suites
```

`MeshData = { positions: Float32Array /*xyz*/, indices: Uint32Array /*tri*/ }`.
`Mat4` = 16 numbers, column-major (three.js / manifold convention).

## 6. Validation (tests)

* SDF: sphere/box distances within `h`; voxel volume within 3 %.
* Every part: `status() == NoError`, volume > 0.
* `shellA ∩ Mp` and `shellB ∩ Mp` ≈ 0 volume; `shellA ∩ shellB` ≈ 0.
* Silicone thickness: `minGap(shell cavity surface, master) ≈ d1 ± 1.5 h`.
* Board reliefs translated back reconstruct `Mp` (volume within 1 %).
* Pin holes coincide in A, B and board; clip gap = sandwich − interference.
* Air traps: an "h"-shaped test cavity yields exactly one vent; a candle yields none.

## 7. Decisions after expert review (Fable advisors, see `ADVICE-*.md`)

| Advice | Decision |
|---|---|
| `Manifold.levelSet` (WASM 3.5.3) traps on large outputs | Replaced by our own **marching-tetrahedra** mesher (`src/core/mesher.js`): Kuhn 6-tet split ⇒ closed 2-manifold by construction, two-layer typed-array edge tables (no hash map), then `Manifold.simplify(0.25 h)`. ~1 s per 1 M-triangle surface + manifold construction. |
| Silicone too thin for keys at 5 mm | `siliconeThickness` 6, key offset `max(2.5, 0.5·d1)`, key 2.4 × 1.5 mm, groove clearance 0.1 |
| FDM holes print undersize; clips too loose/fragile | pins Ø4 + 0.4 clearance; clip wall 3.4, interference 0.3; 4 clips per side (pitch ≲ 50 mm) |
| Double board = tall thin upright print with overhanging reliefs on both faces | default `boardStyle: 'single'` (two flat, support-free boards; both halves can still be poured in one session); `double` kept as an option (matches the reference video) |
| Wax shrinks 10–15 % | `topExtension` 5 mm riser above the master |
| Wick seals by interference | wick channel Ø1.6 for a ~2 mm wick |
| PLA softens at ~55–60 °C | `printMaterial` (PLA/PETG/ASA/PCTG) with densities, default PETG, heat warning |
| Vents must never exit the envelope | vent rods are included in the SDF source |
| Silicone volume from booleans of 1 M-tri meshes is slow | counted on the voxel grid |
| Hollow (shelled) masters | only positive-volume components are used |
| Later / roadmap | silicone pre-load recess on the board (anti-flash), crush bead / V-chamfer seal, block-style back-down printed shells, draft angle, hybrid exact-near-surface SDF, mode B from master + d1, pry slots |

## 8. Later additions

* **Silicone collar** (`collar.js`): the silicone continues `collarHeight` above the rim and
  `collarOverhang` past the shell wall; each shell gets a dam and a 0.5 mm-step 45° ledge; flanges
  and boards reach the collar top. **Broader end walls**: `endWallExtra` tapers in over
  `endWallBlend` at the ±X ends (applied in the outer distance field, x-only).
* **Interlocking registration** (default, `pins.js`): diamond-section tapered pegs (45° lower
  faces, prints upright without supports) on flange A / board B face, matching sockets (+clearance)
  in flange B / board A; the double board has blind sockets on face A and pegs on face B.
* **Real fills** (`pipeline.js enclosedFill`): silicone half X = connected regions of a box minus
  (shell X ∪ its board) that touch neither the box sides nor bottom (open only at the pour level);
  cast = the same for the two silicone halves. Contact faces are overlapped by 0.02 mm first:
  exactly-touching faces stay separate in exact booleans and would leave a zero-thickness sheet
  linking the pocket to the peg sockets. A pocket that does not close is reported as a leak.
