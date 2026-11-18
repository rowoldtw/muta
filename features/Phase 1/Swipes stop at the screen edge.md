---
status: done
native: false
area: "Moving it"
---

Swiping the window to a screen's edge stops it there instead of losing it.

> [!how] How it works
> The cursor rides on the window during a swipe but can't leave the screens, so `pip-main.js` stops the window where the cursor would (`onScreen`). The window's clock also survives a failed step: before, one error while moving left it looking alive but stopped, and the window wouldn't move again.
