import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { Sails } from './Sails';
import { patchUnderwater } from '../render/water/underwaterLight';

/**
 * Visual boat. The GLB (Sketchfab export, cm units, Z-up baked into its root matrix) is normalised so
 * that in the boat's local frame: +Z = bow, +Y = up, origin = midships on the design waterline.
 *
 * "Swedish royal yacht Amadis" by Museovirasto – Finnish Heritage Agency, CC-BY-4.0.
 */
export interface BoatModelInfo {
  /** metres: stern..bow of the hull proper (no bowsprit) along +Z */
  hullStern: number;
  hullBow: number;
  beam: number;
  keelDepth: number;
  deckHeight: number;
}

export class Boat {
  readonly root = new THREE.Group();
  /** model pivot inside root (offsets the GLB onto the design waterline) */
  readonly model = new THREE.Group();
  sail: THREE.Mesh[] = [];
  info!: BoatModelInfo;

  constructor() {
    this.root.name = 'boat';
    this.root.add(this.model);
  }

  sails!: Sails;

  /** sail visuals follow the physics (trim angle, furling, luffing) */
  setRig(r: RigState, t: number): void {
    // the GLB's own sails are the furled bundles: only show them when the set sails are (mostly) down
    for (const m of this.sail) m.visible = r.up < 0.6;
    this.sails.update(r.boom, r.flow, r.aws, r.aoa, r.up, t);
  }

  async load(url: string, onProgress?: (f: number) => void): Promise<void> {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const gltf = await loader.loadAsync(url, (e) => e.total && onProgress?.(e.loaded / e.total));
    const scene = gltf.scene;
    scene.scale.setScalar(0.01); // cm → m
    scene.updateMatrixWorld(true);

    // Hull extents from the plank meshes (sails/rigging/bowsprit excluded)
    const hullBox = new THREE.Box3();
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.castShadow = true;
      m.receiveShadow = true;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats as THREE.MeshStandardMaterial[]) {
        mat.envMapIntensity = 1.0;
        // The Sketchfab export has inconsistent triangle winding on double-sided materials, so three's
        // gl_FrontFacing flip would point many outer hull normals inward (a hull bottom lit from above).
        // The authored vertex normals are right — use them as they are.
        mat.onBeforeCompile = (sh) => {
          sh.fragmentShader = sh.fragmentShader.replace(
            '#include <normal_fragment_begin>',
            THREE.ShaderChunk.normal_fragment_begin.replace('float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;', 'float faceDirection = 1.0;'),
          );
          patchUnderwater(sh);
        };
        if (/Sail/.test(mat.name)) {
          this.sail.push(m);
          mat.side = THREE.DoubleSide;
          m.castShadow = true;
        }
        if (/Plank/.test(mat.name)) hullBox.expandByObject(m);
      }
    });

    const wl = WATERLINE_ABOVE_KEEL;
    const cz = (hullBox.min.z + hullBox.max.z) / 2;
    // origin: hull centre in x/z, design waterline in y
    scene.position.set(-(hullBox.min.x + hullBox.max.x) / 2 * 1, -(hullBox.min.y + wl), -cz);
    this.model.add(scene);
    this.sails = new Sails(this.model, this.root, null);
    this.root.add(this.sails.group);
    this.info = {
      hullStern: hullBox.min.z - cz,
      hullBow: hullBox.max.z - cz,
      beam: hullBox.max.x - hullBox.min.x,
      keelDepth: wl,
      deckHeight: hullBox.max.y - hullBox.min.y - wl,
    };
  }
}

export interface RigState {
  /** signed boom angle, rad (+ = to port) */
  boom: number;
  /** 0..1 sails set */
  up: number;
  /** apparent wind flow direction, boat frame (unit) */
  flow: THREE.Vector3;
  aws: number;
  aoa: number;
}

/** design draft (m): waterline height above the lowest point of the keel */
const WATERLINE_ABOVE_KEEL = 2.25;
