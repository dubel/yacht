import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { ITEMS } from '../gameplay/Inventory';

/*
 * Icons for the things he owns: each one's own model, turning slowly about the vertical, lit as if on a
 * table by a window. A small renderer of its own (a canvas off the page) draws a model and the picture is
 * copied onto the icon's canvas — as often as the caller wants: every frame for the open inventory, once
 * for the slots bar. A model is framed by its own size (its bounding sphere), turned first as the catalogue
 * says (ITEMS[..].pose) so a long thing lies across the picture.
 *
 * A weapon's model is a copy of the one in the hand (`pieces`); the rest are loaded from assets/items.
 */
/** touches to a model's look for its icon, by its source */
const LOOKS: Record<string, (o: THREE.Object3D) => void> = {
  // the coin's texture is dark, patinated bronze: gild it, as a ducat in the purse should shine
  'items/coin': (o) => o.traverse((m) => {
    const mat = (m as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
    if (mat?.isMeshStandardMaterial) { mat.color.setRGB(2.4, 1.75, 0.7); mat.metalness = 0.85; mat.roughness = Math.min(mat.roughness, 0.45); mat.emissive.setRGB(0.12, 0.08, 0.02); }
  }),
};

export class ItemIcons {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(26, 1, 0.01, 100);
  private readonly spin = new THREE.Group();
  private readonly models = new Map<string, { root: THREE.Object3D; radius: number } | 'loading'>();
  private readonly loader = new GLTFLoader();

  /** `pieces`: a copy of a weapon's model by its use, once they have loaded */
  constructor(private readonly pieces: (use: string) => THREE.Object3D | null) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(1);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.loader.setMeshoptDecoder(MeshoptDecoder);
    const pm = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    const key = new THREE.DirectionalLight(0xfff0d8, 2.6);
    key.position.set(2, 3, 2.5);
    const rim = new THREE.DirectionalLight(0xbcd4ff, 1.2);
    rim.position.set(-2.5, 1, -2);
    this.scene.add(key, rim, new THREE.HemisphereLight(0xfff4e0, 0x3a2c1c, 0.6), this.spin);
  }

  /** the model for an item's icon, framed: null while it loads */
  private model(id: string): { root: THREE.Object3D; radius: number } | null {
    const src = ITEMS[id]?.model ?? id;
    const have = this.models.get(src);
    if (have === 'loading') return null;
    if (have) return have;
    const frame = (o: THREE.Object3D, pose?: [number, number]) => {
      const turn = new THREE.Group();
      turn.add(o);
      if (pose) turn.rotation.set(pose[0], 0, pose[1]);
      turn.updateMatrixWorld(true);
      const sphere = new THREE.Box3().setFromObject(turn).getBoundingSphere(new THREE.Sphere());
      // (centred on the spin's axis)
      const root = new THREE.Group();
      root.add(turn);
      turn.position.sub(sphere.center);
      o.traverse((m) => { m.frustumCulled = false; });
      LOOKS[src]?.(o);
      this.models.set(src, { root, radius: sphere.radius });
    };
    if (src.startsWith('fpv:')) {
      const o = this.pieces(src.slice(4));
      if (!o) return null;
      frame(o, ITEMS[id]?.pose);
      return this.models.get(src) as { root: THREE.Object3D; radius: number };
    }
    this.models.set(src, 'loading');
    this.loader.loadAsync(`assets/${src}.glb`).then((g) => frame(g.scene, ITEMS[id]?.pose)).catch(() => this.models.delete(src));
    return null;
  }

  /**
   * Draw item `id` onto `canvas`, turned to `angle` (rad) about the vertical. False if its model isn't ready
   * yet (try again later).
   */
  draw(id: string, canvas: HTMLCanvasElement, angle: number, zoom = ITEMS[id]?.zoom ?? 1.3): boolean {
    const m = this.model(id);
    const ctx = canvas.getContext('2d')!;
    if (!m) return false;
    const w = canvas.width, h = canvas.height;
    const r = this.renderer;
    if (r.domElement.width !== w || r.domElement.height !== h) r.setSize(w, h, false);
    this.spin.clear();
    this.spin.add(m.root);
    this.spin.rotation.y = angle;
    // (a little from above; far enough that the whole sphere fits — a little closer than that by `zoom`: a
    //  long thing fills only a band of its sphere, and turning, it is seldom at full length toward the eye)
    const dist = (m.radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2))) * 1.02 / zoom;
    this.camera.position.set(0, dist * 0.26, dist * 0.97);
    this.camera.lookAt(0, 0, 0);
    this.camera.near = dist / 20;
    this.camera.far = dist * 3;
    this.camera.updateProjectionMatrix();
    r.render(this.scene, this.camera);
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(r.domElement, 0, 0);
    return true;
  }

  /** `n` frames of a whole turn of item `id`, side by side on one canvas (for a spinning icon that costs nothing) */
  strip(id: string, size: number, n: number, zoom = 1): HTMLCanvasElement | null {
    const one = document.createElement('canvas');
    one.width = one.height = size;
    const out = document.createElement('canvas');
    out.width = size * n;
    out.height = size;
    const ctx = out.getContext('2d')!;
    for (let k = 0; k < n; k++) {
      if (!this.draw(id, one, (k / n) * Math.PI * 2, zoom)) return null;
      ctx.drawImage(one, k * size, 0);
    }
    return out;
  }
}
