Tak. Po sprawdzeniu repozytorium Clearwater dokładniej, zrobiłbym z tego **świadomie etapowy projekt technologiczno-growy**, a nie od razu „budowę gry”. Clearwater jest wyjątkowo dobrym punktem startowym, bo rzeczywiście jest samodzielnym WebGL2 rendererem, bez zależności i build stepu, a README dokładnie wskazuje osobne komponenty: FFT, ripples, caustics, główny shader wody, postprocessing i adaptive quality. ([GitHub][1])

Przy okazji jedna korekta do wcześniejszej odpowiedzi: **nie kopiowałbym Clearwatera bezpośrednio jako monolitycznego `index.html`**, tylko potraktował go jako referencyjny kod, z którego budujemy własny `WaterRenderer`. Jego kod jest bardzo dobrze podzielony logicznie mimo single-file formy. 

# Docelowy rezultat

Za „grywalne demo” przyjąłbym mniej więcej taki zakres:

```text
                         ☀
                    sky / clouds
                         │
             ┌───────────┴───────────┐
             │                       │
         island                  island
       ███████                  ███████
       █     █~~~~~~~~~~~~~~~~~~█     █
             ~~~~~~~ ⛵ ~~~~~~~~~
             ~~~~~~~~~~~~~~~~~~~~
                  lagoon
             🪨             🪸

                  ↓
              player boat
```

Gracz:

```text
W / S      throttle / trim
A / D      steering
Q / E      sail trim
mouse      camera
Space      tack/gybe / sail action
Esc        menu
```

i może:

* wypłynąć z małego portu,
* żeglować po lagunie,
* zmieniać kurs względem wiatru,
* obserwować przechył łódki,
* opływać wyspy i skały,
* podpływać do oznaczonych miejsc,
* doświadczyć wake, fal i odbić,
* przejść przez różne pory dnia,
* wejść pod wodę,
* wrócić do portu.

Czyli nie robimy jeszcze „Sea of Thieves”. **Robimy jedną bardzo małą, ale absurdalnie dobrze wyglądającą lagunę.**

---

# Architektura końcowa

Docelowo:

```text
Browser
│
├── TypeScript
│   │
│   ├── Game
│   ├── Input
│   ├── World
│   ├── Boat
│   ├── Sailing
│   ├── Weather
│   └── UI
│
├── Three.js
│   │
│   ├── Scene
│   ├── Camera
│   ├── GLTF
│   ├── Lighting
│   └── WebGL2
│
├── Water Renderer
│   │
│   ├── FFT spectrum
│   ├── Ripples
│   ├── Caustics
│   ├── Reflection
│   ├── Refraction
│   ├── Depth absorption
│   ├── Foam
│   └── Underwater
│
└── JoltPhysics.js
    │
    └── WASM
```

Three.js `WebGLRenderer` działa na WebGL2, a jego klasyczne materiały/shadery są właśnie tym, co chcemy tutaj wykorzystać. ([Three.js][2])

---

# MILESTONE 0 — Rendering laboratory

To jest **najbardziej szczegółowo zaplanowany etap**, bo tutaj decydujemy, czy cały projekt ma sens.

## Cel

Doprowadzić do sytuacji:

```text
Vite
  ↓
Three.js
  ↓
WebGL2
  ↓
Clearwater-derived WaterRenderer
  ↓
piękna woda
```

bez fizyki i gameplayu.

---

## 0.1 — repo

```text
lagoon-sailing/
├── src/
├── public/
├── package.json
├── tsconfig.json
├── vite.config.ts
└── README.md
```

Instalujemy:

```bash
npm install three
npm install -D vite typescript
```

Jeszcze:

```text
NO React
NO Vue
NO ECS
NO physics
NO UI framework
```

---

## 0.2 — bootstrap Three.js

Pierwszy działający program:

```ts
const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: 'high-performance'
});

renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(
    60,
    innerWidth / innerHeight,
    0.1,
    5000
);
```

I:

```text
<body>
  canvas
</body>
```

