import GObject from 'gi://GObject?version=2.0'
import GLib from 'gi://GLib?version=2.0'
import Gio from 'gi://Gio?version=2.0'
import Gdk from 'gi://Gdk?version=4.0'
import Gtk from 'gi://Gtk?version=4.0'
import Pango from 'gi://Pango?version=1.0'
import Adw from 'gi://Adw?version=1'

import { APP_ID, APP_NAME } from './config.js'
import { BookView } from './book-view.js'
import { ImageView } from './image-view.js'
import { DEBUG, debug } from './log.js'
import { TocView } from './toc-view.js'
import { renderQuoteImage } from './share-image.js'
import { state } from './state.js'

Gio._promisify(Gtk.FileDialog.prototype, 'open', 'open_finish')

const PROGRESS_OSD_TIMEOUT_MS = 1500

const COLORS = {
    light: { bg: '#ffffff', fg: '#1f1f23' },
    dark: { bg: '#1d1d20', fg: '#e0e0e2' },
}

// Line art in the image view is recolored in dark mode, as in the book (see
// `lineArtFilter` in reader/reader.js). The image view adds the class only in
// dark mode.
const LINE_ART_CSS = (() => {
    const level = color => [1, 3, 5]
        .reduce((sum, i) => sum + parseInt(color.slice(i, i + 2), 16), 0) / 765
    const paper = level(COLORS.dark.bg)
    const ink = level(COLORS.dark.fg)
    return `image-view picture.line-art {
        filter: invert(${ink / (ink + paper)}) brightness(${ink + paper});
    }`
})()
let lineArtCssLoaded = false

// Keys for turning pages while the book has focus. These are handled in the
// capture phase, before WebKit sees them.
const PAGE_KEYS = {
    'Right|KP_Right|l': view => view.goRight(),
    'Left|KP_Left|h': view => view.goLeft(),
    'Page_Down|KP_Page_Down|space': view => view.next(),
    'Page_Up|KP_Page_Up|<Shift>space': view => view.prev(),
    'Down|KP_Down|j': view => view.scrollDown(),
    'Up|KP_Up|k': view => view.scrollUp(),
}

// Actions that only make sense with a book open
const BOOK_ACTIONS = ['toggle-sidebar', 'back', 'forward', 'find']

const makeFileDialog = () => {
    const epub = new Gtk.FileFilter({ name: 'EPUB Books' })
    epub.add_mime_type('application/epub+zip')
    epub.add_suffix('epub')
    const all = new Gtk.FileFilter({ name: 'All Files' })
    all.add_pattern('*')
    const filters = new Gio.ListStore({ item_type: Gtk.FileFilter })
    filters.append(epub)
    filters.append(all)
    return new Gtk.FileDialog({ title: 'Open Book', filters, default_filter: epub })
}

const makeMainMenu = () => {
    const menu = new Gio.Menu()
    const appearance = new Gio.Menu()
    for (const id of ['style-switcher', 'text-size']) {
        const item = new Gio.MenuItem()
        item.set_attribute_value('custom', new GLib.Variant('s', id))
        appearance.append_item(item)
    }
    menu.append_section(null, appearance)

    const file = new Gio.Menu()
    file.append('_Open…', 'win.open')
    file.append('_New Window', 'app.new-window')
    menu.append_section(null, file)

    const view = new Gio.Menu()
    view.append('_Continuous Scrolling', 'app.scrolled')
    view.append('_Fullscreen', 'win.fullscreen')
    menu.append_section(null, view)

    const help = new Gio.Menu()
    help.append('_Preferences', 'app.preferences')
    help.append('_Keyboard Shortcuts', 'app.shortcuts')
    help.append(`_About ${APP_NAME}`, 'app.about')
    menu.append_section(null, help)
    return menu
}

