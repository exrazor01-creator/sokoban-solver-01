// Sokoban solver: push-optimal breadth-first search over pushes, solved room by room.
//
// Approach (own implementation):
//   1. Parse the XSB level.
//   2. Split it into rooms: the hallway is one square wide, so the dead squares of the
//      player's row (squares a box alone can never be pushed from to a goal) cut the
//      floor into components; each component holding boxes is a room. Boxes never leave
//      their room, so the rooms' push optima add up to the level's.
//   3. Solve each room push-optimally with a BFS over pushes. A state is the sorted box
//      squares plus the player's reachable region (named by its lowest square), so the
//      first solved state the BFS meets is push-optimal. Two prunings keep the search
//      small, and neither can prune a solvable state: dead squares (reverse reachability
//      from the goals, pulling a box back) and frozen 2x2 blocks of walls and boxes with
//      a box off its goal.
//   4. Stitch the rooms together: walk the player (shortest walk, BFS) to the next push
//      square, push, and continue. Other rooms' boxes stand as walls while one room is
//      solved (on their goals once their room is done).
//   5. If room decomposition or a room search ever fails, fall back to a push search
//      over the whole level; if that fails too, answer with an empty (valid) solution
//      rather than crashing or leaving an instance unanswered.
//
// Determinism: fixed direction order everywhere, no clock, no randomness. Work is
// budgeted by a state cap per search, never by time, so two runs output identical bytes.
//
// Node built-ins only; erasable TypeScript syntax only (runs under `node main.ts`).

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** Max BFS states kept by one push search: a work budget, never the clock. */
const MAX_STATES = 250_000;

/** The four directions in fixed order: up, down, left, right. */
interface Dir {
  dx: number;
  dy: number;
  step: string; // the letter for a plain step
  push: string; // the letter for a step that pushes a box
}
const DIRS: Dir[] = [
  { dx: 0, dy: -1, step: 'u', push: 'U' },
  { dx: 0, dy: 1, step: 'd', push: 'D' },
  { dx: -1, dy: 0, step: 'l', push: 'L' },
  { dx: 1, dy: 0, step: 'r', push: 'R' },
];

interface Level {
  w: number;
  h: number;
  wall: Uint8Array; // 1 where a wall stands (outer frame included)
  goals: number[];
  boxes: number[]; // sorted
  player: number;
}

interface Room {
  boxes: number[];
  goals: number[];
  done: boolean;
}

/** Parse XSB text (# wall, space floor, . goal, $ box, * box on goal, @ player, + player on goal). */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const i = y * w + x;
      const ch = row[x];
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outermost frame is wall whatever the text shows: nothing leaves the board.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/**
 * The squares a box alone can ever stand on and still be pushed onto a goal: pull a
 * box backwards from every goal. From square x, a box could have arrived by a push in
 * direction d when both the square it came from (x - d) and the square the player
 * stood on (x - 2d) are open floor.
 */
function liveSquares(lv: Level): Uint8Array {
  const { w, wall, goals } = lv;
  const live = new Uint8Array(wall.length);
  const queue: number[] = [];
  for (const g of goals) {
    live[g] = 1;
    queue.push(g);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (const d of DIRS) {
      const step = d.dy * w + d.dx;
      const from = x - step;
      const stand = x - 2 * step;
      if (from < 0 || stand < 0 || from >= wall.length || stand >= wall.length) continue;
      if (!wall[from] && !wall[stand] && !live[from]) {
        live[from] = 1;
        queue.push(from);
      }
    }
  }
  return live;
}

/**
 * Flood-fill the squares the player reaches from `from` with `occupied` in the way.
 * Marks them in `seen` with `stamp` and returns the lowest square reached (the region's name).
 */
function floodRegion(
  w: number,
  wall: Uint8Array,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    // Neighbours in fixed order; out-of-range neighbours are walls by construction
    // (the outer frame), but guard the index anyway.
    const up = p - w;
    if (up >= 0 && wall[up] === 0 && occupied[up] === 0 && seen[up] !== stamp) {
      seen[up] = stamp;
      stack[n++] = up;
    }
    const down = p + w;
    if (down < wall.length && wall[down] === 0 && occupied[down] === 0 && seen[down] !== stamp) {
      seen[down] = stamp;
      stack[n++] = down;
    }
    if (p % w > 0) {
      const left = p - 1;
      if (wall[left] === 0 && occupied[left] === 0 && seen[left] !== stamp) {
        seen[left] = stamp;
        stack[n++] = left;
      }
    }
    if (p % w < w - 1) {
      const right = p + 1;
      if (wall[right] === 0 && occupied[right] === 0 && seen[right] !== stamp) {
        seen[right] = stamp;
        stack[n++] = right;
      }
    }
  }
  return low;
}