Zero frameworka UI.

---

# 0.3 — WebGL capability check

Clearwater wymaga WebGL2 oraz `EXT_color_buffer_float`. Jego README wprost deklaruje to wymaganie i adaptive resolution. ([GitHub][1])

Robimy:

```ts
const gl = renderer.getContext();

gl.getExtension('EXT_color_buffer_float');
```

i własny:

```ts
Capabilities.ts
```

np.:

```ts
interface GpuCapabilities {
    webgl2: boolean;
    floatColorBuffer: boolean;
    maxTextureSize: number;
    maxSamples: number;
}
```

Na starcie pokazujemy sensowny error, jeśli sprzęt nie daje rady.

---

# 0.4 — przeniesienie Clearwatera

**Tu nie przepisujemy wszystkiego naraz.**

Najpierw robimy:

```text
clearwater-original/
```

jako osobny reference branch / directory.

Następnie:

```text
src/render/water/
├── WaterRenderer.ts
├── WaterSpectrum.ts
├── WaterFFT.ts
├── Ripples.ts
├── Caustics.ts
├── WaterMaterial.ts
├── WaterGeometry.ts
└── shaders/
    ├── fullscreen.vert.glsl
    ├── spectrum.frag.glsl
    ├── fft.frag.glsl
    ├── resolve.frag.glsl
    ├── ripple.frag.glsl
    ├── caustics.vert.glsl
    ├── caustics.frag.glsl
    └── water.frag.glsl
```

---

# 0.5 — najpierw FFT

Clearwater ma:

```text
H0 texture
   ↓
spectrum evolution
   ↓
horizontal FFT
   ↓
vertical FFT
   ↓
resolve
   ↓
surface texture
```

Dokładnie tak działa jego kod. 

Nie upraszczamy tego na dzień dobry.

Robimy:

```ts
class WaterSpectrum {
    readonly heightSlopeTexture: THREE.Texture;

    update(time: number): void;
}
```

I debugowy ekran:

```text
[F1] FFT
```

pokazuje:

```text
HEIGHT
████████████████
████▒▒▒▒████████
```

---

# 0.6 — osobna symulacja ripple

Clearwater ma drugi lokalny buffer:

```text
RN = 256
RSIZE = 7m
```

i rozwiązuje falę w lokalnym obszarze. 

Chcemy:

```ts
class RippleSimulation {
    update(dt: number): void;

    disturb(
        worldPosition: THREE.Vector2,
        strength: number,
        radius: number
    ): void;
}
```

Na tym etapie:

```text
mouse click on water
          ↓
       ripple
```

Tak jak w oryginalnym demo.

---

# 0.7 — caustics

Kopiujemy koncepcję:

```text
water normal
     ↓
Snell/refraction
     ↓
intersection with seabed
     ↓
density accumulation
     ↓
caustic texture
```

Clearwater robi nawet osobne kanały dla różnych współczynników załamania, żeby uzyskać chromatic dispersion. 

Na tym etapie:

```text
F2
↓
RAW CAUSTICS
```

Musimy zobaczyć, że działa niezależnie od głównego water shadera.

---

# 0.8 — główny water shader

Tu zaczynamy przenosić najbardziej wartościową część Clearwatera.

W szczególności:

```text
FFT surface
+
ripple displacement
+
normal reconstruction
+
Fresnel
+
reflection
+
refraction
+
absorption
+
sun glints
```

Clearwater rzeczywiście robi fixed-point intersection z powierzchnią wody, łączy dwa skalowane pola fal i lokalne ripples, po czym z tego wylicza normalną. 

Nie zmieniałbym tej matematyki dopóki nie mamy powodu.

---

# 0.9 — seabed

Na początek:

```text
infinite shallow plane
```

z prostym materiałem piasku.

Potem dopiero przenosimy charakterystyczne pebble shading z Clearwatera. Jego shader robi kilka skal tekstury kamyków, miesza je z proceduralnym piaskiem i dodaje większoskalowe wariacje dna. 

---

