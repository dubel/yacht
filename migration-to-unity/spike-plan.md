# Spike: laguna + statek + nasza woda w Unity

**Cel jedyny:** sprawdzić, czy nasza woda (Clearwater + Gerstner + FFT + kilwater + kaustyki) wygląda w Unity
co najmniej tak dobrze jak w three.js — porównując **zrzuty z tej samej kamery, o tej samej porze, z tym samym statkiem**.
Wszystko, co do tego nie prowadzi, jest wycięte albo zastąpione atrapą.

**Platforma:** tylko desktop (Linux, Framework 13). Bez WebGL/WebAssembly/iPada — więc wolno używać compute shaderów.

**Czas:** ~4–5 dni roboczych. Pierwsze „mięsko” (woda z optyką obok three.js) po ~2,5 dnia.

---

## Co wycinamy (świadomie)

| Obszar | W spike'u | Dlaczego można |
|---|---|---|
| Generator świata (`WorldGen.ts`, 498 linii) | **nie portujemy** — eksport gotowej mapy wysokości i kolorów z three.js | porównujemy wodę, nie generator; teren ma być *identyczny*, więc eksport jest lepszy niż port |
| Niebo, chmury, pogoda, cykl dnia | **zrzut naszego nieba do cubemapy** → skybox + reflection probe | odbicie nieba to połowa wyglądu wody; identyczne niebo = uczciwe porównanie |
| Fizyka żeglugi (`BoatPhysics.ts`, 575 linii) | **atrapa**: port `WaveField.ts` + pływanie na 4–6 punktach + prosta prędkość/skręt z klawiatury | statek ma siedzieć na tych samych falach i ciągnąć kilwater; czucie żeglugi to osobne pytanie |
| Żagle (`Sails.ts`) | statyczne z modelu | nie wpływa na wodę |
| Podwodny przebieg, cząstki, deszcz | pomijamy | kamera zostaje nad wodą |
| Audio, UI, chodzenie, Tortuga, życie | pomijamy | — |
| Buildy mobilne/web, adaptacyjna jakość | pomijamy | — |
| Czystość architektury (ADR z `architecture-migration.md`) | pomijamy — kod spike'owy, `MonoBehaviour` wprost | jeśli spike przejdzie, właściwa migracja i tak zaczyna od projektu struktury |

---

## Etap 0 — środowisko i pętla „zrzut + stan” (0,5 dnia)

- Unity Hub (AUR `unityhub`) + **Unity 6 LTS**, moduł Linux Build Support. **Logowanie/licencja Personal robisz Ty** (`! unityhub`).
- Projekt w `unity-spike/` w tym repo (URP 3D template), `.gitignore` na `Library/ Temp/ Logs/ Build/`.
- Pakiety: **URP**, **glTFast** (`com.unity.cloud.gltfast`). Nic więcej.
- `tools/unity.sh`:
  - `compile` — `Unity -batchmode -nographics -quit -projectPath unity-spike -logFile -` (błędy kompilacji na stdout),
  - `build` — `-executeMethod SpikeBuild.Linux` → `unity-spike/Build/spike.x86_64`,
  - `shot` — uruchamia build z `-cam x,y,z,tx,ty,tz -t 5 -shot out.png -state out.json`: renderuje N klatek, zapisuje zrzut i JSON (pozycja statku, fps, czasy GPU), wychodzi.
