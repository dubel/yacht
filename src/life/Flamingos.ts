import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { terrainHeight } from '../world/WorldGen';

/*
 * Flamingos on the mudflats of the Laguna Karmazynowa: dense flocks wading in water a hand or two deep, most
 * of them with the head down in it, sifting, the bill swept from side to side; others standing, looking
 * round, pausing, and the whole flock wandering slowly over the flat as it feeds. At night they sleep
 * standing on one leg, the head tucked in. Come near — on foot, in the jolly boat or with the ship — and
 * heads come up all over the flock; nearer still and the flock walks off, away from you, keeping to the
 * shallows, a few of them flapping their wings in alarm, and settles again once you are gone. They honk all
 * the while, the more for being uneasy.
 *
 * The model is rigged and animated (walk, idle, a pause, sleep, flapping); feeding it has not, so it is made
 * here: the neck's bones bent forward and down in an arc until the head is in the water, the body tipped a
 * little, the head sweeping from side to side. Two hundred skinned birds would be too dear, so every clip is
 * baked once, at load, into a texture of vertex positions (and one of normals), a row a frame; each bird is
 * then one instance whose vertex shader reads its own frame from it — two clips at once, cross-fading from
 * one to the next.
 */

/** the model stands ~1.7 m: a Caribbean flamingo stands some 1.3 */
const SCALE = 0.78;
/** baked frames a second */
const FPS = 20;
/** water it wades in: deeper than this (m) … and no deeper than that */
const SHALLOW = 0.08, DEEP = 0.55;
/** the shallows are looked for this far round the lagoon's middle, on a grid this fine (m) */
const SEARCH = 520, CELL = 5;
const MAX_FLOCKS = 4, MAX_BIRDS = 240;
/** further than this (m) from the lagoon nothing is drawn or moved */
const FAR = 1400;
/** the head in the water: the head bone this high over the feet (model units) */
const FEED_HEAD = 0.36;
/** how the neck's bend is shared out along it (higher: more at the root), and how far the body tips */
const BEND_P = 2, BODY_TIP = 0.42;
/** a cross-fade between two clips (s) */
const FADE = 0.35;

type Act = 'idle' | 'pause' | 'walk' | 'dip' | 'feed' | 'raise' | 'sleep' | 'flap';
/** the baked clips (raise is dip played backwards) */
type ClipName = Exclude<Act, 'raise'>;

interface Clip {
  /** first row in the textures */
  row: number;
  /** frames (one more row follows: the first again for a loop, the last held for a one-off) */
  frames: number;
  duration: number;
  loop: boolean;
}

interface Bird {
  pos: THREE.Vector2;
  heading: number;
  size: number;
  mirror: number;
  /** where in the flock it keeps (offset from the flock's middle) */
  slot: THREE.Vector2;
  act: Act;
  t: number;
  /** what it was doing (cross-faded out) */
  was: Act;
  wasT: number;
  fade: number;
  /** how long before it thinks of doing something else */
  timer: number;
  speed: number;
  /** 0 calm … 1 wants away */
  fear: number;
  /** the bottom under it, and where that was measured */
  floor: number;
  floorAt: THREE.Vector2;
}

interface Flock {
  /** the flat it lives on */
  home: THREE.Vector2;
  range: number;
  /** its middle now, and where it is wandering to */
  mid: THREE.Vector2;
  goal: THREE.Vector2;
  birds: Bird[];
  callT: number;
  unease: number;
}

