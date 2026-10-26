# Klio Reader

A simple EPUB viewer for GNOME. You open a book file and read it. It has no
library and nothing to import or organize.

Built with GTK 4, libadwaita, and WebKitGTK. Book rendering is handled by
[foliate-js](https://github.com/johnfactotum/foliate-js), the engine from
[Foliate](https://johnfactotum.github.io/foliate/).

## Features

- Paginated reading, one page at a time
- Or continuous scrolling (Ctrl+M): keep scrolling past the end of a chapter to go on to the next one
- Table of contents sidebar (F9) that follows your position
- Footnotes open in a popup
- Find in the whole book (Ctrl+F, then Enter / Shift+Enter or Ctrl+G / Ctrl+Shift+G)
- Text size (Ctrl+plus / Ctrl+minus / Ctrl+0, or Ctrl+scroll); line length scales with it
- Preferences (Ctrl+,) to override the book's font, font size, and text alignment
- Light, dark, or follow-the-system style, picked from the main menu; links use the system accent color
- Remembers where you left off in each book
- Open a book by double-clicking it, with File › Open (Ctrl+O), or by dragging it onto the window

## Installing

On Fedora, from [COPR](https://copr.fedorainfracloud.org/coprs/mkozlows/klio-reader/):

```sh
sudo dnf copr enable mkozlows/klio-reader
sudo dnf install klio-reader
```

`dnf upgrade` picks up new versions.

## Running from source

Requires `gjs`, GTK 4, libadwaita ≥ 1.8, and WebKitGTK 6.0
(on Fedora: `gjs gtk4 libadwaita webkitgtk6.0`).

```sh
git submodule update --init
./src/main.js path/to/book.epub
```

Set `READER_DEBUG=1` to enable the WebKit inspector (right-click › Inspect Element).

## Installing from source

Requires `meson` (on Fedora: `sudo dnf install meson`). To install just for
yourself, with no `sudo`:

```sh
meson setup _build --prefix="$HOME/.local"
meson install -C _build
```

That adds Klio Reader to the app grid and registers it for `.epub` files. To make it
the default for EPUBs, use Files › right-click a book › Open With…, or run
`xdg-mime default org.klio.Reader.desktop application/epub+zip`.

The installed copy doesn't change when the source does: run
`meson install -C _build` again to update it. To remove it, run
`ninja -C _build uninstall`.

Or as a Flatpak:

```sh
flatpak-builder --user --install --force-clean _flatpak org.klio.Reader.json
```

## Releasing

```sh
./release.sh 0.2.0 "What changed"
```

This bumps the version, tags it, publishes a GitHub release with the
`meson dist` tarball, and starts the COPR build. It needs `meson`, `gh`, and
`copr-cli`, all logged in. Run it with `DRY_RUN=1` first to build and test the
tarball without publishing anything.

Release from the `meson dist` tarball, not GitHub's automatic source archives:
those leave out the foliate-js submodule.

## How it fits together

| File | Role |
| --- | --- |
| `src/application.js` | `Adw.Application`: opens files, app-wide actions, About and Shortcuts dialogs |
| `src/window.js` | The window: header bar, contents sidebar, empty/error states, keyboard handling |
| `src/book-view.js` | `WebKit.WebView` subclass. Serves the reader page, foliate-js, and the book over a private `reader://` URI scheme, and bridges calls between GTK and the page |
| `src/reader/` | The page inside the WebView. Wraps foliate-js and applies the book stylesheet (colors, justification, hyphenation) |
| `src/preferences.js` | Preferences dialog: overrides for the book's font, font size, and alignment |
| `src/toc-view.js` | Table of contents tree (`Gtk.ListView` + `Gtk.TreeListModel`) |
| `src/state.js` | Window size, text size, and reading positions, saved to `$XDG_STATE_HOME/org.klio.Reader/state.json` |
| `src/foliate-js/` | Git submodule, pinned |

The reader page's Content-Security-Policy blocks scripts in book content.
Links to websites open in the default browser.

## License

GPL-3.0-or-later; see [LICENSE](LICENSE). foliate-js is MIT-licensed.
