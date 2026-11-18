---
status: planned
priority: high
native: false
area: "Any vault"
---

The window looks and behaves the same in any Obsidian theme, while the page itself follows the theme.

> [!how] Plan
> Muta owns the window and the theme owns the page. The window is everything Muta draws: the frame, glass and darkness, the edge bars and their buttons, the rail, the properties pill, the notch and the agent beam. It should look the same in every theme. The page is the note's own text, callouts, tables and code, and it should take the theme's look, as it would in Obsidian. Cupertino barely styles popout windows (its window rules skip `.is-popout-window`), so most of the window is already Muta's; what still leaks in from a theme is:
>
> - **Backgrounds:** themes paint `.workspace`, `.workspace-leaf`, `.view-header`, `.view-content` and `.markdown-reading-view`. Muta makes them see-through, so the glass shows, but only for the ones Cupertino paints. The fix is to make every layer from `body` to the page see-through in `body.muta-window`, and draw only Muta's own panel.
> - **The top bar:** header height, icon size, padding and hover backgrounds come from theme variables (`--header-height`, `--icon-size`, `--clickable-icon-radius`). The fix is to set Muta's own values for these on `body.muta-window`, so a theme can't move the buttons off the page's edges or the notch.
> - **The properties pill and the rail's marks:** these lean on `.metadata-container` and callout classes that themes restyle heavily, Minimal and AnuPpuccin especially. The fix is to style the pill from Muta's tokens, and read the marks' positions only, never their looks.
> - **Fonts and radii:** Muta's own controls should use the system font (`-apple-system`) and Muta's radii. The page keeps `--font-text` and the theme's radii.
> - **Light and dark:** these already follow Obsidian's `theme-light`/`theme-dark` through Muta's own tokens. Themes that set colours only through their Style Settings classes need checking.
>
> To test it without touching the screen:
>
> - A second test vault (`Muta Themes`) gets the default theme, Minimal, Things, AnuPpuccin, Blue Topaz, Prism and Cupertino, each with no snippets.
> - A script switches the theme in that vault (`app.customCss.setTheme`, through `obsidian eval`) and captures the window with Electron's `webContents.capturePage()`, which needs no screen access. It does this docked, floating and tucked, in light and dark.
> - Each capture is compared to Cupertino's.
>
> If a theme still pulls a part of the window its own way, the fix goes in `styles.css` under `body.muta-window` with Muta's tokens. Only when no CSS fix will do does it go in as a per-theme exception.

> [!out] Left out
> Theme options set through Style Settings are only checked for the themes above, not supported one by one.
