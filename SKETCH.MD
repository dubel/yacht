Tak. Po przejrzeniu **aktualnego Clearwatera** zmieniłbym wcześniejszą rekomendację w dość konkretny sposób:

> **Three.js + WebGL2 + własny water renderer oparty na Clearwater + JoltPhysics.js/WASM + TypeScript + Vite.**

Nie zaczynałbym od WebGPU. Clearwater jest obecnie bardzo ciekawym „rdzeniem referencyjnym” dla tego projektu: ma FFT ocean spectrum, lokalne ripples, caustics, fizyczny Fresnel, sun glints, podwodne rozpraszanie i nawet kosztowny lens-glare, a całość jest MIT. 

Jednocześnie **nie próbowałbym wrzucać Clearwatera jako gotowej biblioteki do Three.js**. To raczej kod, który warto rozebrać na części i włączyć jako własny subsystem renderingu wody.

---

# 1. Docelowa architektura

Widzę to tak:

```text
                         BROWSER
                            │
                   ┌────────┴────────┐
                   │                 │
                TypeScript        WebGL2
                   │                 │
        ┌──────────┼──────────┐      │
        │          │          │      │
      Game       Physics     World    │
      logic      Jolt        scene    │
        │          │          │       │
        │          │          │       │
        └──────────┴──────────┴───────┤
                                       │
                              THREE.JS RENDERER
                                       │
                  ┌────────────────────┼───────────────────┐
                  │                    │                   │
              Opaque pass         Reflection pass     Refraction
                  │                    │                   │
                  └────────────────────┼───────────────────┘
                                       │
                                CLEARWATER CORE
                                       │
                         ┌─────────────┼─────────────┐
                         │             │             │
                       FFT          Caustics       Ripples
                         │             │             │
                         └─────────────┼─────────────┘
                                       │
                                  Water shader
                                       │
                                  Postprocess
                                       │
                                     canvas
```

A nad tym:

```text
                  GAME TIME
                     │
       ┌─────────────┼─────────────┐
       │             │             │
    Sun/Sky       Wind/Weather   Audio
       │             │
       │             │
       └───────┬─────┘
               │
        Water + Sailing
```

---

# 2. Dlaczego jednak WebGL2, a nie WebGPU?

To jest najważniejsza decyzja architektoniczna.

Three.js ma już `WebGPURenderer`, który preferuje WebGPU i fallbackuje do WebGL2. TSL pozwala pisać materiały/shadery niezależnie od backendu. ([Three.js][1])

Ale obecnie istnieje istotne ograniczenie: w `WebGPURenderer` nie działają klasyczne `ShaderMaterial`, `RawShaderMaterial` ani modyfikacje przez `onBeforeCompile()`. Trzeba portować taki rendering do TSL. ([Three.js][1])

A Clearwater to praktycznie:

```text
custom GLSL
    +
multiple framebuffer passes
    +
float render targets
    +
fullscreen shaders
```

Czyli dokładnie to, czego nie chciałbym na dzień dobry przepisywać na TSL.

Za to **WebGLRenderer jest nadal utrzymywany i oficjalnie rekomendowany do czystych aplikacji WebGL2**, a Three ma gotowe `Water`, `Reflector`, `Refractor`, GPGPU water itd. ([Three.js][1])

### Dlatego:

**v1:**

```text
Three.js
    ↓
WebGLRenderer
    ↓
WebGL2
```

**v2, kiedy wszystko już wygląda dobrze:**

```text
Clearwater GLSL
       ↓
TSL/WGSL
       ↓
WebGPURenderer
```

To jest migracja optymalizacyjna, a nie fundament projektu.

---

# 3. Clearwater — co dokładnie z niego bierzemy

I tutaj zrobiłem trochę dokładniejszą analizę kodu.

Clearwater ma kilka bardzo ciekawych elementów.

## A. FFT ocean spectrum

Domyślnie:

```text
N = 256
patch = 4.6 m
depth = 1.6 m
```

a potem wykonuje GPU FFT w osobnych passach i rozwiązuje z tego height/slope field. 

To jest świetne jako **źródło dużych fal i normalnych wody**.

Co ważne: nie skopiowałbym bezmyślnie `L = 4.6`.

