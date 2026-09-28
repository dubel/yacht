# Wymagania wstępne i instalacja środowiska Unity na Omarchy Quattro (Arch Linux)

Niniejszy poradnik krok po kroku opisuje konfigurację środowiska deweloperskiego Unity na systemie **Omarchy Quattro** (dystrybucja oparta na **Arch Linux**, środowisko **Hyprland / Wayland**) na laptopie **Framework Laptop 13 (2025)** ze zintegrowanym układem graficznym (AMD Radeon 780M / 890M lub Intel Arc) i 96 GB RAM.

---

## 1. Weryfikacja systemu i sterowników Vulkan / Mesa

Silnik Unity 6 oraz potok URP na Linuksie działają natywnie w oparciu o API **Vulkan**. Wymagane są aktualne sterowniki Mesa oraz ładowarka Vulkan ICD.

### Krok 1.1: Instalacja sterowników GPU

W zależności od wariantu procesora w Twoim Framework 13, zainstaluj odpowiedni pakiet Vulkan:

#### Dla procesorów AMD Ryzen (Radeon 780M / 890M) — zalecane:
```bash
sudo pacman -S --needed mesa vulkan-radeon lib32-vulkan-radeon vulkan-icd-loader lib32-vulkan-icd-loader vulkan-tools
```

#### Dla procesorów Intel Core Ultra (Intel Arc Graphics):
```bash
sudo pacman -S --needed mesa vulkan-intel lib32-vulkan-intel vulkan-icd-loader lib32-vulkan-icd-loader vulkan-tools
```

### Krok 1.2: Weryfikacja obsługi Vulkan
Uruchom w terminalu:
```bash
vulkaninfo --summary
```
Powinieneś zobaczyć swój układ graficzny (np. `RADV GFX1103 / Radeon 780M` lub `Intel(R) Graphics`) ze statusem `VULKAN 1.3`.

---

## 2. Pakiety systemowe, biblioteki C++ i Git LFS

Unity Editor oraz kompilator IL2CPP wymagają zestawu standardowych bibliotek systemowych:

```bash
sudo pacman -S --needed \
    base-devel \
    git \
    git-lfs \
    clang \
    cmake \
    libnotify \
    openssl \
    nss \
    libxcursor \
    libxrandr \
    libxi \
    libxss \
    glu
```

Zainicjalizuj Git LFS (niezbędne do przechowywania dużych plików `.glb`, tekstur i dźwięków w repozytorium):
```bash
git lfs install
```

---

## 3. Środowisko .NET i Mono

W Unity 6 zalecany jest systemowy SDK .NET do integracji z nowoczesnymi IDE (Rider / VS Code):

```bash
sudo pacman -S --needed dotnet-sdk dotnet-runtime mono msbuild
```

Sprawdź wersję .NET:
```bash
dotnet --version
```

---

## 4. Instalacja Unity Hub i Unity 6 LTS

Najwygodniejszym i zalecanym sposobem instalacji na Arch Linux / Omarchy jest pakiet z repozytorium AUR zarządzany przez `yay`.

### Krok 4.1: Instalacja Unity Hub
```bash
yay -S --needed unityhub
```
*(Alternatywnie dostępny jest pakiet binarny `unityhub-bin`).*

### Krok 4.2: Uruchomienie i logowanie
Uruchom Unity Hub z menu aplikacji lub z terminala:
```bash
unityhub
```
- Zaloguj się na konto Unity ID (lub utwórz darmowe konto personal).
- Zaakceptuj darmową licencję Personal (*Preferences → Licenses → Add license → Get a free Personal license*).

### Krok 4.3: Instalacja edytora Unity 6 (6000.0.x LTS)
W zakładce **Installs → Install Editor**:
1. Wybierz wersję **Unity 6 (6000.0.x LTS)** – oficjalnie wspieraną, zoptymalizowaną pod URP i Vulkan na Linuksie.
2. Zaznacz wymagane moduły:
   - **Linux Build Support (IL2CPP)**
   - **Documentation** (przydatne offline)
   - *(Opcjonalnie)* **Windows Build Support (Mono)** – jeśli planujesz eksportować buildy na Windows.
   - *(Opcjonalnie)* **WebGL Build Support** – jeśli będziesz chciał porównać build natywny z wersją przeglądarkową.

