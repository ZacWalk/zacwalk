/* The attract mode's pilot. It plays the real game through the same controls a player has
   (game.js reads it just as it reads input.js), so the title screen shows the game itself, not
   a recording.

   Every few frames it tries every way the stick can point, held for a moment, a little longer
   or a while, follows each path a short way ahead, and takes the one that keeps the ship clear
   of bullets, enemies, the terrain and the boss while lining its guns up with something to
   shoot. It holds fire whenever there is something to hit, and lets go to fire the beam once it
   is charged and lined up. The game is the same every time; the pilot is not: each game it
   takes on a slightly different style, so no two demos play out alike. */

import { PH, W } from './screen.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const rand = (lo, hi) => lo + Math.random() * (hi - lo);

/* Each path: a direction, and how many frames the stick is held that way before it is let go. */
const PATHS = [{ x: 0, y: 0, hold: 0 }];
for (const [x, y] of [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
]) {
  const len = Math.hypot(x, y);
  for (const hold of [3, 10, 28]) PATHS.push({ x: x / len, y: y / len, hold });
}
const STILL = PATHS[0];

/* How far ahead each path is followed, in frames, and the frames it is checked at: often at
   first, when it matters most, then less often. */
const AHEAD = 28;
const LOOKS = [1, 2, 4, 6, 9, 12, 16, 20, 24, 28];

/* What a path costs for a collision, for shaving past something, and for ending with the ship
   out of sight behind the page. */
const HIT = 1000;
const NEAR = 6;
const UNSEEN = 4;

/* Points on the ship, from its top left, that the terrain kills it at (as game.js has them),
   and a skin around them that the pilot keeps clear of, with how much each matters. */
const HULL = [
  [28, 7],
  [10, 3],
  [12, 10],
  [3, 7],
];
const SKIN = [
  [31, 7, 1.5],
  [10, 0, 1.5],
  [12, 13, 1.5],
  [0, 7, 1],
  [20, 2, 1],
  [20, 12, 1],
  [35, 7, 0.5],
  [10, -4, 0.5],
  [12, 17, 0.5],
  [22, -2, 0.5],
  [22, 16, 0.5],
];

const PLAYING = new Set(['ready', 'play', 'warning', 'boss']);

/* Everything that could hit the ship in the next few frames, each moving in a straight line:
   where it is, how fast it moves, its hit box around the ship's centre, and the frame it
   starts moving (enemies that come from behind wait for their warning). */
class Threats {
  constructor() {
    this.n = 0;
    this.grow(64);
  }

  grow(size) {
    const old = this.data;
    this.data = new Float64Array(size * 7);
    if (old) this.data.set(old);
    this.size = size;
  }

  add(x, y, vx, vy, hw, hh, from) {
    if (this.n === this.size) this.grow(this.size * 2);
    const d = this.data;
    const k = this.n++ * 7;
    d[k] = x;
    d[k + 1] = y;
    d[k + 2] = vx;
    d[k + 3] = vy;
    d[k + 4] = hw;
    d[k + 5] = hh;
    d[k + 6] = from;
  }
}

export class Pilot {
  constructor() {
    // The rest of the controls a game asks about, which a pilot never touches.
    this.drag = { x: 0, y: 0 };
    this.typed = [];
    this.tapped = false;
    this.touched = false;
    this.path = STILL;
    this.firing = false;
    this.target = null;
    // Rectangles of the screen the page draws over, [x0, y0, x1, y1] in game pixels (attract.js).
    this.cover = [];
    this.frame = 0;
    this.planIn = 0;
    this.seen = new WeakMap();
    this.spotted = new WeakMap();
    this.threats = new Threats();
    this.newGame();
  }

