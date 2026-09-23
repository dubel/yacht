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
| `N` | następna pogoda (blokuje automatyczne zmiany) |
| `[` / `]` | czas −1 h / +1 h |
| `P` | zatrzymaj / wznów upływ czasu (np. żeby napawać się zachodem) |
| `M` | wycisz dźwięk (dźwięk startuje po pierwszym kliknięciu / klawiszu — wymóg przeglądarek) |
| `R` | reset łodzi |
| `F1` | panel debug |
| `F2`–`F8` | widoki wody: final, normalne, kaustyki, odbicie, głębokość, ripples/kilwater, FFT |
| `H` | ukryj pomoc |

Cel: opłyń 5 boi (dowolna kolejność) i wróć na start. Najlepszy czas zapisuje się lokalnie.

## Pora dnia i pogoda (parametry URL)

Doba trwa 7 minut. Pogoda zmienia się sama (pogodnie → pochmurno → deszcz → burza → sztorm…), chyba że ją ustawisz.

| Parametr | Znaczenie | Przykład |
| --- | --- | --- |
| `time` | godzina startu | `?time=18:30`, `?time=6` |
| `weather` | pogoda: `clear`/`pogodnie`, `cloudy`/`pochmurno`, `rain`/`deszcz`, `storm`/`burza`, `gale`/`sztorm`, `fog`/`mgla`, `auto` | `?weather=burza` |
| `daylen` | długość doby w minutach (`0` = zatrzymany zegar) | `?daylen=2` |
| `pause` | start z zatrzymanym zegarem | `?time=17:45&pause` |
| `moon` | faza księżyca: 0 nów, 0.25 pierwsza kwadra, 0.5 pełnia, 0.75 ostatnia kwadra | `?moon=0.25` |

Np. zachód słońca w sztormie: `?time=17:40&weather=sztorm`, noc przy pełni: `?time=21&weather=pogodnie`.

Chmury są wolumetryczne (ray-marching przez warstwę na zakrzywionej Ziemi, szum Perlin-Worley jak w *Horizon Zero Dawn*):
odbijają się w wodzie, rzucają przesuwające się cienie na lagunę, wyspy i łódź, o zachodzie świecą od spodu na czerwono,
nocą oświetla je księżyc, a błyskawice rozświetlają je od środka. Burza buduje wieże do 6.5 km.

Pogoda steruje wszystkim naraz: zachmurzeniem i jasnością nieba, światłem, mgłą, wiatrem (a więc prędkością i przechyłem),
wysokością fal (także w fizyce), wzburzeniem i grzywaczami, deszczem (smugi + kręgi na wodzie), błyskawicami (błysk,
piorun, grzmot opóźniony o czas dojścia dźwięku) i dźwiękiem. Nocą świeci księżyc z prawdziwą fazą (tarcza oświetlana
z kierunku słońca), gwiazdy obracają się z czasem, woda odbija księżycową ścieżkę.

## Parametry debug

`?debug` · `?t=5` (zamrożony czas symulacji) · `?view=caustics` · `?cam=x,y,z,tx,ty,tz` (wolna kamera) ·
`?sun=elewacja,azymut` (przypięte słońce) · `?speed=4` (prędkość startowa m/s) · `?q=0.8` (skala rozdzielczości) ·
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
├── environment/            Environment (niebo, słońce, księżyc, gwiazdy, IBL, mgła), Clouds (chmury wolumetryczne + cienie),
│                           GameTime, Weather, WeatherFX (deszcz, pioruny), Wind, WaveField (Gerstner CPU=GPU)
├── audio/AudioSystem.ts    warstwy nagrań + synteza WebAudio
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
| 12 | dzień/noc | ✅ doba 7 min, wschody/zachody, księżyc z fazami, gwiazdy, adaptacja ekspozycji |
| 13 | pogoda | ✅ 6 stanów z płynnymi przejściami i automatyczną zmianą; chmury wolumetryczne z cieniami; deszcz, burza z piorunami, sztorm, mgła |
| 14 | pętla gry | ✅ v1: boje + czas + rekord |
| 15 | dopracowanie świata | ◐ proceduralne palmy/drzewa/krzaki (low-poly) |
| 16 | audio | ✅ nagrania CC/PD (ocean, chlupot, deszcz, grzmoty, mewy, świerszcze, skrzypienie) + synteza (wiatr, gwizd w olinowaniu, szum wody przy burcie, łopot żagla), wytłumienie pod wodą |
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
- **Dźwięki** — nagrania z Wikimedia Commons (CC0, domena publiczna, CC BY 3.0, CC BY-SA 3.0/4.0),
  przycięte i przekodowane; pełna lista autorów i licencji: `public/assets/audio/CREDITS.md`.
- Three.js — MIT.