# 0.10 — sky

Three.js `Sky`.

Plus:

```text
Sun
```

którego pozycja steruje jednocześnie:

```text
sky
sunlight
water glints
caustics
```

---

# 0.11 — postprocessing

Three.js `EffectComposer` jest dostępny właśnie dla `WebGLRenderer`, więc tutaj możemy użyć jego klasycznego pipeline'u. ([Three.js][3])

Na start:

```text
HDR scene
 ↓
bloom
 ↓
tone mapping
 ↓
output
```

A dopiero później:

```text
chromatic aberration
vignette
grain
lens diffraction
```

Clearwater ma już własny końcowy pass z ACES, lekką aberracją chromatyczną, bloom, vignette i grain. 

Lens diffraction zostawiłbym na sam koniec M0 — to fajny efekt, ale nie jest istotny dla podstawowej wiarygodności wody. Sam Clearwater implementuje go jako dodatkowy FFT-based convolution pass. 

---

# 0.12 — debug UI

Od razu:

```text
F1  debug
F2  water
F3  normals
F4  caustics
F5  reflection
F6  depth
F7  ripples
```

oraz:

```text
FPS
resolution
FFT size
ripple resolution
water quality
```

Clearwater już ma tryby debug oraz adaptive quality, więc zdecydowanie warto zachować ten sposób myślenia. ([GitHub][1])

---

# Definition of Done — Milestone 0

Chcemy otrzymać:

```text
                    ☀

~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
~~~~~~~~~~ beautiful water ~~~~~~~~~~~~~
~~~~~~ reflections / glints ~~~~~~~~~~~~
~~~~~~~~~~~~~~~▒▒▒▒~~~~~~~~~~~~~~~~~~~~~
          caustics below
```

i:

* 60 FPS na rozsądnym sprzęcie,
* interaktywne ripples,
* przesuwający się sun,
* reflection/refraction,
* caustics,
* HDR/tone mapping,
* debug modes,
* adaptive resolution.

**Żadnej łódki.**

Jeżeli M0 wygląda słabo, nie przechodzimy dalej.

---

# MILESTONE 1 — prawdziwy lagoon world

Teraz przestajemy być demem wodnym.

## World

Tworzymy:

```text
250 × 250 m
```

na początek.

```text
             island
          ███████████
       ███           ███

   ███                    ███
        ~~~~~~~~~~~~~~~
      ~~~~~ lagoon ~~~~~
            ⛵
      ~~~~~~~~~~~~~~~
   ███                    ███
```

### Elementy

* seabed terrain
* 2–3 wyspy
* beach
* rocks
* shallow zones
* deep zone
* kilka palm / roślin
* mała przystań

---

## Terrain

Nie proceduralny noise jako final.

Robimy:

```text
heightmap
   ↓
terrain mesh
   ↓
PBR material
```

i depth texture / height lookup:

```ts
terrain.getHeight(x, z)
```

oraz:

```ts
water.getDepth(x, z)
```

---

# MILESTONE 2 — pierwszy boat asset

Kupujemy / pobieramy jeden konkretny model łodzi.

Idealnie:

```text
GLB
```

Three.js `GLTFLoader` daje nam naturalny pipeline dla glTF/GLB, a później możemy użyć Meshopt/KTX2 do optymalizacji assetów. ([Three.js][4])

Robimy:

```text
Boat.glb
 ├── Hull
 ├── Mast
 ├── Boom
 ├── Rudder
 ├── Keel
 └── Sail
```

Na tym etapie żagiel może być zwyczajnym mesh'em.

Łódka **stoi na wodzie**.

---

# MILESTONE 3 — kamera + sterowanie łodzią

Najpierw fake physics.

Sterowanie:

```text
W        forward
S        reverse/brake
A        rudder left
D        rudder right
Q        sail in
E        sail out
mouse    camera
```

Kamera:

```text
             camera
                ╲
                 ╲
                  ⛵
```

z:

* smoothing,
* collision avoidance,
* camera shake,
* underwater transition.

