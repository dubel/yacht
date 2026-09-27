# Tortuga — zabudowa miasteczka za przystanią

## Kontekst historyczny

Tortuga (Île de la Tortue) w drugiej połowie XVII wieku to nie miasto w europejskim sensie — to piracka faktoria: kilkadziesiąt budynków między brzegiem a dżunglą, postawione z tego co było pod ręką (drewno okrętowe, palmy, kamień koralowy). Ulice to raczej wydeptane, piaszczyste trakty — tu i ówdzie wzmocnione deskami. Bruku z „kocich łbów" tu nie będzie: to nie Port Royal i nie Havana, a spontaniczne osiedle bukanierów na wyspie, gdzie nawet gubernator mieszkał w drewnianym domu.

## Przestrzeń do zagospodarowania

Płaski teren za keją ciągnie się ok. **60 m w głąb lądu** (na zachód) i **~350 m wzdłuż nabrzeża** (północ-południe), wypoziomowany na 2 m n.p.m. Za nim zaczyna się linia drzew — palmy, potem dżungla na wzniesieniach.

Miasteczko ma być wąskie i długie, przyciśnięte do wody — bo tam jest handel, rum i statki.

---

## Inwentarz assetów — co mamy do dyspozycji

### Budynki — modele samodzielne (1 budynek = 1 plik)

| # | Asset | Charakter |
|---|-------|-----------|
| 1 | `medieval_tavern.glb` | Duża tawerna (160 mesh-parts — jeden złożony budynek) |
| 2 | `middle_age_noble_house.glb` | Dom szlachecki / rezydencja |
| 3 | `medieval_blacksmith.glb` | Kuźnia |
| 4 | `game_ready_wooden_house.glb` | Porządny dom drewniany |
| 5 | `medieval_house.glb` | Dom średniowieczny (duży) |
| 6 | `medieval_house (1).glb` | Dom — złożony z 73 elementów ale stanowi jeden budynek |
| 7 | `medieval_house_again_other.glb` | Dom drewniany z murem pruskim — belki, cegła, dach (jeden budynek z 30 parts) |
| 8 | `medieval_house_another.glb` | Dom — jeden mesh, jednolity |
| 9 | `wooden_cabin.glb` | Kabina z bali (belki, ściany, komin, drzwi, szyby) |
| 10 | `wooden_log_cabin.glb` | Chata z bali (baza + drzwi) |
| 11 | `old_wooden_cabin__house.glb` | Stara drewniana chata |
| 12 | `wooden_home.glb` | Mały dom drewniany (1 mesh, lekki) |
| 13 | `wooden_house_3d_model__game-ready_environment.glb` | Dom drewniany game-ready |
| 14 | `thatched_hut.glb` | Chata ze strzechą |
| 15 | `forest_hut_gameready.glb` | Leśna chata |
| 16 | `old_forest_hut.glb` | Stara leśna chata |
| 17 | `stone_hut_high_poly.glb` | Chata kamienna (35 parts — detale jednego budynku) |
| 18 | `broken_house.glb` | Ruina / spalony dom |
| 19 | `outbuilding.glb` | Budynek gospodarczy (szopa/przybudówka) |
| 20 | `pirate_wooden_shack_-_mobile_game_asset.glb` | Piracka szopa (mała, lekka) |
| 21 | `medieval.glb` | Dom średniowieczny (piętra, schody, dach — jeden budynek) |

### 🔪 Do wycięcia: `low-poly_medieval_wooden_and_plaster_houses.glb` → 9 osobnych budynków

Ten plik zawiera **9 budynków** na odrębnych pozycjach, z których każdy jest osobnym nodem z własnymi meshami. Dzielą się na dwa wyraźne typy architektoniczne:

**Typ A — domy drewniane z murem pruskim** (drewno + tynk, okiennice):

| Node | Materiały | Uwagi |
|------|-----------|-------|
| `Cube.015` | WoodWindow, WoodSurface, WoodDoor, Woodwall, WoodenRoof, UnderRoof, **Thatch Roof** | Dach częściowo ze strzechą — najciekawszy wizualnie |
| `Cube.014` | WoodWindow, Woodwall, WoodDoor, WoodenRoof, UnderRoof, WoodSurface | Czysty drewniany dom |
| `Cube.008` | WoodWindow, Woodwall, WoodDoor, WoodSurface, WoodenRoof, UnderRoof | Wariant poprzedniego |
| `Cube.004` | WoodWindow, Woodwall, WoodDoor, WoodenRoof, UnderRoof | Prostsza wersja — brak okładziny |
| `Cube.002` | Woodwall, WoodDoor, WoodWindow, WoodenRoof, UnderRoof, **Thatch Roof** | Strzecha + drewno |

