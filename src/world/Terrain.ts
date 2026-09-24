import * as THREE from 'three';
import { patchUnderwater } from '../render/water/underwaterLight';
import { boxIsOpenOcean, terrainHeight } from './WorldGen';
import { tileIndex } from './tileGrid';
import type { TileRequest, TileResult } from './terrain.worker';
import type { Vegetation } from './Vegetation';

/**
 * Streamed terrain: the world (see WorldGen) is cut into TILE-sized square tiles around the camera, each
 * built off the main thread by a small worker pool at a level of detail that drops with distance. Tiles
 * with nothing but deep ocean are never built (decided from the feature layout alone), so open water
 * costs nothing. A tile keeps showing its old mesh until the new level of detail arrives: no holes.
 */

const TILE = 256;
/** detail levels: segments per tile side, and the distance (m, camera → nearest point of the tile) it serves */
const LODS = [
  { n: 128, dist: 320 },
  { n: 64, dist: 800 },
  { n: 32, dist: 1600 },
  { n: 16, dist: 3200 },
];
/** a tile only drops to a coarser level (or unloads) this far past the threshold: no flicker on a boundary */
const HYSTERESIS = 60;
/** tiles at this level or finer carry plants (low-poly models) */
const VEG_LOD = 2;
/** full plant models only on tiles this close (m, nearest point; in / out with hysteresis) — they cost
 *  ~5× the triangles, and beyond this no one can tell */
const VEG_FULL_IN = 110, VEG_FULL_OUT = 150;
/** new meshes handed to the GPU per frame (spreads the buffer uploads) */
const UPLOADS_PER_FRAME = 3;

interface Tile {
  tx: number;
  tz: number;
  /** level currently shown (−1: none yet) */
  lod: number;
  mesh: THREE.Mesh | null;
  /** level being built (−1: none) */
  pending: number;
  /** finest level at which the worker found only deep water (99: never) */
  emptyAt: number;
  /** plants on this tile, one instanced mesh per kind (null: not placed yet) */
  plants: THREE.InstancedMesh[] | null;
  plantsAsked: boolean;
  /** close enough for the full plant models */
  near: boolean;
}

export class Terrain {
  readonly group = new THREE.Group();
  readonly material: THREE.MeshStandardMaterial;
  private readonly pebbles: THREE.IUniform<THREE.Texture>;
  private readonly tiles = new Map<string, Tile>();
  private readonly open = new Map<string, boolean>();
  private readonly index = LODS.map((l) => new THREE.BufferAttribute(tileIndex(l.n), 1));
  private readonly workers: Worker[] = [];
  private readonly busy: boolean[] = [];
  private readonly queue: { tile: Tile; lod: number; d: number }[] = [];
  private readonly jobs = new Map<number, { tile: Tile; lod: number; worker: number }>();
  private readonly results: { job: { tile: Tile; lod: number }; r: TileResult }[] = [];
  private nextId = 1;

  private readonly plants = new THREE.Group();