W grze potrzebujemy raczej:

```text
              lagoon
       ┌────────────────────┐
       │                    │
       │        ⛵          │
       │                    │
       └────────────────────┘

            np. 128–512 m
```

Więc zrobiłbym wieloskalową wodę:

```text
FFT 256
  ↓
large waves

Gerstner / noise
  ↓
medium waves

normal maps / procedural detail
  ↓
micro ripples

local ripple simulation
  ↓
boat interaction
```

Czyli Clearwater jako **jeden z poziomów**, a nie absolutnie cały model.

---

# 4. Ripples — zostawiamy prawie 1:1

Clearwater ma osobną symulację:

```text
RN = 256
RSIZE = 7 m
```

czyli lokalne pole około 7 × 7 m. 

To jest wręcz idealne pod łódkę.

Zamiast:

```text
tap water
```

będzie:

```text
boat hull
   ↓
wake generator
   ↓
local ripple field
```

i ewentualnie:

```text
oar
 │
 ▼
ripple
```

To daje bardzo naturalny efekt.

Nie próbowałbym symulować 500×500 metrów interaktywnej wody.

---

# 5. Caustics — absolutnie zachować

To jest jeden z najmocniejszych elementów Clearwatera.

Ma osobny pass:

```text
256 × 256 projected grid
          ↓
1024 × 1024 caustics texture
```

i oblicza refrakcję promieni słońca przez falującą powierzchnię. 

Na dnie laguny dostajesz:

```text
      WATER
~~~~~~~~~~~~~~~~~~~~~~
  \  /\/\ /\ /\
   \/  \/\  /\/

  ✨  ✨   ✨  ✨
      seabed
```

I moim zdaniem właśnie **caustics + właściwa transmisja światła przez wodę** będą jednym z największych czynników "wow".

---

# 6. Główny shader Clearwatera też warto zachować

Ma już:

* Fresnel
* refraction
* physically inspired absorption/scattering
* seabed shading
* sun glints
* haze
* underwater volume

Na przykład Fresnel jest liczony fizycznie, a nie jako prosty `pow(1-dot(...), 5)`. 

Pod wodą robi również absorpcję i scattering zależne od odległości w wodzie. 

**To bym zdecydowanie przeniósł.**

---

# 7. Ale jednej rzeczy z Clearwater NIE przenosiłbym 1:1

Clearwater jest świetnym rendererem demonstracyjnym:

> "kamera + nieskończona woda + procedurally generated seabed"

a nasza gra będzie:

```text
                  island
            █████████████
         ███             ███
      ███                     ███

~~~~~~~~~~~~~~ WATER ~~~~~~~~~~~~~~~
             ⛵

          rocks / beach
```

Czyli musimy integrować wodę z prawdziwą sceną.

Dlatego zrobiłbym:

### Scene render

```text
sceneColorRT
sceneDepthRT
```

najpierw renderujemy:

* wyspy
* skały
* roślinność
* łódkę
* wszystko poza wodą

Potem:

### Reflection pass

```text
mirror camera
      ↓
scene from below mirror plane
      ↓
reflectionRT
```

### Water pass

Shader dostaje:

```text
sceneColor
sceneDepth
reflection
FFT surface
ripples
caustics
sky
sun
```

i składa:

```text
finalWater =
    Fresnel * reflection
    +
    transmission * underwaterScene
    +
    caustics
    +
    specular
    +
    absorption
```

To jest moim zdaniem właściwy sposób wykorzystania Clearwatera.

---

# 8. Water renderer jako osobny moduł

Chciałbym mieć coś w tym stylu:

```ts
class LagoonWater {
    readonly spectrum: WaterSpectrum;
    readonly ripples: RippleSimulation;
    readonly caustics: CausticsRenderer;
    readonly material: WaterMaterial;

    update(time: number, dt: number): void;

    renderReflection(...): void;
    renderCaustics(...): void;
    renderWater(...): void;

    sampleHeight(x: number, z: number, time: number): number;
    sampleNormal(x: number, z: number, time: number): Vector3;
}
```

Czyli dla reszty gry woda będzie po prostu API:

