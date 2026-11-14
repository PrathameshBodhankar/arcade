# Arcade Games

Free, original pixel-style browser games. They're built with plain HTML, CSS, JavaScript and Canvas: no libraries, no build step, no backend.

**Play:** https://prathameshbodhankar.github.io/arcade/

| Game | What it is | Where it lives |
|---|---|---|
| **Bolt Run** | Endless runner | Its own repo: [bolt-run](https://github.com/PrathameshBodhankar/bolt-run) (link unchanged) |
| **Pixel Serpent** | Classic snake | `snake/` |
| **Comet Pinball** | Physics pinball table | `pinball/` |
| **Mate in One** | 1000 chess checkmate puzzles | `chess/` |
| **Gem Burst** | Match-3 puzzle game, 300 levels | `gems/` |

It works on desktop and on phones, including iOS Safari. Add it to your home screen to play full-screen.

## Files

```
index.html          homepage (game cards + saved best scores)
shared.css          shared look: colours, buttons, overlays, safe-area padding
storage.js          save helper: persistent storage request + 'not saving' warning
sound.js            shared WebAudio synth (no audio files, iOS-safe unlock, shared mute)
snake/              Pixel Serpent: index.html + snake.js
pinball/            Comet Pinball: index.html + pinball.js
chess/              Mate in One: index.html, chess.js (UI), chess.css,
                    core.js (chess rules engine), puzzles.js (the 1000 puzzles),
                    tools/generate-puzzles.js (how the puzzles were made)
gems/               Gem Burst: index.html, gems.js (UI), gems.css, engine.js (match-3 rules),
                    levels.js (the 300 levels), tools/generate-levels.js (how they were made)
tests/arcade.test.js  Playwright tests for homepage, snake, pinball
tests/mate.test.js    puzzle verification + Mate in One UI tests
tests/gems.test.js    match-3 rules, level checks, Gem Burst UI tests
```

### Saving progress
GitHub Pages only hosts files, so there's no server to save to. Instead, every game saves automatically in the player's browser (`localStorage`):

- **No account needed.** Progress is kept per device and per browser.
- **`storage.js` makes saves sturdier:**
  - It asks the browser to keep the data permanently, so it isn't cleared when the device runs low on space.
  - It shows a warning if the browser can't save at all, for example in private browsing.
- **iPhone:** Safari clears website data after about 7 days without a visit. Adding the arcade to the Home Screen (Share → Add to Home Screen) keeps it. The homepage and the Mate in One level map both say this.

All the games share one website address, so they also share saved data in the browser. That's how the homepage can show your Bolt Run best score too. The saved keys are `boltrun.hi`, `arcade.snake.hi`, `arcade.pinball.hi`, `arcade.mate1` (Mate in One progress), `arcade.mate1.solved`, `arcade.gems` (Gem Burst progress), `arcade.gems.cleared` and `arcade.muted`.

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
  - **Skip ▸** (or the `S` key) moves straight to the next level and unlocks it, at any time.
    - Skipped levels show **SKIP** on the level map, and you can go back to them whenever you like. Solving one later replaces the mark with stars.
    - "Continue" always goes to your next new level, so it never pulls you back to skipped ones.
  - After 2 hints, or 3 misses, a **Show answer** button appears. Using it unlocks the next level but earns no stars.
  - Solving, revealing or skipping a level unlocks the next one.

**The rules engine (`chess/core.js`):** it handles legal moves, including castling, en passant and promotion, plus check, checkmate, stalemate, FEN, SAN and UCI. It's checked against the standard "perft" move counts for well-known tricky test positions.

**Where the puzzles come from (`chess/tools/generate-puzzles.js`):** all 1000 are original. They come from 30,000 games between two simple bots.

- **The bots:** they like captures, development and checks, and they avoid leaving pieces hanging. Occasionally they blunder, which is what creates checkmate chances.
- **Which positions are kept:** a position counts only when all of these are true:
  - Exactly one move gives checkmate.
  - The game is past the opening.
  - Material is roughly even, so the positions look like real games.
- **Difficulty:** each candidate gets a difficulty score. The score goes up with:
  - Other checks that don't work and act as decoys.
  - Mates that need a quiet move, a discovered check, under-promotion, castling or en passant.
  - The number of pieces on the board.
- **Variety:** back-rank rook mates are by far the most common kind in games, so picking by difficulty alone would mean "rook, rook, rook…".
  - Each group of 100 levels gets a set mix of mating pieces: about 30 queen, 26 rook, 15 bishop, 15 knight, 10 pawn and a few king/castling mates.
  - Each piece type's puzzles get harder from group to group.
  - Inside a group, levels still go from easier to harder, but the same piece never mates twice in a row and the same pattern doesn't repeat within 3 levels.
  - The order is fixed, so level 37 is the same puzzle for everyone.

Every puzzle is re-checked by the tests.

To make a fresh set: `node chess/tools/generate-puzzles.js 30000`. Add `POOL_OUT=pool.json` to also save every candidate. You can then re-pick from that pool without replaying games: `node chess/tools/generate-puzzles.js pool.json`.

## Gem Burst: how it works
An original match-3 game in the arcade's pixel style. It uses no artwork, names or terms from other games.

- **Playing:**
  - Swipe a gem, or tap two neighbouring gems, to swap them and line up 3 or more of a colour.
  - Matched gems pop, the gems above fall, new ones drop in, and chain reactions score combos.
  - If no moves are left, the board shuffles itself.
- **Six gem types:** ruby, amber, topaz, emerald, sapphire and amethyst. Each has its own shape as well as colour, so they're easy to tell apart.
- **Special gems:**

  | Match | Makes | What it does |
  |---|---|---|
  | 4 in a row | Line gem | Clears its whole row or column |
  | L or T shape | Bomb | Clears a 3×3 area |
  | 5 in a row | Prism | Swap it with a gem to clear every gem of that colour |

  Swapping two specials together gives a combined blast:

  | Swap | Blast |
  |---|---|
  | Line + line | Cross: a full row and column |
  | Line + bomb | Rows and columns three wide |
  | Bomb + bomb | 5×5 area |
  | Prism + special | Every gem of that colour becomes that special and goes off |
  | Prism + prism | The whole board |
- **Goals:** reach a score, collect gems of a colour, break all the ice (some takes two hits), smash all the stone (some takes two hits), or bring star coins down to the bottom. Later levels combine two goals.
- **Moves and stars:**
  - Each level has a move limit, and the game does not use lives or timers.
  - Moves left over at the end are worth bonus points.
  - Clearing the goal earns ★. Scoring past the level's two score thresholds earns ★★ or ★★★.
- **Levels:**
  - 300 levels across 6 worlds: Quartz Cave, Amber Woods, Topaz Dunes, Emerald Falls, Sapphire Sea and Amethyst Peak.
  - Boards come in 11 shapes, including holes, pillars, hourglasses and crosses.
  - **Skip ▸** and **↻ Retry** are always available. Skipped levels show SKIP on the map.

**The engine (`gems/engine.js`):** it handles all the rules with no screen code, so the same file runs in the browser and in the test bots. Each move returns a list of steps (swap, clear, fall, collect, shuffle, win or lose) with a picture of the board after each. The game animates those steps exactly.

**How the 300 levels were made (`gems/tools/generate-levels.js`):**

1. **Design.** Each level gets a board shape, 5 or 6 colours, goals and obstacles. New goal types appear one at a time. Ice and stone get thicker later on, and double goals start after level 60.
2. **Calibrate.** A bot plays each level dozens of times. It plays like a casual player:
   - It can't see which gems will drop in next.
   - About a third of its moves are just any valid move. On the first levels it's even more casual, so newcomers breeze through.

   The move limit and target scores are then set so the bot wins a target share of games. That share is about 97% at the start and about 65% by level 300. Every 10th level is a harder "boss" level, with an easier one right after.
3. **Redesign.** Levels that come out too hard or too long are redesigned easier.
4. **Verify and set stars.** Every level is checked by a second set of bot games. The ★★ and ★★★ scores come from the bot's results: its middle score and its top 15%.

To regenerate the levels: `node gems/tools/generate-levels.js 300`. It takes about 10 minutes on 2 cores.

## Tests
```
npm i playwright
node tests/arcade.test.js
node tests/mate.test.js
node tests/gems.test.js
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
- **Levels and stars:** unlocking, ★★★ and ★★ ratings, wrong-move explanations and take-backs, hints, Show answer, Skip (button and `S` key, map marking, Continue behaviour), and drag-and-drop.
- **Progress:** it's still there after a reload and shows on the homepage.
- **iPhone:** in portrait and landscape, levels can be solved with taps.

`gems.test.js` checks the rules, the levels and the game screen:

- **Match-3 rules:** matches, refused swaps, all three special gems, prism, line and bomb combos, ice, stone and star coins.
- **All 300 levels:** each is well-formed, and a simple bot can win a sample of them within the move limit.
- **The game:** the level intro, swipe and tap swaps, bounce-back for moves that don't match, winning and unlocking, losing, Skip and Retry, map marks, and the homepage card.
- **iPhone:** in portrait and landscape, the board fits and touch swaps work.