  /* A new game, a new style: where it likes to sit, how close it lets things come, how quick
     it is to see a bullet and how often it changes its mind, how keen it is on power-ups and
     the beam, and how set in its ways. */
  newGame() {
    this.style = {
      home: rand(36, 80),
      lean: rand(0.3, 0.7),
      nerve: rand(0.8, 1.25),
      reaction: Math.round(rand(4, 14)),
      focus: Math.random() < 0.5 ? 2 : 3,
      zeal: rand(0.7, 1.4),
      greed: rand(0.6, 1.6),
      reach: rand(0.4, 1.2),
      beamAt: rand(0.55, 1),
      patience: rand(0.3, 1.2),
      whim: rand(0.05, 0.5),
    };
    this.home = this.style.home;
    this.lean = this.style.lean;
    this.wanderIn = 0;
  }

  // ---------- what the game reads ----------

  poll(game) {
    this.think(game);
  }

  took() {
    return false;
  }

  confirmed() {
    return false;
  }

  move() {
    return this.path;
  }

  get fire() {
    return this.firing;
  }

  endFrame() {}

  detach() {}

  // ---------- flying ----------

  think(game) {
    const p = game.player;
    this.frame++;
    this.track(game);
    if (!p.alive || p.flyIn || !PLAYING.has(game.state)) {
      this.path = STILL;
      this.firing = false;
      this.planIn = 0;
      return;
    }
    // Like a player, it only changes its mind every few frames.
    if (--this.planIn <= 0) {
      this.planIn = this.style.focus;
      this.plan(game);
    }
    this.trigger(game);
  }

  plan(game) {
    const p = game.player;
    this.wander();
    const goal = this.aim(game);
    const speed = 1.25 + 0.35 * p.speed;
    let best = STILL;
    let bestCost = Infinity;
    for (const path of PATHS) {
      let x = p.x;
      let y = p.y;
      let cost = 0;
      let look = 0;
      for (let t = 1; t <= AHEAD; t++) {
        if (t <= path.hold) {
          x = clamp(x + path.x * speed, 0, game.width - 32);
          y = clamp(y + path.y * speed, 1, PH - 13);
        }
        if (t !== LOOKS[look]) continue;
        look++;
        const d = this.danger(game, x, y, t);
        if (d === HIT) {
          // Sooner is worse: if every path hits something, take the one that buys most time.
          cost += HIT * (2 - t / AHEAD);
          break;
        }
        cost += d * NEAR * (1 - t / (2 * AHEAD));
      }
      cost += goal.wx * Math.abs(x - goal.x) + goal.wy * Math.max(0, Math.abs(y - goal.y) - 2);
      cost += this.hidden(x, y) * UNSEEN;
      if (path.x === this.path.x && path.y === this.path.y) cost -= this.style.patience;
      cost += Math.random() * this.style.whim;
      if (cost < bestCost) {
        bestCost = cost;
        best = path;
      }
    }
    this.path = best;
  }

  /* Every so often it drifts somewhere else to sit, around where its style likes to be, so it
     does not park in one spot. */
  wander() {
    if (--this.wanderIn > 0) return;
    this.wanderIn = Math.round(rand(200, 600));
    this.home = clamp(this.style.home + rand(-22, 22), 30, 100);
    this.lean = clamp(this.style.lean + rand(-0.2, 0.2), 0.2, 0.8);
  }

  /* How much of the ship, with its top left at (x, y), the page would hide: 0 to 1. */
  hidden(x, y) {
    let most = 0;
    for (const [x0, y0, x1, y1] of this.cover) {
      const w = Math.min(x + 32, x1) - Math.max(x, x0);
      const h = Math.min(y + 12, y1) - Math.max(y, y0);
      if (w > 0 && h > 0) most = Math.max(most, (w * h) / (32 * 12));
    }
    return most;
  }