```ts
water.sampleHeight(x, z, time)
water.sampleNormal(x, z, time)
```

To będzie bardzo ważne.

---

# 9. I tutaj pojawia się kluczowa rzecz: fizyka ≠ rendering

Nie próbowałbym pobierać wysokości wody z GPU co klatkę.

Zrobiłbym:

```text
                   WATER
                     │
         ┌───────────┴───────────┐
         │                       │
     GPU renderer            CPU physics
         │                       │
   Clearwater FFT          simplified waves
   + ripples                 + wind
   + normals
```

Fizyka łódki może używać np. 6–10 Gerstner waves.

Wizualna woda może mieć dużo bardziej skomplikowane FFT.

Dzięki temu:

```text
GPU water:
    100% beautiful

CPU water:
    100% predictable
```

I to jest dużo lepsza architektura.

---

# 10. JoltPhysics.js

Tu Jolt jest naprawdę interesujący.

Oficjalne JoltPhysics.js ma:

* WASM
* rigid bodies
* soft bodies
* cloth-like constraints
* buoyancy
* sample water simulation

i jego API jest wystawione z C++ Jolt do JS. ([GitHub][2])

Ma też bezpośrednio funkcję `ApplyBuoyancyImpulse()`. ([jrouwe.github.io][3])

Dlatego:

**Jolt > Rapier dla tego konkretnego projektu**, chociaż Rapier też byłby zupełnie sensowny jako engine rigid-body. Rapier również działa przez WASM. ([Rapier][4])

---

# 11. Model łódki

Nie używałbym jednego collidera typu:

```text
BOX
```

bo łódka będzie zachowywać się jak wanna.

Zamiast tego:

```text
                 bow
                  ▲

           ●──────●──────●
           │             │
           │    HULL     │
           │             │
           ●──────●──────●

        6–8 buoyancy points
```

Każdy punkt:

```text
waterHeight
       ↓
submersion
       ↓
buoyancy force
       ↓
drag
```

Dzięki temu łódka naturalnie:

* kołysze się,
* przechyla,
* nurkuje dziobem,
* wynurza rufę,
* reaguje na fale.

---

# 12. Następnie fizyka żeglowania

To zrobiłbym **samemu**, nie szukał gotowej biblioteki.

Mamy:

```text
true wind
    ↓
boat velocity
    ↓
APPARENT WIND
```

czyli:

```text
V_apparent = V_wind - V_boat
```

Następnie:

```text
                 wind
                  →
                 ↘
                  ↘
                 /|
                / |
               /  |
           sail   |
```

Obliczamy:

```text
angle of attack
        ↓
       CL
       CD
        ↓
lift + drag
        ↓
force on sail
        ↓
moment on boat
```

W uproszczeniu:

```text
F = 0.5 * rho * V² * A * C
```

i osobno:

```text
lift
drag
```

Potem:

```text
      sail force
          ↓
        ⛵
      ↗     ↘
    heel   forward
```

To daje bardzo dużo możliwości gameplayowych:

* płynięcie z wiatrem
* close hauled
* beam reach
* gybe
* tack
* złe ustawienie żagla
* utrata prędkości
* przechył

---

# 13. Keel i rudder

To będzie druga część modelu.

### Keel

Daje boczną siłę przeciwstawiającą się:

```text
sail force →→→
```

przez:

```text
keel ←←←
```

czyli łódka nie jedzie bokiem jak materac.

### Rudder

```text
rudder angle
     ↓
hydrodynamic force
     ↓
yaw moment
     ↓
boat turns
```

To daje bardzo naturalną fizykę sterowania.

---

# 14. Żagiel

Nie szukałbym koniecznie "gotowej łódki z fizycznym żaglem".

Zrobiłbym:

```text
GLB sailboat
      │
      ├── hull
      ├── mast
      ├── boom
      ├── rudder
      ├── keel
      └── sail mesh
```

A żagiel:

```text
subdivided grid
    ↓
custom cloth
    ↓
wind deformation
```

### v1

GPU deformation:

```text
wind
 +
sail angle
 +
boat velocity
      ↓
vertex displacement
```

To jest tanie i może wyglądać świetnie.

### v2

Prawdziwy cloth.

