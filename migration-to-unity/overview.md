# Przegląd migracji: Lagoon (yacht) z Three.js do Unity

Dokument zawiera podsumowanie analizy repozytorium **Lagoon (`yacht`)**, ocenę opłacalności i wykonalności portu do silników natywnych (**Unity vs Unreal Engine**), analizę zysków wydajnościowych i jakościowych oraz ocenę środowiska pracy na laptopie **Framework Laptop 13 (2025) z 96 GB RAM**.

---

## 1. Analiza stanu wyjściowego projektu (Three.js + TypeScript)

Projekt to zaawansowany prototyp morskiej gry eksploracyjnej w klimatach historycznych (*Sea of Thieves* / symulator żeglugi w lagunie). Zawiera zarówno tryb żeglowania brygantyną w perspektywie trzeciej osoby (TPP), jak i poruszanie się marynarzem po pokładzie statku oraz po lądzie w perspektywie pierwszej osoby (FPV).

### Kluczowe moduły w repozytorium:
- **System wody (adaptacja [Clearwater](https://github.com/Aureliengmz/clearwater)):**
  - `WaterSpectrum.ts`: GPU FFT 256×256 generujące spektrum fal oceanicznych.
  - `Ripples.ts`: lokalna symulacja równania falowego 2D (512×512 na obszarze 128 m) wokół jachtu, generująca wzburzenie, kilwater i pianę.
  - `Caustics.ts`: analityczne kaustyki z dyspersją chromatyczną rzucane na kadłub i dno morskie.
  - `WaterSurface.ts` & `UnderwaterPass.ts`: siatka radialna skupiona na kamerze, Snell's window, ekstynkcja światła, rozpraszanie podwodne i promienie słoneczne.
- **Dedykowana fizyka żeglowania (`BoatPhysics.ts`):**
  - Autorski integrator 6DOF (brak zewnętrznych silników fizyki typu PhysX czy Rapier).
  - Wyporność oparta na 33 kolumnach kadłuba próbkowanych względem fal Gerstnera.
  - Hydrodynamiczne i aerodynamiczne profile cienkie (*thin-foil*) dla stępki, płetwy sterowej i ożaglowania (krzywe biegunowe siły nośnej, opór indukowany, przeciągnięcie, wiatr pozorny).
  - `Sails.ts`: proceduralna deformacja geometrii żagli (wybrzuszanie, łopotanie, zwijanie).
- **Generowanie świata i streaming terenu (`Terrain.ts`, `WorldGen.ts`):**
  - Deterministyczna, analityczna mapa wysokości (rafy koralowe, wyspy, miasto Tortuga, Wyspa Czaszek).
  - Wielowątkowy streaming kafelków terenu w Web Workerach (`terrain.worker.ts`) z 4 poziomami szczegółowości (LOD).
  - Instancjonowanie roślinności (palmy, zarośla).
- **Kamery i kontrola postaci (`DeckWalker.ts`, `LandWalker.ts`):**
  - `DeckWalker`: poruszanie się po ruchomym, kołyszącym się układzie odniesienia pokładu, tłumienie przechyłów imitujące ludzki błędnik, kolizje z burtami i nadbudówkami.
  - `LandWalker`: lądowanie na plaży, brodzenie w wodzie, wspinaczka po zboczach do 40°.
- **Atmosfera i chmury (`Clouds.ts`, `Weather.ts`):**
  - Ray-marching chmur wolumetrycznych oparty na trójwymiarowym szumie Perlin-Worley (inspirowany rozwiązaniem z *Horizon Zero Dawn*), rzucanie cieni na wodę i ląd.
- **Audio i rozgrywka:**
  - Proceduralna synteza Web Audio (świst wiatru w takielunku, furkot żagli, plusk wody przy burcie) + próbki dźwiękowe.
  - Ekwipunek, broń (armaty, muszkiety, pistolety, rapier), luneta optyczna, sonda głębokości, kotwica i keksowanie (*kedging*).

Całość liczy około 80 zwartych, wysoce wyspecjalizowanych plików TypeScript, pozbawionych zewnętrznych frameworków UI/ECS.

---

## 2. Ocena szans na port: Unity (URP) vs Unreal Engine 5

| Cecha | Unity (Universal Render Pipeline) | Unreal Engine 5 |
| :--- | :--- | :--- |
| **Szansa na udany, szybki port** | **Bardzo wysoka (90–95%)** | Średnia (40–50%) |
| **Bariera językowa i translacja** | **Znikoma (TypeScript → C#)** | Bardzo wysoka (TypeScript → C++/Blueprints) |
| **Fizyka i poruszanie się po statku** | Prosta adaptacja kodu 6DOF do C# | Duży narzut `CharacterMovementComponent` |
| **Styl wizualny** | Stylized / Low-Poly / PBR | Zoptymalizowany pod ciężki fotorealizm |
| **Kompatybilność z Framework 13 (iGPU)** | **Znakomita (płynny edytor 60–120 FPS)** | **Krytycznie niska (dławienie iGPU, 15–25 FPS)** |

### Dlaczego Unity (URP) to optymalny wybór:
1. **Translacja TypeScript → C#:**
   - Składnia obu języków jest zbliżona. Matematyka wektorowa (`Vector3`, `Quaternion`), pętle symulacji i algorytmy deterministyczne z `WorldGen.ts` czy `BoatPhysics.ts` przenosi się w relacji 1:1.
2. **Gotowy ekosystem wody:**
   - Dostępny jest m.in. uznany, otwartoźródłowy **Crest Ocean System (URP)**, który fabrycznie realizuje dokładnie te same założenia co Clearwater (dynamiczne fale FFT, lokalne ripples i kilwater, kaustyki, zanurzenie pod wodę i Snell's window), ale zoptymalizowany w natywnych Compute Shaderach.
3. **C# Job System + Burst Compiler:**
   - Web Workery z Three.js można zastąpić natywnymi zadaniami wielowątkowymi kompilowanymi do instrukcji wektorowych SIMD (Burst), co eliminuje mikro-przycięcia i drastycznie przyspiesza generowanie siatek terenu oraz deformację żagli.
4. **Swoboda architektury poruszania się na statku:**
   - Unity nie wymusza monolitycznych struktur postaci. Przypięcie marynarza do lokalnego układu współrzędnych jachtu (`DeckWalker`) jest proste i przewidywalne.

### Dlaczego Unreal Engine 5 jest odradzany:
- **Sztywny framework:** Wymóg oparcia wszystkiego o hierarchię `AActor`, `ACharacter`, `PlayerController` i pamięciożerne makra Unreal C++.
- **Problemy z `CharacterMovementComponent`:** Domyślny kontroler ruchu w Unrealu ma udokumentowane problemy ze stabilnym utrzymywaniem gracza na poruszających się, obracających fizycznie powierzchniach (statkach na falach).
- **Zasobożerność podzespołów:** Technologie UE5 (Lumen, Nanite, Virtual Shadow Maps) są zaprojektowane pod potężne karty graficzne dGPU i fotorealistyczne assety z milionami wielokątów, co całkowicie mija się z charakterem tego projektu.

---

## 3. Zyski jakościowe i wydajnościowe

Przejście z przeglądarkowego WebGL2 na natywny silnik Unity przynosi wymierne korzyści:

### Wydajność
1. **Compute Shaders zamiast techniki Ping-Pong FBO:**
   - W Clearwaterze symulacja FFT i ripples odbywa się przez renderowanie pełnoekranowych prostokątów do buforów zmiennoprzecinkowych. W Unity Compute Shadery wykonują to bezpośrednio na pamięci VRAM bez angażowania potoku geometrii.
2. **Brak pauz Garbage Collectora (GC):**
   - W JavaScript silnik V8 okresowo wstrzymuje wątek główny na czyszczenie pamięci. W C# w Unity (wykorzystując struktury `struct` i alokatory `NativeArray`) kod osiąga 0 alokacji na klatkę.
3. **SRP Batcher i GPU Instancing:**
   - Drastyczna redukcja liczby wywołań rysowania (Draw Calls) dla budynków Tortugi, pomostów i setek palm.
4. **Wielowątkowość:**
   - Przeniesienie 33 punktów wyporności, aerodynamiki żagli i deformacji siatek do wątków w tle (Job System).

### Jakość wizualna i audio
1. **Zaawansowany post-processing i antyaliasing:**
   - Wprowadzenie Temporal Anti-Aliasingu (TAA / FSR), który eliminuje migotanie cienkich lin takielunku i krawędzi fal.
   - Ground Truth Ambient Occlusion (GTAO) dające miękkie cienie kontaktowe pod deskami pokładu i w załamaniach skał.
2. **Oświetlenie i wolumetria:**
   - Prawdziwa mgła wolumetryczna i promienie światła (god rays) reagujące dynamicznie na chmury i błyskawice.
3. **Natywne audio przestrzenne:**
   - Obsługa HRTF, okluzji akustycznej (wyciszanie dźwięków morza w kajucie lub jaskini) i pogłosów w czasie rzeczywistym.

---

## 4. Analiza stacji roboczej: Framework Laptop 13 (2025) z 96 GB RAM

### Charakterystyka sprzętu
- **Pamięć RAM (96 GB DDR5):** Wybitny atut. Pozwala na jednoczesne uruchomienie środowiska Unity, IDE (Rider / VS Code), przeglądarki z dziesiątkami kart i cache assetów bez korzystania z pliku wymiany (swap).
- **Układ graficzny:** Zintegrowana grafika (iGPU: **AMD Radeon 780M / 890M** lub **Intel Arc**). Brak dedykowanej karty dGPU.
- **Chłodzenie (TDP ~28W):** Ograniczony budżet cieplny małej, 13-calowej obudowy ultrabooka.

### Unreal Engine 5 na Framework 13:
- **Nieakceptowalny komfort pracy.**
- Viewport edytora UE5 z włączonym Lumenem/Nanite generuje na iGPU zaledwie **15–25 FPS**, zmuszając do obniżenia jakości do minimum.
- Ciągła kompilacja shaderów i praca edytora rozgrzewa CPU do maksymalnych temperatur, wywołując głośną pracę wentylatorów i thermal throttling.

### Unity (URP) na Framework 13:
- **Idealne dopasowanie technologiczne.**
- Unity z Universal Render Pipeline jest wyjątkowo lekkie dla układu graficznego. Na zintegrowanych Radeon 780M / 890M edytor i gra działają stabilnie w **60–120 FPS**.
- Czas kompilacji skryptów C# wynosi 1–2 sekundy. Wejście w tryb *Play Mode* zajmuje ułamek sekundy.
- Laptop zachowuje wysoką kulturę pracy (chłodny, cichy) i pozwala na komfortową pracę na baterii.

---

## 5. Podsumowanie decyzji i mapa dokumentacji

Rekomendowany kierunek to **Unity 6 LTS z Universal Render Pipeline (URP Forward+)**. 

Szczegółowe zagadnienia techniczne, szacunki czasowe oraz instrukcje środowiskowe zostały podzielone na dedykowane dokumenty:

| Dokument | Zawartość |
| :--- | :--- |
| **[hints-to-fast-migrate.md](hints-to-fast-migrate.md)** | **Szacunek pracochłonności (10–14 dni roboczych, ~4–7 mln tokenów LLM), harmonogram faza po fazie i 3 kluczowe dźwignie szybkiej migracji.** |
| **[arch-linux-prerequisites.md](arch-linux-prerequisites.md)** | Konfiguracja środowiska pod Omarchy Quattro (Arch Linux), Vulkan/Mesa, Unity Hub, Blender + Blender CLI. |
| **[architecture-migration.md](architecture-migration.md)** | Decyzje architektoniczne (ADR 001–008): potok URP Forward+, Crest Ocean, fizyka 6DOF z Burst, kontrolery postaci, generator świata. |
| **[how-to-connect-agent-to-unity.md](how-to-connect-agent-to-unity.md)** | Integracja agenta AI: most MCP, skrypty edytora, Unity Editor CLI, Unity Hub CLI i skrypt `tools/unity.sh`. |
| **[fetching-3rd-party-assets.md](fetching-3rd-party-assets.md)** | Autonomiczne pobieranie assetów przez LLM (ambientCG, Poly Haven, Sketchfab API, multimodal vision). |
| **[modelling-3d-assets.md](modelling-3d-assets.md)** | Workflow tworzenia obiektów w Blenderze pod Unity (.blend, .glb, skala, pivoty, PBR Principled BSDF). |
| **[cross-compilation-possibilities.md](cross-compilation-possibilities.md)** | Kompilacja skrośna z Arch Linux na: Windows (.exe), WebAssembly/WebGPU (GitHub Pages), Android (.apk), macOS (.app). |
| **[performance-approach.md](performance-approach.md)** | Strategia wydajnościowa i szacunek FPS (75–95 FPS z FSR, 120 FPS max) na Framework Laptop 13 z 96 GB RAM. |