  /* The bullets and enemies on screen, as threats moving in straight lines. A bullet is only
     seen once it has been on screen for the pilot's reaction time. Enemies' speeds are taken
     from how far they moved since the last frame, since most of them steer. */
  track(game) {
    const threats = this.threats;
    threats.n = 0;
    for (const b of game.bullets) {
      const at = this.spotted.get(b);
      if (at === undefined) this.spotted.set(b, this.frame);
      else if (this.frame - at >= this.style.reaction) threats.add(b.x, b.y, b.vx, b.vy, 5, 3.5, 0);
    }
    for (const e of game.enemies) {
      if (e.dead) continue;
      let seen = this.seen.get(e);
      if (!seen) {
        seen = { x: e.x - (e.vx || 0), y: e.y - (e.vy || 0), vx: 0, vy: 0 };
        this.seen.set(e, seen);
      }
      seen.vx = e.x - seen.x;
      seen.vy = e.y - seen.y;
      seen.x = e.x;
      seen.y = e.y;
      if (e.delay > 0) threats.add(e.x, e.y, e.vx, 0, e.hw + 10, e.hh + 3, e.delay);
      else threats.add(e.x, e.y, seen.vx, seen.vy, e.hw + 10, e.hh + 3, 0);
    }
  }

  /* What the ship would meet with its top left at (x, y), `t` frames from now: HIT, or how
     closely it shaves past things. */
  danger(game, x, y, t) {
    const cx = x + 16;
    const cy = y + 7;
    const margin = 8 * this.style.nerve;
    const { data, n } = this.threats;
    let near = 0;
    for (let i = 0, k = 0; i < n; i++, k += 7) {
      const dt = t - data[k + 6];
      if (dt < 0) continue;
      const dx = Math.abs(cx - data[k] - data[k + 2] * dt) - data[k + 4];
      const dy = Math.abs(cy - data[k + 1] - data[k + 3] * dt) - data[k + 5];
      if (dx < 0 && dy < 0) return HIT;
      const gap = dx > dy ? dx : dy;
      if (gap < margin) near += (1 - gap / margin) ** 2;
    }
    const L = game.st.level;
    const left = game.scrollX + game.scrollSpeed * t;
    for (const [hx, hy] of HULL) if (solid(L, left, x + hx, y + hy)) return HIT;
    for (const [hx, hy, w] of SKIN) if (solid(L, left, x + hx, y + hy)) near += w;
    const boss = game.boss;
    if (boss && boss.phase !== 'gone') {
      if (boss.touches(cx, cy)) return HIT;
      if (boss.touches(cx + 6, cy) || boss.limbAt(cx, cy, 14)) near += 1;
      const room = boss.x - cx - 40;
      if (room < 0) near -= room / 20;
    }
    return near;
  }

  /* Where it would like the ship to be: lined up with the boss's eye, the next enemy or a
     power-up worth having, or else cruising where its style likes to sit. Returns the spot,
     with how much it cares about each axis. */
  aim(game) {
    const p = game.player;
    const s = this.style;
    // Where it likes to sit is set for the arcade's screen; on a wider one it sits further in.
    const home = (this.home * game.width) / W;
    const goal = { x: home, y: this.cruise(game), wx: 0.03, wy: 0.04 };
    const boss = game.boss;
    if (boss?.alive) {
      // Leads the eye by as far as the boss bobs while the shots fly to it.
      const c = boss.eyeIn(Math.max(0, boss.coreBox().x - p.x - 30) / 6);
      goal.y = c.y + c.h / 2 - 7;
      goal.wy = (boss.open ? 0.2 : 0.1) * s.zeal;
      goal.x = Math.min(home, boss.x - 110);
    } else {
      const e = this.pick(game);
      if (e) {
        // Leads the target by as far as it moves while the shots fly to it.
        const vy = this.seen.get(e)?.vy ?? 0;
        const flight = Math.max(0, e.x - p.x - 30) / 6;
        goal.y = clamp(e.y + vy * flight, 4, PH - 4) - 7;
        goal.wy = 0.12 * s.zeal;
      }
    }
    // Clear of the lane where enemies are about to come from behind.
    for (const w of game.warnings) {
      if (Math.abs(goal.y + 7 - w.y) < 40) goal.y = (w.y < PH / 2 ? w.y + 44 : w.y - 44) - 7;
    }
    const k = this.pickup(game);
    if (k) {
      goal.x = clamp(k.x - 16, 0, game.width - 32);
      goal.y = k.y - 7;
      goal.wx = 0.06 * s.greed;
      goal.wy = 0.15 * s.greed;
    }
    return goal;
  }

