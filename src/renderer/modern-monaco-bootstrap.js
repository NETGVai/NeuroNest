(function bootstrapModernMonaco() {
  var ready = import('./modern-monaco-adapter.mjs').then(function(module) {
    return module.initializeModernMonaco();
  });

  // Publish readiness synchronously from this external classic script. The
  // production CSP allows self-hosted scripts but blocks inline bridges and
  // inline import maps.
  window.monacoReady = ready;
  ready.then(function(monaco) {
    window.monaco = monaco;
    window.monacoInitializationError = null;
  }).catch(function(error) {
    window.monacoInitializationError = error instanceof Error ? error : new Error(String(error));
    console.error('[Monaco] Failed to initialize local modern-monaco:', error);
  });
  // Keep the shared promise handled until an editor caller attaches its own
  // error UI and retry behavior.
  ready.catch(function() {});
})();
