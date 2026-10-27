# Klio Reader

A simple EPUB viewer for GNOME. You open a book file and read it. It has no
library and nothing to import or organize.

Built with GTK 4, libadwaita, and WebKitGTK. Book rendering is handled by
[foliate-js](https://github.com/johnfactotum/foliate-js), the engine from
[Foliate](https://johnfactotum.github.io/foliate/).

## Features

- Paginated reading, one page at a time
- Or continuous scrolling (Ctrl+M): keep scrolling at the end of a chapter and its last lines scroll up the window, then one more scroll goes on to the next
- Images fit in the window, so covers and full-page illustrations show whole
- Table of contents sidebar (F9) that follows your position
- Footnotes open in a popup
- Right-click a selection › Copy Share Image: the passage as a quote image in your default font, with the author and title
- Find in the whole book (Ctrl+F, then Enter / Shift+Enter or Ctrl+G / Ctrl+Shift+G)
- Text size (Ctrl+plus / Ctrl+minus / Ctrl+0, or Ctrl+scroll); line length scales with it
- Preferences (Ctrl+,): a default font for text the book doesn't choose a font for, and overrides for the book's font, font size, and text alignment
- Light, dark, or follow-the-system style, picked from the main menu; links use the system accent color, and in dark mode black-and-white line art (ornaments, maps, drawings) is recolored to match
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

## Debugging

Set `READER_DEBUG=1` to turn on:

- Verbose logging to stderr: calls into the book page and how long they took,
  messages back from it, section loads, and actions that were ignored, with
  the reason
- Ctrl+Shift+D, which logs the current state, including any calls into the
  page that haven't finished
- The WebKit inspector (right-click › Inspect Element)

To have it on for copies started from the app grid or Files too, add it to
your session environment and log out and back in:

```sh
mkdir -p ~/.config/environment.d
echo READER_DEBUG=1 > ~/.config/environment.d/klio-reader.conf
```

The log then goes to the journal:
`journalctl --user -b | grep -E 'Gjs-Console|CONSOLE'`.

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
| `src/share-image.js` | Renders selected text as a quote image for the clipboard |
| `src/preferences.js` | Preferences dialog: the default font, and overrides for the book's font, font size, and alignment |
| `src/toc-view.js` | Table of contents tree (`Gtk.ListView` + `Gtk.TreeListModel`) |
| `src/log.js` | Debug logging, on with `READER_DEBUG` |
| `src/state.js` | Window size, text size, and reading positions, saved to `$XDG_STATE_HOME/org.klio.Reader/state.json` |
| `src/foliate-js/` | Git submodule, pinned |

The reader page's Content-Security-Policy blocks scripts in book content.
Links to websites open in the default browser.

## License

GPL-3.0-or-later; see [LICENSE](LICENSE). foliate-js is MIT-licensed.
