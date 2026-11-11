---
status: done
native: false
area: Pages
---

Pages slide up or down depending on where the link is, and sideways when stepping through the order.

> [!how] How it works
> Hovering, the old page (a copy, `.muta-old`) drifts away, fading and blurring, as the new one slides in 10px and sharpens. Stepping through the order, the two slide side by side a page's width apart and stay solid, like turning a page: a crossfade there doubled the text and dimmed it for a moment, which read as a blink. The animations start before the new page is first drawn, so it never shows in place for a frame first (`crossfade()` in `main.js`).

> [!out] Left out
> With macOS's Reduce motion on, pages switch and the window moves without animating.