export class Flamingos {
  readonly group = new THREE.Group();
  /** a bird honks at (x, z) (set by the game) */
  onCall: ((x: number, z: number) => void) | null = null;
  /** how loud the flocks' murmur is where the listener is (0 … 1) */
  murmur = 0;
  private mesh: THREE.InstancedMesh | null = null;
  private vat: THREE.InstancedBufferAttribute | null = null;
  private readonly clips = {} as Record<ClipName, Clip>;
  /** a walk cycle covers this much ground (m) */
  private stride = 0.5;
  private flocks: Flock[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly Y = new THREE.Vector3(0, 1, 0);

  constructor(private readonly home: { x: number; z: number }) {
    this.group.name = 'flamingos';
  }

  async load(url: string): Promise<void> {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const gltf = await loader.loadAsync(url);
    const { pos, nrm, width, rows, geo } = this.bake(gltf.scene, gltf.animations);
    const tex = (data: Float32Array) => {
      const t = new THREE.DataTexture(data, width, rows, THREE.RGBAFormat, THREE.FloatType);
      t.minFilter = t.magFilter = THREE.NearestFilter;
      t.needsUpdate = true;
      return t;
    };
    const uniforms = { uVatPos: { value: tex(pos) }, uVatNrm: { value: tex(nrm) } };
    this.vat = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BIRDS * 3), 3);
    this.vat.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aVat', this.vat);
    // (a touch deeper than painted: the American flamingo is the most vivid of them)
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, color: new THREE.Color(1, 0.78, 0.76), roughness: 0.85, metalness: 0, envMapIntensity: 0.4, side: THREE.DoubleSide });
    const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    for (const m of [mat, depth]) vatShader(m, uniforms);
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX_BIRDS);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.customDepthMaterial = depth;
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.group.add(this.mesh);
    // (the shallows are searched now, while the game loads, not in the middle of a voyage)
    this.flocks = this.gather();
  }

  // ------------------------------------------------------------------ baking

  /** every clip's frames, skinned on the CPU: vertex positions and normals (m, feet at 0, facing +z) */
  private bake(scene: THREE.Object3D, anims: THREE.AnimationClip[]) {
    let found: THREE.SkinnedMesh | null = null;
    scene.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) found = o as THREE.SkinnedMesh; });
    if (!found) throw new Error('flamingo: no skinned mesh');
    const sm: THREE.SkinnedMesh = found;
    const g = sm.geometry, n = g.getAttribute('position').count;
    const bones = sm.skeleton.bones;
    const bone = (prefix: string) => bones.find((b) => b.name.startsWith(prefix))!;
    const head = bone('headx'), spine = bone('spine_01');
    // the neck: from the head down to (not including) the spine, base first
    const neck: THREE.Object3D[] = [];
    for (let b: THREE.Object3D | null = head; b && b !== spine && !b.name.startsWith('spine'); b = b.parent) neck.unshift(b);
    const mixer = new THREE.AnimationMixer(scene);
    const find = (s: string) => anims.find((a) => a.name.endsWith('|' + s))!;
    const src = { idle: find('idle'), pause: find('idle_Pause'), walk: find('walk'), sleep: find('sleep'), flap: find('flapping') };
    const pose = (clip: THREE.AnimationClip, t: number) => {
      mixer.stopAllAction();
      mixer.clipAction(clip).play();
      mixer.setTime(t);
      scene.updateMatrixWorld(true);
    };
    // bend the neck (total angle a, spread along it, about the bird's side-to-side axis) and tip the body
    const X = new THREE.Vector3(1, 0, 0), qa = new THREE.Quaternion(), qp = new THREE.Quaternion();
    const turn = (b: THREE.Object3D, axis: THREE.Vector3, a: number) => {
      // a rotation about a world axis, as the bone's local one
      b.parent!.getWorldQuaternion(qp);
      qa.setFromAxisAngle(axis, a);
      b.quaternion.premultiply(qp.clone().invert().multiply(qa).multiply(qp));
      b.updateMatrixWorld(true);
    };
    const bend = (a: number, tip: number, sweep: number) => {
      turn(spine, X, tip);
      neck.forEach((b, i) => {
        // most of it at the root (the neck swings down), less toward the head (a curve at the end)
        turn(b, X, a * share[i]);
        // the sweep: the last few links swing the head sideways (about the vertical)
        if (i >= neck.length - 3) turn(b, this.Y, sweep / 3);
      });
    };
    const share = neck.map((_, i) => Math.pow(1 - i / neck.length, BEND_P));
    const sum = share.reduce((x, y) => x + y, 0);
    share.forEach((v, i) => (share[i] = v / sum));
    // how far the neck must bend for the head to reach the water
    const base = src.pause;
    const tipFor = (a: number) => BODY_TIP * Math.min(1, a / 2);
    const headY = (a: number) => { pose(base, 0); bend(a, tipFor(a), 0); return head.getWorldPosition(new THREE.Vector3()).y; };
    let lo = 0.3, hi = 3.4;
    for (let k = 0; k < 24; k++) { const mid = (lo + hi) / 2; if (headY(mid) > FEED_HEAD) lo = mid; else hi = mid; }
    const A = (lo + hi) / 2, TIP = tipFor(A);

    // the frames
    const clips: [ClipName, number, boolean, (t: number) => void][] = [];
    for (const c of ['idle', 'pause', 'walk', 'sleep', 'flap'] as const) clips.push([c, src[c].duration, true, (t) => pose(src[c], t)]);
    const DIP = 1.1, FEED = 3.2;
    clips.push(['dip', DIP, false, (t) => { const k = THREE.MathUtils.smootherstep(t / DIP, 0, 1); pose(base, 0); bend(A * k, TIP * k, 0); }]);
    clips.push(['feed', FEED, true, (t) => {
      const ph = (t / FEED) * Math.PI * 2;
      pose(base, 0);
      // sifting: the bill swept side to side, the neck working a little
      bend(A + 0.08 * Math.sin(ph * 2), TIP, 0.45 * Math.sin(ph));
    }]);
    const rows = clips.reduce((s, [, d]) => s + Math.max(2, Math.round(d * FPS)) + 1, 0);
    const pos = new Float32Array(n * rows * 4), nrm = new Float32Array(n * rows * 4);
    // skinning, as the GPU would: bindMatrixInverse · Σ wᵢ Bᵢ · bindMatrix · p, then the mesh's own transform
    const P = g.getAttribute('position'), N = g.getAttribute('normal');
    const SI = g.getAttribute('skinIndex'), SW = g.getAttribute('skinWeight');
    const bindP: THREE.Vector3[] = [], bindN: THREE.Vector3[] = [];
    const bindN3 = new THREE.Matrix3().setFromMatrix4(sm.bindMatrix);
    for (let i = 0; i < n; i++) {
      bindP.push(new THREE.Vector3().fromBufferAttribute(P, i).applyMatrix4(sm.bindMatrix));
      bindN.push(new THREE.Vector3().fromBufferAttribute(N, i).applyMatrix3(bindN3));
    }
    const out = new THREE.Matrix4().makeScale(SCALE, SCALE, SCALE);
    const boneM = bones.map(() => new THREE.Matrix4()), M = new THREE.Matrix4(), M3 = new THREE.Matrix3(), G3 = new THREE.Matrix3();
    const v = new THREE.Vector3(), w = new THREE.Vector3();
    const frame = (r: number) => {
      const G = out.clone().multiply(sm.matrixWorld).multiply(sm.bindMatrixInverse);
      G3.getNormalMatrix(G);
      bones.forEach((b, i) => boneM[i].multiplyMatrices(b.matrixWorld, sm.skeleton.boneInverses[i]));
      const e = M.elements;
      for (let i = 0; i < n; i++) {
        e.fill(0);
        for (let k = 0; k < 4; k++) {
          const wt = SW.getComponent(i, k);
          if (!wt) continue;
          const be = boneM[SI.getComponent(i, k)].elements;
          for (let j = 0; j < 16; j++) e[j] += wt * be[j];
        }
        v.copy(bindP[i]).applyMatrix4(M).applyMatrix4(G);
        w.copy(bindN[i]).applyMatrix3(M3.setFromMatrix4(M)).applyMatrix3(G3).normalize();
        const o = (r * n + i) * 4;
        pos[o] = v.x; pos[o + 1] = v.y; pos[o + 2] = v.z; pos[o + 3] = 1;
        nrm[o] = w.x; nrm[o + 1] = w.y; nrm[o + 2] = w.z; nrm[o + 3] = 0;
      }
    };
    let row = 0;
    for (const [name, duration, loop, set] of clips) {
      const frames = Math.max(2, Math.round(duration * FPS));
      this.clips[name] = { row, frames, duration, loop };
      for (let f = 0; f <= frames; f++) {
        // (the extra row: a loop's first frame again, a one-off's last held)
        set(loop ? ((f % frames) / frames) * duration : (Math.min(f, frames - 1) / (frames - 1)) * duration);
        frame(row + f);
      }
      row += frames + 1;
    }
    // how much ground a walk cycle covers: a foot's sweep back while it bears the weight (~60% of the cycle)
    const foot = bone('footl');
    let fmin = Infinity, fmax = -Infinity;
    for (let k = 0; k < 16; k++) { pose(src.walk, (k / 16) * src.walk.duration); const z = foot.getWorldPosition(v).z; fmin = Math.min(fmin, z); fmax = Math.max(fmax, z); }
    this.stride = ((fmax - fmin) * SCALE) / 0.6;
    mixer.stopAllAction();
    // the instanced bird: the model's triangles and colours (its shape comes from the textures)
    const first = (a: Float32Array) => { const r = new Float32Array(n * 3); for (let i = 0; i < n; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 4 + j]; return r; };
    const geo = new THREE.BufferGeometry();
    geo.setIndex(g.index);
    geo.setAttribute('position', new THREE.BufferAttribute(first(pos), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(first(nrm), 3));
    const col = g.getAttribute('color');
    if (col) {
      // (painted as sRGB: taken as linear they come out a washed-out, nearly white pink in the tropical sun)
      const c = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) for (let j = 0; j < 3; j++) c[i * 3 + j] = srgbToLinear(col.getComponent(i, j));
      geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
    }
    return { pos, nrm, width: n, rows, geo };
  }

  // ------------------------------------------------------------------ flocks

  /** where they gather: the widest shallows round the lagoon (its mudflats), a flock on each */
  private gather(): Flock[] {
    const n = Math.round((2 * SEARCH) / CELL) + 1;
    const ok = new Uint8Array(n * n);
    const at = (i: number, j: number) => new THREE.Vector2(this.home.x - SEARCH + i * CELL, this.home.z - SEARCH + j * CELL);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { const c = at(i, j); if (this.wades(c.x, c.y)) ok[i * n + j] = 1; }
    // how much shallow water round each shallow cell (within 25 m)
    const R = Math.round(25 / CELL), score: [number, number, number][] = [];
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      if (!ok[i * n + j]) continue;
      let k = 0;
      for (let a = -R; a <= R; a++) for (let b = -R; b <= R; b++) if (a * a + b * b <= R * R && ok[(i + a) * n + j + b]) k++;
      score.push([k, i, j]);
    }
    score.sort((x, y) => y[0] - x[0]);
    const best = score[0]?.[0] ?? 0;
    const flocks: Flock[] = [];
    let seed = 1234567;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (const [k, i, j] of score) {
      // only the broad flats (a narrow rim along a beach is no place for a flock)
      if (flocks.length >= MAX_FLOCKS || k < best * 0.5 || k < 20) break;
      const home = at(i, j);
      if (flocks.some((f) => f.home.distanceTo(home) < 110)) continue;
      const want = Math.min(40 + Math.floor(rnd() * 25), MAX_BIRDS - flocks.reduce((s, f) => s + f.birds.length, 0));
      const flock: Flock = { home, range: 22, mid: home.clone(), goal: home.clone(), birds: [], callT: rnd() * 3, unease: 0 };
      // a tight, ragged bunch: dense in the middle, looser round the edge
      const spread = 0.4 * Math.sqrt(want);
      for (let tries = 0; flock.birds.length < want && tries < want * 60; tries++) {
        const a = rnd() * Math.PI * 2, r = spread * Math.sqrt(-Math.log(1 - rnd() * 0.93));
        const slot = new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r);
        const p = home.clone().add(slot);
        if (!this.wades(p.x, p.y) || flock.birds.some((b) => b.pos.distanceTo(p) < 0.7)) continue;
        const act: Act = rnd() < 0.65 ? 'feed' : rnd() < 0.5 ? 'idle' : 'pause';
        flock.birds.push({
          pos: p, heading: rnd() * Math.PI * 2, size: 0.9 + rnd() * 0.18, mirror: rnd() < 0.5 ? -1 : 1, slot,
          act, t: rnd() * 5, was: act, wasT: 0, fade: 1, timer: 2 + rnd() * 10, speed: 0, fear: 0,
          floor: terrainHeight(p.x, p.y), floorAt: p.clone(),
        });
      }
      if (flock.birds.length) flocks.push(flock);
    }
    return flocks;
  }

  private wades(x: number, z: number): boolean {
    const d = -terrainHeight(x, z);
    return d > SHALLOW && d < DEEP;
  }

  /** start doing `act` (cross-fading from what it did) */
  private start(b: Bird, act: Act): void {
    if (b.act === act) return;
    b.was = b.act;
    b.wasT = b.t;
    b.fade = 0;
    b.act = act;
    b.t = 0;
  }

  /** still bringing the head up (or down) */
  private moving(b: Bird): boolean {
    return (b.act === 'raise' || b.act === 'dip') && b.t < this.clips.dip.duration;
  }

  /** the row (fractional) of an act at time t into it */
  private row(act: Act, t: number): number {
    const c = this.clips[act === 'raise' ? 'dip' : act];
    let k = t / c.duration;
    if (c.loop) k -= Math.floor(k);
    else k = THREE.MathUtils.clamp(k, 0, 1);
    if (act === 'raise') k = 1 - k;
    return c.row + k * c.frames;
  }

  /**
   * Once per frame. `threat`: where the sailor is, and how far off he frightens them (m: the ship from
   * further than a man); `eye`: the listener; `night`: 0 day … 1 night (they sleep).
   */
  update(dt: number, threat: THREE.Vector2, scare: number, eye: THREE.Vector3, night: number): void {
    const mesh = this.mesh, vat = this.vat;
    if (!mesh || !vat) return;
    if (Math.hypot(eye.x - this.home.x, eye.z - this.home.z) > SEARCH + FAR) { this.group.visible = false; this.murmur = 0; return; }
    this.group.visible = true;
    const walkRate = (b: Bird) => (Math.max(0.3, b.speed) / this.stride) * this.clips.walk.duration;
    let k = 0, murmur = 0;
    for (const fl of this.flocks) {
      // flocks far off: they go on with what they are doing, not moving about
      if (fl.mid.distanceTo(threat) < 400) this.think(fl, dt, threat, scare, night);
      const heard = 1 - THREE.MathUtils.smoothstep(Math.hypot(eye.x - fl.mid.x, eye.z - fl.mid.y), 10, 160);
      murmur = Math.max(murmur, heard * (night > 0.6 ? 0.25 : 0.55 + 0.45 * fl.unease));
      for (const b of fl.birds) {
        // the walk played as fast as it goes (feet not sliding), the rest at their own pace
        b.t += b.act === 'walk' ? dt * walkRate(b) : dt;
        b.wasT += b.was === 'walk' ? dt * walkRate(b) : dt;
        b.fade = Math.min(1, b.fade + dt / FADE);
        // (the heightfield is dear: measured again only once it has moved a little)
        if (b.floorAt.distanceToSquared(b.pos) > 0.04) { b.floor = terrainHeight(b.pos.x, b.pos.y); b.floorAt.copy(b.pos); }
        this.p.set(b.pos.x, b.floor, b.pos.y);
        this.q.setFromAxisAngle(this.Y, b.heading);
        this.s.set(b.size * b.mirror, b.size, b.size);
        this.m.compose(this.p, this.q, this.s);
        mesh.setMatrixAt(k, this.m);
        vat.setXYZ(k, this.row(b.was, b.wasT), this.row(b.act, b.t), THREE.MathUtils.smoothstep(b.fade, 0, 1));
        k++;
      }
    }
    mesh.count = k;
    mesh.instanceMatrix.needsUpdate = true;
    vat.needsUpdate = true;
    this.murmur = murmur;
  }

  private think(fl: Flock, dt: number, threat: THREE.Vector2, scare: number, night: number): void {
    // ---- the flock: wanders slowly over its flat; driven off by him, away from him ----
    const alarm = 1 - THREE.MathUtils.smoothstep(fl.mid.distanceTo(threat), scare, scare * 1.5);
    if (alarm > 0.3) {
      // somewhere away from him they can wade
      const away = fl.mid.clone().sub(threat).normalize();
      for (const turn of [0, 0.6, -0.6, 1.2, -1.2]) {
        const g = fl.mid.clone().add(away.clone().rotateAround(new THREE.Vector2(), turn).multiplyScalar(18));
        if (this.wades(g.x, g.y)) { fl.goal.copy(g); break; }
      }
    } else if (fl.mid.distanceTo(fl.goal) < 2) {
      // a new place to feed, somewhere on the flat
      for (let tries = 0; tries < 12; tries++) {
        const a = Math.random() * Math.PI * 2, r = Math.random() * fl.range;
        const g = new THREE.Vector2(fl.home.x + Math.cos(a) * r, fl.home.y + Math.sin(a) * r);
        if (this.wades(g.x, g.y)) { fl.goal.copy(g); break; }
      }
    }
    const pace = alarm > 0.3 ? 1 : night > 0.6 ? 0 : 0.06;
    const to = fl.goal.clone().sub(fl.mid), left = to.length();
    if (left > 0.5) fl.mid.addScaledVector(to.divideScalar(left), Math.min(pace * dt, left));

    // ---- each bird ----
    let unease = 0;
    const bs = fl.birds;
    for (const b of bs) {
      const dx = b.pos.x - threat.x, dz = b.pos.y - threat.y, d = Math.hypot(dx, dz) || 1;
      const fear = 1 - THREE.MathUtils.smoothstep(d, scare, scare * 1.6);
      b.fear += (fear - b.fear) * (1 - Math.exp(-dt * (fear > b.fear ? 3 : 0.3)));
      unease = Math.max(unease, b.fear);
      b.timer -= dt;
      const headDown = b.act === 'feed' || b.act === 'dip';
      // its place in the flock
      const off = fl.mid.clone().add(b.slot).sub(b.pos), far = off.length();
      let speed = 0;
      if (far > (b.fear > 0.3 ? 0.6 : 1.6)) {
        // fallen behind: walk there (the head comes up first)
        if (headDown) this.start(b, 'raise');
        else if (!this.moving(b)) {
          this.start(b, 'walk');
          speed = THREE.MathUtils.clamp(far * 0.5, 0.35, b.fear > 0.3 ? 1.1 : 0.55);
          b.heading += wrap(Math.atan2(off.x, off.y) - b.heading) * (1 - Math.exp(-dt * 4));
        }
      } else if (b.fear > 0.4) {
        // uneasy: the head up, looking; now and then a flap of the wings
        if (headDown) this.start(b, 'raise');
        else if (!this.moving(b) && (b.act !== 'flap' || b.t > this.clips.flap.duration)) this.start(b, b.fear > 0.7 && Math.random() < 0.004 ? 'flap' : 'idle');
      } else if (night > 0.6) {
        if (headDown) this.start(b, 'raise');
        else if (!this.moving(b)) this.start(b, 'sleep');
      } else {
        // calm: mostly feeding, now and then looking round or a pause
        if (b.act === 'walk' || b.act === 'sleep' || (b.act === 'flap' && b.t > this.clips.flap.duration)) this.start(b, 'idle');
        if (b.act === 'dip' && !this.moving(b)) this.start(b, 'feed');
        if (b.act === 'raise' && !this.moving(b)) this.start(b, 'idle');
        if (b.timer <= 0 && !this.moving(b)) {
          const r = Math.random();
          if (headDown) { if (r < 0.35) this.start(b, 'raise'); }
          else this.start(b, r < 0.7 ? 'dip' : r < 0.85 ? 'pause' : 'idle');
          b.timer = headDown ? 5 + Math.random() * 14 : 2 + Math.random() * 5;
          // a little turn, a shuffle of its place
          b.heading += (Math.random() - 0.5) * 0.8;
          b.slot.x += (Math.random() - 0.5) * 0.5;
          b.slot.y += (Math.random() - 0.5) * 0.5;
        }
      }
      b.speed += (speed - b.speed) * (1 - Math.exp(-dt * 4));
      if (b.act === 'walk' && b.speed > 0.01) {
        for (const turn of [0, 0.5, -0.5, 1.1, -1.1]) {
          const h = b.heading + turn, nx = b.pos.x + Math.sin(h) * b.speed * dt, nz = b.pos.y + Math.cos(h) * b.speed * dt;
          if (this.wades(nx, nz)) { b.pos.set(nx, nz); if (turn) b.heading += turn * 0.2; break; }
        }
      }
    }
    // no two in one place (a nudge; it may take one a little deeper, not far)
    for (let i = 0; i < bs.length; i++)
      for (let j = i + 1; j < bs.length; j++) {
        const a = bs[i].pos, c = bs[j].pos, dx = c.x - a.x, dz = c.y - a.y, d2 = dx * dx + dz * dz;
        if (d2 > 0.42 || d2 < 1e-8) continue;
        const d = Math.sqrt(d2), push = (0.65 - d) * 0.5;
        const ux = (dx / d) * push, uz = (dz / d) * push;
        a.set(a.x - ux, a.y - uz);
        c.set(c.x + ux, c.y + uz);
      }
    // honks: now and then from one of them, often when they are uneasy (seldom at night)
    fl.unease = unease;
    fl.callT -= dt;
    if (fl.callT <= 0 && bs.length) {
      fl.callT = unease > 0.3 ? 0.25 + Math.random() * 0.8 : night > 0.6 ? 8 + Math.random() * 20 : 1.5 + Math.random() * 5;
      const b = bs[Math.floor(Math.random() * bs.length)];
      this.onCall?.(b.pos.x, b.pos.y);
    }
  }

  /** the flocks (debugging) */
  get where(): { x: number; z: number; n: number }[] {
    return this.flocks.map((f) => ({ x: +f.mid.x.toFixed(1), z: +f.mid.y.toFixed(1), n: f.birds.length }));
  }
}

/** the vertex shader reads the bird's shape from the baked frames: two clips' rows, cross-faded */
function vatShader(mat: THREE.Material, uniforms: Record<string, THREE.IUniform>): void {
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
attribute vec3 aVat;
uniform sampler2D uVatPos;
uniform sampler2D uVatNrm;
vec3 vatRow(sampler2D t, float row) {
  float r = floor(row);
  vec3 a = texelFetch(t, ivec2(gl_VertexID, int(r)), 0).xyz;
  vec3 b = texelFetch(t, ivec2(gl_VertexID, int(r) + 1), 0).xyz;
  return mix(a, b, row - r);
}
vec3 vat(sampler2D t) { return mix(vatRow(t, aVat.x), vatRow(t, aVat.y), aVat.z); }`,
      )
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nobjectNormal = normalize(vat(uVatNrm));')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed = vat(uVatPos);');
  };
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function wrap(a: number): number {
  return a - Math.round(a / (Math.PI * 2)) * Math.PI * 2;
}