**Typ B — domy tynkowane / kamienne** (z panelami ściennymi):

| Node | Materiały | Uwagi |
|------|-----------|-------|
| `Cube.003` | Side01, Side02, Side04, UnderRoof, **TileRoof** | Dach dachówkowy — zamożniejszy |
| `Cube.001` | Side01, Side02, Side04, UnderRoof, **ThatchRoof** | Tynk + strzecha |
| `Cube.005` | Side01, Side04, UnderRoof, **TileRoof** | Mniejszy, dachówkowy |
| `Cube` | Side02, Side01, Side04, UnderRoof, **ThatchRoof** | Tynk + strzecha |

Plus `Base.002` (podest kamienny) i `Plane` (podłoże) — do odrzucenia lub użycia osobno.

### 🍺 Do wycięcia: `medieval_tavern_asset_pack.glb` → 18 osobnych rekwizytów

To **nie jest budynek** — to zestaw rekwizytów do wyposażenia tawerny i miasteczka:

| Rekwizyt | Mesh node |
|----------|-----------|
| **Beczka** | `Barrel_mesh` |
| **Skrzynia** | `Crate_mesh` |
| **Stołek** | `Stool_mesh` |
| **Kufer** | `Chest_mesh` |
| **Stół (wariant 1)** | `Table01_mesh` |
| **Stół (wariant 2)** | `Table02_mesh` |
| **Ława** | `Bench_mesh` |
| **Kufel** | `Mug_mesh` |
| **Miska** | `Bowl_mesh` |
| **Talerz** | `Plate_mesh` |
| **Kieliszek (3 warianty)** | `Glass01_mesh`, `Glass02_mesh`, `Glass03_mesh` |
| **Miecz** | `Sword_mesh` |
| **Halabarda** | `Halberd_mesh` |
| **Włócznia** | `Spear_mesh` |
| **Buława** | `Mace_mesh` |
| **Świeca** | `Candle_LP_mesh` |

To złoto — beczki i skrzynie mogą stać wszędzie, broń wisieć przy kuźni, a stoły i ławy trafią na plac i pod tawerną.

### 🍖 Do wycięcia: `medieval_tavern_table.glb` → stół z jedzeniem (16 elementów)

Stół z ławą, zastawiony jedzeniem. Osobne meshe:
`table`, `bench`, `mug`, `plate`, `cheese`, `beef`, `broken_egg`, `egg`, `eggs`, `jug`, `bowl`, `bowls`, `bread`, `cutlery`, `spoon`, `bread_slice`

Można użyć całości (zastawiony stół) albo wyciągnąć sam dzban (`jug`) czy chleb (`bread`) jako dekorację.

### Pozostałe dekoracje (osobne pliki)

| Asset | Rola |
|-------|------|
| `medieval_stone_well_-_game_prop.glb` | Studnia kamienna |
| `medieval_market_stall.glb` | Stragan handlowy |
| `medieval_stall.glb` | Mniejszy stragan |
| `the_butchers_table.glb` | Stół rzeźnika |
| `blacksmithing_tools..glb` | Narzędzia kowalskie (kowadło, młoty — jeden model) |
| `tavern_mug.glb` | Kufel (osobny) |

---

## Podłoże i trakty

Zamiast bruku — **piaszczysty trakt**, bardziej udeptany i ciemniejszy niż plaża, z fragmentami **drewnianych kładek / pomostów** w miejscach, gdzie piasek rozmaka od deszczu (jak przy studni i na głównym placu).

Tekstura nawierzchni: **mokry / ubity piasek** — ciemniejszy odcień tego, co już jest na plażach (vertex color terrain). Między budynkami naturalnie wydeptane ścieżki, nie projektowane ulice.

**NIE potrzebujemy** kocich łbów ani kamiennego bruku. To by wyglądało zbyt europejsko. Tortuga to piasek, deski i błoto.

---

## Układ miasteczka (z południa na północ)

