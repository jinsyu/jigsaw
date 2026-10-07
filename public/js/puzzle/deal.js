// Dealing tray pieces. Shared by the screens (demo store, tray order) and the rt server
// (start of a puzzle, trays of students gone for a minute), so it stays free of DOM APIs.
import { rng } from './geometry.js';

// Fisher-Yates over a copy of `list`; random() returns [0, 1).
export function shuffle(list, random) {
  const order = [...list];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

// Deterministic shuffle so a demo always deals the same tray order.
export function shuffledPieces(count, seed) {
  return shuffle(
    Array.from({ length: count }, (_, i) => i),
    rng(seed),
  );
}

/**
 * Deals `pieces` round-robin in a random order. Takers with fewer pieces come first (ties
 * in random order), so the numbers dealt differ by at most one and empty trays fill first.
 * @param {number[]} pieces
 * @param {Array<{ id: string, count: number }>} takers  count = pieces already in the tray
 * @param {() => number} random
 * @returns {Record<string, number[]>} pieces dealt per taker id ({} when there are no takers)
 */
export function dealEvenly(pieces, takers, random) {
  if (takers.length === 0) return {};
  const order = shuffle(takers, random).sort((a, b) => a.count - b.count);
  const dealt = Object.fromEntries(order.map((t) => [t.id, []]));
  shuffle(pieces, random).forEach((piece, i) => dealt[order[i % order.length].id].push(piece));
  return dealt;
}
