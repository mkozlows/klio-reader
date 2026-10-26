import GObject from 'gi://GObject?version=2.0'
import GLib from 'gi://GLib?version=2.0'
import Gio from 'gi://Gio?version=2.0'
import Gdk from 'gi://Gdk?version=4.0'
import Gtk from 'gi://Gtk?version=4.0'
import Adw from 'gi://Adw?version=1'

import { APP_ID, APP_NAME, VERSION, MODULE_DIR } from './config.js'
import { ReaderWindow } from './window.js'
import { PreferencesDialog } from './preferences.js'
import { state } from './state.js'

const ACCELS = {
    'app.new-window': ['<Control>n'],
    'app.quit': ['<Control>q'],
    'app.shortcuts': ['<Control>question'],
    'app.preferences': ['<Control>comma'],
    'win.open': ['<Control>o'],
    'win.close': ['<Control>w'],
    'win.toggle-sidebar': ['F9'],
    'win.fullscreen': ['F11'],
    'win.find': ['<Control>f'],
    'win.find-next': ['<Control>g'],
    'win.find-previous': ['<Control><Shift>g'],
    'app.scrolled': ['<Control>m'],
    'win.leave-fullscreen': ['Escape'],
    'win.back': ['<Alt>Left'],
    'win.forward': ['<Alt>Right'],
    'win.text-larger': ['<Control>plus', '<Control>equal', '<Control>KP_Add'],
    'win.text-smaller': ['<Control>minus', '<Control>KP_Subtract'],
    'win.text-reset': ['<Control>0', '<Control>KP_0'],
}

const SHORTCUTS = [
    ['General', [
        ['Open', '<Control>o'],
        ['New Window', '<Control>n'],
        ['Close Window', '<Control>w'],
        ['Quit', '<Control>q'],
        ['Preferences', '<Control>comma'],
        ['Keyboard Shortcuts', '<Control>question'],
    ]],
    ['Reading', [
        ['Next Page', 'Right Page_Down space'],
        ['Previous Page', 'Left Page_Up <Shift>space'],
        ['Scroll Down', 'Down'],
        ['Scroll Up', 'Up'],
        ['Find', '<Control>f'],
        ['Next Match', '<Control>g'],
        ['Previous Match', '<Control><Shift>g'],
        ['Back', '<Alt>Left'],
        ['Forward', '<Alt>Right'],
    ]],
    ['View', [
        ['Contents', 'F9'],
        ['Continuous Scrolling', '<Control>m'],
        ['Fullscreen', 'F11'],
        ['Larger Text', '<Control>plus'],
        ['Smaller Text', '<Control>minus'],
        ['Reset Text Size', '<Control>0'],
    ]],
]

const CSS = `
.progress-osd {
    padding: 6px 12px;
    border-radius: 999px;
}

/* Style switcher in the main menu, after GNOME Text Editor's */
.style-switcher {
    margin: 6px 0 9px;
}
.style-switcher checkbutton {
    min-width: 44px;
    min-height: 44px;
    padding: 1px;
    border-radius: 999px;
    background-clip: content-box;
    box-shadow: inset 0 0 0 1px alpha(currentColor, .15);
}
.style-switcher checkbutton:checked {
    box-shadow: inset 0 0 0 2px var(--accent-bg-color);
}
.style-switcher checkbutton.default {
    background-image: linear-gradient(to bottom right, #fff 49.99%, #202020 50.01%);
}
.style-switcher checkbutton.light {
    background-color: #fff;
}
.style-switcher checkbutton.dark {
    background-color: #202020;
}
.style-switcher checkbutton radio {
    -gtk-icon-source: none;
    border: none;
    box-shadow: none;
    background: none;
    min-width: 12px;
    min-height: 12px;
    padding: 2px;
    transform: translate(27px, 14px);
}
.style-switcher checkbutton radio:checked {
    -gtk-icon-source: -gtk-icontheme("object-select-symbolic");
    background-color: var(--accent-bg-color);
    color: var(--accent-fg-color);
}
`

const COLOR_SCHEMES = {
    default: Adw.ColorScheme.DEFAULT,
    light: Adw.ColorScheme.FORCE_LIGHT,
    dark: Adw.ColorScheme.FORCE_DARK,
}

const MIN_TEXT_SCALE = 0.5
const MAX_TEXT_SCALE = 3