/**
 * Whether the box just pushed to `t` is stuck in a frozen 2x2 block: four squares of
 * walls and boxes, one of them a box off its goal. Such a box can never move again.
 */
function frozenAt(
  w: number,
  wall: Uint8Array,
  occupied: Uint8Array,
  goal: Uint8Array,
  t: number,
): boolean {
  // The four 2x2 blocks that have t as a corner.
  const tops = [t, t - 1, t - w, t - w - 1];
  for (const a of tops) {
    if (a < 0 || a + w + 1 >= wall.length) continue;
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a])) continue;
    if (!(wall[b] || occupied[b])) continue;
    if (!(wall[c] || occupied[c])) continue;
    if (!(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) ||
        (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) {
      return true;
    }
  }
  return false;
}

/** A state's key: the region's lowest square, then the sorted box squares. */
function stateKey(boxes: number[], low: number): string {
  return `${low}|${boxes.join(',')}`;
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower-case LURD. */
function walkTo(
  w: number,
  wall: Uint8Array,
  occupied: Uint8Array,
  from: number,
  to: number,
): string {
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how: string[] = new Array(wall.length);
  const queue: number[] = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (const d of DIRS) {
      const q = p + d.dy * w + d.dx;
      if (q < 0 || q >= wall.length) continue;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = d.step;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: push square out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

/**
 * The push-optimal solution of a level: {pushes, moves} (moves in LURD, an upper-case
 * letter marking a push), or null when the search gives up or the level has no solution.
 * Breadth-first over pushes, so the first solved state met is push-optimal.
 */
function solvePushes(lv: Level, maxStates: number = MAX_STATES): { pushes: number; moves: string } | null {
  const { w, wall, goals } = lv;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(lv);
  if (lv.boxes.some((b) => !live[b])) return null;

  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);
  if (solved(lv.boxes)) return { pushes: 0, moves: '' };

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size); // marks the expanded state's player region
  const mark = new Int32Array(size); // marks a successor state's region, for its key
  const stack = new Int32Array(size);
  let stamp = 0;

  // States in discovery order: their boxes, the player's square after the push that
  // made them, and the parent state's index. The player's exact square inside a
  // region never matters, only the region, so the key carries the region's lowest square.
  const stateBoxes: number[][] = [lv.boxes.slice()];
  const statePlayer: number[] = [lv.player];
  const parent: number[] = [-1];
  const index = new Map<string, number>();

  for (const b of lv.boxes) occupied[b] = 1;
  const firstLow = floodRegion(w, wall, occupied, lv.player, seen, ++stamp, stack);
  for (const b of lv.boxes) occupied[b] = 0;
  index.set(stateKey(lv.boxes, firstLow), 0);

  let found = -1;
  for (let head = 0; found < 0 && head < stateBoxes.length; head++) {
    const boxes = stateBoxes[head];
    for (const b of boxes) occupied[b] = 1;
    const regionStamp = ++stamp;
    floodRegion(w, wall, occupied, statePlayer[head], seen, regionStamp, stack);
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi];
      for (const d of DIRS) {
        const step = d.dy * w + d.dx;
        const stand = b - step; // where the player must stand to push
        const t = b + step; // where the box lands
        if (stand < 0 || stand >= size || t < 0 || t >= size) continue;
        if (seen[stand] !== regionStamp || wall[t] || occupied[t] || !live[t]) continue;
        // Tentatively move the box, check the frozen-block deadlock, then key the state.
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenAt(w, wall, occupied, goal, t);
        let key = '';
        let next: number[] | null = null;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          const low = floodRegion(w, wall, occupied, b, mark, ++stamp, stack);
          key = stateKey(next, low);
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || index.has(key)) continue;
        if (stateBoxes.length >= maxStates) return null;
        index.set(key, stateBoxes.length);
        stateBoxes.push(next as number[]);
        statePlayer.push(b);
        parent.push(head);
        if (solved(next as number[])) {
          found = stateBoxes.length - 1;
          break;
        }
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  if (found < 0) return null;

  // Rebuild the move string: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]) path.push(s);
  path.reverse();
  let moves = '';
  let player = lv.player;
  let boxes = lv.boxes.slice();
  for (const s of path) {
    const nextBoxes = stateBoxes[s];
    const from = boxes.find((b) => !nextBoxes.includes(b)) as number;
    const to = nextBoxes.find((b) => !boxes.includes(b)) as number;
    const step = to - from;
    const dir = DIRS.find((d) => d.dy * w + d.dx === step) as Dir;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(w, wall, occupied, player, from - step);
    for (const b of boxes) occupied[b] = 0;
    moves += dir.push;
    player = from;
    boxes = nextBoxes.slice();
  }
  return { pushes: path.length, moves };
}

/** The square the player stands on after `moves` from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) {
    p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  }
  return p;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway) out of the
 * floor; each connected part left that holds a box is a room. Null when the level is
 * not such a set of rooms: a box starts in the hallway, a goal falls outside every
 * part, or some part holds a different count of boxes and goals.
 */
function roomsOf(lv: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = lv;
  const live = liveSquares(lv);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) {
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;

  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const id = rooms.length;
    const squares: number[] = [s];
    part[s] = id;
    for (let i = 0; i < squares.length; i++) {
      for (const d of DIRS) {
        const q = squares[i] + d.dy * w + d.dx;
        if (q < 0 || q >= wall.length) continue;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = id;
          squares.push(q);
        }
      }
    }
    rooms.push({ boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]].boxes.push(b);
  for (const g of goals) {
    if (part[g] < 0) return null;
    rooms[part[g]].goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/**
 * Solve a level room by room: each room's push-optimal solution in turn, the other
 * rooms' boxes standing as walls (on their goals once their room is done), the player
 * walking on from where the last room left it. Falls back to a push search over the
 * whole level when the level is no set of rooms or a room search gives up.
 */
function solveLevel(lv: Level): { pushes: number; moves: string } | null {
  const rooms = roomsOf(lv);
  if (rooms !== null) {
    let player = lv.player;
    let pushes = 0;
    let moves = '';
    let ok = true;
    for (const room of rooms) {
      const wall = lv.wall.slice();
      for (const other of rooms) {
        if (other === room) continue;
        const blockers = other.done ? other.goals : other.boxes;
        for (const b of blockers) wall[b] = 1;
      }
      const sub: Level = {
        w: lv.w,
        h: lv.h,
        wall,
        goals: room.goals.slice().sort((a, b) => a - b),
        boxes: room.boxes.slice().sort((a, b) => a - b),
        player,
      };
      const solved = solvePushes(sub);
      if (solved === null) {
        ok = false;
        break;
      }
      pushes += solved.pushes;
      moves += solved.moves;
      player = endOf(lv.w, player, solved.moves);
      room.done = true;
    }
    if (ok) return { pushes, moves };
  }
  return solvePushes(lv);
}

/** Replay `moves` on the level: true only when every step is legal and all boxes end on goals. */
function replaysSolved(lv: Level, moves: string): boolean {
  const boxAt = new Set<number>(lv.boxes);
  let player = lv.player;
  const goal = new Set<number>(lv.goals);
  for (const ch of moves.toLowerCase()) {
    const d = ch === 'u' ? -lv.w : ch === 'd' ? lv.w : ch === 'l' ? -1 : ch === 'r' ? 1 : 0;
    if (d === 0) return false;
    const next = player + d;
    if (next < 0 || next >= lv.wall.length || lv.wall[next]) return false;
    if (boxAt.has(next)) {
      const beyond = next + d;
      if (beyond < 0 || beyond >= lv.wall.length || lv.wall[beyond] || boxAt.has(beyond)) return false;
      boxAt.delete(next);
      boxAt.add(beyond);
    }
    player = next;
  }
  return [...boxAt].every((b) => goal.has(b));
}

/** The move string for one level: a verified solution, or '' when none was found. */
function solve(text: string): string {
  let lv: Level;
  try {
    lv = parseLevel(text);
  } catch {
    return '';
  }
  if (lv.player < 0 || lv.boxes.length === 0) return '';
  let result: { pushes: number; moves: string } | null = null;
  try {
    result = solveLevel(lv);
  } catch {
    result = null;
  }
  if (result !== null && replaysSolved(lv, result.moves)) return result.moves;
  return '';
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  let moves = '';
  try {
    moves = solve(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'));
  } catch {
    moves = '';
  }
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
