// dev harness for the first-person pieces and the hand on them (npm run dev, then /tools/dev/fpv.html):
// ?w=pistol|revolver|rapier|lantern|skull &fire=<s after pulling> &lift=1 (lantern up) &side=1 (a look at the eye's frame from
// outside) &close=eye|left|right|front|under|top (a close look at the grip) &axes=1 &g=<Grasp JSON override>
import * as THREE from 'three';
import { GRASP, Weapons, type Weapon } from '../../src/fpv/Weapons';
const Q = new URLSearchParams(location.search);
const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('c') as HTMLCanvasElement, antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(0x7a8a99);
const cam = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.08, 100);
const w = new Weapons();
await w.load();
w.overlay.add(new THREE.HemisphereLight(0xdde8ff, 0x665544, 1.2));
const pressed = new Set<string>();
const input = { lookDX: 0, lookDY: 0, dragDX: 0, dragDY: 0, click: false, lmb: false, locked: true,
  wasPressed: (k: string) => pressed.has(k), isDown: (k: string) => pressed.has('hold:' + k) } as never;
w.select((Q.get('w') ?? 'pistol') as Weapon);
// &g={"thumb":[..],...}: override the grasp
if (Q.get('g')) Object.assign(GRASP[(Q.get('w') ?? 'pistol') as 'pistol'], JSON.parse(Q.get('g')!));
// (assets are fetched relative to the page: serve them from the root)
const sun = new THREE.Vector3(0.4, 0.8, 0.3).normalize();
const step = (dt: number) => w.update(dt, input, cam, 0, false, sun, new THREE.Color(1, 0.97, 0.9), 2.5, null);
for (let i = 0; i < 90; i++) step(1 / 60);
if (Q.get('fire')) { pressed.add('ControlLeft'); step(1 / 60); pressed.clear(); for (let t = 0; t < +(Q.get('fire') ?? 0); t += 1 / 60) step(1 / 60); }
// &shots=N: pull the trigger every 0.3 s, N times, logging the revolver's state
if (Q.get('shots')) {
  const st = (w as unknown as { guns: Record<string, { rounds: number; hammer: number; hammerTo: number; cylinder: number; reload: number }> }).guns[Q.get('w') ?? 'pistol'];
  let fired = 0;
  w.onPistol = () => { fired++; };
  for (let i = 0, t = 0; i < +Q.get('shots')!; i++) {
    pressed.add('ControlLeft'); step(1 / 60); pressed.clear();
    for (let k = 0; k < 18; k++) step(1 / 60);
    t += 0.3;
    console.log(`pull ${i + 1}: fired ${fired} rounds ${st.rounds} hammer ${st.hammer.toFixed(2)}→${st.hammerTo} cyl ${(st.cylinder * 180 / Math.PI).toFixed(0)}° reload ${st.reload.toFixed(2)}`);
  }
}
// &swig=0..1 &left=0..1: the rum mid-swig, that much left in the bottle
if (Q.get('left')) { (w as unknown as { rumLeft: number }).rumLeft = +Q.get('left')!; for (let i = 0; i < 30; i++) step(1 / 60); }
if (Q.get('swig')) { w.debugSwig = +Q.get('swig')!; (w as unknown as { swig: number }).swig = w.debugSwig; for (let i = 0; i < 30; i++) step(1 / 60); }
if (Q.get('lift')) { pressed.add('hold:ControlLeft'); for (let i = 0; i < 90; i++) step(1 / 60); }
// &hammer=0..1: the revolver's hammer set there (after the frames above)
if (Q.get('hammer')) (w as unknown as { guns: Record<string, { model: { setHammer(k: number): void } }> }).guns[Q.get('w') ?? 'pistol'].model.setHammer(+Q.get('hammer')!);
// &hide=a,b: those parts of the pieces hidden
for (const n of (Q.get('hide') ?? '').split(',').filter(Boolean)) w.overlay.traverse((o) => { if (o.name.startsWith(n)) o.visible = false; });
let view = cam;
if (Q.get('axes')) {
  const grip = (w as unknown as { gripOf(n: string): THREE.Object3D }).gripOf(Q.get('w') ?? 'pistol');
  const ax = new THREE.AxesHelper(0.08); (ax.material as THREE.Material).depthTest = false; ax.renderOrder = 9; grip.add(ax);
  const hand = w.hands.root.getObjectByName('Bone020_024')!;
  const ah = new THREE.AxesHelper(0.05); (ah.material as THREE.Material).depthTest = false; ah.renderOrder = 9; hand.add(ah);
  ah.scale.setScalar(1 / hand.getWorldScale(new THREE.Vector3()).x);
  const g = grip.getWorldPosition(new THREE.Vector3()), h = hand.getWorldPosition(new THREE.Vector3());
  console.log('grip', g.toArray().map((v) => v.toFixed(3)).join(','), 'hand', h.toArray().map((v) => v.toFixed(3)).join(','), 'handScale', hand.getWorldScale(new THREE.Vector3()).x.toFixed(4));
}
if (Q.get('side')) {
  view = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.01, 100);
  view.position.set(0.9, 0.1, -0.2);
  view.lookAt(0.1, -0.15, -0.3);
  const eye = new THREE.Mesh(new THREE.SphereGeometry(0.03), new THREE.MeshBasicMaterial({ color: 0xff0000 }));
  w.overlay.add(eye);
}
// &close=front|left|right|under|eye: a close look at the grip (from the eye it keeps the eye's position)
const close = Q.get('close');
if (close) {
  const grip = (w as unknown as { gripOf(n: string): THREE.Object3D }).gripOf(Q.get('w') ?? 'pistol');
  const g = grip.getWorldPosition(new THREE.Vector3());
  view = new THREE.PerspectiveCamera(close === 'eye' ? 18 : 35, innerWidth / innerHeight, 0.01, 100);
  const off = { front: [0, 0.02, -0.35], left: [-0.35, 0.03, 0], right: [0.35, 0.03, 0], under: [0.02, -0.35, 0.02], top: [0.02, 0.35, 0.02], eye: [0, 0, 0], axis: [0, 0, 0], axis2: [0, 0, 0] }[close]!;
  view.position.set(close === 'eye' ? 0 : g.x + off[0], close === 'eye' ? 0 : g.y + off[1], close === 'eye' ? 0 : g.z + off[2]);
  // 'axis': down the grip from behind (the little finger's end), the palm (+X) to the right
  if (close === 'axis2') {
    const ax = new THREE.Vector3(0, 1, 0).transformDirection(grip.matrixWorld), px = new THREE.Vector3(1, 0, 0).transformDirection(grip.matrixWorld);
    view.position.copy(g).addScaledVector(ax, 0.3);
    view.up.copy(px.clone().cross(ax).negate());
  }
  if (close === 'axis') {
    const ax = new THREE.Vector3(0, 1, 0).transformDirection(grip.matrixWorld), px = new THREE.Vector3(1, 0, 0).transformDirection(grip.matrixWorld);
    view.position.copy(g).addScaledVector(ax, -0.3);
    view.up.copy(px.clone().cross(ax).negate());
  }
  view.lookAt(g);
}
{ const gr = (w as unknown as { gripOf(n: string): THREE.Object3D }).gripOf(Q.get('w') ?? 'pistol'); const y = new THREE.Vector3(0, 1, 0).applyQuaternion(gr.quaternion); console.log('gripAxis(piece)', y.toArray().map((v) => v.toFixed(3)).join(','), 'at', gr.position.toArray().map((v) => v.toFixed(3)).join(','), 'angle from up', (Math.acos(y.y) * 57.3).toFixed(1)); }
{ // the wrist: the gap between the end of the forearm and the hand (m)
  const hr = w.hands.root, a = hr.getObjectByName('Bone018_end_041')!.getWorldPosition(new THREE.Vector3()), b = hr.getObjectByName('Bone020_024')!.getWorldPosition(new THREE.Vector3());
  console.log('wristGap', a.distanceTo(b).toFixed(4)); }
renderer.render(w.overlay, view);
(window as unknown as { __ready: boolean }).__ready = true;