Stoisz na kei, patrzysz w głąb lądu. Za plecami pomosty i statki, przed tobą — rząd budynków ciągnący się wzdłuż brzegu. Jest jeden główny trakt równoległy do kei, kilka metrów od niej — i od niego odbijają wąskie przejścia w głąb, do drugiego rzędu chat przy linii drzew.

---

### 🏚️ Strefa południowa (z ≈ −170 do −60)

Peryferie — biedniejsza część, chaotyczna, tu trafiają nowi przybysze.

#### Pierwszy rząd (przy kei):

| Pozycja | Asset | Rola |
|---------|-------|------|
| Narożnik południowy | `pirate_wooden_shack_-_mobile_game_asset.glb` | **Szopa rybacka** — najlichszy budynek, na wpół na plaży. Sieci, haki, zapach ryb. |
| Dalej na północ | `LP:Cube.004` *(low-poly, typ A — prosty drewniany)* | **Chata rybaka** — prosty dom drewniany, bez okładziny. Jedno z wejść od traktu. |
| Naprzeciwko szopy | `LP:Cube` *(low-poly, typ B — tynk + strzecha)* | **Dom handlarza** — tynkowane ściany, strzecha. Trochę lepszy od sąsiadów. |
| Bliżej centrum | `thatched_hut.glb` | **Chata ze strzechą** — palmowy dach, wąskie wejście. Dom bukaniera. |

#### Drugi rząd (przy drzewach):

| Pozycja | Asset | Rola |
|---------|-------|------|
| Na granicy dżungli | `forest_hut_gameready.glb` | **Leśna chata myśliwego** — łowca żółwi, ledwo widoczna od kei. |
| Dalej, przy ścieżce | `old_forest_hut.glb` | **Stara opuszczona chata** — dach się zapada. Warstwy czasu. |
| Między drzewami | `broken_house.glb` | **Ruina** — spalony dom. Pożar albo atak Hiszpanów. Nikt nie odbudowuje. |

#### Dekoracje w strefie:

- **2–3 beczki** (`Barrel_mesh` z tavern_asset_pack) — przy szopie i chacie
- **Skrzynia** (`Crate_mesh`) — przy drodze, porzucona

---

### 🏛️ Strefa centralna — Plac Targowy (z ≈ −60 do +60)

Serce Tortugi. Handel, rum, plotki, bijatyki.

#### Plac (ok. 25×30 m)

Otwarty, ubity piasek, otoczony budynkami z trzech stron (od kei otwarty — widok na port).

| Element | Asset | Opis |
|---------|-------|------|
| **Środek placu** | `medieval_stone_well_-_game_prop.glb` | **Studnia** — jedyne źródło słodkiej wody. Kamień koralowy, kołowrotka. „Spotkajmy się przy studni." |
| **Stragan wschodni** (bliżej kei) | `medieval_market_stall.glb` | **Stragan z towarem** — płótno na ramie, beczki z soloniną, zdobycze z okrętów. |
| **Stragan zachodni** (naprzeciwko) | `medieval_stall.glb` | **Stragan z rumem i tytoniem** — mniejszy, beczki. |
| **Stół rzeźnika** (przy straganie) | `the_butchers_table.glb` | **Stół do obróbki mięsa** — żółwie, dziczyzna. Bukanierzy = „suszyciele mięsa". |
| **Zastawiony stół** (na placu) | `medieval_tavern_table.glb` *(cały zestaw)* | **Stół biesiadny** — ława, kufle, chleb, ser, mięso pod gołym niebem. |
| **Drugi stół** (pod tawerną) | `Table01_mesh` + `Bench_mesh` + `Stool_mesh` *(z asset pack)* | **Stół i ławy z tawernianego zestawu** — prostsze, dostawione pod ścianę tawerny. |
| **Beczki** (rozrzucone po placu) | 3–4× `Barrel_mesh` *(z asset pack)* | Beczki z rumem, woda, solonina. |
| **Skrzynie** (przy straganach) | 2× `Crate_mesh` *(z asset pack)* | Towary ze zdobyczy. |
| **Kufel porzucony** | `tavern_mug.glb` | Klimat — leży na ziemi przy studni. |

#### Budynki wokół placu:

