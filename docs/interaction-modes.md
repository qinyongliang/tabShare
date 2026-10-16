# Interaction and display modes (0.8.2)

The compact shared-page panel offers DOM and WebRTC display modes. The mode is authoritative for the shared source tab: all visitors see the same mode, including late joins. Independent fit/zoom remains per visitor. Advanced controls, URL navigation and source viewport following are collapsed by default.

- **DOM** preserves native text selection, form controls and incremental node/style updates. Unsupported regions continue to use regional video. DOM packets can themselves travel over WebRTC DataChannels; the selector changes rendering, not the transport protocol.
- **WebRTC** presents the complete source viewport as live video. Pointer coordinates map to source CSS pixels. If the peer connection is unavailable, bounded JPEG snapshots provide an emergency view; this is not represented as live WebRTC. Video shows the pixels of the explicitly shared tab, including visible page overlays.
- Both extension and server need updating. Older extensions intentionally accept DOM mode only. Reopen the shared page after reloading the updated extension.

## Responsiveness changes

Continuous DOM scrolling now coalesces the latest position independently for each scrolling container every 32 ms, rather than restarting a 100 ms debounce timer on every event. Navigation/disconnect clears pending positions. This reduces avoidable sender delay; end-to-end latency still depends on page work and network conditions.

Ordinary node/text patches no longer recalculate the outer fit geometry. Fit runs on initial/reset snapshots, source dimension changes and actual viewer resize/zoom events, scheduled through requestAnimationFrame. Source mutation byte budgets and transport backpressure remain enforced.

The loading indicator remains a real CSS animation in the trusted viewer. Mirrored source scripts remain disabled; mode selection does not relax sandbox/CSP or input allowlists.

## Verification

`npm test` covers coalescer cadence, independent containers, cancellation, reentrant scheduling and exact mode allowlists. `tests/e2e.mjs` exercises visible mode controls, repeated switching, late joins, multiple viewers and actual source clicks through the full-frame surface, in both relay-only and forced TURN runs. Existing clipboard, Chinese input, downloads, scrolling, popups, resource/CSS and reconnection scenarios continue to run. Browser screenshots are retained as CI artifacts.
