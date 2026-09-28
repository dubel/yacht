# Szacunek pracochłonności, harmonogram i wskazówki szybkiej migracji (Hints to Fast Migrate)

Niniejszy dokument przedstawia inżynierskie szacunki czasowe, zapotrzebowanie na tokeny modeli językowych (LLM), harmonogram wdrożenia faza po fazie oraz kluczowe zasady pozwalające przeprowadzić migrację gry Lagoon z Three.js do Unity w najkrótszym możliwym czasie.

---

## 1. Podsumowanie szacunków (Executive Summary)

| Parametr | Szacunek | Uwagi |
| :--- | :--- | :--- |
| **Czas do „First Playable”** | **2–3 dni** | Pływający jacht ze stępką, sterem i żaglami na falującym oceanie w widoku TPP. |
| **Pełna migracja (Full-time)** | **10–14 dni roboczych** | 2–3 tygodnie intensywnej współpracy z agentem AI (6–8h dziennie). |
| **Pełna migracja (Part-time)** | **4–6 tygodni** | Tryb wieczorowy / poboczny (1.5–2h dziennie). |
| **Zużycie tokenów wejściowych (Input)** | **4 – 7 mln tokenów** | Czytanie kodu TypeScript, kontekst projektu, pętla kompilatora CLI. |
| **Zużycie tokenów wyjściowych (Output)** | **350k – 600k tokenów** | Wygenerowanie ~12 000 – 15 000 linii czystego kodu C# i shaderów. |
| **Szacunkowy koszt tokenów (API)** | **~15 – 30 USD** | Przy modelach klasy Claude 3.5 Sonnet / Gemini Pro (przy Flash < 5 USD). |

---

## 2. Harmonogram wdrożenia faza po fazie

```mermaid
gantt
    title Harmonogram migracji Lagoon do Unity (14 dni roboczych)
    dateFormat  X
    axisFormat  Dzień %d

    section Fundamenty
    Faza 1: Setup, glTFast, Crest, SkyDirector :active, 0, 1
    
    section Fizyka i Woda
    Faza 2: Port BoatPhysics 6DOF i żagle Burst   :crit, 1, 4
    
    section Kontrola Gracza
    Faza 3: DeckWalker, LandWalker, Luneta FPV    : 4, 6
    
    section Świat i Streaming
    Faza 4: WorldGen Burst, Kafle LOD, Tortuga    : 6, 9
    
    section Gameplay i Audio
    Faza 5: Armaty, Narzędzia, Synteza DSP Audio  : 9, 12
    
    section Szlify
    Faza 6: URP Polish, Testy Framework 13, Build : 12, 14
```

### Faza 1: Szkielet projektu i import assetów (Dzień 1)
- **Zakres:** Założenie projektu Unity 6 URP, instalacja `glTFast`, `Burst`, `Mathematics`, import Crest Ocean System, skopiowanie modeli `.glb`, konfiguracja skryptu `tools/unity.sh`.
- **Rola LLM:** Konfiguracja wstępna, automatyzacja importu, weryfikacja środowiska.
- **Zużycie tokenów:** ~300k input / ~25k output.
- **Efekt:** Scena testowa ze słońcem, wodą Crest i zaimportowanym jachtem *Amadis*.

