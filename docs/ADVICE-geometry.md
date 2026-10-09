I have everything I need; no further tool calls. Findings below.

# Meltemi Mold Studio — geometry core review

Measured on this box (Node 22, manifold-3d 3.5.3), 100×40×200 mm master + margin 8.5 mm, h = 0.6 → 8.5 M voxels: voxelize 85 ms, exact EDT 1.15 s, sweeps 0.7 s, each `levelSet` 3.9–9.3 s and ~0.75–1.0 M triangles, `simplify(0.3h)` 0.8 s → 16–43 k triangles, RSS 1.5 GB. Note the `normal` preset (4 M) gives h = 0.71 for this job, `fine` 0.53, `draft` 1.07.

## Critical

1. **Features thinner than h vanish** (`sdf.js signedDistanceExact`): sites are only occupancy-flip voxels. Measured: a 0.3 mm fin at h = 0.6 gets 0 % coverage by a d1 = 3 envelope and pierces the cavity. Fix: make every voxel within `lim` of any triangle a site (the triangle-major loop already visits them) regardless of `occ`, and add a `shell − Mp` safety subtract with a warning. Test: fins/rods 0.3, 0.6, 1.0 mm.
2. **Hollow masters** (shelled STLs): `decompose()` returns the inner shell as a negative-volume part (measured +8000 / −1728), and parity marks the void "outside" → floating shell blob inside the void and a bowl-shaped board relief that fills with silicone. Fix: `M = union(decompose().filter(v => v.volume() > 0))` per master, plus a border flood-fill of `occ`. Test: hollow cube.
3. **Vents/wick are excluded from the SDF but can exit the envelope** (vertical vent at the x of a trap under a wide brim where the master narrows above) → open channel through the shell wall. Include the rods in the SDF source (cheap with the exact path) or clip them to `{phiS < −1}`.
4. **Memory/performance**: manifold-3d objects are not GC'd (`delete()` required) and each raw levelSet is ~1 M tris. Fix: `simplify(0.3h)` immediately after each `levelSet` (862 k → 42 k outer, 750 k → 16 k cavity; downstream `subtract` 988 → 64 ms), delete intermediates, clip the cavity levelSet bounds to `y ≤ y0 + 2h` (9.3 → 5.6 s), sample the smooth outer field at edge 1.5 h (3.6 → 1.4 s, ΔV 0.06 %). Budget then ≈ 20–25 s, < 500 MB. The `tolerance` argument of `levelSet` does not reduce triangles (865 k vs 862 k).
5. **Mode B clearance 0.3 mm is below SDF accuracy**: exact path max |err| 0.17 mm at h 0.6 / 0.145 at h 0.4 (bias +0.03, i.e. thinner), occupancy-only 0.32. Fix: hybrid sampler — trilinear far field, exact BVH closest-point whenever `|phi| < 2h` (≈1.3 M samples ≈ 2 s for a 150 mm form) → offsets accurate to ~0.02 mm at any h; this also helps item 1. Raise the default to 0.5 mm (FDM tolerance alone is ±0.15).

## Important

6. **Sweep math**: prefix/suffix-min is the exact *outside* distance to the swept set (min over translates), but inside values are the deepest upstream value, not the distance to the swept boundary. Never offset a swept field inward (`phiCav + c`) or derive the silicone-only region from it. The trilinear zero crossing at the shadow's lateral wall (jump from ≈ −(d1 + half-width) to +ε) is biased outward ≤ h/2 — harmless. The plinth sweep is fine: `phiCav − w < 0 ⇔ phiCav < w` reads outside values only.
7. **A/B outlines differ at the plane** (sphere r 15 at y = +6: face radii 19.0 vs 19.95, B\A = 115 mm²). `keyRing2D` clips to the *union* of faces (`face.add`); use the intersection shrunk by kw, otherwise with `keyOffset > ~0.55·d1` the ridge lands where silicone B has no material. Report the asymmetric area as a parting metric and let auto-orient minimise it.
8. **Voting fallback breaks closed but inconsistently wound meshes**: sphere with 30 % flipped triangles → xyz vote keeps 92 % of the volume (holes), z-parity 100 %. Repair winding first (BFS over shared edges, flip to majority) and let unbalanced columns cast a weak parity vote instead of abstaining.
9. **Air traps**: elder rule and 6-connectivity are correct and quiet on the demo candle (0 vents at h 0.5/0.7, 0.8 mm relief), but depth alone will flood deeper reliefs with vents. Add a volume criterion (young component ≥ ~30 mm³), cap and rank by volume, and 26-connectivity for the vertical link (thin inclined channels read as closed pockets). Run the same analysis on the *silicone* region (`cav − Mp`) to warn about bubble-prone overhangs during the silicone pour.
10. **Closing at bounds**: the y/z sweeps run to the grid faces and `levelSet` caps them there, so `zFloor` and `y0` must lie ≥ 2h inside the grid or the floor becomes the grid cap and ribs hang below it. Assert `grid.min.z + 2h ≤ zFloor`; margin ≥ d1 + w + baseExtra + 3h.
11. **Coplanar master faces at y0** (flat-backed plaque): `slice`/`trimByPlane` exactly on the face can return an empty `S` and silently drop keys. Use `S = slice(y0 − ε) ∪ slice(y0 + ε)`, ε = 0.05.
12. **Silicone volume**: count voxels `phiCav < 0 && !occMp` (±3 %) instead of a boolean between two ~1 M-tri meshes.

## Nice to have

13. JS marching tetrahedra over the voxel array → MeshGL → `new Manifold(...)` avoids the ~0.4 µs/sample callback (23 M samples ≈ 9 s per surface at h 0.5); expect < 1 s.
14. Flange outline = `O.offset(f)` with a morphological closing instead of `hull` (matches the conformal wavy flange, saves plastic/board on L-shaped layouts); pins along the non-convex mid-curve.
15. Extract the cavity at level d1 + 0.3h so thickness never falls below d1 (measured `minGap` 4.51 for d1 = 5 at h 0.6 after simplify 0.18); test `minGap(cav, Mp) ≥ d1 − 0.5h`.
16. Size-aware defaults: warn when h > min(1 mm, 0.15·d1) (a 300 mm vase gets h = 2 mm at `normal`), `minVoxel = min(0.4, bbox/60)` for tiny parts, warn when the gap between components < d1 (thin silicone web).
17. Key profile: trapezoid/half-round with 10–15° draft instead of a 1.8×1.4 rectangle; sharp silicone tongues tear when the board is peeled.
18. Regression set: thin fins; hollow cube; off-centre sphere (face mismatch, analytic swept volume); 30 %-flipped sphere; h-shaped cavity (1 vent) + 3 mm-relief plate (vent cap); 100×40×200 budget gate (< 30 s, < 600 MB at h 0.6).