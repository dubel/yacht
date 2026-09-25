// dev view of a skeleton guard's cut: /tools/dev/guard.html?cut=0|1 — five phases side by side, from the front
// (&view=side from his right)
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { bladeAxis, swingArm } from '../../src/world/SkullIsland';
const Q = new URLSearchParams(location.search);
const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('c') as HTMLCanvasElement, antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(0x556070);
const scene = new THREE.Scene();
const sun = new THREE.DirectionalLight(0xffffff, 2); sun.position.set(2, 4, 3);
scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2.5), sun);
const loader = new GLTFLoader(); loader.setMeshoptDecoder(MeshoptDecoder);
const gltf = await loader.loadAsync('assets/island/skeleton.glb');
const box = new THREE.Box3().setFromObject(gltf.scene), k = 1.85 / (box.max.y - box.min.y);
const phases = [0.45, 0.52, 0.58, 0.64, 0.7];
const cut = +(Q.get('cut') ?? 0);
phases.forEach((p, i) => {
  const model = clone(gltf.scene);
  model.position.y = -box.min.y;
  const inner = new THREE.Group(); inner.add(model); inner.scale.setScalar(k);
  const root = new THREE.Group(); root.add(inner); root.position.x = (i - 2) * 1.9; scene.add(root);
  const mixer = new THREE.AnimationMixer(model);
  mixer.clipAction(gltf.animations.find((a) => a.name.includes('Running'))!).play();
  mixer.update(0.2);
  let arm: THREE.Bone | null = null, fore: THREE.Bone | null = null, hand: THREE.Bone | null = null;
  model.traverse((o) => { if (o.name.startsWith('R_shoulder')) arm = o as THREE.Bone; if (o.name.startsWith('R_forarm')) fore = o as THREE.Bone; if (o.name.startsWith('HandleBone')) hand = o as THREE.Bone; });
  const blade = bladeAxis(model, hand!); if (i === 0) console.log('blade', blade?.toArray().map((x) => x.toFixed(2)).join(','));
  swingArm(root, arm!, fore!, hand!, 0, p, cut, blade ?? undefined);
});
const cam = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.1, 100);
if (Q.get('view') === 'side') { cam.position.set(-12, 1.3, 3); cam.lookAt(0, 1.1, 0); } else { cam.position.set(0, 1.4, 7.5); cam.lookAt(0, 1.1, 0); }
renderer.render(scene, cam);
(window as unknown as { __ready: boolean }).__ready = true;
