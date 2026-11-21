# Sokoban solver — make.fun `sokoban-solver-01-run-20261121`

A push-optimal Sokoban solver in a single `main.ts` (Node built-ins only, erasable
TypeScript, no dependencies, no clock, no randomness).

## How it works

1. **Parse** the XSB level (`#` wall, `.` goal, `$` box, `*` box on goal, `@` player).
2. **Split into rooms.** The level is a one-wide hallway with rooms off it. The dead
   squares of the player's row — squares from which a box alone can never be pushed
   onto a goal — cut the floor into components; each component holding boxes is a
   room. A box can never leave its room (a push through a door into the hallway is
   one-way), so the rooms are independent and their push optima add up to the
   level's optimum.
3. **Solve each room push-optimally** with a breadth-first search over pushes. A state
   is the sorted box squares plus the player's reachable region (named by its lowest
   square); BFS over pushes means the first solved state found is push-optimal. Two
   prunings keep the search small, and neither can prune a solvable state:
   - *dead squares* — reverse reachability from the goals, pulling a box backwards;
   - *frozen 2×2 blocks* — four squares of walls and boxes holding a box off its goal.
   While one room is solved, the other rooms' boxes stand as walls (on their goals
   once their room is done).
4. **Stitch** the rooms together: the player walks (shortest walk, BFS) to the next
   push square, pushes, and continues. The full move string is emitted in LURD
   (upper-case letters mark pushes).
5. **Fall back safely.** If room decomposition or a room search ever fails, the solver
   tries a push search over the whole level; if that fails too it still writes a valid
   (empty) `solution.txt` for every instance — it never crashes and never leaves an
   instance unanswered. Every emitted solution is replayed and verified before it is
   written.

Work is budgeted by a state cap per search (250,000 states), never by the clock, and
all tie-breaking uses a fixed direction order, so two runs output identical bytes.

## Results (local grading, kit scorer)

Practice set — **score 1,000,000** (all five instances at exactly P\*):

| instance | pushes | P\* |
|----------|--------|-----|
| i001 | 13 | 13 |
| i002 | 16 | 16 |
| i003 | 29 | 29 |
| i004 | 47 | 47 |
| i005 | 60 | 60 |

Runtime ≈ 0.9 s for the whole set (limit 60 s). Two runs into different output
directories are byte-identical (`diff -r` clean).

The solver was also checked on two freshly drawn sets from the kit's own generator
(different seeds): both scored 1,000,000 as well (P\* 13/16/32/47/61 and
13/14/29/45/60), so the result is not fitted to the practice set.

## Run locally

```sh
MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
MAKEFUN_OUTPUT_DIR=out MAKEFUN_REFERENCE_DIR=<kit>/practice/reference \
  MAKEFUN_SCORES_DIR=scores node <kit>/program/scorer/score.ts
```

## Files

- `main.ts` — the solver (own implementation).
- `LICENSE` — MIT, copied from the kit starter.
