// Push-optimal Sokoban solver for make.fun sokoban-solver-01.
//
// Every generated level is a one-square-wide hallway across the board (the row the player
// starts in) with rooms off it above and below, each opening through one door. A box pushed
// through a door into the hallway can never come back, so no optimal solution ever takes a
// box out of its room and a level's push-optimal count is the sum of its rooms' optima.
// This solver exploits that: it finds the hallway row (the player's row), splits the floor
// into rooms (connected components of floor off the hallway row), solves each room
// independently with a breadth-first search over push states (each push costs 1, so BFS
// layers are push-optimal), prunes dead positions (corner and freeze deadlocks, plus any
// push that would put a box onto the hallway), then stitches the room solutions together
// with deterministic walks along the hallway. If the room splitting fails for a level it
// falls back to a plain global push-BFS over the whole level.
//
// Fully deterministic: fixed iteration orders, no clock reads, no randomness; the search is
// bounded by the state space, never by time.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// l r u d
const DX = [-1, 1, 0, 0];
const DY = [0, 0, -1, 1];
const MOVE = ['l', 'r', 'u', 'd'];

type Grid = {
  w: number; h: number;
  wall: Uint8Array;
  goal: Uint8Array;
};

function parse(text: string) {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h);
  const goal = new Uint8Array(w * h);
  const boxes: number[] = [];
  let player = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ch = rows[y]![x] ?? '#';
      const i = y * w + x;
      if (ch === '#') wall[i] = 1;
      if ('.*+'.includes(ch)) goal[i] = 1;
      if ('$*'.includes(ch)) boxes.push(i);
      if ('@+'.includes(ch)) player = i;
    }
  }
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goal, boxes, player };
}

function reachableCells(g: Grid, blocked: (q: number) => boolean, start: number): Uint8Array {
  const { w, h, wall } = g;
  const vis = new Uint8Array(w * h);
  if (start < 0 || wall[start] || blocked(start)) return vis;
  vis[start] = 1;
  const stack = [start];
  while (stack.length > 0) {
    const p = stack.pop()!;
    const x = p % w, y = (p / w) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d]!, ny = y + DY[d]!;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const q = ny * w + nx;
      if (vis[q] || wall[q] || blocked(q)) continue;
      vis[q] = 1;
      stack.push(q);
    }
  }
  return vis;
}

// Room of each cell: connected components of floor off the hallway row. cell -> room id or -1.
function splitRooms(w: number, h: number, wall: Uint8Array, hallwayRow: number): Int32Array {
  const roomOf = new Int32Array(w * h).fill(-1);
  let id = 0;
  for (let y = 0; y < h; y++) {
    if (y === hallwayRow) continue;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (wall[i] || roomOf[i] !== -1) continue;
      const stack = [i];
      roomOf[i] = id;
      while (stack.length > 0) {
        const p = stack.pop()!;
        const px = p % w, py = (p / w) | 0;
        for (let d = 0; d < 4; d++) {
          const nx = px + DX[d]!, ny = py + DY[d]!;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h || ny === hallwayRow) continue;
          const q = ny * w + nx;
          if (wall[q] || roomOf[q] !== -1) continue;
          roomOf[q] = id;
          stack.push(q);
        }
      }
      id++;
    }
  }
  return roomOf;
}

// Build a search grid for one room: only the room's cells and the hallway are walkable.
function buildRoomGrid(w: number, h: number, wall: Uint8Array, goal: Uint8Array, hallwayRow: number, cells: number[]): { g: Grid; door: number; doorOut: number } {
  const gw = new Uint8Array(w * h).fill(1);
  const gg = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    const i = hallwayRow * w + x;
    if (!wall[i]) gw[i] = 0;
  }
  let door = -1, doorOut = -1;
  for (const c of cells) {
    gw[c] = 0;
    gg[c] = goal[c];
    const cy = (c / w) | 0;
    if (cy === hallwayRow - 1 || cy === hallwayRow + 1) {
      const hc = hallwayRow * w + (c % w);
      if (!wall[hc]) { door = c; doorOut = hc; }
    }
  }
  return { g: { w, h, wall: gw, goal: gg }, door, doorOut };
}

