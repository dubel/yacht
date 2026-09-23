# Lagoon — żeglowanie po lagunie (Three.js)

Statyczna gra przeglądarkowa: brygantyna na tropikalnej lagunie. Three.js + WebGL2, woda na bazie
[Clearwater](https://github.com/Aureliengmz/clearwater), własna fizyka żeglowania. Bez frameworków i backendu.

**Online: https://dubel.dev/yacht/** (GitHub Pages, publikowane przy każdym pushu na `master`).

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # → dist/ (statyczny hosting: GitHub Pages, Cloudflare Pages, S3…)
```

Wymaga WebGL2 z `EXT_color_buffer_float` (każdy współczesny desktop, większość telefonów).

## Sterowanie

| Klawisz | Akcja |
| --- | --- |
| `A` / `D` (strzałki) | ster |
| `W` / `S` (lub `Q` / `E`) | wybieranie / luzowanie szotów (wyłącza auto-trym) |
| `T` | auto-trym żagli |
| `Spacja` | postaw / zwiń żagle |
| mysz (przeciąganie), kółko | obrót kamery (także pod wodę), zoom |
| `V` | zanurz kamerę pod łódź / wynurz |
| `R` | reset łodzi |
| `F1` | panel debug |
| `F2`–`F8` | widoki wody: final, normalne, kaustyki, odbicie, głębokość, ripples/kilwater, FFT |
| `H` | ukryj pomoc |

Cel: opłyń 5 boi (dowolna kolejność) i wróć na start. Najlepszy czas zapisuje się lokalnie.

## Parametry URL (debug / zrzuty)

`?debug` · `?t=5` (zamrożony czas) · `?view=caustics` · `?cam=x,y,z,tx,ty,tz` (wolna kamera) ·
`?sun=elewacja,azymut` · `?speed=4` (prędkość startowa m/s) · `?q=0.8` (skala rozdzielczości) ·
`?noadapt` · `?inspect=side|front|top` (ortogonalny widok łodzi z siatką 1 m — do pomiarów takielunku)

## Architektura

```
src/
├── main.ts                 bootstrap, sprawdzenie GPU, ekran ładowania
├── core/                   Game (pętla, adaptacyjna rozdzielczość), Config, Input, Capabilities, noise
├── render/
│   ├── Pipeline.ts         scena (MSAA, HDR+depth) → odbicie planarne → woda → [pod wodą] → post
│   ├── PostProcessor.ts    bloom + ACES + grading (Clearwater)
│   └── water/
│       ├── WaterSpectrum   FFT 256² (Clearwater), skalowane do patcha 20 m
│       ├── Ripples         lokalne równanie falowe 512² / 128 m wokół łodzi + kanał piany (kilwater)
│       ├── Caustics        kaustyki z dyspersją (Clearwater), rzutowane na prawdziwe dno
│       ├── WaterSurface    siatka radialna wokół kamery, shader wody (Fresnel, połysk, refrakcja, absorpcja; od spodu: okno Snella)
│       ├── UnderwaterPass  słup wody między obiektywem a sceną: ekstynkcja, rozpraszanie, promienie światła
│       ├── UnderwaterParticles  zawiesina wokół kamery pod wodą
│       ├── underwaterLight wspólny patch oświetlenia pod wodą (dno, kadłub, boje)
│       └── optics.ts       wspólne stałe optyczne wody
├── environment/            Environment (niebo Preethama, słońce, IBL, kolor mgły), Wind, WaveField (Gerstner CPU=GPU)
├── world/                  Terrain (analityczna mapa wysokości: wyspy, rafa, dno), Vegetation (instancing)
├── boat/                   Boat (GLB), Sails (proceduralne żagle + obracane reje/bom/gafel)
├── physics/BoatPhysics.ts  6DOF: wyporność wielopunktowa, kil/ster/żagiel jako profile, wiatr pozorny
├── camera/SailingCamera.ts
├── gameplay/Mission.ts     boje, czas, rekord
└── debug/                  DebugUI (F1), Hud (instrumenty)
tools/                      shot.mjs (zrzuty headless), probe.mjs, sim*.ts (testy fizyki offline)
```

Kluczowa zasada z planu: **fizyka ≠ rendering**. Fizyka czyta tylko fale Gerstnera z `WaveField`
(te same fale przesuwają wierzchołki wody na GPU); FFT, ripples i kaustyki są wyłącznie wizualne.

Testy fizyki bez przeglądarki:

```bash
npx tsx tools/sim.ts          # biegunowa prędkości dla kursów 30–180° TWA
npx tsx tools/sim-turn.ts 3   # zwrotność
```

## Status względem MILESTONES.MD

| M | Zakres | Stan |
| --- | --- | --- |
| 0 | woda Clearwater w Three.js | ✅ FFT, ripples, kaustyki, shader, niebo, post, widoki debug, adaptacyjna rozdzielczość. ❌ lens glare (celowo na koniec) |
| 1 | świat laguny | ✅ wyspy, plaże, rafa z przejściem, rafy koralowe, dno z teksturą kamyków |
| 2 | model łodzi | ✅ GLB zoptymalizowany 64 → 7 MB (WebP + meshopt), linia wodna |
| 3 | kamera + sterowanie | ✅ |
| 4 | JoltPhysics | ⏸ **odłożone** — własny integrator 6DOF wystarcza dla jednej łodzi; Jolt wróci przy kolizjach z obiektami / soft-body żagli (M18) |
| 5 | wyporność | ✅ 33 kolumny kadłuba, tłumienie, osiadanie na mieliźnie |
| 6–7 | żeglowanie, kil, ster, przechył | ✅ ~7.5 kn na półwietrze przy 13 kn wiatru, bajdewind do ~40° TWA |
| 8 | deformacja żagla | ✅ proceduralne żagle (brzuch od wiatru pozornego, łopotanie, zwijanie) |
| 9 | kilwater | ✅ fala dziobowa/rufowa w symulacji, turbulencja, piana w przestrzeni świata |
| 10 | odbicia świata | ✅ odbicie planarne (wyspy, łódź, roślinność) |
| 11 | pod wodą | ✅ absorpcja i rozpraszanie, promienie światła z kaustyk, okno Snella i całkowite odbicie od spodu powierzchni, kaustyki na kadłubie, zawiesina, widok dzielony linią wody. ❌ bąbelki |
| 12 | dzień/noc | ◐ słońce sterowane `?sun=`, brak cyklu |
| 13 | pogoda | ◐ podmuchy i skręty wiatru; brak stanów pogody |
| 14 | pętla gry | ✅ v1: boje + czas + rekord |
| 15 | dopracowanie świata | ◐ proceduralne palmy/drzewa/krzaki (low-poly) |
| 16 | audio | ❌ |
| 17 | wydajność | ◐ adaptacyjna rozdzielczość; brak profili jakości |
| 18–19 | cloth v2, polish | ❌ / ◐ (ekran ładowania, rekord) |

## Licencje i atrybucje

- **Model łodzi**: „Swedish royal yacht Amadis” — Museovirasto / Finnish Heritage Agency,
  [Sketchfab](https://sketchfab.com/3d-models/swedish-royal-yacht-amadis-1f320f9e96cd4a9d961d7b1553a2feed),
  licencja **CC-BY-4.0**. W repo jest tylko wersja zoptymalizowana; oryginał (62 MB) trzymamy lokalnie w `assets/` (`npm run optimize-boat`); żagle postawione są generowane w kodzie.
- **Clearwater** — © 2026 Lumaris (Aurélien), licencja **MIT** (`third_party/clearwater/LICENSE`).
  Z Clearwatera pochodzą: spektrum i GPU FFT, symulacja ripples, kaustyki z dyspersją, model optyczny wody
  (Fresnel, absorpcja/rozpraszanie, połysk Beckmanna z LEAN), filtr B-spline, post-processing
  i tekstura kamyków dna (`public/assets/textures/pebbles.jpg`). Oryginał referencyjny:
  `third_party/clearwater/index.reference.html`.
- Three.js — MIT.
