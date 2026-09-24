/*
 * Names for the places on the chart, derived from their position (so a world always has the same names).
 * Genitive nouns fit any kind; feminine adjectives only the feminine kinds (wyspa, skała, łacha).
 */

const GENITIVE = [
  'Czaszki', 'Mew', 'Syreny', 'Wraków', 'Kapitana Flinta', 'Złotego Piasku', 'Szeptów', 'Kraba', 'Zatopionego Dzwonu',
  'Czarnej Bandery', 'Pelikana', 'Żółwia', 'Przemytników', 'Latarnika', 'Kormorana', 'Barakudy', 'Bosmana', 'Delfina',
  'Starego Rumu', 'Wisielca', 'Trzech Palm', 'Martwego Kapitana', 'Mgieł', 'Kotwicy', 'Papugi', 'Dublonów', 'Rekina',
  'Kompasu', 'Sztormów', 'Perłopławów', 'Ośmiornicy', 'Cichej Wody',
];
const FEMININE = [
  'Rumowa', 'Samotna', 'Kokosowa', 'Burzowa', 'Perłowa', 'Sztormowa', 'Przeklęta', 'Zielona', 'Wietrzna', 'Mglista',
  'Złota', 'Czerwona', 'Zapomniana', 'Kręta', 'Dzika', 'Srebrna',
];
const KIND: Record<string, string> = { island: 'Wyspa', cay: 'Łacha', rock: 'Skała', atoll: 'Atol' };

function hash(x: number, z: number): number {
  let h = Math.imul(Math.round(x) | 0, 2654435761) ^ Math.imul(Math.round(z) | 0, 40503);
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h = Math.imul(h ^ (h >>> 13), 3266489917);
  return (h ^ (h >>> 16)) >>> 0;
}

export function placeName(kind: string, x: number, z: number): string {
  if (kind === 'home') return 'Laguna Startowa';
  const h = hash(x, z);
  const noun = KIND[kind] ?? 'Wyspa';
  // feminine kinds get an adjective about a third of the time
  if (kind !== 'atoll' && h % 3 === 0) return `${noun} ${FEMININE[(h >>> 4) % FEMININE.length]}`;
  return `${noun} ${GENITIVE[(h >>> 8) % GENITIVE.length]}`;
}
