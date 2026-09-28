// Unity spike: browser side of tools/dev/export-unity.mjs — imported into the running game by the dev
// server (so it shares the game's `three`). Returns the sky, the FFT spectrum seed, the boat model and the
// lighting/wave state, all in three.js world coordinates.
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const b64 = (u8: Uint8Array) => {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
};

/** equirect of the sky (three coords): u → lon (0 = −Z, +90° = +X), v → lat (0.5 = horizon) */
function skyEquirect(renderer: THREE.WebGLRenderer, envScene: THREE.Scene, w: number): THREE.WebGLRenderTarget {
  const cubeRT = new THREE.WebGLCubeRenderTarget(1024, { type: THREE.HalfFloatType, generateMipmaps: false });
  const cc = new THREE.CubeCamera(0.1, 5000, cubeRT);
  cc.update(renderer, envScene);
  const rt = new THREE.WebGLRenderTarget(w, w / 2, { type: THREE.FloatType, depthBuffer: false });
  const mat = new THREE.ShaderMaterial({
    uniforms: { uCube: { value: cubeRT.texture } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `uniform samplerCube uCube; varying vec2 vUv;
      void main(){
        float lon = (vUv.x - 0.5)*6.28318530718, lat = (vUv.y - 0.5)*3.14159265359;
        vec3 d = vec3(cos(lat)*sin(lon), sin(lat), -cos(lat)*cos(lon));
        gl_FragColor = vec4(textureCube(uCube, d).rgb, 1.0);
      }`,
    depthTest: false,
    depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(rt);
  renderer.render(quad, cam);
  renderer.setRenderTarget(prev);
  cubeRT.dispose();
  return rt;
}

export async function run(game: any) {
  const r: THREE.WebGLRenderer = game.renderer;
  const env = game.env;

  // clear sky only: an empty cloud map (transmittance 1) — the spike has no clouds
  const skyU = env.sky.material.uniforms;
  const cloudMap = skyU.uCloudMap.value;
  const noClouds = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  noClouds.needsUpdate = true;
  skyU.uCloudMap.value = noClouds;
  const skyRT = skyEquirect(r, env.envScene, 2048);
  skyU.uCloudMap.value = cloudMap;
  // raw float RGBA, GL row order (row 0 = v 0 = straight down): Unity loads it as is (LoadRawTextureData)
  const sky = new Float32Array(skyRT.width * skyRT.height * 4);
  r.readRenderTargetPixels(skyRT, 0, 0, skyRT.width, skyRT.height, sky);
  skyRT.dispose();

  const h0: Float32Array = game.spectrum.h0.image.data;

  // the boat as the game shows it (cm → m and waterline offset baked into `model`), without the set sails
  const model: THREE.Object3D = game.boat.model;
  const clone = model.clone(true);
  clone.position.set(0, 0, 0);
  clone.quaternion.identity();
  clone.scale.set(1, 1, 1);
  clone.traverse((o) => { o.visible = true; });
  const glb = (await new GLTFExporter().parseAsync(clone, { binary: true, maxTextureSize: 2048 })) as ArrayBuffer;

  const w = game.waves;
  const wp = game.weather.p;
  const cam: THREE.PerspectiveCamera = game.cam.camera;
  const root: THREE.Object3D = game.boat.root;
  const state = {
    time: game.time,
    wind: { x: game.wind.dir.x, z: game.wind.dir.z },
    // (flat arrays: Unity's JsonUtility has no nested arrays)
    waves: { A: w.uniformA.flatMap((v: THREE.Vector4) => v.toArray()), B: w.uniformB.flatMap((v: THREE.Vector4) => v.toArray()) },
    env: {
      lightDir: env.lightDir.toArray(),
      sunRadiance: env.sunRadiance.toArray(),
      skyIrradiance: env.skyIrradiance.toArray(),
      fogColor: env.fogColor.toArray(),
      fogDensity: env.fogDensity,
      lightColor: env.light.color.toArray(),
      lightIntensity: env.light.intensity,
      exposure: game.pipeline.post.exposure,
      golden: env.golden,
    },
    weather: { chop: wp.chop, whitecaps: wp.whitecaps, rain: wp.rain },
    boat: { position: root.position.toArray(), quaternion: root.quaternion.toArray(), info: game.boat.info },
    camera: { position: cam.position.toArray(), quaternion: cam.quaternion.toArray(), fov: cam.fov, near: cam.near, far: cam.far },
  };
  return { state, sky: b64(new Uint8Array(sky.buffer)), h0: b64(new Uint8Array(h0.buffer, h0.byteOffset, h0.byteLength)), boat: b64(new Uint8Array(glb)) };
}
