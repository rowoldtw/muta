---
status: done
native: true
area: "Moving it"
---

Throw the window and it springs to the nearest of five spots: the corners and the top middle.

> [!how] How it works
> `pip-main.js` follows the drag or swipe every frame and runs the spring on its own clock. `pip-helper.swift` reads the trackpad's own scroll events, including touch down and lift, which Electron's wheel events leave out. It needs no permissions.
