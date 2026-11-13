# Arcade Games

Free, original pixel-style browser games. They're built with plain HTML, CSS, JavaScript and Canvas: no libraries, no build step, no backend.

**Play:** https://prathameshbodhankar.github.io/arcade/

| Game | What it is | Where it lives |
|---|---|---|
| **Bolt Run** | Endless runner | Its own repo: [bolt-run](https://github.com/PrathameshBodhankar/bolt-run) (link unchanged) |
| **Pixel Serpent** | Classic snake | `snake/` |
| **Comet Pinball** | Physics pinball table | `pinball/` |

It works on desktop and on phones, including iOS Safari. Add it to your home screen to play full-screen.

## Files

```
index.html          homepage (game cards + saved best scores)
shared.css          shared look: colours, buttons, overlays, safe-area padding
sound.js            shared WebAudio synth (no audio files, iOS-safe unlock, shared mute)
snake/              Pixel Serpent: index.html + snake.js
pinball/            Comet Pinball: index.html + pinball.js
tests/arcade.test.js  Playwright tests (node tests/arcade.test.js)
```

All the games share one website address, so they also share saved data in the browser. That's how the homepage can show your Bolt Run best score too. The saved keys are `boltrun.hi`, `arcade.snake.hi`, `arcade.pinball.hi` and `arcade.muted`.

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

## Tests
```
npm i playwright
node tests/arcade.test.js
```
The suite runs 35 checks:

- **Homepage:** game links, saved best scores, back button.
- **Snake:** eating, growing, no reversing, wall and self collisions, top speed.
- **Pinball:**
  - The launch reaches the playfield and the flippers hit the ball.
  - A 3-minute bot run: the ball never escapes or gets stuck.
  - Draining, game over, ball save, and two-finger touch.
- **iPhone:** in portrait and landscape, there's no sideways scrolling and a tap starts each game.