// Follow system / light / dark, as in GNOME Text Editor
const makeStyleSwitcher = () => {
    const box = new Gtk.Box({
        css_classes: ['style-switcher'],
        halign: Gtk.Align.CENTER,
        spacing: 18,
    })
    for (const [target, tooltip] of [
        ['default', 'Follow System Style'],
        ['light', 'Light Style'],
        ['dark', 'Dark Style'],
    ]) {
        box.append(new Gtk.CheckButton({
            css_classes: [target],
            tooltip_text: tooltip,
            action_name: 'app.color-scheme',
            action_target: new GLib.Variant('s', target),
        }))
    }
    return box
}

// The "− 100% +" row at the top of the main menu
const makeTextSizeControls = window => {
    const box = new Gtk.Box({ spacing: 12, margin_start: 12, margin_end: 12, homogeneous: true })
    const button = (props, cssClasses = ['flat', 'circular']) => new Gtk.Button({
        ...props, css_classes: cssClasses, halign: Gtk.Align.CENTER,
    })
    const reset = button({
        action_name: 'win.text-reset',
        tooltip_text: 'Reset Text Size',
        label: '100%',
    }, ['flat'])
    reset.add_css_class('numeric')
    box.append(button({
        action_name: 'win.text-smaller',
        tooltip_text: 'Smaller Text',
        icon_name: 'zoom-out-symbolic',
    }))
    box.append(reset)
    box.append(button({
        action_name: 'win.text-larger',
        tooltip_text: 'Larger Text',
        icon_name: 'zoom-in-symbolic',
    }))
    window.connect('text-scale-changed', (_, scale) =>
        reset.label = `${Math.round(scale * 100)}%`)
    return box
}