Chodzi o to, żeby już wtedy **fajnie się nią pływało**, nawet bez prawdziwej fizyki.

---

# MILESTONE 4 — JoltPhysics

Tutaj dopiero dokładamy WASM.

JoltPhysics.js jest dystrybuowany jako npm ESM, ma warianty WASM z osobnym plikiem albo embedded i ma niemal całe API Jolt dostępne w JavaScript. ([GitHub][5])

Do pierwszego static deploy użyłbym:

```text
jolt-physics/wasm-compat
```

bo WASM jest wtedy embedded w bundle i nie musimy kombinować z osobnym assetem. W wersji produkcyjnej można później przejść na wariant z osobnym `.wasm`, jeśli rozmiar bundle'a będzie problemem. ([GitHub][5])

---

# MILESTONE 5 — buoyancy

I tu robi się ciekawie.

Nie:

```text
boat = box
```

tylko:

```text
         ●────●────●
         │         │
         │  HULL   │
         │         │
         ●────●────●

        6–8 points
```

Każdy punkt:

```text
world position
      ↓
water height
      ↓
submerged depth
      ↓
buoyancy force
      ↓
drag
```

Jolt ma już API do stosowania impulsu buoyancy/drag oraz osobne przykłady water buoyancy. ([GitHub][6])

Ale u nas zrobiłbym **własny wielopunktowy model**, bo będziemy dokładniej kontrolować zachowanie łódki.

### Definition of Done

Łódka stojąca na falach:

```text
~~~~~~╱╲~~~~~~
      ⛵
~~~~~~╲╱~~~~~~
```

lekko:

* przechyla się,
* podnosi dziób,
* opada,
* reaguje na większą falę.

To ma wyglądać naturalnie nawet przy wyłączonym napędzie.

---

# MILESTONE 6 — sailing physics

Teraz z samej łódki robimy **żaglówkę**.

## Wind

```ts
interface Wind {
    direction: number;
    speed: number;
    gustiness: number;
}
```

## Apparent wind

```text
true wind
    ↓
boat velocity
    ↓
apparent wind
```

## Sail forces

```text
                 apparent wind
                       ↘
                        \
                         \
                       sail
                         \
                          \
                           ⛵
```

Liczymy:

```text
angle of attack
CL
CD
lift
drag
```

w zależności od:

```text
sail angle
wind speed
boat speed
wind angle
```

Dalej:

```text
sail force
    ↓
boat force
    ↓
boat velocity
```

---

# MILESTONE 7 — keel + rudder + heel

Dodajemy:

```text
keel
rudder
heel torque
```

W rezultacie:

```text
    wind →
          
       ⛵
      /|
     / |
    /  |
```

łódka zaczyna rzeczywiście zachowywać się jak żaglówka, a nie łódź motorowa z kawałkiem płótna.

Debugujemy:

```text
WIND             12 kt
APPARENT WIND    16 kt
AWA              42°
SAIL             35°
HEEL              7°
BOAT SPEED        5.8 kt
```

---

# MILESTONE 8 — sail deformation

Najpierw **nie robimy cloth physics**.

Robimy:

```text
sail mesh
    ↓
vertex shader
    ↓
wind deformation
```

Żagiel ma reagować na:

```text
wind
apparent wind
sail trim
boat velocity
```

To będzie tanie i już powinno wyglądać świetnie.

---

# MILESTONE 9 — wake + boat/water interaction

Teraz zacznie się magia.

Łódź generuje:

```text
bow wave
stern wake
turning wake
foam
```

oraz:

```text
boat
 ↓
local ripple disturbances
 ↓
Clearwater ripple simulation
```

Czyli:

```text
                 ⛵
                /  \
               /    \
~~~~~~~~~~~~~~/~~~~~~\~~~~~~~~~~~~
          ~~~~~     ~~~~~
       ~~~~~             ~~~~~
```

Nie potrzebujemy pełnego CFD.

---

# MILESTONE 10 — reflection of the actual world

Do tej pory woda może odbijać głównie niebo.

