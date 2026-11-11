---
status: done
native: true
area: Window
parent: "[[Edge bars]]"
---

‹ the note's name ›, stepping to the previous or next note in order.

> [!use] Using it
> Click the arrows or swipe sideways with two fingers to step. Click the name to pick from the whole list: the button grows into a menu centred on it, half over the window and half below it, over Liquid Glass like the window's own, lightly tinted, with grey highlights, the current note ticked and a hairline between each phase and area. Move the cursor off it, click elsewhere or pick a note and it shrinks back into the button.

> [!how] How it works
> The menu is its own small window (`pip-main.js`'s `openMenu()`), a child of the preview so it moves with it, never focused, so it can reach past the preview's edges; it's kept on the screen. Its page is laid out at full size and clipped to the button's outline, which grows to its own while the button's name fades out and the list in (the Web Animations API); behind it, a panel of Liquid Glass (`NSGlassEffectView`, clear, lightly tinted; macOS's menu material before macOS 26; `glass.node`'s `panel()`, with round corners to match the page's border) grows in step in Core Animation, with the same duration and curve, blurring the preview and whatever else is under it. It closes 250ms after the cursor leaves it; the bottom bar stays open until it's back in. Docked at the notch, the window stays out while the cursor is on the menu, and going into the notch closes it at once.