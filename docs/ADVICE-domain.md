# Practitioner review — Meltemi Mold Studio

## Critical fixes

1. **Silicone must stand proud of the flanges.** Silicone face and flange face are coplanar (both at y0∓T/2 in the pour frame): clamp load goes plastic-to-plastic, the silicone seam has zero preload → wax/resin flash on every cast. Recess the board faces inside the silicone footprint by `siliconePreload` 0.4 mm (0.3–0.6); keep the flange-contact ring at full T/2.
2. **Seal the flange/board joint for the silicone pour.** 3–25 kcP silicone under a 200 mm head leaks through 0.1 mm gaps over a 30–60 min pot life, and 4 mm PLA boards warp. Add a 0.6×1.0 mm triangular crush bead 2 mm outside the silicone footprint, a 1 mm 45° V-chamfer along the external seam to hold hot glue/plasticine (README step 1), clip pitch ≤ 50 mm instead of "3 per side", bottom clips mandatory.
3. **Print material vs. heat.** PLA Tg ≈ 55–60 °C; wax pours at 60–85 °C, PU resin exotherms past 80 °C; a 2.4 mm floor behind 5 mm silicone reaches Tg → sagging shells, creeping clips. Add `printMaterial` (PLA 1.24 / PETG 1.27 / ASA 1.07 g/cm³), warn for wax/resin on PLA, recommend PETG for cast-stage parts and all clips.
4. **FDM-realistic shell and orientation.** Upright printing suits prismatic candles only; any chin or arm makes cavity ceilings that need supports. Add `shellStyle: block` (outer swept to a flat back plane and floor, printed back-down, parting face up): the straight-pull sweep then guarantees an overhang-free cavity, the mating face is an ironed top layer, no ribs, 10–15 % infill. Default `boardStyle: single` — reliefs print flat relief-up, support-free, demold trivially, and both boxes are still poured in one session; a double board is a 4×200 mm upright slab with overhanging drips on both faces.
5. **Pins/clips at FDM tolerances.** Holes print 0.2–0.4 mm undersize: Ø3 + 0.25 clearance will not assemble. Use Ø4 tapered pins with 0.5 mm clearance, or integral cones (Ø6→Ø4, 3 mm tall) on flange A with +0.3 mm sockets in B/board. Clip interference 0.15→0.3 mm, wall 2.8→3.4 mm, print clips with the C profile in XY (flexure within layers).
6. **Channels vs. thin silicone.** 2 mm vents and the 2.2 mm wick run in the parting plane inside a 5 mm skin and cross the key ring 2.25 mm from the cavity → ≤0.5 mm webs that tear. Enforce ≥1.5 mm silicone between any channel, key, cavity and outer surface; interrupt the key ring around channels.
7. **Separation and release.** Three rigid parts, silicone bonded to both board faces, pinned: add two 10×4 mm pry slots per flange edge and prescribe release (wax spray/petroleum jelly) on reliefs — silicone keys into layer lines. Warn that platinum silicones are inhibited by SLA-resin prints (post-cure + 2 coats acrylic lacquer, cure test first); PLA/PETG is usually fine; tin-cure (Mold Max, OOMOO) is the safe default for printed boxes.

## Recommended changes (with numbers)

- `siliconeThickness` default `clamp(0.06·maxDim, 6, 12)`; enable keys only when d1 ≥ 6 (at 5 mm the key leaves 1.35/1.85 mm webs).
- Key: half-round r 1.5 mm (w 3, h 1.5), offset `max(2.5, 0.5·d1)`, groove clearance 0.1 (silicone compresses; 0.2 is loose). Alternative: 3–4 Ø5 hemispherical domes per half — better in shear, easier to print than a 1.8×1.4 mm fin.
- Riser: `topExtension` 2→8 mm for wax (paraffin shrinks 10–15 % by volume → sink at the pour face; second top-up pour, level the base), 4 resin, 2 plaster.
- Wick: channel Ø = 0.8×wick Ø (1.6 mm for a 2 mm LX/CD wick) so it seals by interference; Ø5 countersunk hole through the floor for wick putty; add a `wickBar` part (slot across the rim) — without it candles come out off-centre.
- Silicone-pour air traps: run `findAirTraps` on `(cavX ∩ half) − Mp` Z-up; per trap a Ø1.0 mm bleed hole through the shell (taped after it weeps); README: brush a detail coat on reliefs before closing (texture and drip undersides).
- Draft: `shellDraft` 1–2° in the sweep (`phiCav − tan α·|y0−y|`); 0.5 mm elephant-foot chamfer on every flange/board face edge.
- Board: double 4→6 mm; `boardTopExtra` 6→12 with a 20×8 mm finger hole. Densities: silicone presets (Mold Star 15 1.09, Dragon Skin 1.07, OOMOO 30 1.34, Mold Max 30 1.25), by-volume toggle, +12 % waste on the shopping number; soy 0.92. `ventMinDepth` 1.5→1.0; `cageClearance` 0.3→0.5.
- **Mode B:** hobbyists rarely own a scan of their silicone. Accept (a) master + d1 + parting plane (rebuild the envelope with the existing pipeline), (b) a scan, (c) bounding box + parting plane (→ cradle). The cage parting plane must be the silicone's own seam, not the bbox centre. Output a two-half straight-pull cage, open top, flanges overlapping the silicone flange ≥5 mm with 0.4 mm compression, 0.5 mm body clearance, 1 mm internal contact beads every 20 mm so scan noise cannot prevent closure, feet, clips; windows only ≥10 mm from edges/pins.

## Nice to have

- Undercut/feather map on the master for the ±Y pull with max undercut depth; warn where surfaces graze y0 (FDM drops <0.4 mm relief edges → a step at the seam on every cast).
- Min-thickness heat map of the silicone halves; per-part print report (orientation, supports, grams, time); `printMatrix` per part.
- Master-in-board mode: board with the y0 silhouette cut out (+0.2 mm) to seat a physical/printed full master → no layer lines on the cavity.
- Pour troughs in the board handle leading into each cavity (today silicone is poured into a 5 mm slot). Block-mold mode for parts < 60 mm (plain box + board, d1 10–15 mm, no shell demolding).
- Peel-away pour shell (1.2 mm wall, V-score) as in screenshot 2, with the sturdier cage for casting.

## Things that are right

- The ±T/2 relief translation with shells at ±T/2 reconstructs `cavX ∩ half − Mp` exactly, and curing against a rigid board means no silicone-to-silicone contact — no release/bonding problem between halves.
- prefixMin/suffixMin is the correct straight-pull sweep for ±Y; exact planar trims for mating faces; reliefs from exact booleans on the master, never SDF-smoothed.
- U-shaped key open at the pour side; vents as parting-plane half-channels (demoldable, double as risers); wick snapped to the plane (a split channel clamps a wick better than a drilled hole).
- Persistence-based air-trap detection; silicone volume split per half; plinth so halves stand upright; flat base as pour face for candles; `hull(O).offset(f)` flange.