Tutaj możemy użyć Jolt soft body — Jolt ma jawnie wsparcie soft bodies i constraints dla cloth. ([GitHub][5])

Ale **nie robiłbym tego w pierwszej wersji**.

---

# 15. Wake

To będzie osobny system.

Nie próbowałbym fizycznie symulować całego kilwateru.

Robimy:

```text
boat velocity
boat yaw
boat acceleration
```

→ generator wake.

Np.:

```text
          ⛵
           \
            \
             ~~~~~
          ~~~~~~~~~
       ~~~~~~~~~~~~~
```

Składa się z:

```text
foam texture
+
ripples
+
small displacement
```

W spokojnej zatoce powinno wyglądać bardzo dobrze.

---

# 16. Świat / laguna

Nie robiłbym jednej gigantycznej proceduralnej powierzchni.

Na start:

```text
500m × 500m
```

albo nawet:

```text
250m × 250m
```

i potem LOD.

Świat:

```text
                    mountains
                 ████████████
             ████            ███

       island                    island
     ███████                   ███████
     █     █~~~~~~~~~~~~~~~~~~~█     █
           ~~~~      ⛵       ~~~~
           ~~~~~~~~~~~~~~~~~~~~~~~~
               shallow lagoon

          rocks       sand
```

---

# 17. Seabed

Tutaj zrobiłbym prawdziwą geometrię.

Nie kopiowałbym Clearwaterowego proceduralnego dna 1:1.

Clearwater robi bardzo ładne proceduralne pebbles/seabed w shaderze. ([GitHub][6])

Ale u nas:

```text
terrain
   ↓
heightmap
   ↓
PBR materials
```

i materiał zależny od:

```text
depth
slope
noise
distance from shore
```

np.:

```text
0.0–0.5m   → sand
0.5–1.5m   → sand + rocks
1.5–3m     → darker sand
3m+        → rock
```

A Clearwaterowy shading i caustics na tym położymy.

---

# 18. Roślinność

Trzy poziomy:

```text
NEAR
    high-poly palm
    high-poly rocks

MID
    instanced vegetation

FAR
    billboard / impostor
```

Three.js ma bardzo dobre wsparcie dla GLTF i nowoczesnych rozszerzeń glTF, w tym meshopt, Basis/KTX2 itd. ([Three.js][7])

Do asset pipeline:

```text
source asset
     ↓
Blender
     ↓
GLB
     ↓
meshopt
     ↓
KTX2 textures
```

To powinno znacząco ograniczyć rozmiar pobieranych danych.

---

# 19. Światło i dzień/noc

Tutaj Three.js ma już gotowy `Sky`, oparty o analityczny model Preethama. Dla `WebGLRenderer` używasz `Sky`; wariant `SkyMesh` jest dla WebGPU. ([Three.js][8])

Zrobiłbym:

```text
GameTime
    │
    ├── sun azimuth
    ├── sun elevation
    ├── sun color
    ├── sun intensity
    ├── sky
    ├── fog
    ├── water absorption
    └── environment
```

np.:

```text
05:30 sunrise
08:00 morning
12:00 noon
17:00 golden hour
19:30 sunset
22:00 night
```

I **nie zmieniałbym tylko koloru directional light**.

Zmienia się cały system.

---

# 20. HDR / exposure / tone mapping

Clearwater ma własny HDR pipeline i ACES-like final mapping. ([GitHub][6])

W Three.js wykorzystałbym:

```text
HDR render target
       ↓
tone mapping
       ↓
bloom
       ↓
color grading
       ↓
vignette
```

Three.js ma obecnie więcej możliwości tone mappingu niż tylko ACES, więc można eksperymentować pod konkretne lighting conditions. ([Three.js][9])

---

# 21. Lens glare z Clearwatera?

**Tak, ale dopiero na końcu.**

To jest bardzo fajny bajer:

```text
sun
 ↓
water glints
 ↓
lens diffraction
 ↓
tiny spectral flare
```

Clearwater robi nawet FFT convolution dla tego efektu. 

Ale:

```text
water      ██████████  ważne
lighting   ██████████  ważne
reflection ██████████  ważne
caustics   ████████    ważne
glare      ██          później
```

