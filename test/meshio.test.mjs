import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';
import {
  meshFromManifold, manifoldFromMesh, parseSTL, writeSTL, transformMesh, concatMeshes, meshBBox, meshVolume, weldMesh,
} from '../src/core/meshio.js';

/** Cube [0,s]^3 as 12 unwelded triangles (36 vertices), outward CCW. */
function cubeSoup(s = 10) {
  const v = [[0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0], [0, 0, s], [s, 0, s], [s, s, s], [0, s, s]];
  const f = [
    [0, 2, 1], [0, 3, 2], // bottom (-z)
    [4, 5, 6], [4, 6, 7], // top (+z)
    [0, 1, 5], [0, 5, 4], // front (-y)
    [2, 3, 7], [2, 7, 6], // back (+y)
    [1, 2, 6], [1, 6, 5], // right (+x)
    [3, 0, 4], [3, 4, 7], // left (-x)
  ];
  const positions = new Float32Array(f.length * 9);
  f.forEach((t, i) => t.forEach((vi, c) => positions.set(v[vi], 9 * i + 3 * c)));
  const indices = new Uint32Array(f.length * 3).map((_, i) => i);
  return { positions, indices };
}

test('writeSTL -> parseSTL round trip (binary, Manifold input, Buffer with offset)', async () => {
  const { Manifold } = await setup();
  const m = Manifold.sphere(7, 48).translate([1, 2, 3]);
  const stl = writeSTL(m, 'sphere');
  assert.ok(stl instanceof Uint8Array);
  assert.equal(stl.byteLength, 84 + 50 * m.numTri());
  const head = new TextDecoder().decode(stl.subarray(0, 5));
  assert.notEqual(head.toLowerCase(), 'solid');
  const back = parseSTL(stl);
  assert.equal(back.indices.length / 3, m.numTri());
  const b0 = m.boundingBox(), b1 = meshBBox(back);
  for (let a = 0; a < 3; a++) {
    assert.ok(Math.abs(b0.min[a] - b1.min[a]) < 1e-5 && Math.abs(b0.max[a] - b1.max[a]) < 1e-5);
  }
  assert.ok(Math.abs(meshVolume(back) - m.volume()) < 1e-3 * m.volume());
  // Node Buffer that is a view at a non-zero offset into a larger ArrayBuffer
  const big = new Uint8Array(stl.byteLength + 13);
  big.set(stl, 13);
  const view = Buffer.from(big.buffer, 13, stl.byteLength);
  assert.equal(parseSTL(view).indices.length, back.indices.length);
  // ArrayBuffer input
  assert.equal(parseSTL(stl.slice().buffer).indices.length, back.indices.length);
  // normals point outwards
  const dv = new DataView(stl.buffer, stl.byteOffset, stl.byteLength);
  const nx = dv.getFloat32(84, true), ny = dv.getFloat32(88, true), nz = dv.getFloat32(92, true);
  const cx = (dv.getFloat32(96, true) + dv.getFloat32(108, true) + dv.getFloat32(120, true)) / 3 - 1;
  const cy = (dv.getFloat32(100, true) + dv.getFloat32(112, true) + dv.getFloat32(124, true)) / 3 - 2;
  const cz = (dv.getFloat32(104, true) + dv.getFloat32(116, true) + dv.getFloat32(128, true)) / 3 - 3;
  assert.ok(nx * cx + ny * cy + nz * cz > 0);
});

test('parseSTL ASCII', () => {
  const txt = `solid tri
  facet normal 0 0 1
    outer loop
      vertex 0 0 0
      vertex 1 0 0
      vertex 0 1.5e0 -2E-1
    endloop
  endfacet
  facet normal 0 0 1
    outer loop
      vertex 0 0 1
      vertex 1 0 1
      vertex 0 1 1
    endloop
  endfacet
endsolid tri
`;
  const m = parseSTL(new TextEncoder().encode(txt));
  assert.equal(m.indices.length, 6);
  assert.deepEqual([...m.positions.slice(6, 9)].map((x) => +x.toFixed(4)), [0, 1.5, -0.2]);
  assert.throws(() => parseSTL(new Uint8Array(10)));
});

