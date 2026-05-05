/**
 * Extra zoom guards beyond viewport meta (iOS/Android often still allow pinch).
 * Uses gesture events (Safari), multi-touch touchmove, and ctrl+wheel.
 */
const passiveFalse = { passive: false };

function preventDefault(e) {
  e.preventDefault();
}

// WebKit/Safari pinch-zoom
document.addEventListener("gesturestart", preventDefault, passiveFalse);
document.addEventListener("gesturechange", preventDefault, passiveFalse);
document.addEventListener("gestureend", preventDefault, passiveFalse);

// Chrome/Android and others: block two-finger pinch
document.addEventListener(
  "touchmove",
  (e) => {
    if (e.touches.length > 1) {
      e.preventDefault();
    }
  },
  passiveFalse
);

// Pinch on trackpad / some browsers
document.addEventListener(
  "wheel",
  (e) => {
    if (e.ctrlKey) {
      e.preventDefault();
    }
  },
  passiveFalse
);