export const Application = GObject.registerClass({
    GTypeName: 'ReaderApplication',
}, class Application extends Adw.Application {
    textScale = state.get('textScale')

    constructor() {
        super({
            application_id: APP_ID,
            flags: Gio.ApplicationFlags.HANDLES_OPEN,
        })
    }

    vfunc_startup() {
        super.vfunc_startup()

        // Running from the source tree: find the app icons in data/
        const iconTheme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default())
        for (const size of ['scalable', 'symbolic']) {
            const dir = GLib.build_filenamev(
                [MODULE_DIR, '..', 'data', 'icons', 'hicolor', size, 'apps'])
            if (GLib.file_test(dir, GLib.FileTest.IS_DIR)) iconTheme.add_search_path(dir)
        }

        const actions = {
            'new-window': () => this.#newWindow().present(),
            'quit': () => this.quit(),
            'about': () => this.#showAbout(),
            'shortcuts': () => this.#showShortcuts(),
            'preferences': () => new PreferencesDialog(this).present(this.active_window),
        }
        for (const [name, activate] of Object.entries(actions)) {
            const action = new Gio.SimpleAction({ name })
            action.connect('activate', activate)
            this.add_action(action)
        }

        const scrolled = Gio.SimpleAction.new_stateful('scrolled', null,
            GLib.Variant.new_boolean(state.get('scrolled')))
        scrolled.connect('change-state', (action, value) => {
            action.set_state(value)
            state.set('scrolled', value.get_boolean())
            for (const window of this.get_windows())
                if (window instanceof ReaderWindow) window.setScrolled(value.get_boolean())
        })
        this.add_action(scrolled)

        const savedScheme = state.get('colorScheme')
        const colorScheme = new Gio.SimpleAction({
            name: 'color-scheme',
            parameter_type: new GLib.VariantType('s'),
            state: GLib.Variant.new_string(savedScheme in COLOR_SCHEMES ? savedScheme : 'default'),
        })
        colorScheme.connect('change-state', (action, value) => {
            const name = value.get_string()[0]
            if (!(name in COLOR_SCHEMES)) return
            action.set_state(value)
            state.set('colorScheme', name)
            Adw.StyleManager.get_default().color_scheme = COLOR_SCHEMES[name]
        })
        this.add_action(colorScheme)
        Adw.StyleManager.get_default().color_scheme =
            COLOR_SCHEMES[colorScheme.state.get_string()[0]]

        const provider = new Gtk.CssProvider()
        provider.load_from_string(CSS)
        Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(),
            provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)

        for (const [action, accels] of Object.entries(ACCELS))
            this.set_accels_for_action(action, accels)
    }

    vfunc_activate() {
        (this.active_window ?? this.#newWindow()).present()
    }

    vfunc_open(files) {
        for (const file of files) {
            const windows = this.get_windows()
            const existing = windows.find(w => w.file?.equal(file))
            if (existing) {
                existing.present()
                continue
            }
            const window = windows.find(w => w instanceof ReaderWindow && !w.file)
                ?? this.#newWindow()
            window.openFile(file)
            window.present()
        }
    }

    vfunc_shutdown() {
        state.flush()
        super.vfunc_shutdown()
    }

    setTextScale(scale) {
        scale = Math.round(Math.min(MAX_TEXT_SCALE, Math.max(MIN_TEXT_SCALE, scale)) * 10) / 10
        this.textScale = scale
        state.set('textScale', scale)
        for (const window of this.get_windows())
            if (window instanceof ReaderWindow) window.setTextScale(scale)
    }

    // Overrides for the book's own styles, as set in Preferences
    get textStyle() {
        return {
            font: state.get('customFont') ? state.get('fontFamily') : null,
            overrideSize: state.get('overrideFontSize'),
            align: state.get('textAlign'),
        }
    }

    // changes: any of customFont, fontFamily, overrideFontSize, textAlign
    setTextStyle(changes) {
        for (const [key, value] of Object.entries(changes)) state.set(key, value)
        for (const window of this.get_windows())
            if (window instanceof ReaderWindow) window.setTextStyle(this.textStyle)
    }

    #newWindow() {
        const window = new ReaderWindow(this)
        window.setTextScale(this.textScale)
        window.setTextStyle(this.textStyle)
        window.setScrolled(state.get('scrolled'))
        return window
    }

    #showAbout() {
        const dialog = new Adw.AboutDialog({
            application_name: APP_NAME,
            application_icon: APP_ID,
            version: VERSION,
            developer_name: 'Mike Kozlowski',
            comments: 'A simple e-book viewer',
            license_type: Gtk.License.GPL_3_0,
            website: 'https://github.com/mkozlows/klio-reader',
            issue_url: 'https://github.com/mkozlows/klio-reader/issues',
        })
        dialog.add_legal_section('foliate-js', 'Copyright © 2022 John Factotum',
            Gtk.License.MIT_X11, null)
        dialog.add_acknowledgement_section('Book rendering by',
            ['foliate-js https://github.com/johnfactotum/foliate-js'])
        dialog.present(this.active_window)
    }

    #showShortcuts() {
        const dialog = new Adw.ShortcutsDialog()
        for (const [title, items] of SHORTCUTS) {
            const section = new Adw.ShortcutsSection({ title })
            for (const [label, accel] of items)
                section.add(Adw.ShortcutsItem.new(label, accel))
            dialog.add(section)
        }
        dialog.present(this.active_window)
    }
})