test('unwelded cube soup (36 verts) -> valid manifold, volume 1000', async () => {
  await setup();
  const soup = cubeSoup(10);
  assert.equal(soup.positions.length, 108);
  const w = weldMesh(soup, 1e-4);
  assert.equal(w.positions.length / 3, 8);
  assert.equal(w.indices.length, 36);
  const { manifold, repaired, warnings } = manifoldFromMesh(soup);
  assert.equal(repaired, false);
  assert.equal(manifold.status(), 'NoError');
  assert.ok(Math.abs(manifold.volume() - 1000) < 1e-6, `volume ${manifold.volume()}`);
  assert.equal(manifold.genus(), 0);
  assert.deepEqual(warnings, []);
  // tiny position noise (below weld tolerance) still welds
  const noisy = cubeSoup(10);
  for (let i = 0; i < noisy.positions.length; i++) noisy.positions[i] += ((i * 7919) % 13 - 6) * 1e-5;
  const r2 = manifoldFromMesh(noisy);
  assert.equal(r2.repaired, false);
  assert.ok(Math.abs(r2.manifold.volume() - 1000) < 0.1);
});

test('inside-out cube is flipped; degenerate triangles dropped', async () => {
  await setup();
  const soup = cubeSoup(10);
  const flipped = transformMesh(soup, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  for (let t = 0; t < flipped.indices.length; t += 3) {
    const s = flipped.indices[t + 1]; flipped.indices[t + 1] = flipped.indices[t + 2]; flipped.indices[t + 2] = s;
  }
  assert.ok(meshVolume(flipped) < 0);
  const r = manifoldFromMesh(flipped);
  assert.equal(r.repaired, false);
  assert.ok(Math.abs(r.manifold.volume() - 1000) < 1e-6);
  assert.ok(r.warnings.some((w) => /inside-out/.test(w)));
  // add a degenerate (zero-area, repeated vertex) triangle
  const withDeg = concatMeshes([soup, { positions: new Float32Array([0, 0, 0, 0, 0, 0, 10, 0, 0]), indices: new Uint32Array([0, 1, 2]) }]);
  const r3 = manifoldFromMesh(withDeg);
  assert.equal(r3.repaired, false);
  assert.ok(Math.abs(r3.manifold.volume() - 1000) < 1e-6);
  assert.ok(r3.warnings.some((w) => /degenerate/.test(w)));
});

test('open mesh (cube minus one triangle) is repaired by remesh', async () => {
  await setup();
  const soup = cubeSoup(10);
  const open = { positions: soup.positions.slice(9), indices: new Uint32Array(33).map((_, i) => i) };
  const t = performance.now();
  const { manifold, repaired, warnings } = manifoldFromMesh(open);
  const dt = performance.now() - t;
  assert.equal(repaired, true);
  assert.equal(manifold.status(), 'NoError');
  assert.ok(Math.abs(manifold.volume() - 1000) < 100, `repaired volume ${manifold.volume()}`);
  assert.ok(warnings.length >= 1);
  const bb = manifold.boundingBox();
  for (let a = 0; a < 3; a++) assert.ok(Math.abs(bb.min[a]) < 0.5 && Math.abs(bb.max[a] - 10) < 0.5);
  console.log(`[meshio] open cube repaired in ${dt.toFixed(0)} ms, volume ${manifold.volume().toFixed(1)} (${manifold.numTri()} tris)`);
});

test('meshFromManifold / transformMesh / concatMeshes / meshBBox / meshVolume', async () => {
  const { Manifold } = await setup();
  const c = Manifold.cube([2, 3, 4]);
  const md = meshFromManifold(c);
  assert.ok(md.positions instanceof Float32Array && md.indices instanceof Uint32Array);
  assert.equal(md.indices.length, c.numTri() * 3);
  assert.ok(Math.abs(meshVolume(md) - 24) < 1e-5);
  assert.deepEqual(meshBBox(md), { min: [0, 0, 0], max: [2, 3, 4] });
  // translate
  const tr = transformMesh(md, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1]);
  assert.deepEqual(meshBBox(tr), { min: [10, 20, 30], max: [12, 23, 34] });
  // mirror in x keeps positive volume (winding flipped)
  const mir = transformMesh(md, [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  assert.ok(Math.abs(meshVolume(mir) - 24) < 1e-5);
  assert.deepEqual(meshBBox(mir).min, [-2, 0, 0]);
  // scale 2 -> volume x8
  const sc = transformMesh(md, [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1]);
  assert.ok(Math.abs(meshVolume(sc) - 192) < 1e-4);
  const cat = concatMeshes([md, null, tr]);
  assert.equal(cat.indices.length, 2 * md.indices.length);
  assert.ok(Math.abs(meshVolume(cat) - 48) < 1e-4);
  assert.deepEqual(meshBBox(cat), { min: [0, 0, 0], max: [12, 23, 34] });
  const back = manifoldFromMesh(cat);
  assert.equal(back.repaired, false);
  assert.ok(Math.abs(back.manifold.volume() - 48) < 1e-4);
  // writeSTL accepts MeshData too
  assert.equal(parseSTL(writeSTL(md)).indices.length, md.indices.length);
});
