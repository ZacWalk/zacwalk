/* The only script the page loads up front. Once the page has loaded it starts the attract mode
   (attract.js), the game playing itself behind the portrait; it shows the title screen's PRESS
   START button, which the page hides for anyone without scripts; and it opens the arcade
   (arcade.js) when someone presses it, pausing the attract mode until they quit. */

const scene = document.querySelector('[data-attract]');
const button = document.querySelector('[data-press-start]');
let demo = null;

// After the page has loaded, and when the browser has a moment, so the game never holds up the
// page. Not for anyone who has asked their browser to save data.
if (scene && 'IntersectionObserver' in window && !navigator.connection?.saveData) {
  const begin = () =>
    import('./attract.js')
      .then(({ attract }) => (demo = attract(scene)))
      .catch((err) => console.error(err));
  const soon = () => (window.requestIdleCallback ? requestIdleCallback(begin, { timeout: 1500 }) : setTimeout(begin, 200));
  if (document.readyState === 'complete') soon();
  else window.addEventListener('load', soon, { once: true });
}

if (button && 'HTMLDialogElement' in window) {
  // The best score on this machine (see SCORES_KEY in game.js), as an arcade would show it.
  const hi = button.querySelector('[data-hi]');
  const showHi = () => {
    try {
      const best = JSON.parse(localStorage.getItem('rethinkify-scores') ?? 'null')?.[0]?.score;
      if (hi && Number.isFinite(best)) hi.textContent = `HI ${String(best).padStart(7, '0')}`;
    } catch {
      // No storage, or nothing saved yet: the button just says PRESS START.
    }
  };
  showHi();

  let loading = null;
  let starting = false;
  const load = () => (loading ??= import('./arcade.js'));
  button.addEventListener('pointerenter', load, { once: true });
  button.addEventListener('focus', load, { once: true });
  button.addEventListener('click', async () => {
    // A second tap while the game is still loading would make a second AudioContext.
    if (starting) return;
    starting = true;
    // Browsers only let sound start inside a click, so make the AudioContext here and now.
    const Context = window.AudioContext ?? window.webkitAudioContext;
    let audio = null;
    try {
      audio = Context ? new Context({ latencyHint: 'interactive' }) : null;
      audio?.resume().catch(() => {});
    } catch {
      audio = null;
    }
    const back = () => {
      demo?.resume();
      showHi();
    };
    try {
      const { play } = await load();
      demo?.pause();
      await play({ audio, opener: button, onClose: back });
    } catch (err) {
      audio?.close().catch(() => {});
      loading = null;
      back();
      console.error(err);
    } finally {
      starting = false;
    }
  });
  button.hidden = false;
}
