/*
 * The world's own state, kept between sessions: what has happened at places — guards killed, treasure
 * taken — as opposed to the player's (his inventory) or the chart's (what he has discovered). Each place
 * that keeps some registers its storage key here, so it can all be wiped at once (?worldStateReset).
 */
export const WORLD_KEYS = [
  /** the Skull Island: its guards, its gold, its respawn clock */
  'lagoon.skull',
];

/** every place as at the very start of the world */
export function resetWorldState(): void {
  for (const k of WORLD_KEYS) try { localStorage.removeItem(k); } catch { /* storage unavailable */ }
}