export const ReaderWindow = GObject.registerClass({
    GTypeName: 'ReaderWindow',
    Signals: {
        'text-scale-changed': { param_types: [GObject.TYPE_DOUBLE] },
    },
}, class ReaderWindow extends Adw.ApplicationWindow {
    file = null
    #bookKey = null
    #book = null // { title, author } of the book showing
    #imageView = new ImageView({ css_classes: ['view'] })
    #canGoBack = false
    #font = null // the custom font last applied, if any
    #defaultFont = null // the default font last applied
    #bookView = new BookView()
    #tocView = new TocView()
    #title = new Adw.WindowTitle({ title: APP_NAME })
    #stack = new Gtk.Stack({ transition_type: Gtk.StackTransitionType.CROSSFADE })
    #spinner = new Adw.Spinner({ halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER, visible: false })
    #progressLabel = new Gtk.Label({
        ellipsize: Pango.EllipsizeMode.END,
        max_width_chars: 40,
        css_classes: ['numeric'],
    })
    #progressOsd = new Gtk.Revealer({
        transition_type: Gtk.RevealerTransitionType.CROSSFADE,
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.END,
        margin_bottom: 12,
        can_target: false,
    })
    #progressOsdTimeout = 0
    // Shown while pulling past the edge of a chapter in scrolled mode
    #pullIcon = new Gtk.Image({ icon_name: 'go-down-symbolic' })
    #pullLabel = new Gtk.Label({ ellipsize: Pango.EllipsizeMode.END, max_width_chars: 40 })
    #pullBar = new Gtk.ProgressBar()
    #pullOsd = new Gtk.Revealer({
        transition_type: Gtk.RevealerTransitionType.CROSSFADE,
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.END,
        margin_bottom: 12,
        can_target: false,
    })
    #errorPage = new Adw.StatusPage({ icon_name: 'dialog-error-symbolic', title: 'Unable to Open Book' })
    #splitView
    #contentToolbar
    #toastOverlay = new Adw.ToastOverlay()
    #searchBar = new Gtk.SearchBar()
    #findButton = new Gtk.ToggleButton({
        icon_name: 'system-search-symbolic',
        tooltip_text: 'Find',
    })
    #searchEntry = new Gtk.SearchEntry({
        placeholder_text: 'Find in book',
        hexpand: true,
        search_delay: 250,
    })
    #searchStatus = new Gtk.Label({ css_classes: ['dim-label', 'numeric'] })

    constructor(application) {
        super({
            application,
            title: APP_NAME,
            default_width: state.get('width'),
            default_height: state.get('height'),
            maximized: state.get('maximized'),
            width_request: 360,
            height_request: 294,
        })
        this.#buildUI()
        this.#setupActions()
        this.#setupAppearance()
        this.#setupDragAndDrop()

        this.#tocView.connect('navigate', (_, href) => {
            debug(`contents: ${href}`)
            this.#bookView.goTo(href)
            if (this.#splitView.collapsed) this.#splitView.show_sidebar = false
            this.#bookView.grab_focus()
        })
        this.#bookView.connect('relocate', (_, { cfi, tocId, tocLabel, progress }) => {
            if (this.#bookKey && cfi) state.setPosition(this.#bookKey, cfi)
            this.#tocView.setCurrent(tocId)
            if (this.#bookView.scrolled && !this.#spinner.visible && !this.#pullOsd.reveal_child)
                this.#showProgress(tocLabel ? `${tocLabel} · ${progress}` : progress)
        })
        this.#bookView.connect('share-selection', (_, paragraphs) => this.#copyShareImage(paragraphs))
        this.connect('destroy', () => this.#hideProgress())
        this.#bookView.connect('pull', (_, { fraction, label }) => {
            this.#pullOsd.reveal_child = fraction > 0
            if (!fraction) return
            this.#hideProgress()
            this.#pullLabel.label = label || 'Next'
            this.#pullBar.fraction = fraction
        })
        this.#bookView.connect('zoom', (_, dir) =>
            this.application.setTextScale(this.application.textScale + dir * 0.1))
        this.#bookView.connect('view-image', (_, uri) => this.#viewImage(uri))
        this.#bookView.connect('history-changed', (_, canGoBack, canGoForward) => {
            this.#canGoBack = canGoBack
            this.lookup_action('back').enabled = canGoBack || this.#viewingImage
            this.lookup_action('forward').enabled = canGoForward
        })
        this.connect('close-request', () => {
            state.set('maximized', this.maximized)
            if (!this.maximized && !this.fullscreened) {
                const [width, height] = this.get_default_size()
                state.set('width', width)
                state.set('height', height)
            }
            return false
        })
    }

    #buildUI() {
        // Sidebar: table of contents
        const sidebarToolbar = new Adw.ToolbarView({ content: this.#tocView })
        sidebarToolbar.add_top_bar(new Adw.HeaderBar({
            title_widget: new Adw.WindowTitle({ title: 'Contents' }),
        }))

        // Content: header bar + status pages / book
        const header = new Adw.HeaderBar({ title_widget: this.#title })
        const sidebarButton = new Gtk.ToggleButton({
            icon_name: 'sidebar-show-symbolic',
            tooltip_text: 'Contents',
            action_name: 'win.toggle-sidebar',
        })
        header.pack_start(sidebarButton)
        header.pack_start(new Gtk.Button({
            icon_name: 'go-previous-symbolic',
            tooltip_text: 'Back',
            action_name: 'win.back',
        }))
        const findButton = this.#findButton
        findButton.bind_property('active', this.#searchBar, 'search-mode-enabled',
            GObject.BindingFlags.BIDIRECTIONAL)
        const menu = new Gtk.PopoverMenu({ menu_model: makeMainMenu() })
        menu.add_child(makeStyleSwitcher(), 'style-switcher')
        menu.add_child(makeTextSizeControls(this), 'text-size')
        header.pack_end(new Gtk.MenuButton({
            icon_name: 'open-menu-symbolic',
            tooltip_text: 'Main Menu',
            popover: menu,
            primary: true,
        }))
        header.pack_end(findButton)

        const emptyPage = new Adw.StatusPage({
            icon_name: APP_ID,
            title: 'Read a Book',
            description: 'Drag and drop an EPUB file here',
            child: new Gtk.Button({
                label: '_Open…',
                use_underline: true,
                action_name: 'win.open',
                halign: Gtk.Align.CENTER,
                css_classes: ['pill', 'suggested-action'],
            }),
        })
        emptyPage.add_css_class('icon-dropshadow')
        this.#errorPage.child = new Gtk.Button({
            label: '_Open Another Book…',
            use_underline: true,
            action_name: 'win.open',
            halign: Gtk.Align.CENTER,
            css_classes: ['pill'],
        })
        const bookPage = new Gtk.Overlay({ child: this.#bookView })
        bookPage.add_overlay(this.#spinner)
        // In scrolled mode there's no page footer, so progress shows here
        const progressBox = new Gtk.Box({ css_classes: ['osd', 'progress-osd'] })
        progressBox.append(this.#progressLabel)
        this.#progressOsd.child = progressBox
        bookPage.add_overlay(this.#progressOsd)
        const pullRow = new Gtk.Box({ spacing: 6, halign: Gtk.Align.CENTER })
        pullRow.append(this.#pullIcon)
        pullRow.append(this.#pullLabel)
        const pullBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            css_classes: ['osd', 'pull-osd'],
        })
        pullBox.append(pullRow)
        pullBox.append(this.#pullBar)
        this.#pullOsd.child = pullBox
        bookPage.add_overlay(this.#pullOsd)
        this.#stack.add_named(emptyPage, 'empty')
        this.#stack.add_named(bookPage, 'book')
        this.#stack.add_named(this.#errorPage, 'error')
        this.#stack.add_named(this.#imageView, 'image')
        this.#imageView.connect('close', () => this.#closeImage())
        if (!lineArtCssLoaded) {
            lineArtCssLoaded = true
            const provider = new Gtk.CssProvider()
            provider.load_from_string(LINE_ART_CSS)
            Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(),
                provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
        }
        this.#toastOverlay.child = this.#stack

        this.#contentToolbar = new Adw.ToolbarView({
            content: this.#toastOverlay,
            top_bar_style: Adw.ToolbarStyle.RAISED_BORDER,
        })
        this.#contentToolbar.add_top_bar(header)
        this.#contentToolbar.add_top_bar(this.#buildSearchBar())

        this.#splitView = new Adw.OverlaySplitView({
            sidebar: sidebarToolbar,
            content: this.#contentToolbar,
            show_sidebar: false,
            min_sidebar_width: 220,
            max_sidebar_width: 320,
        })
        this.content = this.#splitView

        const breakpoint = new Adw.Breakpoint({
            condition: Adw.BreakpointCondition.parse('max-width: 640sp'),
        })
        breakpoint.add_setter(this.#splitView, 'collapsed', true)
        this.add_breakpoint(breakpoint)

        // Keep the toggle button in sync when the sidebar is closed some other
        // way (e.g. clicking outside it when collapsed)
        this.#splitView.connect('notify::show-sidebar', () =>
            this.lookup_action('toggle-sidebar')
                .change_state(GLib.Variant.new_boolean(this.#splitView.show_sidebar)))

        const pageKeys = new Gtk.ShortcutController({
            propagation_phase: Gtk.PropagationPhase.CAPTURE,
        })
        for (const [trigger, f] of Object.entries(PAGE_KEYS))
            pageKeys.add_shortcut(new Gtk.Shortcut({
                trigger: Gtk.ShortcutTrigger.parse_string(trigger),
                action: Gtk.CallbackAction.new(() => f(this.#bookView)),
            }))
        this.#bookView.add_controller(pageKeys)
    }

    #buildSearchBar() {
        const entry = this.#searchEntry
        // (the bar clears the entry when it closes; that's handled below)
        entry.connect('search-changed', () => {
            if (this.#searchBar.search_mode_enabled) this.#bookView.search(entry.text)
        })
        entry.connect('activate', () => this.#bookView.findNext())
        entry.connect('next-match', () => this.#bookView.findNext())
        entry.connect('previous-match', () => this.#bookView.findPrevious())
        const keys = new Gtk.EventControllerKey({
            propagation_phase: Gtk.PropagationPhase.CAPTURE,
        })
        keys.connect('key-pressed', (_, keyval, _code, state) => {
            const enter = keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter
            if (!enter || !(state & Gdk.ModifierType.SHIFT_MASK)) return false
            this.#bookView.findPrevious()
            return true
        })
        entry.add_controller(keys)

        const box = new Gtk.Box({ spacing: 6 })
        box.append(entry)
        box.append(this.#searchStatus)
        box.append(new Gtk.Button({
            icon_name: 'go-up-symbolic',
            tooltip_text: 'Previous Match',
            action_name: 'win.find-previous',
            css_classes: ['flat'],
        }))
        box.append(new Gtk.Button({
            icon_name: 'go-down-symbolic',
            tooltip_text: 'Next Match',
            action_name: 'win.find-next',
            css_classes: ['flat'],
        }))
        this.#searchBar.child = new Adw.Clamp({ maximum_size: 500, child: box })
        this.#searchBar.connect_entry(entry)

        this.#searchBar.connect('notify::search-mode-enabled', () => {
            if (this.#searchBar.search_mode_enabled) {
                entry.grab_focus()
                if (entry.text) this.#bookView.search(entry.text)
            } else {
                this.#bookView.clearSearch()
                this.#searchStatus.label = ''
                entry.remove_css_class('error')
                for (const name of ['find-next', 'find-previous'])
                    this.lookup_action(name).enabled = false
                if (this.file) this.#bookView.grab_focus()
            }
        })
        this.#bookView.connect('search-changed', (_, { current, total, done }) => {
            const empty = !entry.text
            this.#searchStatus.label = empty ? ''
                : total === 0 ? (done ? 'No results' : 'Searching…')
                : current < 0 ? 'Searching…'
                : `${current + 1} of ${total}`
            if (!empty && done && total === 0) entry.add_css_class('error')
            else entry.remove_css_class('error')
            for (const name of ['find-next', 'find-previous'])
                this.lookup_action(name).enabled = total > 0
        })
        return this.#searchBar
    }

    #setupActions() {
        const actions = {
            'open': () => this.#chooseFile(),
            'close': () => this.close(),
            'back': () => this.#viewingImage ? this.#closeImage() : this.#bookView.back(),
            'forward': () => this.#bookView.forward(),
            'text-larger': () => this.application.setTextScale(this.application.textScale + 0.1),
            'text-smaller': () => this.application.setTextScale(this.application.textScale - 0.1),
            'text-reset': () => this.application.setTextScale(1),
            'leave-fullscreen': () => this.unfullscreen(),
            'find': () => {
                this.#searchBar.search_mode_enabled = true
                this.#searchEntry.grab_focus()
                this.#searchEntry.select_region(0, -1)
            },
            'find-next': () => this.#bookView.findNext(),
            'find-previous': () => this.#bookView.findPrevious(),
        }
        for (const [name, activate] of Object.entries(actions)) {
            const action = new Gio.SimpleAction({ name })
            action.connect('activate', activate)
            this.add_action(action)
        }
        if (DEBUG) {
            const action = new Gio.SimpleAction({ name: 'log-state' })
            action.connect('activate', () => this.#bookView.logState())
            this.add_action(action)
            this.application.set_accels_for_action('win.log-state', ['<Control><Shift>d'])
        }

        const sidebar = Gio.SimpleAction.new_stateful('toggle-sidebar', null,
            GLib.Variant.new_boolean(false))
        sidebar.connect('change-state', (action, value) => {
            action.set_state(value)
            this.#splitView.show_sidebar = value.get_boolean()
        })
        this.add_action(sidebar)

        const fullscreen = Gio.SimpleAction.new_stateful('fullscreen', null,
            GLib.Variant.new_boolean(false))
        fullscreen.connect('change-state', (_, value) =>
            value.get_boolean() ? this.fullscreen() : this.unfullscreen())
        this.add_action(fullscreen)
        this.connect('notify::fullscreened', () => {
            const { fullscreened } = this
            fullscreen.set_state(GLib.Variant.new_boolean(fullscreened))
            this.lookup_action('leave-fullscreen').enabled = fullscreened
            this.#contentToolbar.reveal_top_bars = !fullscreened
            if (fullscreened) this.#toastOverlay.add_toast(new Adw.Toast({
                title: 'Press Esc to leave fullscreen',
                timeout: 2,
            }))
        })
        this.lookup_action('leave-fullscreen').enabled = false

        for (const name of [...BOOK_ACTIONS, 'find-next', 'find-previous'])
            this.lookup_action(name).enabled = false
        this.lookup_action('find').bind_property('enabled', this.#findButton, 'sensitive',
            GObject.BindingFlags.SYNC_CREATE)
    }

    #setupAppearance() {
        const styleManager = Adw.StyleManager.get_default()
        const update = () => {
            const { dark } = styleManager
            const colors = dark ? COLORS.dark : COLORS.light
            const link = Adw.AccentColor.to_standalone_rgba(
                styleManager.get_accent_color(), dark).to_string()
            const rgba = new Gdk.RGBA()
            rgba.parse(colors.bg)
            this.#bookView.set_background_color(rgba)
            this.#bookView.setAppearance({ dark, link, ...colors })
        }
        const handlers = ['notify::dark', 'notify::accent-color']
            .map(signal => styleManager.connect(signal, update))
        this.connect('destroy', () => handlers.forEach(id => styleManager.disconnect(id)))
        this.#updateAppearance = update
        update()
    }

    #updateAppearance = () => {}

    get #viewingImage() {
        return this.#stack.visible_child_name === 'image'
    }

    // Show an image from the book in place of the book, until it's closed
    async #viewImage(uri) {
        try {
            const { data, lineArt } = await this.#bookView.getImage(uri)
            const texture = Gdk.Texture.new_from_bytes(new GLib.Bytes(GLib.base64_decode(data)))
            this.#imageView.show(texture, { lineArt })
            this.#stack.visible_child_name = 'image'
            this.#imageView.grab_focus()
            this.lookup_action('back').enabled = true
        } catch (e) {
            console.warn(`Could not show image: ${e.message}`)
            this.#toastOverlay.add_toast(new Adw.Toast({ title: 'Can’t show this image' }))
        }
    }

    #closeImage() {
        this.#stack.visible_child_name = 'book'
        this.#imageView.clear()
        this.lookup_action('back').enabled = this.#canGoBack
        this.#bookView.grab_focus()
    }

    // Put an image of the passage, set as a quote, on the clipboard
    #copyShareImage(paragraphs) {
        const texture = renderQuoteImage(this.get_renderer(), {
            paragraphs,
            title: this.#book?.title ?? '',
            author: this.#book?.author ?? '',
            font: this.#defaultFont ?? 'Serif',
        })
        // Offered as PNG data. Offering the texture itself leaves it to GTK to
        // convert, and it can't convert the GPU texture the renderer makes.
        this.get_clipboard().set_content(
            Gdk.ContentProvider.new_for_bytes('image/png', texture.save_to_png_bytes()))
        this.#toastOverlay.add_toast(new Adw.Toast({ title: 'Image copied', timeout: 2 }))
    }

    async setTextStyle(style) {
        const newFonts = [style.font, style.defaultFont]
            .filter(font => font && font !== this.#font && font !== this.#defaultFont)
        this.#font = style.font
        this.#defaultFont = style.defaultFont
        this.#bookView.setLayout(style)
        // A font installed while the app is running is new to the book's web
        // process, which then needs replacing
        if (!newFonts.length || !this.#bookKey) return
        const file = this.file
        const hasFonts = await Promise.all(newFonts.map(font =>
            this.#bookView.hasFont(font).catch(() => true)))
        if (hasFonts.every(Boolean) || this.file !== file
            || this.#font !== style.font || this.#defaultFont !== style.defaultFont) return
        this.#bookView.restartWebProcess()
        this.openFile(file)
    }

    setScrolled(scrolled) {
        this.#bookView.setLayout({ scrolled })
        if (!scrolled) this.#hideProgress()
    }

    #showProgress(text) {
        this.#progressLabel.label = text
        this.#progressOsd.reveal_child = true
        if (this.#progressOsdTimeout) GLib.source_remove(this.#progressOsdTimeout)
        this.#progressOsdTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            PROGRESS_OSD_TIMEOUT_MS, () => {
                this.#progressOsdTimeout = 0
                this.#progressOsd.reveal_child = false
                return GLib.SOURCE_REMOVE
            })
    }

    #hideProgress() {
        if (this.#progressOsdTimeout) GLib.source_remove(this.#progressOsdTimeout)
        this.#progressOsdTimeout = 0
        this.#progressOsd.reveal_child = false
    }

    setTextScale(scale) {
        this.#bookView.setLayout({ textScale: scale })
        this.emit('text-scale-changed', scale)
    }

    #setupDragAndDrop() {
        const target = Gtk.DropTarget.new(Gio.File.$gtype, Gdk.DragAction.COPY)
        // capture phase, so drops on the book don't go to WebKit
        target.propagation_phase = Gtk.PropagationPhase.CAPTURE
        target.connect('drop', (_, file) => {
            // ignore drags from inside the book, like an image being dragged
            if (target.current_drop.get_drag()) return false
            debug(`dropped: ${file.get_uri()}`)
            this.openFile(file)
            return true
        })
        this.add_controller(target)
    }

    async #chooseFile() {
        try {
            const file = await makeFileDialog().open(this, null)
            if (file) this.openFile(file)
        } catch (e) {
            if (!e.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED)) console.error(e)
        }
    }

    async openFile(file) {
        debug(`opening ${file.get_uri()}`)
        this.file = file
        this.#bookKey = null
        this.#book = null
        for (const name of BOOK_ACTIONS) this.lookup_action(name).enabled = false
        this.#splitView.show_sidebar = false
        this.#searchBar.search_mode_enabled = false
        this.#title.title = file.get_basename()
        this.#title.subtitle = ''
        this.title = file.get_basename()
        this.#spinner.visible = true
        this.#stack.visible_child_name = 'book'
        this.#imageView.clear()

        try {
            const book = await this.#bookView.open(file)
            if (this.file !== file) return
            this.#bookKey = book.identifier ? `id:${book.identifier}` : `uri:${file.get_uri()}`
            this.#book = { title: book.title, author: book.author }
            if (book.title) {
                this.#title.title = book.title
                this.title = book.title
            }
            this.#title.subtitle = book.author
            this.#tocView.setTOC(book.toc)
            this.lookup_action('toggle-sidebar').enabled = !this.#tocView.isEmpty
            this.lookup_action('find').enabled = true
            this.#updateAppearance()
            await this.#bookView.display(state.getPosition(this.#bookKey))
            if (this.file !== file) return
            this.#spinner.visible = false
            this.#bookView.grab_focus()
            Gtk.RecentManager.get_default().add_item(file.get_uri())
        } catch (e) {
            if (this.file !== file) return
            console.warn(`Could not open ${file.get_uri()}: ${e.message}`)
            this.#spinner.visible = false
            this.#title.title = APP_NAME
            this.title = APP_NAME
            this.#errorPage.description = GLib.markup_escape_text(
                e.message.replace(/^(\w*Error: )+/, ''), -1)
            this.#stack.visible_child_name = 'error'
        }
    }
})