---

## 5. Wybór IDE i integracja z Unity

Dla systemu Arch Linux / Omarchy istnieją dwa optymalne środowiska:

### Opcja A (Zdecydowanie zalecana): JetBrains Rider
Rider oferuje bezkonkurencyjną integrację z Unity, podgląd shaderów HLSL, analizę alokacji pamięci na żywo oraz autouzupełnianie API Unity.

Instalacja przez JetBrains Toolbox lub bezpośrednio z AUR:
```bash
yay -S --needed jetbrains-rider
```
W Unity przejdź do: `Edit → Preferences → External Tools → External Script Editor` i wybierz **Rider**.

### Opcja B: Visual Studio Code
Jeśli preferujesz lżejsze środowisko:
```bash
sudo pacman -S --needed code
```
W VS Code zainstaluj oficjalne rozszerzenia:
- `C# Dev Kit` (Microsoft)
- `Unity` (Microsoft)

---

## 6. Instalacja Blendera i automatyzacja przez Blender CLI dla LLM

Blender jest kluczowym narzędziem wspierającym pipeline 3D w grach. W Unity posiadanie zainstalowanego Blendera w systemie pozwala m.in. na **bezpośrednie przeciąganie plików `.blend` do projektu** (Unity automatycznie wywołuje Blendera w tle do konwersji).

### Krok 6.1: Instalacja Blendera
Na Arch Linux / Omarchy instalujemy Blendera z oficjalnego repozytorium:
```bash
sudo pacman -S --needed blender
```

Weryfikacja wersji w konsoli:
```bash
blender --version
```

### Krok 6.2: Potęga Blender CLI i Python API (`bpy`) dla agenta AI

Blender posiada kompletne środowisko Pythona oraz pełny tryb bezgłowy (**headless**). Oznacza to, że agent AI (LLM) może manipulować modelami 3D, optymalizować geometrię i przygotowywać kolizje **bez konieczności otwierania interfejsu graficznego**.

Podstawowe wywołanie Blendera w tle:
```bash
blender -b [plik.blend] -P skrypt.py
```
- `-b` (lub `--background`) – uruchomienie bez GUI.
- `-P` (lub `--python`) – wykonanie skryptu Python.
- `--python-expr "import bpy; ..."` – wykonanie jednoliniowego polecenia.

#### Przykłady zautomatyzowanych zadań dla agenta:

1. **Automatyczne generowanie siatek kolizji (Convex Hull):**
   Agent pisze jednolinijkowy skrypt Pythona tworzący uproszczony kadłub kolizyjny dla Unity:
   ```bash
   blender -b model.glb --python-expr "import bpy; bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.modifier_add(type='DECIMATE'); bpy.context.object.modifiers['Decimate'].ratio = 0.1; bpy.ops.export_scene.gltf(filepath='model_collision.glb')"
   ```

2. **Automatyczne generowanie poziomów szczegółowości (LODs):**
   Zamiast ręcznie zmniejszać liczbę wielokątów w modelach Tortugi, agent uruchamia skrypt redukujący siatkę o 50% dla LOD1 i o 75% dla LOD2.

3. **Naprawa punktów zaczepienia (Pivot / Origin):**
   W budynkach i palmach punkt obrotu musi znajdować się dokładnie na dole modelu na poziomie gruntu (Z=0 / Y=0). Agent może hurtowo przesunąć punkt bazowy we wszystkich pobranych modelach:
   ```python
   # tools/fix_pivot.py
   import bpy
   for obj in bpy.context.scene.objects:
       if obj.type == 'MESH':
           bpy.context.view_layer.objects.active = obj
           bpy.ops.object.origin_set(type='ORIGIN_BOTTOM', center='BOUNDS')
   bpy.ops.export_scene.gltf(filepath='fixed_model.glb')
   ```

