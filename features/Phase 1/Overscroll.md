---
status: done
native: false
area: Pages
---

Pulling past a page's top or bottom rubber-bands and fades it gradually; a flick carries on past the end and eases back, like macOS.

> [!use] Using it
> **Overscroll** in settings.

> [!how] How it works
> A flick's bounce starts on the scroll that carries the page to its end, not a frame after it has stopped there (`attachOverscroll()` in `main.js`), and carries on at the page's speed, easing back as a critically damped spring (`bouncePath()`).