Nie pozwoliłbym, żeby efekt lens flare zjadł budżet GPU zanim mamy dobrą wodę.

---

# 22. Finalna struktura repo

Zrobiłbym mniej więcej:

```text
lagoon-sailing/
│
├── src/
│   ├── main.ts
│   │
│   ├── core/
│   │   ├── Game.ts
│   │   ├── Time.ts
│   │   └── Config.ts
│   │
│   ├── render/
│   │   ├── Renderer.ts
│   │   ├── SceneRenderer.ts
│   │   ├── ReflectionRenderer.ts
│   │   ├── RefractionRenderer.ts
│   │   ├── PostProcessor.ts
│   │   │
│   │   └── water/
│   │       ├── LagoonWater.ts
│   │       ├── Spectrum.ts
│   │       ├── FFT.ts
│   │       ├── Ripples.ts
│   │       ├── Caustics.ts
│   │       ├── WaterMaterial.ts
│   │       ├── water.vert.glsl
│   │       ├── water.frag.glsl
│   │       └── common.glsl
│   │
│   ├── physics/
│   │   ├── PhysicsWorld.ts
│   │   ├── BoatPhysics.ts
│   │   ├── Buoyancy.ts
│   │   ├── SailingPhysics.ts
│   │   ├── Rudder.ts
│   │   └── SailCloth.ts
│   │
│   ├── world/
│   │   ├── Lagoon.ts
│   │   ├── Terrain.ts
│   │   ├── Islands.ts
│   │   ├── Vegetation.ts
│   │   └── Rocks.ts
│   │
│   ├── environment/
│   │   ├── Sun.ts
│   │   ├── Sky.ts
│   │   ├── Weather.ts
│   │   └── Wind.ts
│   │
│   ├── boat/
│   │   ├── Boat.ts
│   │   ├── Sail.ts
│   │   └── Wake.ts
│   │
│   ├── camera/
│   │   ├── SailingCamera.ts
│   │   └── CameraShake.ts
│   │
│   └── debug/
│       ├── DebugUI.ts
│       └── DebugDraw.ts
│
├── public/
│   ├── assets/
│   │   ├── boats/
│   │   ├── terrain/
│   │   ├── vegetation/
│   │   ├── rocks/
│   │   ├── textures/
│   │   └── hdr/
│   │
│   └── fonts/
│
├── tools/
│   ├── optimize-assets.ts
│   └── ...
│
├── package.json
├── tsconfig.json
├── vite.config.ts
└── README.md
```

---

# 23. Minimalny stack

Ja bym zaczął wręcz absurdalnie mało:

```json
{
  "dependencies": {
    "three": "...",
    "jolt-physics": "..."
  },
  "devDependencies": {
    "typescript": "...",
    "vite": "..."
  }
}
```

I tyle.

Nie brałbym od razu:

```text
React
Vue
Redux
ECS framework
game engine
UI framework
```

To nie jest aplikacja webowa.

Canvas:

```text
<body>
  <canvas id="game"></canvas>
</body>
```

a reszta jest Three.js.

---

# 24. Vite

Vite jest tutaj tylko build toolchainem:

```text
src/
  ↓
vite build
  ↓
dist/
  ├── index.html
  ├── assets/
  ├── *.js
  └── *.wasm
```

I hosting:

```text
GitHub Pages
Cloudflare Pages
S3
Netlify
Vercel
```

bez backendu.

To jest dokładnie model, który chciałeś osiągnąć.

---

# 25. Jedna ważna rzecz dotycząca Clearwatera

Jest MIT:

```text
MIT License
Copyright (c) 2026 Lumaris
```

i licencja jawnie pozwala m.in. używać, modyfikować i dystrybuować kod. 

Czyli możemy go **legalnie forkować / adaptować do naszego water engine**, ale zachowałbym:

```text
src/render/water/clearwater/
    LICENSE
    NOTICE.md
```

i informację w README, że część implementacji pochodzi z Clearwatera.

To również bardzo dobrze pasuje do tego projektu, bo autor sam napisał implementację jako łatwy do czytania, samodzielny kod GLSL/JS. ([GitHub][10])

---