### Faza 2: Fizyka żeglugi 6DOF i ocean (Dni 2–4) $\rightarrow$ *Kamień Milowy: First Playable!*
- **Zakres:**
  - Przepisanie `BoatPhysics.ts` na `BoatDynamics.cs` (integracja 6DOF, profile cienkie stępki, steru i żagli, opór falowy Froude'a).
  - Połączenie 33 punktów wyporności kadłuba z asynchronicznym odpytywaniem fal Crest (`ICollisionProvider`).
  - Przepisanie proceduralnej aerodynamiki żagli z `Sails.ts` na wielowątkowe zadanie `SailDeformerJob` skompilowane w Burst.
- **Rola LLM:** Bezpośrednia translacja TypeScript $\rightarrow$ C#, optymalizacja alokacji pamięci (zero GC per frame).
- **Zużycie tokenów:** ~1.2 mln input / ~90k output (kilka pętli kompilacji z konsoli).
- **Efekt:** W pełni grywalny jacht – sterujesz sterem i szotami, łódź reaguje na wiatr pozorny, przechyla się i tnie fale.

### Faza 3: Kontrola postaci i kamery (Dni 5–6)
- **Zakres:**
  - Port `DeckWalker.ts`: poruszanie się marynarzem w układzie lokalnym kadłuba z zachowaniem kompensacji kołysania (`LEVEL = 0.55`).
  - Port `LandWalker.ts`: schodzenie na brzeg szalupą, brodzenie w wodzie, wspinaczka do 40°.
  - Luneta (`Spyglass.ts`) z powiększeniem optycznym i maską soczewki; kamera TPP.
- **Rola LLM:** Architektura kontrolera postaci i kamery.
- **Zużycie tokenów:** ~800k input / ~70k output.
- **Efekt:** Możliwość swobodnego biegania po pokładzie płynącego statku, patrzenia przez lunetę i lądowania na plaży.

### Faza 4: Generowanie świata i streaming terenu (Dni 7–9)
- **Zakres:**
  - Port algorytmów analitycznych z `WorldGen.ts` do biblioteki matematycznej `WorldGenMath.cs` (funkcje `fbm`, `vnoise`, atole, rafy).
  - Wielowątkowy generator siatek kafelków (`GenerateTerrainMeshJob`) z 4 poziomami LOD zastępujący Web Workery.
  - Instancjonowanie palm i skał oraz rozstawienie prefabów Tortugi i Wyspy Czaszek.
- **Rola LLM:** Przeniesienie proceduralnej matematyki świata, optymalizacja pod Burst.
- **Zużycie tokenów:** ~1.5 mln input / ~120k output.
- **Efekt:** Eksploracja pełnego archipelagu wysp i miasteczka portowego z płynnym doczytywaniem LOD bez zacięć klatkażu.

### Faza 5: Walka, ekwipunek i proceduralne audio (Dni 10–12)
- **Zakres:**
  - Balistyka dział (`Artillery.ts`), muszkiety, pistolet skałkowy, rapir.
  - Sonda głębokości (ołowianka), keksowanie kotwicą (*kedging*), ekwipunek i kompas.
  - Port proceduralnej syntezy Web Audio z `AudioSystem.ts` na filtry DSP Unity (`OnAudioFilterRead` – świst wiatru w takielunku modulowany prędkością wiatru pozornego, szum wody przy burtach, trzepot luźnych żagli).
- **Rola LLM:** Generowanie filtrów DSP w C#, implementacja mechanik ekwipunku i balistyki.
- **Zużycie tokenów:** ~1.2 mln input / ~90k output.
- **Efekt:** Kompletna warstwa audio, mechaniki RPG i walka morska.

### Faza 6: Szlify, optymalizacja pod Framework 13 i Build (Dni 13–14)
- **Zakres:**
  - Wdrożenie profilu post-processingu URP (TAA, SSAO, ACES).
  - Profilowanie i testy termiczne na zintegrowanej grafice laptopa Framework 13.
  - Zbudowanie pliku wykonywalnego `.x86_64` pod Omarchy / Arch Linux.
- **Rola LLM:** Konfiguracja build pipeline, analiza ewentualnych wąskich gardeł w profilera Unity.
- **Zużycie tokenów:** ~500k input / ~40k output.
- **Efekt:** Gotowa, zoptymalizowana gra działająca poza przeglądarką w stabilnych 60–120 FPS.

---

## 3. Dlaczego potrzebujemy 4–7 mln tokenów?

Wielu programistów zakłada, że skoro kod projektu ma kilkanaście tysięcy linii, wystarczy kilkaset tysięcy tokenów. W praktyce agencyjnej kluczowe są dwa zjawiska:

1. **Kontekst modułowy (Context Window):**
   Przed przepisaniem pliku takiego jak `DeckWalker.ts`, agent musi wczytać do pamięci podręcznej powiązane pliki (`Boat.ts`, `Input.ts`, `DeckMap.ts`). Każde zapytanie operuje na oknie 30k–60k tokenów.
2. **Pętla walidacji kompilatora CLI (`./tools/unity.sh check`):**
   Agent pisze kod, uruchamia sprawdzenie z konsoli, analizuje logi błędów i natychmiast poprawia ewentualne niezgodności typów. Taka 2–3 krotna iteracja na moduł zużywa tokeny, ale **gwarantuje, że otrzymujesz czysty, w 100% kompilujący się kod bez manualnego debugowania**.

---

## 4. Trzy kluczowe dźwignie przyspieszające migrację

Aby utrzymać tempo 14 dni, należy bezwzględnie przestrzegać trzech zasad:

1. **Użyj Crest Ocean System zamiast pisać shadery wody od zera:**
   - *Oszczędność:* **Około 2 tygodni pracy**.
   - Przenoszenie buforów FFT i równania falowego z WebGL2 do HLSL na Vulkanie to ogromne ryzyko ugrzęźnięcia w shaderach. Crest rozwiązuje to od pierwszego dnia.
2. **glTFast dla modeli 3D:**
   - *Oszczędność:* **Kilka dni pracy**.
   - Wszystkie zoptymalizowane modele `.glb` z obecnego repozytorium działają w Unity od ręki bez reteksturowania czy ponownego riggowania.
3. **Pętla CLI `tools/unity.sh`:**
   - *Oszczędność:* **Ciągła płynność pracy**.
   - Agent weryfikuje poprawność kodu w 2 sekundy w terminalu, nie czekając na Twoją manualną weryfikację w edytorze.

---

## 5. Dobre praktyki współpracy z Agentem podczas migracji

- **Zasada jednego modułu:** Nie proś agenta o „przepisanie całej gry naraz”. Przepisuj moduł po module według faz (np. *„Dziś robimy wyłącznie `BoatPhysics.ts` $\rightarrow$ `BoatDynamics.cs` wraz z testami prędkości biegunowej”*).
- **Częste commity Git:** Po zakończeniu każdej podfazy rób commit w repozytorium. Jeśli agent pójdzie w złą stronę, możesz natychmiast cofnąć stan do działającego punktu.
- **Wizualna ocena w trybie Play:** Agent przygotowuje kod i weryfikuje kompilację, a Ty uruchamiasz tryb *Play Mode* w Unity na Frameworku 13 i weryfikujesz odczucia z fizyki i sterowania.
