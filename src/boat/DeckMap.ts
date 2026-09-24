import * as THREE from 'three';
import type { Boat } from './Boat';

/*
 * Where one can stand on the boat: a heightfield of the deck in the boat's local frame (+Z bow, +Y up,
 * origin midships on the waterline), made once after the model loads by rendering it from straight above
 * with an orthographic camera into a float target that stores each surface's height. Sails and rigging are
 * left out, and so is everything above head height, so the map holds the deck and whatever stands on it
 * (rails, masts, guns, hatches, the raised stern deck) — the walker treats sudden rises as walls and
 * gentle ones as steps.
 */

const RES = 0.05; // m per sample
/** no hull here (over the side) */
export const OFF = -99;

export class DeckMap {
  readonly res = RES;
  readonly x0: number;
  readonly z0: number;
  readonly w: number;
  readonly h: number;
  /** height (m, boat frame) per sample, OFF outside the hull; row-major, x fastest, z from z0 upward */
  readonly y: Float32Array;
  /** the walkable floor: `y` with obstacles thinner than ~25 cm opened away (boom, tiller, rail stanchions) */
  readonly floor: Float32Array;
  /** the most common floor height: the main deck */
  readonly deckY: number;

  constructor(renderer: THREE.WebGLRenderer, boat: Boat, headroom = 1.85) {
    const info = boat.info;
    const xmin = -info.beam / 2 - 0.3, xmax = info.beam / 2 + 0.3;
    const zmin = info.hullStern - 0.5, zmax = info.hullBow + 0.5;
    this.x0 = xmin;
    this.z0 = zmin;
    this.w = Math.ceil((xmax - xmin) / RES);
    this.h = Math.ceil((zmax - zmin) / RES);

    // two passes: the first (no ceiling) finds the main deck, the second keeps only what is below head height
    const pass = (clipY: number) => {
      const rt = new THREE.WebGLRenderTarget(this.w, this.h, { type: THREE.FloatType, depthBuffer: true });
      const cam = new THREE.OrthographicCamera(xmin, xmin + this.w * RES, -zmin, -(zmin + this.h * RES), 0.1, 100);
      cam.position.set(0, 50, 0);
      cam.up.set(0, 0, -1);
      cam.lookAt(0, 0, 0);
      cam.updateMatrixWorld();
      const mat = new THREE.ShaderMaterial({
        side: THREE.DoubleSide,
        clipping: true,
        clippingPlanes: [new THREE.Plane(new THREE.Vector3(0, -1, 0), clipY)],
        vertexShader: /* glsl */ `
          #include <clipping_planes_pars_vertex>
          varying float vY;
          void main(){
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vY = wp.y;
            vec4 mvPosition = viewMatrix * wp;
            gl_Position = projectionMatrix * mvPosition;
            #include <clipping_planes_vertex>
          }`,
        fragmentShader: /* glsl */ `
          #include <clipping_planes_pars_fragment>
          varying float vY;
          void main(){
            #include <clipping_planes_fragment>
            gl_FragColor = vec4(vY, 0.0, 0.0, 1.0);
          }`,
      });
      // render just the hull, with the boat at the origin (it is before the first physics update)
      const scene = new THREE.Scene();
      scene.overrideMaterial = mat;
      const parent = boat.root.parent;
      const hidden: THREE.Object3D[] = [];
      boat.root.traverse((o) => {
        const m = o as THREE.Mesh;
        const names = m.isMesh ? (Array.isArray(m.material) ? m.material : [m.material]).map((x) => x.name).join() : '';
        if (o.visible && (/Sail|Rope/.test(names) || o === boat.sails.group || (m.isMesh && !names))) { o.visible = false; hidden.push(o); }
      });
      const saved = { p: boat.root.position.clone(), q: boat.root.quaternion.clone() };
      boat.root.position.set(0, 0, 0);
      boat.root.quaternion.identity();
      scene.add(boat.root);
      boat.root.updateMatrixWorld(true);
      const prevTarget = renderer.getRenderTarget(), prevLocal = renderer.localClippingEnabled;
      const prevClear = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha();
      renderer.localClippingEnabled = true;
      renderer.setRenderTarget(rt);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(scene, cam);
      const px = new Float32Array(this.w * this.h * 4);
      renderer.readRenderTargetPixels(rt, 0, 0, this.w, this.h, px);
      renderer.setRenderTarget(prevTarget);
      renderer.localClippingEnabled = prevLocal;
      renderer.setClearColor(prevClear, prevAlpha);
      parent?.add(boat.root);
      boat.root.position.copy(saved.p);
      boat.root.quaternion.copy(saved.q);
      for (const o of hidden) o.visible = true;
      rt.dispose();
      mat.dispose();
      // readPixels rows go bottom-up = from +z (bow) down; store rows from z0 upward
      const out = new Float32Array(this.w * this.h);
      for (let j = 0; j < this.h; j++)
        for (let i = 0; i < this.w; i++) {
          const k = ((this.h - 1 - j) * this.w + i) * 4;
          out[j * this.w + i] = px[k + 3] > 0.5 ? px[k] : OFF;
        }
      return out;
    };

    // main deck = the most common height in 5 cm bins (above the waterline, inside the hull)
    const first = pass(12);
    const bins = new Map<number, number>();
    for (const v of first) if (v > 0.2) { const b = Math.round(v * 20); bins.set(b, (bins.get(b) ?? 0) + 1); }
    let best = 0, deck = info.deckHeight;
    for (const [b, n] of bins) if (n > best) { best = n; deck = b / 20; }
    this.deckY = deck;
    this.y = pass(deck + headroom);
    // morphological opening (erode, then dilate) with a 5×5 window: thin raised things vanish, walls and
    // masts stay; the hull edge stays where it is because the sea outside (OFF) survives the erosion
    const open = (src: Float32Array, pick: (a: number, b: number) => number) => {
      const out = new Float32Array(src.length);
      for (let j = 0; j < this.h; j++)
        for (let i = 0; i < this.w; i++) {
          let v = src[j * this.w + i];
          for (let dj = -2; dj <= 2; dj++)
            for (let di = -2; di <= 2; di++) {
              const ii = i + di, jj = j + dj;
              if (ii >= 0 && jj >= 0 && ii < this.w && jj < this.h) v = pick(v, src[jj * this.w + ii]);
            }
          out[j * this.w + i] = v;
        }
      return out;
    };
    const eroded = open(this.y, Math.min);
    this.floor = open(eroded, Math.max);
    // …but never walk on air: where the eroded map is off the hull, the floor is too
    for (let k = 0; k < this.floor.length; k++) if (this.y[k] === OFF) this.floor[k] = OFF;
  }

  /** top of whatever is at a boat-frame point — deck, rail, mast, cabin roof (up to head height) — or OFF */
  rawAt(x: number, z: number): number {
    const i = Math.floor((x - this.x0) / RES), j = Math.floor((z - this.z0) / RES);
    if (i < 0 || j < 0 || i >= this.w || j >= this.h) return OFF;
    return this.y[j * this.w + i];
  }

  /** walkable floor height at a boat-frame point (nearest sample), OFF over the side */
  at(x: number, z: number): number {
    const i = Math.floor((x - this.x0) / RES), j = Math.floor((z - this.z0) / RES);
    if (i < 0 || j < 0 || i >= this.w || j >= this.h) return OFF;
    return this.floor[j * this.w + i];
  }
}
