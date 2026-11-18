---
status: done
native: true
area: Chrome
---

The window follows Obsidian's light or dark theme: a pale frame and light glass in light mode.

> [!use] Using it
> Switch Obsidian between light and dark (Settings › Appearance) and the window switches with it. Docked at the notch it stays dark, since it grows out of the black notch.

> [!how] How it works
> `styles.css` draws the frame, the page panel and the highlights, tracks and hairlines over the glass from three colours (`--muta-frame`, `--muta-panel`, `--muta-ink`), set again for `.theme-light`. `main.js` passes `dark` to `glass.node`, which holds the glass to macOS's light or dark look and tints it white or black, and re-applies it on Obsidian's `css-change`. Docked, `main.js` keeps the page in `theme-dark` (`keepTheme()`, on every change to its classes, since Obsidian sets them when it likes) and puts Obsidian's theme back on leaving.
