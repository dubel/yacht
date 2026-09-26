// dev view of a Tortuga structure and its measured grid: /tools/dev/tortuga.html?m=wharf&scale=0.011&turn=-1.57&view=top|iso
// green: walkable (brighter higher), red: in the way, blue: solid only (under the deck). Logs the deck level.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { measure } from '../../src/world/structures';
const Q = new URLSearchParams(location.search);
const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('c') as HTMLCanvasElement, antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(0x7a8a99);
const scene = new THREE.Scene();
const sun = new THREE.DirectionalLight(0xffffff, 2); sun.position.set(3, 6, 2);
scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2.2), sun);
const loader = new GLTFLoader(); loader.setMeshoptDecoder(MeshoptDecoder);
const gltf = await loader.loadAsync(`assets/tortuga/${Q.get('m')}.glb`);
const t0 = performance.now();
const m = measure(gltf.scene, { url: '', scale: +(Q.get('scale') ?? 1), turn: +(Q.get('turn') ?? 0) });
const ms = performance.now() - t0;
for (const p of m.parts) scene.add(new THREE.Mesh(p.geo, p.mat));
// the grid as a coloured sheet just over the deck
const cv = document.createElement('canvas'); cv.width = m.nx; cv.height = m.nz;
const cx = cv.getContext('2d')!, img = cx.createImageData(m.nx, m.nz);
for (let k = 0; k < m.nx * m.nz; k++) {
  const c = m.cell[k], o = k * 4;
  const col = c === 1 ? [40, 200 + Math.max(-60, Math.min(55, (m.height[k] - m.deck) * 100)), 60] : c === 2 ? [220, 40, 40] : c === 3 ? [50, 80, 230] : [0, 0, 0];
  img.data.set([...col, c ? 150 : 0], o);
}
cx.putImageData(img, 0, 0);
const tex = new THREE.CanvasTexture(cv); tex.magFilter = THREE.NearestFilter;
const sheet = new THREE.Mesh(new THREE.PlaneGeometry(m.nx * 0.25, m.nz * 0.25), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false }));
sheet.rotation.x = -Math.PI / 2;
sheet.position.set(m.x0 + m.nx * 0.125, m.box.max.y + 0.05, m.z0 + m.nz * 0.125);
if (Q.get('grid') !== '0') scene.add(sheet);
scene.add(new THREE.AxesHelper(2));
const size = m.box.getSize(new THREE.Vector3()), mid = m.box.getCenter(new THREE.Vector3());
const r = Math.max(size.x, size.z) * 0.75;
const cam = Q.get('view') === 'iso'
  ? (() => { const c = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.1, 500); c.position.set(mid.x + r * 1.3, mid.y + r * 1.1, mid.z + r * 1.3); c.lookAt(mid); return c; })()
  : (() => { const a = innerWidth / innerHeight; const c = new THREE.OrthographicCamera(-r * a, r * a, r, -r, 0.1, 500); c.position.set(mid.x, m.box.max.y + 50, mid.z); c.up.set(0, 0, -1); c.lookAt(mid.x, 0, mid.z); return c; })();
renderer.render(scene, cam);
const count = [0, 0, 0, 0]; m.cell.forEach((c) => count[c]++);
(window as unknown as { __out: string }).__out = `deck ${m.deck.toFixed(2)} box ${m.box.min.toArray().map((v) => v.toFixed(1))} → ${m.box.max.toArray().map((v) => v.toFixed(1))} walk ${count[1]} block ${count[2]} solid ${count[3]} parts ${m.parts.length} ${ms.toFixed(0)} ms`;
(window as unknown as { __ready: boolean }).__ready = true;