| Pozycja | Asset | Rola |
|---------|-------|------|
| **Zachodni brzeg** (najgłębiej w ląd, tyłem do drzew) | `medieval_tavern.glb` | **Tawerna „Pod Czarną Flagą"** — największy budynek. Drewno, piętro, ganek. Front na plac i studnię. Serce Tortugi. |
| **Północny narożnik placu** | `middle_age_noble_house.glb` | **Dom gubernatora** — jedyny budynek z aspiracjami. Kamień koralowy + drewno. Balkon na port. |
| **Południowy narożnik placu** | `medieval_blacksmith.glb` | **Kuźnia** — ogień, kowadło. Na skraju placu (iskry!), ale blisko (każdy pirat potrzebuje). |
| **Przy kuźni, na zewnątrz** | `blacksmithing_tools..glb` | **Narzędzia kowalskie** — kowadło, młoty, obcęgi. Przy ścianie kuźni. |
| **Obok tawerny, od południa** | `LP:Cube.015` *(typ A — drewno + strzecha, najładniejszy)* | **Oberża / kwatera** — piętro, strzecha, okiennice. Gości tawerny, którzy jeszcze stoją na nogach. |
| **Obok gubernatora, od północy** | `LP:Cube.003` *(typ B — tynk + dachówka)* | **Dom bogatszego kupca** — tynkowane ściany, dach dachówkowy. Aspiruje do zamożności. |

#### Dekoracje przy kuźni:

- **Miecz** (`Sword_mesh`) i **halabarda** (`Halberd_mesh`) z asset pack — oparte o ścianę, czekają na naprawę
- **Włócznia** (`Spear_mesh`) — wetknięta w piasek obok

#### Dekoracje przy tawernie:

- **Beczki** (2× `Barrel_mesh`) — przed wejściem
- **Świeca** (`Candle_LP_mesh`) — na stole pod ścianą
- **Kufer** (`Chest_mesh`) — w narożniku, zakłada się że z rumem
- **Dzban** (`jug` z tavern_table) — na stole lub progu

---

### 🏘️ Strefa północna (z ≈ +60 do +170)

Gęstsza, bardziej ustabilizowana zabudowa — tu mieszkają dłużej osiedleni.

#### Pierwszy rząd (przy kei):

| Pozycja | Asset | Rola |
|---------|-------|------|
| Tuż za placem | `game_ready_wooden_house.glb` | **Dom cieśli okrętowego** — porządny, zarabia dobrze. |
| Dalej | `medieval_house.glb` | **Składnica / magazyn portowy** — tu trafia zdobycz, zanim ją podzielą. |
| Następny | `LP:Cube.014` *(typ A — czysty drewniany)* | **Dom kartografa** — schludny, z mapami w środku (kto wie). |
| Dalej | `LP:Cube.008` *(typ A — wariant)* | **Dom powroźnika** — wokół liny i sieci. |
| Dalej | `medieval_house_another.glb` | **Dom starszego pirata** — tu od lat, solidny. |
| Końcówka północna | `LP:Cube.005` *(typ B — mniejszy, dachówka)* | **Dom krawca żaglowego** — mały, ale z dachówką. Ma się dobrze. |

#### Drugi rząd (przy drzewach):

| Pozycja | Asset | Rola |
|---------|-------|------|
| Za tawerną | `outbuilding.glb` | **Zaplecze tawerny / kuchnia** — budynek gospodarczy, beczki, zapasy. |
| Środek, przy drzewach | `stone_hut_high_poly.glb` | **Prochownia** — jedyny budynek z kamienia. Proch trzymany daleko od ognia. Grube ściany, bez okien. |
| Za składnicą | `wooden_cabin.glb` | **Kabina z bali** — solidna, grube ściany, komin. Ktoś ją budował na stałe. |
| Dalej | `old_wooden_cabin__house.glb` | **Stara chata** — ciemne drewno, mech. Z czasów pierwszych osadników. |
| Przy linii drzew | `LP:Cube.002` *(typ A — drewno + strzecha)* | **Chata zielarki** — na granicy dżungli, wśród roślin. |

#### Strona wschodnia (bliżej kei, poza głównym traktem):

| Pozycja | Asset | Rola |
|---------|-------|------|
| Przy końcu kei | `wooden_log_cabin.glb` | **Chata z bali samotnika** — ostatni budynek. Tu mieszka ktoś, kto lubi spokój. |
| Obok | `wooden_home.glb` | **Mały dom** — prosty, schludny. Wyszedł z piractwa. |

---

### Budynki wypełniające (rozrzucone po miasteczku)