# 26. Etapy implementacji

I tutaj zrobiłbym **bardzo konkretny roadmap**.

## Milestone 0 — "czy w ogóle potrafimy zrobić taką wodę?"

Tylko:

```text
Three.js
WebGL2
Clearwater
camera
sun
water
```

Zero:

* łódki
* świata
* fizyki
* assetów

Cel:

> Clearwater wygląda tak samo lub lepiej, ale jest już subsystemem Three.js.

### Definition of done

```text
npm run dev
↓
browser
↓
fotorealistyczna woda
↓
drag camera
↓
sun
↓
ripples
↓
caustics
```

---

# 27. Milestone 1 — prawdziwa scena

Dodajemy:

```text
terrain
islands
rocks
sand
sky
sun
fog
```

i integrowany water pass.

Cel:

```text
                    SKY
             ╭──────────────╮

      🪨     ~~~~~~~~~~~~~~~     🪨
             ~~~ water ~~~
                  ⛵
             ~~~~~~~~~~~~~~~
          sand / rocks below
```

To będzie **najważniejszy milestone całego projektu**.

---

# 28. Milestone 2 — łódka

Najpierw zwykły GLB.

```text
boat
 ↓
scene
 ↓
camera follows boat
```

Bez fizyki.

Chcemy zobaczyć:

```text
⛵
~~~~~~
~~~~~~~~~~~~
```

i sprawdzić:

* skala
* materiały
* reflection
* shadow
* wake placeholder
* camera.

---

# 29. Milestone 3 — rigid body + buoyancy

Dodajemy Jolt.

Najpierw:

```text
box floating
```

potem:

```text
hull
```

potem 8 punktów buoyancy.

Acceptance:

```text
boat stationary
      ↓
waves
      ↓
boat naturally rocks
```

Nie sterujemy jeszcze żaglem.

---

# 30. Milestone 4 — sailing

Dodajemy:

```text
wind
   ↓
apparent wind
   ↓
sail force
   ↓
keel
   ↓
boat velocity
```

UI debug:

```text
WIND
→→→→→→

TRUE WIND      12 kt
APPARENT       17 kt
AWA            38°
SAIL ANGLE     32°
HEEL            8°
SPEED           6 kt
```

To będzie bardzo przydatne.

---

# 31. Milestone 5 — prawdziwy żagiel

Najpierw:

```text
shader cloth
```

potem:

```text
optional Jolt softbody
```

i wizualnie:

```text
       /\
      /  \
     /    \
    /      \
~~~⛵~~~~~~~~
```

Żagiel powinien reagować na:

```text
wind
+
boat velocity
+
sail trim
```

---

# 32. Milestone 6 — wake

Tutaj:

```text
water
+
boat
+
speed
```

zaczyna wyglądać jak faktycznie płynąca łódka.

Dodajemy:

* stern wake
* bow foam
* turning wake
* acceleration wake

---

# 33. Milestone 7 — prawdziwe światło

Dodajemy:

```text
sunrise
morning
noon
golden hour
sunset
night
```

i dopiero wtedy zobaczymy, czy rendering rzeczywiście jest "fotorealistyczny".

---

# 34. Milestone 8 — underwater

To będzie bardzo fajne.

Kamera:

```text
        ⛵
~~~~~~~~~~~~── surface
     ↓
     ↓ CAMERA
```

Dodajemy:

* fog underwater
* absorption
* scattering
* caustics
* particles
* seabed
* bubbles
* surface view from below.

Clearwater daje nam sporą część matematyki tego efektu. 

---

# 35. Milestone 9 — weather

Dopiero tutaj.

```text
calm
 ↓
light breeze
 ↓
gusty
 ↓
cloudy
 ↓
rain
```

Wind system steruje:

```text
sailing
water
sail
trees
particles
audio
```

Jedno źródło prawdy.

---

# 36. Milestone 10 — performance

Zrobiłbym przynajmniej trzy profile:

### HIGH

```text
FFT 512
caustics 1024
reflection 1024
SSAO
bloom
glare
```

### MEDIUM

```text
FFT 256
caustics 512
reflection 512
bloom
```

### LOW

```text
FFT 128
caustics off
reflection 256
no glare
```

