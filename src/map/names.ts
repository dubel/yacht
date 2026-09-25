/*
 * Names for the places of the procedural world — unique, not merely likely to differ.
 *
 * A name is "<kind> [<adjective>] <noun>", the noun in the genitive with the adjective agreeing with it
 * (Atol Złotego Kompasu, Wyspa Pijanej Syreny, Łacha Zatopionych Wraków…): NOUNS × (ADJECTIVES + 1) names
 * per kind, about 10 000. Each place gets a slot from its world cell's position modulo a period P and its order
 * among the cell's places of that kind, so the slots in any window of P × P cells — wherever it lies — are all
 * different; a permutation of the name space (an affine map, per world seed and kind) turns slots into names.
 * So within ~80 km for islands (P·2 km), ~200 km for atolls, no two places of a kind share a name. It is all a
 * pure function of the world, so the chart and the spyglass always agree.
 */

type Gender = 'm' | 'f' | 'n' | 'p';

// genitive, with gender (m and n take the same adjective ending)
const NOUNS: [string, Gender][] = [
  ['Kompasu', 'm'], ['Kraba', 'm'], ['Rekina', 'm'], ['Delfina', 'm'], ['Pelikana', 'm'], ['Kormorana', 'm'], ['Albatrosa', 'm'],
  ['Żółwia', 'm'], ['Wieloryba', 'm'], ['Sztormu', 'm'], ['Wiatru', 'm'], ['Księżyca', 'm'], ['Kapitana', 'm'], ['Bosmana', 'm'],
  ['Korsarza', 'm'], ['Pirata', 'm'], ['Kupca', 'm'], ['Wisielca', 'm'], ['Latarnika', 'm'], ['Rybaka', 'm'], ['Dzwonu', 'm'],
  ['Skarbu', 'm'], ['Masztu', 'm'], ['Steru', 'm'], ['Kordelasa', 'm'], ['Muszkietu', 'm'], ['Sztyletu', 'm'], ['Rumu', 'm'],
  ['Syreny', 'f'], ['Mewy', 'f'], ['Papugi', 'f'], ['Ośmiornicy', 'f'], ['Barakudy', 'f'], ['Muszli', 'f'], ['Perły', 'f'],
  ['Kotwicy', 'f'], ['Bandery', 'f'], ['Szabli', 'f'], ['Wdowy', 'f'], ['Mgły', 'f'], ['Burzy', 'f'], ['Czaszki', 'f'],
  ['Beczki', 'f'], ['Klątwy', 'f'], ['Fregaty', 'f'], ['Galery', 'f'], ['Karaweli', 'f'], ['Szalupy', 'f'],
  ['Słońca', 'n'], ['Oka', 'n'], ['Serca', 'n'], ['Złota', 'n'], ['Srebra', 'n'], ['Widma', 'n'], ['Echa', 'n'],
  ['Admirała', 'm'], ['Kucharza', 'm'], ['Cieśli', 'm'], ['Nawigatora', 'm'], ['Szypra', 'm'], ['Kapelana', 'm'], ['Kruka', 'm'],
  ['Sępa', 'm'], ['Krakena', 'm'], ['Węża', 'm'], ['Smoka', 'm'], ['Lwa', 'm'], ['Tygrysa', 'm'], ['Jastrzębia', 'm'], ['Orła', 'm'],
  ['Koguta', 'm'], ['Szczura', 'm'], ['Piasku', 'm'], ['Kamienia', 'm'], ['Ognia', 'm'], ['Grotu', 'm'], ['Kliwra', 'm'],
  ['Bukszprytu', 'm'], ['Kabestanu', 'm'], ['Bursztynu', 'm'], ['Korala', 'm'], ['Hebanu', 'm'], ['Tytoniu', 'm'], ['Cynamonu', 'm'],
  ['Imbiru', 'm'], ['Pieprzu', 'm'], ['Harpuna', 'm'], ['Topora', 'm'],
  ['Małpy', 'f'], ['Kozy', 'f'], ['Ryby', 'f'], ['Mureny', 'f'], ['Płaszczki', 'f'], ['Meduzy', 'f'], ['Mątwy', 'f'], ['Langusty', 'f'],
  ['Krewetki', 'f'], ['Wanilii', 'f'], ['Herbaty', 'f'], ['Kawy', 'f'], ['Soli', 'f'], ['Kości', 'f'], ['Wyroczni', 'f'],
  ['Królowej', 'f'], ['Księżniczki', 'f'], ['Czarownicy', 'f'], ['Narzeczonej', 'f'], ['Latarni', 'f'], ['Lampy', 'f'],
  ['Świecy', 'f'], ['Mapy', 'f'], ['Busoli', 'f'], ['Lunety', 'f'], ['Klepsydry', 'f'],
  ['Działa', 'n'], ['Wiosła', 'n'], ['Koła', 'n'], ['Lustra', 'n'], ['Pióra', 'n'], ['Jaja', 'n'], ['Żelaza', 'n'],
  ['Wraków', 'p'], ['Dublonów', 'p'], ['Przemytników', 'p'], ['Rozbitków', 'p'], ['Korsarzy', 'p'], ['Szeptów', 'p'], ['Łez', 'p'],
  ['Łańcuchów', 'p'], ['Kajdan', 'p'], ['Monet', 'p'], ['Pereł', 'p'], ['Diabłów', 'p'], ['Aniołów', 'p'], ['Wilków', 'p'],
  ['Kapitanów', 'p'], ['Topielców', 'p'], ['Kruków', 'p'], ['Rekinów', 'p'], ['Żółwi', 'p'], ['Palm', 'p'], ['Dzwonów', 'p'],
  ['Beczek', 'p'], ['Masztów', 'p'],
];

