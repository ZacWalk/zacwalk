/* The title screen's attract mode: the game playing itself behind the portrait, the way an
   arcade cabinet played while it waited for a coin. pilot.js flies the ship; this draws the
   game in two layers, the world for the page to show in grey and the shots and explosions in
   colour over it, at a whole number of device pixels per game pixel so every pixel is the same
   size. Its playfield is as wide as the window allows, up to three times the arcade's, so the
   game spreads out either side of the portrait. It runs only while the title screen is in view
   and the arcade is closed, and for anyone who prefers reduced motion it draws a single frame
   and stops. boot.js starts it once the page has loaded. */

import { Sound } from './audio.js';
import { Game } from './game.js';
import { Pilot } from './pilot.js';
import { PH, W, WIDEST } from './screen.js';

/* The game runs sixty frames a second, as it always does, and the title screen draws every
   other one: still a pixel at a time for the terrain, and half the work for the browser. Each
   drawing waits out one frame of the screen before asking for the next, so the browser has
   nothing to do in between. */
const STEP = 1000 / 60;
const DRAW_GAP = 1000 / 30 - 8;

/* How far into the game the still frame for reduced motion is taken: the first enemies are in. */
const STILL_AT = 840;

function layer(name, alpha) {
  const canvas = document.createElement('canvas');
  canvas.className = name;
  canvas.height = PH;
  const g = canvas.getContext('2d', { alpha });
  return { canvas, g };
}

/* Puts the attract mode into `scene` and starts it. Returns pause() and resume(), which the
   arcade uses to stop it while someone plays. */
export function attract(scene) {
  const band = document.createElement('div');
  band.className = 'attract';
  band.setAttribute('aria-hidden', 'true');
  const world = layer('attract-world', false);
  const action = layer('attract-action', true);
  band.append(world.canvas, action.canvas);
  scene.prepend(band);

  const pilot = new Pilot();
  let game = null;
  const calm = matchMedia('(prefers-reduced-motion: reduce)');
  let inView = false;
  let held = false;
  let readerPaused = false;
  let running = false;
  let raf = 0;
  let timer = 0;
  let last = 0;
  let owed = 0;

  const draw = () => game.renderLayers(world.g, action.g);

  // As tall as fits above the wordmark, which sits over the bottom of the scene, and as wide as
  // the scene at that size, from the arcade's width up to WIDEST. The pilot is told what the
  // page draws over the game (the portrait, PRESS START and the readout), in game pixels, so it
  // can keep the ship where it can be seen.
  const fit = () => {
    const dpr = window.devicePixelRatio || 1;
    const room = scene.clientHeight - (parseFloat(getComputedStyle(band).bottom) || 0);
    const k = Math.max(1, Math.floor((room * dpr) / PH));
    const width = Math.min(WIDEST, Math.max(W, Math.floor((scene.clientWidth * dpr) / k)));
    if (width !== world.canvas.width) {
      // A canvas forgets its settings, and what was on it, when it changes size.
      for (const { canvas, g } of [world, action]) {
        canvas.width = width;
        g.imageSmoothingEnabled = false;
      }
      if (game) {
        game.width = width;
        draw();
      }
    }
    band.style.width = `${(width * k) / dpr}px`;
    band.style.height = `${(PH * k) / dpr}px`;
    const at = band.getBoundingClientRect();
    const scale = width / at.width;
    pilot.cover = [...scene.querySelectorAll('[data-covers-game]')]
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width && r.height)
      .map((r) => [(r.left - at.left) * scale, (r.top - at.top) * scale, (r.right - at.left) * scale, (r.bottom - at.top) * scale]);
  };

  const frame = (now) => {
    owed += Math.min(100, now - last);
    last = now;
    while (owed >= STEP) {
      game.update();
      owed -= STEP;
    }
    draw();
    timer = setTimeout(() => (raf = requestAnimationFrame(frame)), DRAW_GAP);
  };

  const run = () => {
    const go = inView && !held && !readerPaused && !calm.matches;
    if (go === running) return;
    running = go;
    if (go) {
      last = performance.now();
      raf = requestAnimationFrame(frame);
    } else {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    }
  };

  fit();
  game = new Game(world.g, pilot, new Sound(null), true, { demo: true, width: world.canvas.width });
  document.fonts?.ready.then(fit);
  if (calm.matches) for (let i = 0; i < STILL_AT; i++) game.update();
  draw();
  band.classList.add('is-on');

  window.addEventListener('resize', fit);
  const motionButton = scene.querySelector('[data-demo-motion]');
  const syncMotion = () => {
    if (motionButton) {
      motionButton.hidden = calm.matches;
      motionButton.textContent = readerPaused ? 'Resume demo' : 'Pause demo';
    }
    run();
  };
  motionButton?.addEventListener('click', () => {
    // Closing the arcade must not undo the reader's own pause.
    readerPaused = !readerPaused;
    syncMotion();
  });
  syncMotion();
  calm.addEventListener('change', syncMotion);
  new IntersectionObserver((entries) => {
    inView = entries.at(-1).isIntersecting;
    run();
  }).observe(scene);

  return {
    pause() {
      held = true;
      run();
    },
    resume() {
      held = false;
      run();
    },
  };
}