Teraz:

```text
reflection camera
       ↓
scene
       ↓
reflection texture
       ↓
water
```

Odbijamy:

* wyspy,
* skały,
* łódkę,
* roślinność.

To jest jeden z największych skoków wizualnych projektu.

---

# MILESTONE 11 — proper seabed + underwater

Teraz:

```text
camera
  ↓
surface
~~~~~~~~~~~~~~
  ↓
  ↓
  ↓
seabed
```

Dodajemy:

* absorption,
* underwater fog,
* scattering,
* caustics,
* sand,
* rocks,
* particles,
* bubbles,
* underwater color grading.

Clearwater już ma sporą część matematyki potrzebnej do tego: refrakcję, odszukiwanie dna, absorption/scattering i shading dna. 

---

# MILESTONE 12 — day/night cycle

Jeden:

```ts
GameTime
```

steruje:

```text
Sun
Sky
Lighting
Fog
Water
Caustics
Exposure
```

Schemat:

```text
05:30  sunrise
08:00  morning
12:00  noon
17:00  golden hour
19:30  sunset
22:00  night
```

Nie potrzebujemy jeszcze realistycznej astronomii. Ważniejsza jest spójność wizualna.

---

# MILESTONE 13 — weather + wind

Tu dopiero robimy pogodę.

```text
CALM
 ↓
BREEZE
 ↓
WINDY
 ↓
CLOUDY
 ↓
RAIN
```

Jedno źródło wiatru zasila:

```text
             Wind
               │
      ┌────────┼────────┐
      ↓        ↓        ↓
    sail     water     trees
      │        │        │
      └────────┼────────┘
               ↓
             audio
```

Nie chcemy sytuacji, w której żagiel pokazuje 5 m/s, drzewa 12 m/s, a woda zachowuje się jak przy 3 m/s.

---

# MILESTONE 14 — gameplay loop

Teraz dopiero robimy z technologicznego demo **grę**.

Minimalny scenariusz:

```text
                 START
                   │
                   ▼
               [HARBOR]
                   │
                   ▼
              explore lagoon
                   │
        ┌──────────┼───────────┐
        ▼          ▼           ▼
      buoy       island      hidden bay
        │
        └──────────┬───────────┘
                   ▼
              return harbor
                   │
                   ▼
                  END
```

Np. trzy proste cele:

```text
○ Visit Lighthouse
○ Reach Hidden Cove
○ Return before sunset
```

Nie potrzebujemy jeszcze inventory, NPC, quest engine itd.

---

# MILESTONE 15 — world polish

Dopiero teraz:

### Near

```text
high-poly
```

### Medium

```text
instancing
```

### Far

```text
LOD / impostors
```

Do tego:

* palmy,
* trawy,
* skały,
* driftwood,
* boje,
* pomost,
* łódki w porcie,
* ptaki.

---

# MILESTONE 16 — audio

Bardzo późno, ale warto.

Warstwy:

```text
wind
water
boat hull
rope
sail
birds
distant ambience
```

i parametryzacja:

```text
volume = f(windSpeed, boatSpeed, cameraDistance)
```

Audio będzie prawdopodobnie jednym z najtańszych sposobów podbicia immersji.

---

# MILESTONE 17 — performance

Dopiero kiedy wszystko działa.

### Quality levels

```text
ULTRA
HIGH
MEDIUM
LOW
```

Sterujemy:

```text
render resolution
FFT resolution
reflection resolution
caustics resolution
shadow resolution
vegetation density
postprocessing
```

Clearwater już posiada adaptive resolution, więc możemy skorzystać z tej samej idei. ([GitHub][1])

### Asset compression

```text
GLB
 +
Meshopt
 +
KTX2/Basis
```

Three.js `KTX2Loader` pozwala transkodować Basis Universal do odpowiednich GPU-compressed texture formats, a sam loader korzysta z WASM. ([Three.js][4])

---

# MILESTONE 18 — sail cloth v2

Dopiero teraz rozważałbym Jolt Soft Body.