/** an adjective's genitive forms from its stem: m/n -ego, f -ej, p -ych (after k/g: -iego, -iej, -ich; soft
 *  stems ending in -i, like ostatni: -ego, -ej, -ch) */
const adj = (stem: string): [string, string, string] => {
  if (/i$/.test(stem)) return [`${stem}ego`, `${stem}ej`, `${stem}ch`];
  const soft = /[kg]$/.test(stem);
  return soft ? [`${stem}iego`, `${stem}iej`, `${stem}ich`] : [`${stem}ego`, `${stem}ej`, `${stem}ych`];
};
const ADJECTIVES = ['Czarn', 'Złot', 'Srebrn', 'Star', 'Zatopion', 'Przeklęt', 'Samotn', 'Krwaw', 'Szalon', 'Ślep', 'Dzik', 'Zielon',
  'Biał', 'Czerwon', 'Ognist', 'Zapomnian', 'Zaginion', 'Śpiąc', 'Milcząc', 'Wieczn', 'Martw', 'Szczęśliw', 'Pijan', 'Rud', 'Blad',
  'Mroczn', 'Burzow', 'Morsk', 'Północn', 'Południow', 'Dalek', 'Ukryt', 'Rozbit', 'Królewsk', 'Hiszpańsk', 'Wielk', 'Upiorn',
  'Żelazn', 'Kamienn', 'Błękitn', 'Szmaragdow', 'Purpurow', 'Szkarłatn', 'Zdradzieck', 'Łys', 'Garbat', 'Jednook', 'Kulaw', 'Ponur',
  'Dumn', 'Wesoł', 'Smutn', 'Głodn', 'Chciw', 'Tajemnicz', 'Zaklęt', 'Ostatni', 'Pierwsz', 'Siódm', 'Złaman', 'Spalon', 'Porzucon',
  'Nawiedzon', 'Mglist', 'Wietrzn', 'Słon', 'Gorzk', 'Słodk', 'Sekretn'].map(adj);

const KIND: Record<string, string> = { island: 'Wyspa', cay: 'Łacha', rock: 'Skała', atoll: 'Atol' };
const SPACE = NOUNS.length * (ADJECTIVES.length + 1);

/** slots per world cell: places of one kind a cell can hold (an atoll at most one) */
export const slotsPerCell = (kind: string) => (kind === 'atoll' ? 1 : 6);
/** the naming period in cells: no two places of a kind within any window this many cells across share a name */
export const namePeriod = (kind: string) => Math.floor(Math.sqrt(SPACE / slotsPerCell(kind)));

function hash(...v: number[]): number {
  let h = 0x2545f491;
  for (const x of v) { h = Math.imul(h ^ (x | 0), 0x9e3779b1); h ^= h >>> 15; }
  return (h ^ (h >>> 13)) >>> 0;
}
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/**
 * The name of the `order`-th place of `kind` in world cell (i, j). Its slot — the cell's position modulo the
 * naming period and the order within the cell — is unique in every window of namePeriod(kind)² cells, and a
 * permutation of the name space (one per world seed and kind) turns it into a name.
 */
export function placeName(kind: string, i: number, j: number, order: number, seed: number): string {
  if (kind === 'home') return 'Laguna Startowa';
  const P = namePeriod(kind), per = slotsPerCell(kind);
  const mi = ((i % P) + P) % P, mj = ((j % P) + P) % P;
  const slot = (mi * P + mj) * per + Math.min(order, per - 1);
  // n → (a·n + b) mod SPACE, a coprime to SPACE: a bijection, so distinct slots get distinct names
  const k = Object.keys(KIND).indexOf(kind);
  let a = 1 + (hash(seed, k, 1) % (SPACE - 1));
  while (gcd(a, SPACE) !== 1) a = (a + 1) % SPACE || 1;
  const b = hash(seed, k, 2) % SPACE;
  const idx = ((a * slot) % SPACE + b) % SPACE;
  const [noun, g] = NOUNS[idx % NOUNS.length];
  const ai = Math.floor(idx / NOUNS.length);
  const form = g === 'f' ? 1 : g === 'p' ? 2 : 0;
  return `${KIND[kind] ?? 'Wyspa'} ${ai === 0 ? '' : ADJECTIVES[ai - 1][form] + ' '}${noun}`;
}

/** how many distinct names a kind has (for tests) */
export const NAME_SPACE = SPACE;