- Pracuję headless na buildach; edytor jest dla Ciebie do oglądania (pod Hyprlandem przez XWayland — jeśli będzie się sypał, nie blokuje spike'a).

**Gotowe gdy:** `tools/unity.sh shot` z pustej sceny daje PNG + JSON.

## Etap 1 — identyczne dane wejściowe z three.js (0,5 dnia)

Mały skrypt `tools/dev/export-unity.mjs` (puppeteer, jak `drive.mjs`) — wyciąga z działającej gry:

1. **Teren laguny:** `heightAt` + `terrainColor` na siatce np. 2048² nad obszarem laguny (~2×2 km)
   → `height.r16` (16-bit RAW) + `color.png`. Plus `pebbles.jpg`.
2. **Niebo:** 6 ścian cubemapy z kamery w (0, 2, 0), bez wody i terenu, `?weather=clear&time=10:30&pause`
   → `sky_{px,nx,py,ny,pz,nz}.png` (HDR jeśli się da — `HalfFloat` RT → EXR; inaczej PNG i dopasowanie ekspozycji).
   Kierunek i kolor słońca → `sun.json`.
3. **Statek:** `amadis.glb` ma wymagane `EXT_meshopt_compression` + `EXT_texture_webp` — glTFast bez dodatków
   tego nie zje. Skrypt gltf-transform: dekodowanie meshopt, WebP → PNG, zapis czystego `.glb`.
4. **Parametry wody:** zrzut `Config.fft`, `Config.caustics`, stałych z `WaveField.ts` i `WaterSurface.ts` → `water.json`,
   żeby obie strony czytały te same liczby.

## Etap 2 — scena bez wody (0,5 dnia)

- Teren: mesh z `height.r16` (kafle 256², bez LOD), materiał: `color.png` × pebbles (prosty shader Lit/Shader Graph).
- Skybox z cubemapy + reflection probe (baked) + directional light z `sun.json`.
- Statek z czystego `.glb`, skala/orientacja sprawdzona zrzutem obok three.js.
- Kamera: port `SailingCamera.ts` (69 linii) + tryb `-cam` = nasze `?cam=x,y,z,tx,ty,tz`.
- Post: URP Volume — tonemapping **ACES**, ekspozycja dopasowana do naszego `PostProcessor.ts`.

**Gotowe gdy:** zrzut Unity i three.js (z tymczasowo schowaną wodą) pokrywają się geometrią i kolorami.

## Etap 3 — woda, warstwa po warstwie (2–2,5 dnia) ← mięsko

Każda warstwa kończy się **zrzutem porównawczym** (sekcja „Porównania” niżej). Kolejność = największy wpływ na wygląd najpierw.

| # | Warstwa | Źródło TS | W Unity | Szac. |
|---|---|---|---|---|
| 3a | Siatka + Gerstner | `WaveField.ts` (153) | promienista siatka wokół kamery; te same fale w vertex shaderze (HLSL) i w C# dla pływania statku | 0,3 d |
| 3b | **Optyka Clearwater** | `WaterSurface.ts` (357), `optics.ts` | shader HLSL (nie Shader Graph — zbyt dużo matematyki): Fresnel, odbicie z reflection probe/skyboxa, absorpcja i rozpraszanie zależne od głębokości (`_CameraDepthTexture`), refrakcja (`_CameraOpaqueTexture`), odblask słońca Beckmann/LEAN | 0,8 d |
| 3c | Szczegół FFT | `WaterSpectrum.ts` (153) | **compute shader** (H0 → ewolucja → FFT → resolve), wynik do RT z mipami, alfa = slope² jak u nas | 0,5 d |
| 3d | Kilwater / kręgi | `Ripples.ts` (157) | równanie falowe na RT 512² jadącym ze statkiem (compute albo `Graphics.Blit`), odcisk kadłuba = prosty kształt z bounding boxu | 0,4 d |
| 3e | Kaustyki | `Caustics.ts` (123) | tekstura kaustyk z tego samego RT, nakładana w shaderze terenu i kadłuba | 0,3 d |

Zasady skrótów w tym etapie:
- **Port 1:1 matematyki**, nie „ulepszanie” — GLSL → HLSL prawie mechanicznie (`vec3`→`float3`, `mix`→`lerp`, `fract`→`frac`, osie Y/Z, lewoskrętność Unity).
- Parametry tylko z `water.json`, żadnego ręcznego strojenia „na oko” zanim zrzuty się nie zgadzają.
- Bez integracji z RenderGraph/Renderer Feature, jeśli nie jest potrzebna — `CommandBuffer` + skrypt na kamerze wystarczy.

## Etap 4 — atrapa ruchu statku (0,3 dnia)

- Pływanie: wysokość i nachylenie z `WaveField.Sample()` w 4–6 punktach kadłuba (to ta sama funkcja co w shaderze → statek *leży* na wodzie).
- Ruch: W/S prędkość 0–6 m/s, A/D skręt, lekki przechył w zakręcie. Wystarczy, żeby zobaczyć kilwater i fale przy burcie w ruchu.

## Etap 5 — porównanie i decyzja (0,5 dnia)

---

## Porównania (wspólne dla wszystkich etapów)

Stały zestaw 5 ujęć, ta sama pora (`10:30`, `weather=clear`, `t=5` — zamrożony czas fal):

| Ujęcie | Co sprawdza |
|---|---|
| A. Kamera zza rufy, statek w lagunie | ogólny vibe, kolor wody, statek na falach |
| B. Nisko nad wodą pod słońce | odblask słońca, Fresnel, szczegół FFT |
| C. Z góry nad płycizną przy rafie | przejrzystość, absorpcja z głębią, kaustyki na dnie |
| D. Blisko burty w ruchu (bez `t`) | kilwater, kręgi, fale przy kadłubie |
| E. Szeroko na przejście w rafie | horyzont, odbicie nieba, daleka woda |

- three.js: `drive.mjs` z `?cam=…&t=5&time=10:30&weather=clear&pause` → `cmp/<ujęcie>-three.png`
- Unity: `tools/unity.sh shot -cam … -t 5` → `cmp/<ujęcie>-unity.png`
- `magick` składa pary obok siebie → `cmp/<ujęcie>.png`; oglądam je ja i Ty.
- Obok: czas klatki GPU w obu (Unity: `FrameTimingManager`; three.js: `bench.mjs`).

## Kryteria decyzji

1. **Wygląd:** w ujęciach A–E Unity jest co najmniej na poziomie three.js (Twoja ocena na parach zrzutów + krótka jazda w buildzie).
2. **Wydajność:** ≥60 fps w 1080p na Frameworku 13 z pełną wodą (dla porównania three.js na morzu ~13,6 ms GPU).
3. **Tempo pracy:** pętla `compile → build → shot` ≤ ~2 min i daje mi wystarczająco dużo informacji, żebym iterował bez Ciebie.
4. **Bonus (nie warunek):** co Unity dało „za darmo” — cienie na wodzie, AA, SSAO, ładniejszy teren.

Jeśli 1–3 przechodzą → planujemy właściwą migrację (fizyka 1:1, generator, Tortuga, chodzenie) na bazie `architecture-migration.md`.
Jeśli nie → zostajemy przy three.js, a spike zostaje jako punkt odniesienia.

## Ryzyka spike'a

- **Edytor/licencja pod Arch + Hyprland** — obejście: praca na buildach headless, edytor tylko do podglądu.
- **Refrakcja i głębia w URP** — `_CameraOpaqueTexture` nie zawiera przezroczystych; woda musi rysować się jako pierwsza przezroczysta. Znane, rozwiązywalne.
- **Różnice kolorów** (sRGB/linear, ACES, ekspozycja) mogą zafałszować porównanie — dlatego etap 2 kończy się zgodnością kolorów *przed* wodą.
- **Eksport nieba HDR** — jeśli EXR z przeglądarki okaże się kłopotliwy, PNG + ręczna ekspozycja (gorsze odblaski słońca, ale porównanie nadal fair, bo słońce liczy shader).

## Harmonogram

| Dzień | Zakres | Punkt kontrolny |
|---|---|---|
| 1 | Etap 0 + 1 + 2 | scena bez wody zgodna z three.js |
| 2 | 3a + 3b | **pierwsze porównanie wody (A, B, E)** |
| 3 | 3c + 3d + etap 4 | woda z FFT i kilwaterem (B, D) |
| 4 | 3e + poprawki zgodności | komplet A–E |
| 5 | bufor + decyzja | pary zrzutów + build do pojeżdżenia |

---

## Wyniki (2026-09-28)

Zrobione w `unity-spike/` (instrukcja: `unity-spike/README.md`), Unity 6.6 URP, Vulkan, Framework 13 (Radeon 860M).

- **Wygląd:** ujęcia A–E (`tools/dev/compare-all.sh` → `.shots/<ujęcie>-cmp.png`) są praktycznie nie do odróżnienia
  w samej wodzie: kolor, przejrzystość płycizn, kaustyki, odbicie planarne, blask, kilwater, piana, linia brzegu,
  mgiełka. Różnice pochodzą z wyciętych rzeczy (brak palm, brak świata za ±640 m, inna poza statku bez fizyki).
- **Wydajność (GPU, ta sama scena, kamera zza rufy):** Unity 8,6 ms @720p / 12,8 ms @1080p;
  three.js 13,9 ms / 22,6 ms (bez roślinności). Około 1,6–1,75× taniej, przy czym three.js liczy jeszcze chmury.
- **Pętla pracy:** setup ≈ 40 s, build ≈ 45 s, zrzut ≈ 10 s — pełny cykl ~1,5 min, bez otwierania edytora.
- **Pułapki znalezione po drodze:** EXR z three.js wczytuje się w Unity z odwróconymi wierszami (niebo jako surowe
  floaty); URP 17 kopiuje głębię domyślnie *po* przezroczystych (woda jej nie widzi); render do tekstury bierze
  format bufora pośredniego z tekstury docelowej (8-bit → przycięte HDR); glTFast nie czyta WebP.