  constructor(pebbles: THREE.Texture, seed: number, private readonly vegetation: Vegetation) {
    this.pebbles = { value: pebbles };
    this.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
    this.material.onBeforeCompile = (sh) => this.patchShader(sh);
    this.group.name = 'terrain';
    this.plants.name = 'vegetation';
    this.group.add(this.plants);
    const count = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 4) - 1));
    for (let w = 0; w < count; w++) {
      const worker = new Worker(new URL('./terrain.worker.ts', import.meta.url), { type: 'module' });
      worker.postMessage({ seed });
      worker.onmessage = (e: MessageEvent<TileResult>) => {
        const job = this.jobs.get(e.data.id);
        if (!job) return;
        this.jobs.delete(e.data.id);
        this.busy[job.worker] = false;
        this.results.push({ job, r: e.data });
      };
      this.workers.push(worker);
      this.busy.push(false);
    }
  }

  heightAt(x: number, z: number): number {
    return terrainHeight(x, z);
  }

  /** tiles in flight or waiting (0 once everything around the camera is built) */
  get backlog(): number {
    return this.queue.length + this.jobs.size + this.results.length;
  }

  get stats(): { tiles: number; meshes: number; vertices: number; plants: number; plantsNear: number } {
    let meshes = 0, vertices = 0, plants = 0, plantsNear = 0;
    for (const t of this.tiles.values()) {
      if (t.mesh) { meshes++; vertices += (LODS[t.lod].n + 1) ** 2; }
      for (const m of t.plants ?? []) if (m.visible) { plants += m.count; if (t.near) plantsNear += m.count; }
    }
    return { tiles: this.tiles.size, meshes, vertices, plants, plantsNear };
  }

  /** build everything around `focus` before the game starts */
  async ready(focus: THREE.Vector3, progress?: (f: number) => void): Promise<void> {
    this.update(focus, Infinity);
    const total = Math.max(1, this.backlog);
    while (this.backlog > 0) {
      await new Promise((r) => setTimeout(r, 16));
      this.update(focus, Infinity);
      progress?.(1 - this.backlog / total);
    }
  }

  /** once per frame: decide which tiles are needed at which detail, dispatch work, adopt finished tiles */
  update(focus: THREE.Vector3, uploads = UPLOADS_PER_FRAME): void {
    this.plan(focus);
    this.dispatch();
    for (let k = 0; k < uploads && this.results.length; k++) this.adopt(this.results.shift()!);
  }

  private isOpenOcean(tx: number, tz: number): boolean {
    const key = `${tx},${tz}`;
    let v = this.open.get(key);
    if (v === undefined) {
      v = boxIsOpenOcean(tx * TILE, tz * TILE, (tx + 1) * TILE, (tz + 1) * TILE);
      if (this.open.size > 20000) this.open.clear();
      this.open.set(key, v);
    }
    return v;
  }

  private plan(focus: THREE.Vector3): void {
    const far = LODS[LODS.length - 1].dist;
    const r = Math.ceil((far + HYSTERESIS) / TILE);
    const ctx = Math.floor(focus.x / TILE), ctz = Math.floor(focus.z / TILE);
    const seen = new Set<string>();
    this.queue.length = 0;
    for (let tz = ctz - r; tz <= ctz + r; tz++)
      for (let tx = ctx - r; tx <= ctx + r; tx++) {
        if (this.isOpenOcean(tx, tz)) continue;
        // distance from the focus to the nearest point of the tile
        const dx = Math.max(tx * TILE - focus.x, 0, focus.x - (tx + 1) * TILE);
        const dz = Math.max(tz * TILE - focus.z, 0, focus.z - (tz + 1) * TILE);
        const d = Math.hypot(dx, dz);
        const key = `${tx},${tz}`;
        let tile = this.tiles.get(key);
        let want = LODS.findIndex((l) => d < l.dist);
        if (want < 0) {
          // past the last level: a loaded tile survives the hysteresis band, otherwise it is unloaded below
          if (tile && d < far + HYSTERESIS) seen.add(key);
          continue;
        }
        // coarsen only past the hysteresis band
        if (tile && tile.lod >= 0 && want > tile.lod && d < LODS[tile.lod].dist + HYSTERESIS) want = tile.lod;
        if (!tile) { tile = { tx, tz, lod: -1, mesh: null, pending: -1, emptyAt: 99, plants: null, plantsAsked: false, near: false }; this.tiles.set(key, tile); }
        seen.add(key);
        const near = d < (tile.near ? VEG_FULL_OUT : VEG_FULL_IN);
        if (near !== tile.near) { tile.near = near; this.plantDetail(tile); }
        if (want === tile.lod || want === tile.pending || want >= tile.emptyAt) continue;
        this.queue.push({ tile, lod: want, d });
      }
    for (const [key, t] of this.tiles) if (!seen.has(key)) this.drop(key, t);
    // nearest first; a tile with nothing to show yet beats a refinement
    this.queue.sort((a, b) => (a.tile.lod < 0 ? 0 : 1) - (b.tile.lod < 0 ? 0 : 1) || a.d - b.d);
  }

  private dispatch(): void {
    let q = 0;
    for (let w = 0; w < this.workers.length && q < this.queue.length; w++) {
      if (this.busy[w]) continue;
      const { tile, lod } = this.queue[q++];
      const id = this.nextId++;
      const n = LODS[lod].n, step = TILE / n;
      this.busy[w] = true;
      tile.pending = lod;
      const veg = !tile.plantsAsked && lod <= VEG_LOD;
      if (veg) tile.plantsAsked = true;
      this.jobs.set(id, { tile, lod, worker: w });
      this.workers[w].postMessage({ id, x0: tile.tx * TILE, z0: tile.tz * TILE, size: TILE, n, skirt: 1.5 + step * 0.75, veg } satisfies TileRequest);
    }
    this.queue.splice(0, q);
  }

  private adopt({ job, r }: { job: { tile: Tile; lod: number }; r: TileResult }): void {
    const t = job.tile;
    if (t.pending === job.lod) t.pending = -1;
    if (this.tiles.get(`${t.tx},${t.tz}`) !== t) return; // unloaded meanwhile
    if (r.veg) this.addPlants(t, r.veg);
    if (r.empty) {
      t.emptyAt = Math.min(t.emptyAt, job.lod);
      if (t.mesh) { this.group.remove(t.mesh); t.mesh.geometry.dispose(); t.mesh = null; }
      t.lod = job.lod;
      return;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(r.position!, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(r.normal!, 3));
    g.setAttribute('color', new THREE.BufferAttribute(r.color!, 3));
    g.setIndex(this.index[job.lod]);
    g.boundingBox = new THREE.Box3(new THREE.Vector3(0, r.minY - 20, 0), new THREE.Vector3(TILE, r.maxY, TILE));
    g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
    const mesh = new THREE.Mesh(g, this.material);
    mesh.position.set(t.tx * TILE, 0, t.tz * TILE);
    mesh.updateMatrix();
    mesh.matrixAutoUpdate = false;
    mesh.receiveShadow = true;
    mesh.name = `tile ${t.tx},${t.tz} n${LODS[job.lod].n}`;
    if (t.mesh) { this.group.remove(t.mesh); t.mesh.geometry.dispose(); }
    this.group.add(mesh);
    t.mesh = mesh;
    t.lod = job.lod;
    t.emptyAt = 99;
    this.plantDetail(t);
  }

  private addPlants(t: Tile, veg: Float32Array[]): void {
    t.plants = [];
    veg.forEach((m, kind) => {
      const count = m.length / 16;
      if (!count) return;
      const mesh = new THREE.InstancedMesh(this.vegetation.geometry(kind, true), this.vegetation.material, count);
      mesh.instanceMatrix = new THREE.InstancedBufferAttribute(m, 16);
      mesh.userData.kind = kind;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // bounds from the instance positions (+ the tallest plant), so whole tiles of trees are culled
      mesh.computeBoundingSphere();
      mesh.boundingSphere!.radius += 12;
      mesh.matrixAutoUpdate = false;
      t.plants!.push(mesh);
      this.plants.add(mesh);
    });
  }

  /** full plant models on the nearest tiles, low-poly ones further out, none past VEG_LOD */
  private plantDetail(t: Tile): void {
    for (const m of t.plants ?? []) {
      m.visible = t.lod >= 0 && t.lod <= VEG_LOD;
      m.geometry = this.vegetation.geometry(m.userData.kind as number, !t.near);
    }
  }

  private drop(key: string, t: Tile): void {
    if (t.mesh) { this.group.remove(t.mesh); t.mesh.geometry.dispose(); }
    for (const m of t.plants ?? []) { this.plants.remove(m); m.dispose(); }
    this.tiles.delete(key);
  }

  private patchShader(sh: THREE.WebGLProgramParametersWithUniforms): void {
    sh.uniforms.uPeb = this.pebbles;
    patchUnderwater(sh);
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
uniform sampler2D uPeb;
float tHash(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*.1031); p3 += dot(p3, p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
float tNoise(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.-2.*f);
  return mix(mix(tHash(i),tHash(i+vec2(1,0)),u.x), mix(tHash(i+vec2(0,1)),tHash(i+vec2(1,1)),u.x), u.y); }
`,
      )
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
{
  // seabed detail: Clearwater's pebble texture in patches, rippled sand elsewhere (texture-bombed to hide tiling)
  float under = smoothstep(0.6, -0.2, vWPos.y);
  vec2 xz = vWPos.xz;
  float k = tNoise(xz*0.21);
  float l = k*8.0; float ia = floor(l), fa = fract(l);
  vec2 oa = sin(vec2(3.0,7.0)*ia), ob = sin(vec2(3.0,7.0)*(ia+1.0));
  vec2 puv = xz/1.3;
  vec3 pa = texture(uPeb, puv+oa).rgb, pb = texture(uPeb, puv+ob).rgb;
  vec3 peb = mix(pa, pb, smoothstep(0.2, 0.8, fa));
  float pebZone = smoothstep(0.45, 0.7, tNoise(xz*0.05 + 3.0)) * under;
  // wave-formed ripple marks only below the water line; dry sand gets grain + wind-blown patches
  float marks = (0.5 + 0.5*sin(dot(xz, vec2(0.93, 0.37))*5.0 + 3.0*tNoise(xz*0.3))) * smoothstep(0.0, -0.4, vWPos.y);
  float grain = tNoise(xz*9.0)*0.6 + tNoise(xz*31.0)*0.4;
  float patches = tNoise(xz*0.35)*0.6 + tNoise(xz*1.7)*0.4;
  vec3 sandDetail = vec3(0.88 + 0.12*marks + 0.12*grain) * mix(vec3(0.92, 0.9, 0.86), vec3(1.05, 1.02, 0.97), patches);
  vec3 pebDetail = peb*2.4;
  diffuseColor.rgb *= mix(vec3(1.0), mix(sandDetail, pebDetail, pebZone), smoothstep(1.8, 0.0, vWPos.y));
  // land: break up the vertex colours (grass, scrub, bare earth)
  float land = smoothstep(1.6, 2.4, vWPos.y);
  float ln = tNoise(xz*0.9)*0.5 + tNoise(xz*3.3)*0.3 + tNoise(xz*11.0)*0.2;
  vec3 earth = vec3(0.32, 0.26, 0.17);
  diffuseColor.rgb = mix(diffuseColor.rgb, mix(diffuseColor.rgb*(0.7 + 0.6*ln), earth, smoothstep(0.62, 0.8, ln)*0.6), land);
  // wet band on beaches
  float wet = smoothstep(0.7, 0.05, vWPos.y) * smoothstep(-0.3, 0.05, vWPos.y);
  diffuseColor.rgb *= 1.0 - 0.18*wet;
}`,
      );
  }
}
