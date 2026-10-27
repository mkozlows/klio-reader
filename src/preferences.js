import GObject from 'gi://GObject?version=2.0'
import Gtk from 'gi://Gtk?version=4.0'
import Pango from 'gi://Pango?version=1.0'
import Adw from 'gi://Adw?version=1'

import { state } from './state.js'

const ALIGNMENTS = [
    ['publisher', 'Book Default'],
    ['justify', 'Justified'],
    ['start', 'Left'],
]

// The default font, and settings for overriding the book's own styles.
// Changes apply immediately through `application.setTextStyle()`.
export const PreferencesDialog = GObject.registerClass({
    GTypeName: 'ReaderPreferencesDialog',
}, class PreferencesDialog extends Adw.PreferencesDialog {
    constructor(application) {
        super({ search_enabled: false })
        const set = changes => application.setTextStyle(changes)
        const makeFontButton = (key, title) => {
            const button = new Gtk.FontDialogButton({
                dialog: new Gtk.FontDialog({ title }),
                level: Gtk.FontLevel.FAMILY,
                use_font: true,
                valign: Gtk.Align.CENTER,
                font_desc: Pango.FontDescription.from_string(state.get(key)),
            })
            button.connect('notify::font-desc', () => {
                const family = button.font_desc?.get_family()
                if (family) set({ [key]: family })
            })
            return button
        }

        const defaults = new Adw.PreferencesGroup()
        const defaultFontButton = makeFontButton('defaultFont', 'Choose Default Font')
        const defaultFont = new Adw.ActionRow({
            title: 'Default Font',
            subtitle: 'For text the book doesn’t choose a font for. Also used for share images.',
            activatable_widget: defaultFontButton,
        })
        defaultFont.add_suffix(defaultFontButton)
        defaults.add(defaultFont)

        const group = new Adw.PreferencesGroup({
            title: 'Book Styles',
            description: 'Use your own settings instead of the book’s',
        })

        const font = new Adw.ExpanderRow({
            title: 'Custom Font',
            subtitle: 'Show all text in one font',
            show_enable_switch: true,
            enable_expansion: state.get('customFont'),
            expanded: state.get('customFont'),
        })
        font.connect('notify::enable-expansion', () =>
            set({ customFont: font.enable_expansion }))
        const fontButton = makeFontButton('fontFamily', 'Choose Font')
        const fontRow = new Adw.ActionRow({ title: 'Font', activatable_widget: fontButton })
        fontRow.add_suffix(fontButton)
        font.add_row(fontRow)
        group.add(font)

        const size = new Adw.SwitchRow({
            title: 'Override Font Size',
            subtitle: 'Show body text at the size set in the main menu',
            active: state.get('overrideFontSize'),
        })
        size.connect('notify::active', () => set({ overrideFontSize: size.active }))
        group.add(size)

        const align = new Adw.ComboRow({
            title: 'Alignment',
            model: Gtk.StringList.new(ALIGNMENTS.map(([, label]) => label)),
            selected: Math.max(0, ALIGNMENTS.findIndex(([id]) => id === state.get('textAlign'))),
        })
        align.connect('notify::selected', () =>
            set({ textAlign: ALIGNMENTS[align.selected][0] }))
        group.add(align)

        const page = new Adw.PreferencesPage()
        page.add(defaults)
        page.add(group)
        this.add(page)
    }
})
