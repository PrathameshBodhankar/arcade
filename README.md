# Arcade Games

Free, original pixel-style browser games. They're built with plain HTML, CSS, JavaScript and Canvas: no libraries, no build step, no backend.

**Play:** https://prathameshbodhankar.github.io/arcade/

| Game | What it is | Where it lives |
|---|---|---|
| **Bolt Run** | Endless runner | Its own repo: [bolt-run](https://github.com/PrathameshBodhankar/bolt-run) (link unchanged) |
| **Pixel Serpent** | Classic snake | `snake/` |
| **Comet Pinball** | Physics pinball table | `pinball/` |
| **Mate in One** | 1000 chess checkmate puzzles | `chess/` |

It works on desktop and on phones, including iOS Safari. Add it to your home screen to play full-screen.

## Files

```
index.html          homepage (game cards + saved best scores)
shared.css          shared look: colours, buttons, overlays, safe-area padding
sound.js            shared WebAudio synth (no audio files, iOS-safe unlock, shared mute)
snake/              Pixel Serpent: index.html + snake.js
pinball/            Comet Pinball: index.html + pinball.js
chess/              Mate in One: index.html, chess.js (UI), chess.css,
                    core.js (chess rules engine), puzzles.js (the 1000 puzzles),
                    tools/generate-puzzles.js (how the puzzles were made)
tests/arcade.test.js  Playwright tests for homepage, snake, pinball
tests/mate.test.js    puzzle verification + Mate in One UI tests
```

All the games share one website address, so they also share saved data in the browser. That's how the homepage can show your Bolt Run best score too. The saved keys are `boltrun.hi`, `arcade.snake.hi`, `arcade.pinball.hi`, `arcade.mate1` (Mate in One progress), `arcade.mate1.solved` and `arcade.muted`.

## Pixel Serpent: how it works
- **Board and movement:** a 20×20 grid. The snake moves one cell per tick, starting at 7 moves a second and speeding up as it eats, up to 16. Drawing slides each segment smoothly between ticks.
- **Turning:**
  - Up to 2 turns are queued, so quick double-turns work, and turning straight back into yourself is blocked.
  - On a phone you can swipe and keep swiping without lifting your finger, or use the on-screen D-pad.
- **Gems:** a bonus gem appears after every 5 apples. It's worth more the faster you grab it, and it blinks before it disappears.

## Comet Pinball: how it works
- **Table:** 400×700 game units. Gravity pulls the ball down the table. The physics runs 120 times a second, with each step split into 4 smaller ones so the ball can't pass through thin walls.
- **Collisions:**
  - Walls, flippers and slingshots are rounded line shapes. The ball is pushed out along the surface and its velocity is reflected relative to how that surface is moving.
  - A moving flipper adds its own speed at the point of contact, which is what gives a flip its punch.
- **Scoring:**
  - Bumpers (pop bumpers) score 100 and kick the ball away. Slingshots score 50.
  - The 3 targets on the left wall score 200 each, plus 1,500 when all are lit.
  - The A/B/C lanes at the top score 250 each. Lighting all three adds 1,000 and raises the multiplier, up to ×5.
- **Balls:** 3 balls per game. For the first 6 seconds after each launch, a ball that drains is given back (ball save). A ball that stops dead somewhere gets a small nudge.
- **Controls:**
  - Keyboard: ←/Z and →// flip, hold Space/↓ to charge the plunger and release to launch.
  - Touch: tap the left or right half of the table to flip (two fingers work), and hold then release to launch.

## Mate in One: how it works
- **The game:**
  - 1000 levels in 10 tiers of 100: Novice, Beginner, Apprentice, Club, Tournament, Expert, Candidate, Master, Grandmaster, Legend.
  - Each level first plays your opponent's last move, which was a blunder. Then you find the one move that checkmates.
  - The board turns so the side you're playing is always at the bottom.
- **Moving pieces:** tap a piece and then tap a square, or drag it. Legal moves show as dots. Promotions ask which piece you want.
- **Checking answers:** the rules engine decides. Your move counts if it really is checkmate, and a wrong move comes with a reason, such as "isn't even check" or "the king escapes". The move is then taken back.
- **Stars:**
  - ★★★ for solving on the first try with no hint.
  - ★★ for solving with at most 1 mistake and 1 hint.
  - ★ otherwise.
- **Getting unstuck:**
  - After 2 hints, or 3 misses, a **Show answer** button appears. Using it unlocks the next level but earns no stars.
  - Solving or revealing a level unlocks the next one.

**The rules engine (`chess/core.js`):** it handles legal moves, including castling, en passant and promotion, plus check, checkmate, stalemate, FEN, SAN and UCI. It's checked against the standard "perft" move counts for well-known tricky test positions.

**Where the puzzles come from (`chess/tools/generate-puzzles.js`):** all 1000 are original. They come from 20,000 games between two simple bots.

- **The bots:** they like captures, development and checks, and they avoid leaving pieces hanging. Occasionally they blunder, which is what creates checkmate chances.
- **Which positions are kept:** a position counts only when all of these are true:
  - Exactly one move gives checkmate.
  - The game is past the opening.
  - Material is roughly even, so the positions look like real games.
- **Ordering:** each candidate gets a difficulty score, and 1000 are picked evenly from easiest to hardest. The score goes up with:
  - Other checks that don't work and act as decoys.
  - Mates that need a quiet move, a discovered check, under-promotion, castling or en passant.
  - The number of pieces on the board.

Every puzzle is re-checked by the tests.

To make a fresh set: `node chess/tools/generate-puzzles.js 20000`

## Tests
```
npm i playwright
node tests/arcade.test.js
node tests/mate.test.js
```
`arcade.test.js` runs 35 checks:

- **Homepage:** game links, saved best scores, back button.
- **Snake:** eating, growing, no reversing, wall and self collisions, top speed.
- **Pinball:**
  - The launch reaches the playfield and the flippers hit the ball.
  - A 3-minute bot run: the ball never escapes or gets stuck.
  - Draining, game over, ball save, and two-finger touch.
- **iPhone:** in portrait and landscape, there's no sideways scrolling and a tap starts each game.

`mate.test.js` checks the engine and every puzzle, then drives the game:

- **Engine:** perft counts match the published numbers.
- **All 1000 puzzles:** each is legal, has exactly one mating move and the stored answer is correct. There are no duplicates.
- **Levels and stars:** unlocking, ★★★ and ★★ ratings, wrong-move explanations and take-backs, hints, Show answer, and drag-and-drop.
- **Progress:** it's still there after a reload and shows on the homepage.
- **iPhone:** in portrait and landscape, levels can be solved with taps.