  /* The height it likes to cruise at in the open air just ahead. */
  cruise(game) {
    const L = game.st.level;
    let top = 0;
    let bottom = PH;
    for (let x = game.player.x; x < game.player.x + 80; x += 8) {
      const col = clamp(Math.floor((game.scrollX + x) / 2), 0, L.cols - 1);
      top = Math.max(top, L.ceil[col]);
      bottom = Math.min(bottom, PH - L.floor[col]);
    }
    top += 14;
    bottom -= 14;
    return (bottom > top ? top + (bottom - top) * this.lean : (top + bottom) / 2) - 7;
  }

  /* The enemy to shoot at: ahead of the ship, near it and near its line, with big ones and
     ones carrying power-ups first. It keeps to its target unless a much better one comes. */
  pick(game) {
    const p = game.player;
    const cx = p.x + 16;
    const cy = p.y + 7;
    const worth = (e) => (e.x - cx) * this.style.reach + Math.abs(e.y - cy) - (e.big ? 60 : 0) - (e.drop ? 40 : 0);
    const fair = (e) => !e.dead && !e.dying && !(e.delay > 0) && e.x > cx + 12 && e.x < game.width + 8;
    let best = this.target && fair(this.target) && game.enemies.includes(this.target) ? this.target : null;
    let bestWorth = best ? worth(best) - 30 : Infinity;
    for (const e of game.enemies) {
      if (!fair(e)) continue;
      const v = worth(e);
      if (v < bestWorth) {
        bestWorth = v;
        best = e;
      }
    }
    this.target = best;
    return best;
  }

  /* A power-up on screen and not yet behind the ship, if one is near enough for its taste. */
  pickup(game) {
    const p = game.player;
    let best = null;
    let bestD = 160 * this.style.greed;
    for (const k of game.pickups) {
      if (k.x < p.x || k.x > game.width - 8) continue;
      const d = Math.abs(k.x - p.x - 16) + Math.abs(k.y - p.y - 7) * 1.5;
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    return best;
  }

  /* Holds fire while there is something to hit, and lets go for a frame to fire the beam once
     it is charged enough for its taste and lined up with something worth it: for the boss, an
     eye that will be open, and where the ship is, by the time the beam gets there. */
  trigger(game) {
    const p = game.player;
    const cy = p.y + 7;
    const boss = game.boss;
    const e = this.target;
    let fire = !!boss?.alive || !!e;
    if (p.charge >= this.style.beamAt) {
      if (boss?.alive) {
        const c = boss.eyeIn(Math.max(0, boss.coreBox().x - p.x - 28) / 7);
        if (c.open && Math.abs(c.y + c.h / 2 - cy) < c.h / 2 + 2) fire = false;
      } else if (e && Math.abs(e.y - cy) < e.hh + 2 && (e.hp >= 3 || e.big || e.kind === 'head')) fire = false;
    }
    this.firing = fire;
  }
}

/* Whether the terrain is at screen point (x, y), with the stage scrolled to `left`. Off the
   top or bottom of the screen counts only where there is terrain at that edge. */
function solid(L, left, x, y) {
  const col = Math.floor((left + x) / 2);
  if (col < 0 || col >= L.cols) return false;
  const floor = L.floor[col];
  const ceil = L.ceil[col];
  return (floor > 0 && y >= PH - floor) || (ceil > 0 && y < ceil);
}
