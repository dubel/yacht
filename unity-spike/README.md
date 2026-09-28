# Unity spike: our water in Unity

The home lagoon, the Amadis and the game's water (Gerstner + FFT + wake + caustics + Clearwater surface,
post included) ported 1:1 to Unity 6 URP — to compare the look and the frame cost with the web version.
Plan: `migration-to-unity/spike-plan.md`. All water maths runs in three.js coordinates (Unity z = −three z).

From the repo root, with the dev server running (`npx vite --port 5173 --strictPort`):

```sh
npx tsx tools/dev/export-terrain.ts     # lagoon heights + colours → unity-spike/Import
node tools/dev/export-unity.mjs         # sky, FFT seed, boat, light/wave state → unity-spike/Import
tools/unity.sh setup                    # import + build the scene (batch mode)
tools/unity.sh build                    # Linux player (Vulkan)
tools/unity.sh run                      # sail: W/S speed, A/D helm, drag to orbit, wheel to zoom, V dive,
                                        # [ ] render scale, \ auto scale (as the web game: 0.7 on HiDPI, 0.45–1)
tools/dev/compare-all.sh                # A–E: .shots/<view>-cmp.png (three.js | Unity)
```

Player flags: `-cam x,y,z,tx,ty,tz` (three coords, like `?cam=`), `-t 5` (frozen waves), `-shot f.png`,
`-state f.json`, `-frames N`, `-bench N -benchres 1920x1080`, `-view 1|3|4|5|6` (normals, reflection,
thickness, wake, FFT), `-nowater`, `-postdebug 1|2`, `-scale 0.7` (fixed render scale; measuring runs default to 1).

Left out on purpose: clouds and weather (the sky is a captured clear 10:30 sky), vegetation, the world beyond
±640 m, sailing physics (the boat floats on the same waves and is driven directly), set sails.