// Freeze deadlock: box bi, on a non-goal square, can never be pushed again.
function frozenDead(g: Grid, boxes: Int32Array, bi: number, frozen: Uint8Array): boolean {
  const { w, h, wall, goal } = g;
  const b = boxes[bi]!;
  if (goal[b]) return false;
  const isBoxIdx = (q: number): number => {
    for (let i = 0; i < boxes.length; i++) if (boxes[i] === q) return i;
    return -1;
  };
  const blocked = (q: number): boolean => {
    if (q < 0 || q >= w * h || wall[q]) return true;
    const qi = isBoxIdx(q);
    if (qi < 0) return false;
    if (frozen[qi]) return true;
    return frozenDead(g, boxes, qi, frozen);
  };
  const x = b % w, y = (b / w) | 0;
  const left = x > 0 ? b - 1 : -1, right = x < w - 1 ? b + 1 : -1;
  const up = y > 0 ? b - w : -1, down = y < h - 1 ? b + w : -1;
  const isWall = (q: number) => q < 0 || q >= w * h || wall[q] === 1;
  if ((isWall(up) || isWall(down)) && (isWall(left) || isWall(right))) return true;
  const wasFrozen = frozen[bi];
  frozen[bi] = 1; // assume frozen while checking neighbours (handles mutual freezes)
  const hBlocked = blocked(left) || blocked(right);
  const vBlocked = blocked(up) || blocked(down);
  if (!wasFrozen) frozen[bi] = 0;
  return hBlocked && vBlocked;
}

function playerPath(g: Grid, boxes: Int32Array, from: number, to: number): string {
  const { w, h, wall } = g;
  const prev = new Int32Array(w * h).fill(-1);
  const prevDir = new Int8Array(w * h).fill(-1);
  const queue = [from];
  prev[from] = from;
  let head = 0;
  while (head < queue.length) {
    const p = queue[head++]!;
    if (p === to) break;
    const x = p % w, y = (p / w) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d]!, ny = y + DY[d]!;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const q = ny * w + nx;
      if (prev[q] !== -1 || wall[q] || boxes.includes(q)) continue;
      prev[q] = p;
      prevDir[q] = d;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('no player path');
  let s = '';
  let p = to;
  while (p !== from) {
    s = MOVE[prevDir[p]!]! + s;
    p = prev[p]!;
  }
  return s;
}

