---
status: done
native: false
area: Obsidian
---

Hovering a link opens the window only while a key is held (⌘ by default), so it doesn't open by accident.

> [!use] Using it
> Hold ⌘ and hover a link, or hover it and then press ⌘. Settings › Behaviour › Hold a key to preview picks the key (⌘, ⌥, ⌃ or ⇧), or None to preview on any hover as before.

> [!how] How it works
> `main.js` keeps track of the modifier keys in each of Obsidian's windows from mouse and key events (mouse events carry them, so they're right as a link is hovered). Its patch of Obsidian's page preview skips a hover without the key and remembers the link; pressing the key while the cursor is still over it (`:hover`) previews it then.
