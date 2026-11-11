---
status: done
native: false
area: Chrome
---

With Reduce transparency the window turns solid, and with Increase contrast its page and popouts get clear edges.

> [!use] Using it
> Turn on Reduce transparency or Increase contrast in System Settings › Accessibility › Display. Reduce motion was already followed: the window switches and moves without animating.

> [!how] How it works
> `styles.css` answers `prefers-reduced-transparency` with solid backgrounds (macOS draws its own glass and blur solid then too) and `prefers-contrast: more` with hairlines round the page panel, the window and popouts, and a stronger scroll rail.