Jolt ma pełne wsparcie soft bodies, a jego dokumentacja wymienia wprost cloth jako zastosowanie; obecna wersja JS wystawia też soft-body klasy API. ([GitHub][7])

Wtedy:

```text
             mast
              │
              │\
              │ \
              │  \
              │   \
              │    \
              │     \
              │      \
```

żagiel rzeczywiście ugina się i trzepocze.

Ale gameplayowa siła żagla nadal pochodzi z naszego:

```text
SailingPhysics
```

a nie z cloth simulation.

To bardzo ważne rozdzielenie.

---

# MILESTONE 19 — final gameplay polish

Na końcu:

```text
loading screen
settings
quality selection
controls screen
pause
restart
save best time
```

plus:

```text
Photo Mode
```

I **Photo Mode** naprawdę bym rozważył jako część demo.

Bo ten projekt ma ogromny komponent „patrzcie, jak pięknie wygląda woda”.

---

# Jak podzieliłbym repo po wszystkich milestone'ach

```text
src/
├── core/
│   ├── Game.ts
│   ├── GameTime.ts
│   └── Config.ts
│
├── render/
│   ├── Renderer.ts
│   ├── SceneRenderer.ts
│   ├── ReflectionRenderer.ts
│   ├── PostProcessor.ts
│   │
│   └── water/
│       ├── WaterRenderer.ts
│       ├── Spectrum.ts
│       ├── FFT.ts
│       ├── Ripples.ts
│       ├── Caustics.ts
│       ├── Reflection.ts
│       ├── Refraction.ts
│       └── WaterMaterial.ts
│
├── physics/
│   ├── PhysicsWorld.ts
│   ├── BoatPhysics.ts
│   ├── Buoyancy.ts
│   ├── SailingPhysics.ts
│   ├── Keel.ts
│   └── Rudder.ts
│
├── boat/
│   ├── Boat.ts
│   ├── Sail.ts
│   ├── Wake.ts
│   └── BoatController.ts
│
├── world/
│   ├── Lagoon.ts
│   ├── Terrain.ts
│   ├── Island.ts
│   ├── Vegetation.ts
│   ├── Rocks.ts
│   └── Harbor.ts
│
├── environment/
│   ├── Sun.ts
│   ├── Sky.ts
│   ├── Wind.ts
│   └── Weather.ts
│
├── gameplay/
│   ├── Mission.ts
│   ├── Waypoint.ts
│   └── GameState.ts
│
├── camera/
│   ├── SailingCamera.ts
│   └── PhotoCamera.ts
│
├── input/
│   └── InputManager.ts
│
└── debug/
    ├── DebugUI.ts
    └── DebugDraw.ts
```

---

# Kolejność, którą naprawdę bym utrzymał

Najważniejsze jest, żeby **nie pomieszać kolejności technicznej z kolejnością "co byłoby fajne"**:

```text
M0  Clearwater → Three.js water
 │
 ▼
M1  lagoon world
 │
 ▼
M2  boat asset
 │
 ▼
M3  boat controls + camera
 │
 ▼
M4  Jolt
 │
 ▼
M5  buoyancy
 │
 ▼
M6  sailing physics
 │
 ▼
M7  keel/rudder/heel
 │
 ▼
M8  sail deformation
 │
 ▼
M9  wake + ripples
 │
 ▼
M10 real reflections
 │
 ▼
M11 underwater
 │
 ▼
M12 day/night
 │
 ▼
M13 weather
 │
 ▼
M14 gameplay loop
 │
 ▼
M15 world polish
 │
 ▼
M16 audio
 │
 ▼
M17 performance
 │
 ▼
M18 real cloth
 │
 ▼
M19 final polish
 │
 ▼
        🎮 PLAYABLE DEMO
```

## I ustanowiłbym cztery "gates"

Nie przechodzimy dalej tylko dlatego, że „kod działa”.

### Gate A — M0

> **Czy woda wygląda wystarczająco dobrze?**

### Gate B — M5