4. **Headless render podglądów (Multimodal Vision):**
   Agent może wyrenderować zrzut modelu z 4 stron do pliku `.png`, obejrzeć go narzędziami wizyjnymi i ocenić jakość siatki przed importem do Unity.

---

## 7. Konfiguracja pod Hyprland / Wayland (Omarchy Quattro)

Edytor Unity działa pod Linuksem jako aplikacja **X11 / Xwayland**. W środowisku kafelkowym Hyprland warto zastosować kilka sprawdzonych ustawień:

### Krok 7.1: Reguły okien w Hyprland (`~/.config/hypr/hyprland.conf`)
Unity otwiera wiele okien dialogowych, próbników kolorów i menu kontekstowych. Aby zapobiec ich kafelkowaniu i zniekształceniom, dodaj do pliku konfiguracyjnego Hyprlanda:

```ini
# Reguły dla Unity Editor i Unity Hub
windowrulev2 = float, class:^(Unity)$, title:^(Opening.*)$
windowrulev2 = float, class:^(Unity)$, title:^(Color)$
windowrulev2 = float, class:^(Unity)$, title:^(Hold On)$
windowrulev2 = float, class:^(Unity)$, title:^(Progress)$
windowrulev2 = float, class:^(Unity)$, title:^(Select.*)$
windowrulev2 = float, class:^(unityhub)$
```

### Krok 7.2: Skalowanie HiDPI (ekran Framework 13 2.8K)
Matryca Framework 13 posiada wysoką rozdzielczość (2880×1920 lub 2256×1504).
- Jeśli interfejs Unity Editora jest zbyt mały, przejdź w edytorze do:
  `Edit → Preferences → UI Scaling` i ustaw skalowanie na **125%** lub **150%**.
- W przypadku problemów z ostrością czcionek w Xwayland, upewnij się, że w konfiguracji Hyprlanda włączona jest obsługa skalowania Xwayland:
  ```ini
  xwayland {
      force_zero_scaling = true
  }
  ```

### Krok 7.3: Przechwytywanie kursora myszy (FPV / Mouselook)
W trybie pierwszej osoby (`DeckWalker` / `LandWalker`) gra blokuje kursor w centrum ekranu (`Cursor.lockState = CursorLockMode.Locked`).
Pod Hyprlandem upewnij się, że nie masz globalnego skrótu kolidującego z kliknięciem lewym/prawym przyciskiem myszy w oknie gry.

---

## 8. Optymalizacja zużycia energii i chłodzenia na Framework 13

Dzięki 96 GB pamięci RAM laptop nie korzysta z dyskowego swapu, co gwarantuje błyskawiczne czasy reakcji. Aby jednak zapobiec niepotrzebnemu rozgrzewaniu 13-calowej obudowy:

1. **Ograniczenie klatkażu edytora w tle:**
   W Unity przejdź do: `Edit → Project Settings → Quality` i upewnij się, że VSync jest włączony w widoku edytora, lub utwórz prosty skrypt w projekcie:
   ```csharp
   Application.targetFrameRate = 60;
   ```
2. **Profil zasilania w Omarchy:**
   Używaj profilu zbalansowanego (`balanced`) podczas pracy na baterii:
   ```bash
   powerprofilesctl set balanced
   ```

---

## 9. Testowa weryfikacja środowiska

Aby upewnić się, że wszystko działa:
1. Uruchom `unityhub`.
2. Kliknij **New Project** → wybierz szablon **3D (URP) - Universal Render Pipeline**.
3. Jako nazwę podaj np. `Lagoon-Unity-Sandbox`.
4. Po załadowaniu edytora sprawdź w konsoli logów (`Console`), czy silnik używa backendu **Vulkan** (pierwsze linie logu: `GfxDevice: creating device client; threaded=1; driver=Vulkan`).
5. Uruchom scenę przyciskiem **Play** – klatkaż powinien wynosić stabilne 60–120 FPS.

