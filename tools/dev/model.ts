// dev viewer for a model's parts: /tools/dev/model.html?m=<file in assets/fpv>&view=front|side|top|back|iso
// logs the overall box and every mesh's box (world, after the model's own transforms)
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { splitPart } from '../../src/fpv/models';
const Q = new URLSearchParams(location.search);
const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('c') as HTMLCanvasElement, antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(0x7a8a99);
const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight(0xffffff, 0x555555, 2.2), new THREE.DirectionalLight(0xffffff, 1.5));
const loader = new GLTFLoader(); loader.setMeshoptDecoder(MeshoptDecoder);
const root = (await loader.loadAsync(`/assets/fpv/${Q.get('m')}.glb`)).scene;
scene.add(root);
root.updateMatrixWorld(true);
const box = new THREE.Box3().setFromObject(root);
const f = (v: THREE.Vector3) => v.toArray().map((x) => +x.toFixed(4));
const parts: string[] = [];
root.traverse((o) => {
  if (!(o as THREE.Mesh).isMesh) return;
  const m = o as THREE.Mesh, b = new THREE.Box3().setFromObject(m);
  const mat = m.material as THREE.MeshStandardMaterial;
  parts.push(`${(m.parent?.name || '') + '/' + m.name} [${mat.name}${mat.transparent ? ' T' : ''}${mat.emissiveMap || mat.emissive?.getHex() ? ' E' + mat.emissive.getHexString() : ''}] min ${f(b.min)} max ${f(b.max)}`);
});
(window as unknown as { __out: string }).__out = `box ${f(box.min)} → ${f(box.max)} size ${f(box.getSize(new THREE.Vector3()))}\n` + parts.join('\n');
// &pca=<node name>: centroid and principal axis of that part's vertices (world)
if (Q.get('pca')) {
  const o = root.getObjectByName(Q.get('pca')!)!;
  const pts: THREE.Vector3[] = [];
  const below = +(Q.get('below') ?? Infinity), xmax = +(Q.get('xmax') ?? Infinity), rmax = +(Q.get('rmax') ?? Infinity), above = +(Q.get('above') ?? -Infinity);
  o.traverse((m) => { const g = (m as THREE.Mesh).geometry; if (!g) return; const p = g.getAttribute('position'); for (let i = 0; i < p.count; i++) { const v = new THREE.Vector3().fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld); if (v.y < below && v.y > above && v.x < xmax && Math.hypot(v.x, v.z) < rmax) pts.push(v); } });
  const bb = new THREE.Box3().setFromPoints(pts);
  (window as unknown as { __out: string }).__out += `\nsel box ${f(bb.min)} ${f(bb.max)}`;
  const c0 = pts.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(pts.length);
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const p of pts) { const d = p.clone().sub(c0).toArray(); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] += d[i] * d[j]; }
  let v = new THREE.Vector3(1, 0.1, 0.1);
  for (let k = 0; k < 50; k++) v = new THREE.Vector3(C[0][0] * v.x + C[0][1] * v.y + C[0][2] * v.z, C[1][0] * v.x + C[1][1] * v.y + C[1][2] * v.z, C[2][0] * v.x + C[2][1] * v.y + C[2][2] * v.z).normalize();
  (window as unknown as { __out: string }).__out += `\nPCA ${Q.get('pca')} centroid ${f(c0)} axis ${f(v)} n=${pts.length}`;
}
// &cut=x0,y0,z0,x1,y1,z1: the triangles in that box cut out (as models.splitPart) and drawn red
if (Q.get('cut')) {
  // (several boxes: separated by ';')
  const boxes = Q.get('cut')!.split(';').map((b) => { const [x0, y0, z0, x1, y1, z1] = b.split(',').map(Number); return new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1)); });
  let mesh: THREE.Mesh | null = null;
  root.traverse((o) => { if ((o as THREE.Mesh).isMesh && !mesh) mesh = o as THREE.Mesh; });
  const n = splitPart(mesh!, boxes, 'cut');
  const c = root.getObjectByName('cut') as THREE.Mesh;
  if (c) c.material = new THREE.MeshBasicMaterial({ color: 0xff2020 });
  (window as unknown as { __out: string }).__out += `\ncut ${n} triangles`;
}
// &rmax=r&above=y: (with pca) only points within r of the y axis and above y
// &hi=a,b: those parts drawn red
for (const n of (Q.get('hi') ?? '').split(',').filter(Boolean)) root.getObjectByName(n)?.traverse((m) => { if ((m as THREE.Mesh).isMesh) (m as THREE.Mesh).material = new THREE.MeshBasicMaterial({ color: 0xff2020, depthTest: false }); });
const c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3()).length() * 1.1;
const cam = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, size / 100, size * 10);
const v = Q.get('view') ?? 'iso';
const off = { front: [0, 0, 1], back: [0, 0, -1], side: [1, 0, 0], top: [0, 1, 0.001], iso: [0.7, 0.5, 0.8] }[v]!;
const zoomAt = Q.get('at') ? new THREE.Vector3(...Q.get('at')!.split(',').map(Number)) : c, zoom = +(Q.get('zoom') ?? 1);
cam.position.set(zoomAt.x + off[0] * size * 1.6 / zoom, zoomAt.y + off[1] * size * 1.6 / zoom, zoomAt.z + off[2] * size * 1.6 / zoom);
cam.lookAt(zoomAt);
const axes = new THREE.AxesHelper(size * 0.4); axes.position.copy(c); (axes.material as THREE.Material).depthTest = false; axes.renderOrder = 9; scene.add(axes);
renderer.render(scene, cam);
(window as unknown as { __ready: boolean }).__ready = true;
