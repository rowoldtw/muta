---
status: planned
priority: medium
native: true
area: "Moving it"
---

Pinch on the window to resize it like macOS picture in picture, keeping its shape and docked corner.

> [!how] Plan
> Chromium drops pinches when the page can't zoom, so `glass.node` watches for them natively on the top bar.

> [!todo] Left to do
> It was reverted from main once (cbb2031); find out why before bringing it back.
