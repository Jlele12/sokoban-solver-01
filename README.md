# sokoban-solver-01

Push-optimal Sokoban solver for the make.fun bounty [sokoban-solver-01-run-20261121](https://make.fun/bounty/sokoban-solver-01-run-20261121).

[![sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/Jlele12/sokoban-solver-01/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/Jlele12/sokoban-solver-01/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

## How it works

Every generated level is a one-square-wide hallway with rooms off it, one door per room.
A box pushed into the hallway can never come back, so each room is solved independently
and the level's push-optimal count is the sum of the rooms' optima. The solver:

1. finds the hallway row (the player's row) and splits the floor into rooms
   (connected components of floor off the hallway);
2. solves each room with a breadth-first search over push states (each push costs 1, so
   BFS layers are push-optimal), pruning corner and freeze deadlocks and any push that
   would put a box onto the hallway;
3. stitches the room solutions together with walks along the hallway.

Fully deterministic: fixed iteration orders, no clock reads, no randomness; the search is
bounded by the state space, never by time. `main.ts` runs on Node 22 (erasable TypeScript
only) and reads `/input/<id>/level.txt`, writing `/output/<id>/solution.txt` in LURD.