> **Czy łódka zachowuje się wiarygodnie na falach?**

### Gate C — M9

> **Czy naprawdę czuję, że płynę łódką?**

### Gate D — M14

> **Czy jest powód, żeby przepłynąć całą lagunę?**

Jeżeli odpowiedź na któreś z tych pytań brzmi „nie”, poprawiamy dany subsystem zamiast dorzucać kolejne ficzery.

---

# Jeszcze jedna rzecz, którą bym zmienił względem wcześniejszego planu

**Nie robiłbym od razu pełnego proceduralnego oceanu.**

Clearwater jest napisany jako **photoreal shallow water**, czyli właściwie trafia w Twój przypadek. Jego obecna implementacja ma FFT do fal, lokalne ripples, caustics z dispersion, fizyczny Fresnel, sun glints, seabed shading i adaptive quality. ([GitHub][1])

Dlatego pierwsza wersja powinna być **laguną**, a nie oceanem.

To oznacza:

```text
depth:       0–5 m
waves:       relatively gentle
wind:        moderate
bottom:      visible
water color: tropical/shallow
shore:       important
caustics:     very important
```

I to jest wręcz wymarzony przypadek dla Clearwatera.

---

# Finalny stack

Ostatecznie trzymałbym się:

```text
TypeScript
       │
       ▼
     Vite
       │
       ├───────────────┐
       ▼               ▼
   Three.js         JoltPhysics
    WebGL2             WASM
       │
       ▼
 Lagoon Water
 ┌─────┼─────────┐
 ▼     ▼         ▼
FFT  Ripples  Caustics
 │     │         │
 └─────┼─────────┘
       ▼
 Reflection / Refraction
       │
       ▼
 HDR / Post
       │
       ▼
    Browser
       │
       ▼
 Static Hosting
```

**A WebGPU zostawiłbym jako przyszły milestone M20+.** Nie dlatego, że jest zły, tylko dlatego, że Clearwater daje nam dziś bardzo dobry kod GLSL/WebGL2, a przepisywanie działającej matematyki do TSL/WGSL na początku projektu byłoby niepotrzebnym ryzykiem. Three.js nadal ma natywny WebGL2 renderer, a jego `EffectComposer` jest właśnie przeznaczony dla tego backendu. ([Three.js][2])

Najbardziej sensowny następny krok widzę jako **M0 rozbite już nie na ogólne punkty, tylko na konkretne taski programistyczne `M0.1 ... M0.15` wraz z proponowanymi klasami, interfejsami, kolejnością portowania konkretnych fragmentów `clearwater/index.html` i pierwszym szkieletem kodu**. To pozwoliłoby praktycznie zacząć repo od pierwszego commita.

[1]: https://github.com/Aureliengmz/clearwater "GitHub - Aureliengmz/clearwater: Real-time, photoreal shallow water in a single HTML file. WebGL2, no libraries, no build step. · GitHub"
[2]: https://threejs.org/docs/pages/WebGLRenderer.html?utm_source=chatgpt.com "WebGLRenderer - Three.js Docs"
[3]: https://threejs.org/docs/pages/EffectComposer.html?utm_source=chatgpt.com "EffectComposer - Three.js Docs"
[4]: https://threejs.org/docs/pages/KTX2Loader.html?utm_source=chatgpt.com "KTX2Loader - Three.js Docs"
[5]: https://github.com/jrouwe/JoltPhysics.js/?utm_source=chatgpt.com "GitHub - jrouwe/JoltPhysics.js: Port of JoltPhysics to JavaScript using emscripten · GitHub"
[6]: https://github.com/jrouwe/JoltPhysics/blob/master/Docs/Samples.md?utm_source=chatgpt.com "JoltPhysics/Docs/Samples.md at master · jrouwe/JoltPhysics · GitHub"
[7]: https://github.com/jrouwe/JoltPhysics.js/blob/main/JoltJS.h?utm_source=chatgpt.com "JoltPhysics.js/JoltJS.h at main · jrouwe/JoltPhysics.js · GitHub"

