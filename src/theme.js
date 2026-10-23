(function () {
  function resolve(doc, win) {
    const body = doc?.body;
    if (body?.hasAttribute?.('data-ds-dark-theme')) return {mode: 'dark', source: 'harness'};

    // Harness publishes the resolved theme on the document, not the preference name.
    const html = doc?.documentElement;
    let scheme = '';
    try {
      scheme = String(win?.getComputedStyle?.(html)?.colorScheme || html?.style?.colorScheme || '').trim().toLowerCase();
    } catch (_) {}
    if (scheme === 'dark' || scheme === 'light') return {mode: scheme, source: 'harness'};

    try {
      if (body && win?.getComputedStyle?.(body)?.getPropertyValue('--dsw-alias-bg-base')?.trim()) {
        return {mode: 'light', source: 'harness'};
      }
    } catch (_) {}

    try {
      if (win?.matchMedia?.('(prefers-color-scheme: light)').matches) return {mode: 'light', source: 'system'};
      if (win?.matchMedia?.('(prefers-color-scheme: dark)').matches) return {mode: 'dark', source: 'system'};
    } catch (_) {}
    return {mode: 'dark', source: 'default'};
  }

  function subscribe(doc, win, onChange) {
    if (!doc || !win) return () => {};
    const update = () => onChange(resolve(doc, win));
    const observers = [];
    const Observer = win.MutationObserver;
    if (typeof Observer === 'function') {
      for (const element of [doc.documentElement, doc.body]) {
        if (!element) continue;
        try {
          const observer = new Observer(update);
          observer.observe(element, {attributes: true, attributeFilter: ['data-ds-dark-theme', 'style', 'class']});
          observers.push(observer);
        } catch (_) {}
      }
    }
    const media = [];
    if (typeof win.matchMedia === 'function') {
      for (const preference of ['light', 'dark']) {
        try {
          const query = win.matchMedia('(prefers-color-scheme: ' + preference + ')');
          if (query?.addEventListener) {
            query.addEventListener('change', update);
            media.push(() => query.removeEventListener('change', update));
          } else if (query?.addListener) {
            query.addListener(update);
            media.push(() => query.removeListener(update));
          }
        } catch (_) {}
      }
    }
    update();
    return () => { for (const observer of observers) observer.disconnect(); for (const remove of media) remove(); };
  }
  return {resolve, subscribe};
})()
