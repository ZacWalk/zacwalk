(() => {
    const menu = document.querySelector('details[data-site-menu]');
    const toggle = menu.querySelector('summary');
    const compact = matchMedia('(max-width: 900px)');

    function fit() {
        const focused = document.activeElement;
        if (compact.matches && menu.contains(focused)) toggle.focus({ preventScroll: true });
        menu.open = !compact.matches;
        if (!compact.matches && focused === toggle) {
            const link = menu.querySelector('a[aria-current]') || menu.querySelector('a');
            link.focus({ preventScroll: true });
        }
    }

    compact.addEventListener('change', fit);
    fit();
    window.addEventListener('pageshow', event => { if (event.persisted) fit(); });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && compact.matches && menu.open) {
            menu.open = false;
            toggle.focus({ preventScroll: true });
            event.preventDefault();
        }
    });
    document.addEventListener('focusin', event => {
        if (compact.matches && !menu.contains(event.target)) menu.open = false;
    });
    document.addEventListener('click', event => {
        if (compact.matches && (!menu.contains(event.target) || event.target.closest('a[href]'))) {
            menu.open = false;
        }
    });
})();