// Push-optimal BFS for one room; returns the move string from the door, or null.
function solveRoom(g: Grid, door: number, doorOut: number, boxPositions: number[], hallwayRow: number): string | null {
  const { w, h, wall, goal } = g;
  const nB = boxPositions.length;
  const startBoxes = Int32Array.from(boxPositions).sort();
  if (startBoxes.every((b) => goal[b] === 1)) return '';

  const keyOf = (boxes: Int32Array, rep: number): string => {
    let s = String.fromCharCode(rep);
    for (let i = 0; i < boxes.length; i++) s += String.fromCharCode(boxes[i]!);
    return s;
  };
  const regionRep = (boxes: Int32Array, start: number): number => {
    const vis = reachableCells(g, (q) => boxes.includes(q), start);
    for (let i = 0; i < vis.length; i++) if (vis[i]) return i;
    return -1;
  };

  // If the door cell itself holds a box, the player must stand in front of it (in the hallway).
  const startPos = startBoxes.includes(door) ? doorOut : door;

  type Node = { boxes: Int32Array; player: number; parent: number; from: number; dir: number };
  const nodes: Node[] = [{ boxes: startBoxes, player: startPos, parent: -1, from: -1, dir: -1 }];
  const visited = new Set<string>([keyOf(startBoxes, regionRep(startBoxes, startPos))]);
  let layerStart = 0, layerEnd = 1, found = -1;

  while (found < 0 && layerStart < layerEnd) {
    for (let si = layerStart; si < layerEnd && found < 0; si++) {
      const node = nodes[si]!;
      const reach = reachableCells(g, (q) => node.boxes.includes(q), node.player);
      for (let bi = 0; bi < nB && found < 0; bi++) {
        const b = node.boxes[bi]!;
        const bx = b % w, by = (b / w) | 0;
        for (let d = 0; d < 4; d++) {
          const px = bx - DX[d]!, py = by - DY[d]!;
          const nx = bx + DX[d]!, ny = by + DY[d]!;
          if (px < 0 || py < 0 || px >= w || py >= h || nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const pq = py * w + px, nq = ny * w + nx;
          if (wall[pq] || wall[nq] || !reach[pq] || node.boxes.includes(nq)) continue;
          // a box pushed onto the hallway row can never come back: never optimal
          if (ny === hallwayRow) continue;
          const nb = Int32Array.from(node.boxes);
          nb[bi] = nq;
          nb.sort();
          const seen = new Uint8Array(nB);
          if (frozenDead(g, nb, bi, seen)) continue;
          const k = keyOf(nb, regionRep(nb, b));
          if (visited.has(k)) continue;
          visited.add(k);
          nodes.push({ boxes: nb, player: b, parent: si, from: pq, dir: d });
          if (nb.every((bb) => goal[bb] === 1)) { found = nodes.length - 1; break; }
        }
      }
    }
    if (found >= 0) break;
    layerStart = layerEnd;
    layerEnd = nodes.length;
  }
  if (found < 0) return null;

  const chain: Node[] = [];
  for (let n = found; n >= 0; n = nodes[n]!.parent) chain.push(nodes[n]!);
  chain.reverse();

  let moves = '';
  for (let k = 1; k < chain.length; k++) {
    const prev = chain[k - 1]!, cur = chain[k]!;
    moves += playerPath(g, prev.boxes, prev.player, cur.from) + MOVE[cur.dir]!;
  }
  return moves;
}

// Fallback: plain push-BFS over the whole level (only used if room splitting fails).
function solveGlobal(l: ReturnType<typeof parse>): string {
  const { w, h, wall, goal } = l;
  const nB = l.boxes.length;
  const startBoxes = Int32Array.from(l.boxes);
  const isGoalState = (bs: Int32Array) => bs.every((b) => goal[b] === 1);
  if (isGoalState(startBoxes)) return '';
  const g: Grid = { w, h, wall, goal };
  const keyOf = (boxes: Int32Array, rep: number): string => {
    let s = String.fromCharCode(rep);
    for (let i = 0; i < boxes.length; i++) s += String.fromCharCode(boxes[i]!);
    return s;
  };
  const regionRep = (boxes: Int32Array, start: number): number => {
    const vis = reachableCells(g, (q) => boxes.includes(q), start);
    for (let i = 0; i < vis.length; i++) if (vis[i]) return i;
    return -1;
  };
  type Node = { boxes: Int32Array; player: number; parent: number; from: number; dir: number };
  const nodes: Node[] = [{ boxes: startBoxes, player: l.player, parent: -1, from: -1, dir: -1 }];
  const visited = new Set<string>([keyOf(startBoxes, regionRep(startBoxes, l.player))]);
  let layerStart = 0, layerEnd = 1, found = -1;
  while (found < 0 && layerStart < layerEnd) {
    for (let si = layerStart; si < layerEnd && found < 0; si++) {
      const node = nodes[si]!;
      const reach = reachableCells(g, (q) => node.boxes.includes(q), node.player);
      for (let bi = 0; bi < nB && found < 0; bi++) {
        const b = node.boxes[bi]!;
        const bx = b % w, by = (b / w) | 0;
        for (let d = 0; d < 4; d++) {
          const px = bx - DX[d]!, py = by - DY[d]!, nx = bx + DX[d]!, ny = by + DY[d]!;
          if (px < 0 || py < 0 || px >= w || py >= h || nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const pq = py * w + px, nq = ny * w + nx;
          if (wall[pq] || wall[nq] || !reach[pq] || node.boxes.includes(nq)) continue;
          const nb = Int32Array.from(node.boxes);
          nb[bi] = nq;
          nb.sort();
          const seen = new Uint8Array(nB);
          if (frozenDead(g, nb, bi, seen)) continue;
          const k = keyOf(nb, regionRep(nb, b));
          if (visited.has(k)) continue;
          visited.add(k);
          nodes.push({ boxes: nb, player: b, parent: si, from: pq, dir: d });
          if (isGoalState(nb)) { found = nodes.length - 1; break; }
        }
      }
    }
    if (found >= 0) break;
    layerStart = layerEnd;
    layerEnd = nodes.length;
  }
  if (found < 0) return '';
  const chain: Node[] = [];
  for (let n = found; n >= 0; n = nodes[n]!.parent) chain.push(nodes[n]!);
  chain.reverse();
  let moves = '';
  for (let k = 1; k < chain.length; k++) {
    const prev = chain[k - 1]!, cur = chain[k]!;
    moves += playerPath(g, prev.boxes, prev.player, cur.from) + MOVE[cur.dir]!;
  }
  return moves;
}

function solve(text: string): string {
  const { w, h, wall, goal, boxes, player } = parse(text);
  const hallwayRow = (player / w) | 0;
  const roomOf = splitRooms(w, h, wall, hallwayRow);

  type Room = { cells: number[]; door: number; doorOut: number; boxes: number[] };
  const rooms = new Map<number, Room>();
  for (const b of boxes) {
    const id = roomOf[b]!;
    let room = rooms.get(id);
    if (!room) {
      const cells: number[] = [];
      for (let i = 0; i < w * h; i++) if (roomOf[i] === id) cells.push(i);
      const built = buildRoomGrid(w, h, wall, goal, hallwayRow, cells);
      room = { cells, door: built.door, doorOut: built.doorOut, boxes: [] };
      rooms.set(id, room);
    }
    room.boxes.push(b);
  }
  const roomList = [...rooms.values()].sort((a, b) => a.doorOut - b.doorOut || a.door - b.door);

  const solved: (string | null)[] = roomList.map((room) => {
    const built = buildRoomGrid(w, h, wall, goal, hallwayRow, room.cells);
    return solveRoom(built.g, room.door, room.doorOut, room.boxes, hallwayRow);
  });
  if (roomList.length === 0 || solved.some((s) => s === null)) {
    return solveGlobal(parse(text));
  }

  // Stitch: walk the hallway from room to room, in door order.
  let moves = '';
  let pos = player;
  for (let ri = 0; ri < roomList.length; ri++) {
    const room = roomList[ri]!;
    // walk along the hallway to the cell in front of the door (rooms are walls here)
    const hallWall = new Uint8Array(w * h).fill(1);
    for (let x = 0; x < w; x++) {
      const i = hallwayRow * w + x;
      if (!wall[i]) hallWall[i] = 0;
    }
    const hallGrid: Grid = { w, h, wall: hallWall, goal: new Uint8Array(w * h) };
    moves += playerPath(hallGrid, Int32Array.from([]), pos, room.doorOut);
    const doorBlocked = room.boxes.includes(room.door);
    if (!doorBlocked) moves += room.door < room.doorOut ? 'u' : 'd'; // step through the door into the room
    moves += solved[ri]!;
    // replay the room's moves to find the final player square, then walk back out to the hallway
    const built = buildRoomGrid(w, h, wall, goal, hallwayRow, room.cells);
    const g = built.g;
    const bs = new Set<number>(room.boxes);
    let p = bs.has(room.door) ? room.doorOut : room.door;
    for (const mv of solved[ri]!) {
      const d = MOVE.indexOf(mv.toLowerCase());
      const q = ((p / w | 0) + DY[d]!) * w + (p % w + DX[d]!);
      if (bs.has(q)) {
        bs.delete(q);
        bs.add(((p / w | 0) + 2 * DY[d]!) * w + (p % w + 2 * DX[d]!));
      }
      p = q;
    }
    const finalBoxes = Int32Array.from([...bs].sort((a, b) => a - b));
    moves += playerPath(g, finalBoxes, p, room.door);
    moves += room.door > room.doorOut ? 'u' : 'd';
    pos = room.doorOut;
  }
  return moves;
}

for (const id of readdirSync(I).sort()) {
  const moves = solve(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