Te modele wypełniają luki, żeby miasteczko nie miało pustych „dziur":

| Asset | Rola | Gdzie |
|-------|------|-------|
| `medieval.glb` | **Dom z piętrami i schodami** — solidna budowla | Strefa centralna, obok placu |
| `medieval_house (1).glb` | **Złożony dom** (73 elementy — bardzo bogaty w detale) | Strefa północna, pierwszy rząd |
| `medieval_house_again_other.glb` | **Dom z murem pruskim** — belki, cegła, dach | Strefa centralna, drugi rząd |
| `wooden_house_3d_model__game-ready_environment.glb` | **Dom drewniany game-ready** | Strefa północna |
| `LP:Cube.001` *(typ B — tynk + strzecha)* | **Dom tynkowany** — wariant | Strefa południowa |

---

### Dekoracje — plan rozmieszczenia rekwizytów z asset_pack

| Rekwizyt | Ilość | Gdzie |
|----------|-------|-------|
| `Barrel_mesh` | 8–10 | Wszędzie — pod ścianami, przy straganach, w przejściach, przy tawernie |
| `Crate_mesh` | 5–6 | Przy magazynie, straganach, na kei, w przejściach |
| `Chest_mesh` | 2–3 | Przy tawernie, pod gubernatorem, przy składnicy |
| `Table02_mesh` | 1–2 | Na zewnątrz tawerny, na placu |
| `Bench_mesh` | 2–3 | Przy stołach, pod ścianami |
| `Stool_mesh` | 3–4 | Rozrzucone — pod tawerną, na placu, przy kuźni |
| `Mug_mesh` | 4–5 | Na stołach, przy studni, na ziemi |
| `Sword_mesh` | 1 | Przy kuźni |
| `Halberd_mesh` | 1 | Przy kuźni |
| `Spear_mesh` | 1 | Wetknięta w piasek |
| `Mace_mesh` | 1 | W skrzyni lub przy kuźni |
| `Candle_LP_mesh` | 2–3 | Na stołach, w oknach |
| `Bowl_mesh`, `Plate_mesh`, `Glass01-03` | po 1–2 | Na stołach, dekoracja |

---

## Zasady rozmieszczenia

1. **Chaos jest zamierzony** — budynki lekko obrócone (±5–15°), przesunięte, nierówne. Nikt tu nie miał geodety.

2. **Jeden główny trakt** (~4 m szer.) biegnie równolegle do kei, ok. 8–12 m od niej. Ubity piasek, gdzieniegdzie deska.

3. **Wąskie przejścia** (1.5–3 m) między budynkami prowadzą z traktu do drugiego rzędu.

4. **Plac targowy** to jedyna przestrzeń, gdzie trakt się rozszerza — ok. 25×30 m otwartej przestrzeni ze studnią, straganami, stołami.

5. **Budynki z low-poly pack rozdzielone i rozrzucone** po całym miasteczku — mieszają się z innymi modelami, dodając różnorodność. 5 drewnianych i 4 tynkowane dają naturalny kontrast „biedniejszy/zamożniejszy" w różnych strefach.

6. **Beczki, skrzynie, broń z asset pack** — rozsiane jako życie miasteczka. Nie w regularnych odstępach, lecz tam, gdzie je ktoś zostawił.

7. **Odległość między budynkami**: min. 2 m (przejście), typowo 3–5 m. Na placu — 10–15 m otwartej przestrzeni.

---

## Podsumowanie: bilans assetów

| Kategoria | Źródło | Ilość |
|-----------|--------|-------|
| Budynki samodzielne | Osobne pliki GLB | 21 |
| Budynki do wycięcia | `low-poly_medieval_wooden_and_plaster_houses.glb` | +9 (= **30 budynków**) |
| Rekwizyty do wycięcia | `medieval_tavern_asset_pack.glb` | +18 |
| Rekwizyty do wycięcia | `medieval_tavern_table.glb` | +16 (stół z jedzeniem) |
| Rekwizyty samodzielne | Studnia, stragany, stół rzeźnika, kufel, narzędzia kowalskie | 6 |
| **Razem** | | **~70 unikalnych obiektów** |

30 budynków na ~350 m nabrzeża (z których nie wszystkie trzeba użyć) + kilkadziesiąt rekwizytów dekoracyjnych daje więcej niż wystarczająco gęstą zabudowę pirackiego miasteczka.
