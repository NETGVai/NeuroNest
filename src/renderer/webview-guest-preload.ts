/**
 * Minimal constrained guest preload for the legacy webview guest
 * (NN-SEC-017, FUT-PKG-04-SECURITY/T-001).
 *
 * The legacy guest webview (the in-app browser panel and the Stripe checkout
 * surface) renders untrusted third-party web content. Per NN-SEC-017 / D-16.1
 * it runs in a dedicated isolated partition with `nodeIntegration:false`,
 * `contextIsolation:true`, and `sandbox:true`, and its preload MUST be
 * *minimal and constrained*: it exposes NO privileged bridge, NO IPC surface,
 * and NO host capability to the guest. Guest-to-host privilege escalation is
 * therefore impossible through this preload — it deliberately does nothing.
 *
 * This file intentionally contains no `contextBridge.exposeInMainWorld` call
 * and no `ipcRenderer` usage. Any future capability the guest legitimately
 * needs must be added through a separately reviewed, typed, main-attested
 * contract — never a broad bridge here.
 */

// No exposed API. The constrained guest has no host bridge by design.
export {};