Clearwater już ma **adaptive resolution**, więc ten pomysł można częściowo zapożyczyć. ([GitHub][6])

---

# 37. Performance architecture

Bardzo pilnowałbym budżetu GPU.

Orientacyjnie:

```text
Frame 16.6 ms @ 60 FPS
─────────────────────────────
scene             ~4 ms
reflection        ~2 ms
water             ~3 ms
caustics          ~2 ms
post              ~2 ms
misc              ~2 ms
─────────────────────────────
                    15 ms
```

To nie są obietnice — bardziej **budżet projektowy**, który potem zmierzymy.

---

# 38. Adaptive quality

System:

```text
GPU frame time
     ↓
  controller
     ↓
 ┌───┴──────────────┐
 ↓                  ↓
quality up       quality down
```

np.:

```text
< 13ms
    quality +=

> 18ms
    quality -=
```

I zmieniamy:

```text
resolution scale
FFT size
reflection resolution
caustics resolution
postprocess quality
vegetation LOD
```

---

# 39. Debug mode

Bez tego projekt zacznie być koszmarem.

Chciałbym mieć:

```text
[F1] Debug
```

i:

```text
FPS
GPU-ish timing
water quality
FFT size
boat speed
wind
heel
depth
camera position
```

plus przełączniki:

```text
[ ] water
[ ] normals
[ ] reflection
[ ] refraction
[ ] caustics
[ ] depth
[ ] shadow
[ ] wake
[ ] physics
[ ] sail cloth
```

I bardzo ważne:

```text
water → normal
water → caustic
water → reflection
water → final
```

tak jak Clearwater ma debugowe widoki, np. bezpośredni podgląd caustics. 

---

# 40. Co z gotową łodzią?

Tutaj workflow:

```text
Fab / Sketchfab / Marketplace
              ↓
             GLB
              ↓
           Blender
              ↓
   ┌──────────┼──────────┐
   ↓          ↓          ↓
 Hull       Rig       Sail mesh
   │          │          │
 Jolt       joints    custom cloth
```

Three `GLTFLoader` obsługuje obecnie m.in. Meshopt, Draco, KTX2/Basis i inne rozszerzenia glTF. ([Three.js][7])

Czyli **nie przywiązywałbym fizyki do konkretnego assetu**.

---

# 41. Jeszcze jedna decyzja: nie używałbym ECS

Przy tej grze nie widzę potrzeby.

Nie będziesz miał:

```text
10 000 entities
```

tylko raczej:

```text
1 boat
5 islands
200 rocks
1000 vegetation instances
```

Wystarczy klasyczna architektura:

```text
Boat
Lagoon
Water
Weather
World
Physics
Camera
```

Dużo przyjemniejsza do dłubania.

---

# 42. A co z WebAssembly?

Dokładnie tak:

```text
TypeScript
   │
   ├── gameplay
   ├── world
   ├── sailing
   └── renderer orchestration
          │
          ▼
        Three.js
          │
          ▼
        WebGL2

WASM
  │
  ▼
Jolt Physics
```

Nie pisałbym gameplayu w WASM.

WASM jest tutaj **narzędziem do ciężkich obliczeń**, nie platformą całej gry.

---

# 43. Najważniejsza rzecz, którą zrobiłbym jako pierwszą

Naprawdę nie zacząłbym od łódki.

Zrobiłbym repo:

```text
lagoon/
```

i pierwszy eksperyment:

```text
Three.js
    +
Clearwater FFT
    +
Clearwater caustics
    +
Clearwater water shader
    +
Three sky
    +
Three camera
```

A potem:

```text
                    sun
                     ☀
                 reflection
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
 ~~~~~~~ ~~~~~~~~~~~~~ ~~~~~~~~
            test object
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
         caustics below
```

I doprowadziłbym **ten jeden kadr** do poziomu:

> „To wygląda jak zdjęcie, a nie jak demo WebGL”.

Dopiero wtedy dokładamy fizykę.

---

# 44. Mój ostateczny wybór technologii

