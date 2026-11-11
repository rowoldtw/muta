---
status: done
native: true
area: Window
parent: "[[Edge bars]]"
---

‹ the note's name ›, stepping to the previous or next note in order.

> [!use] Using it
> Click the arrows or swipe sideways with two fingers to step. Click the name to pick from the whole list: the name's button grows into a menu where it is, out over the bottom bar and the page to a few pixels from the window's edges, over macOS's own menu material, with grey highlights, the current note ticked and a hairline between each phase and area. Click outside it, pick a note or move away and it shrinks back into the button. The order comes from [[Order notes]].

> [!how] How it works
> The menu is laid out at its full size over the button (centred on it, reaching just below it, `placeMenu()`), clipped to the button's outline, which grows to its own while the button's name fades out and the list in (`openMenu()` and `morphMenu()` in `main.js`; the Web Animations API, on the compositor). With `glass.node`, a panel of macOS's menu material (`NSVisualEffectView`, `glass.node`'s `panel()`) grows behind the page in step, over the window's glass, with the same duration and curve in Core Animation; the page panel, the bottom bar and the frame's tint (`body::before`) get a hole of the same shape (an even-odd `clip-path`), so the material shows through. Without `glass.node`, or with Reduce transparency, the menu has a solid fill instead. Going into the notch closes it at once.