| Obszar          | Wybór                                  |
| --------------- | -------------------------------------- |
| Language        | **TypeScript**                         |
| 3D              | **Three.js**                           |
| Renderer v1     | **WebGL2**                             |
| Water           | **Clearwater-derived custom renderer** |
| FFT             | Clearwater GPU FFT                     |
| Ripples         | Clearwater GPU simulation              |
| Caustics        | Clearwater GPU caustics                |
| Reflection      | Three custom planar reflection         |
| Refraction      | custom water pass                      |
| Physics         | **JoltPhysics.js / WASM**              |
| Boat buoyancy   | custom +/lub Jolt buoyancy             |
| Sailing physics | **własny model**                       |
| Sail cloth v1   | GPU deformation                        |
| Sail cloth v2   | Jolt soft body                         |
| Sky             | Three.js Sky                           |
| Assets          | GLB/glTF                               |
| Textures        | KTX2/Basis                             |
| Build           | **Vite**                               |
| Deploy          | static hosting                         |
| UI              | zwykły HTML/CSS                        |
| Framework       | **żaden**                              |
| ECS             | **żaden**                              |
| Backend         | **żaden**                              |

---

## I jedna rzecz jest szczególnie obiecująca

Clearwater ma zaledwie około **900 linii źródłowych**, a cały renderer jest podzielony bardzo czytelnie na: FFT → ripples → caustics → water shader → postprocessing → kamera. ([GitHub][10])

To oznacza, że zamiast budować wodę od zera mamy już **bardzo konkretny, działający eksperymentalny renderer, który możemy potraktować jako bazę matematyczną**.

Ja bym więc nie robił:

```text
Three.js Water.js
        ↓
modyfikowanie kilku uniformów
        ↓
"hopefully photorealistic"
```

tylko:

```text
Clearwater
   ↓
extract algorithms
   ↓
Three.js Water subsystem
   ↓
real 3D scene
   ↓
boat physics
   ↓
sailing
```

To daje nam dużo większą szansę na osiągnięcie **dokładnie tego specyficznego, "krystalicznego, lagunowego" wyglądu**, zamiast kolejnej standardowej niebieskiej wody z shaderem.

### Następny praktyczny krok

Najlepszym kolejnym ruchem byłoby zrobienie **Milestone 0 jako konkretnego startera repo**: `package.json`, Vite, TypeScript, Three.js WebGL2, struktura modułów i pierwszy port Clearwater FFT/ripples/caustics do `src/render/water/`. Mogę też od razu rozpisać **dokładny przepływ renderowania klatki (`scene → depth → reflection → caustics → water → post`) wraz z pseudokodem każdej klasy**.

[1]: https://threejs.org/manual/pages/webgpurenderer?utm_source=chatgpt.com "WebGPURenderer"
[2]: https://github.com/jrouwe/JoltPhysics.js/?utm_source=chatgpt.com "GitHub - jrouwe/JoltPhysics.js: Port of JoltPhysics to JavaScript using emscripten · GitHub"
[3]: https://jrouwe.github.io/JoltPhysics/class_body.html?utm_source=chatgpt.com "Jolt Physics: Body Class Reference"
[4]: https://rapier.rs/docs/user_guides/javascript/getting_started_js/?utm_source=chatgpt.com "Getting started | Rapier"
[5]: https://github.com/jrouwe/JoltPhysics/blob/master/Docs/Architecture.md?utm_source=chatgpt.com "JoltPhysics/Docs/Architecture.md at master · jrouwe/JoltPhysics · GitHub"
[6]: https://github.com/Aureliengmz/clearwater/blob/main/index.html "clearwater/index.html at main · Aureliengmz/clearwater · GitHub"
[7]: https://threejs.org/docs/pages/GLTFLoader.html?utm_source=chatgpt.com "GLTFLoader - Three.js Docs"
[8]: https://threejs.org/docs/pages/Sky.html?utm_source=chatgpt.com "Sky - Three.js Docs"
[9]: https://threejs.org/docs/pages/WebGLRenderer.html?utm_source=chatgpt.com "WebGLRenderer - Three.js Docs"
[10]: https://github.com/Aureliengmz/clearwater "GitHub - Aureliengmz/clearwater: Real-time, photoreal shallow water in a single HTML file. WebGL2, no libraries, no build step. · GitHub"

