import GObject from 'gi://GObject?version=2.0'
import Gio from 'gi://Gio?version=2.0'
import Gtk from 'gi://Gtk?version=4.0'
import Pango from 'gi://Pango?version=1.0'

const TocItem = GObject.registerClass({
    GTypeName: 'ReaderTocItem',
}, class TocItem extends GObject.Object {
    constructor({ id, label, href, subitems }) {
        super()
        this.id = id
        this.label = label
        this.href = href
        this.subitems = subitems
    }
})

const makeStore = items => {
    const store = new Gio.ListStore({ item_type: TocItem })
    for (const item of items) store.append(new TocItem(item))
    return store
}

// Ids of the item with `id` and its ancestors, outermost first
const findPath = (items, id) => {
    for (const item of items ?? []) {
        if (item.id === id) return [id]
        const path = findPath(item.subitems, id)
        if (path) return [item.id, ...path]
    }
    return null
}

export const TocView = GObject.registerClass({
    GTypeName: 'ReaderTocView',
    Signals: {
        'navigate': { param_types: [GObject.TYPE_STRING] },
    },
}, class TocView extends Gtk.ScrolledWindow {
    #toc = []
    #selection = new Gtk.SingleSelection({ autoselect: false, can_unselect: true })
    #listView

    constructor() {
        super({ hscrollbar_policy: Gtk.PolicyType.NEVER, vexpand: true })

        const factory = new Gtk.SignalListItemFactory()
        factory.connect('setup', (_, listItem) => {
            const label = new Gtk.Label({
                xalign: 0,
                ellipsize: Pango.EllipsizeMode.END,
            })
            listItem.child = new Gtk.TreeExpander({ child: label, indent_for_icon: true })
        })
        factory.connect('bind', (_, listItem) => {
            const row = listItem.item
            const expander = listItem.child
            expander.list_row = row
            expander.child.label = row.item.label
            expander.child.tooltip_text = row.item.label
        })

        this.#listView = new Gtk.ListView({
            model: this.#selection,
            factory,
            single_click_activate: true,
            css_classes: ['navigation-sidebar'],
        })
        this.#listView.connect('activate', (_, position) => {
            const item = this.#selection.model.get_item(position)?.item
            if (item?.href) this.emit('navigate', item.href)
        })
        this.child = this.#listView
    }

    get isEmpty() {
        return this.#toc.length === 0
    }

    setTOC(toc) {
        this.#toc = toc
        this.#selection.model = Gtk.TreeListModel.new(makeStore(toc), false, false,
            item => item.subitems ? makeStore(item.subitems) : null)
    }

    // Highlight the current chapter, expanding its parents as needed
    setCurrent(id) {
        const path = id === null ? null : findPath(this.#toc, id)
        if (!path) {
            this.#selection.unselect_all()
            return
        }
        const model = this.#selection.model
        let position = 0
        for (const [depth, pathId] of path.entries()) {
            const n = model.get_n_items()
            for (; position < n; position++) {
                const row = model.get_item(position)
                if (row.get_depth() === depth && row.item.id === pathId) break
            }
            if (position >= n) return
            if (depth < path.length - 1) model.get_item(position).expanded = true
        }
        if (this.#selection.selected !== position) {
            this.#selection.selected = position
            this.#listView.scroll_to(position, Gtk.ListScrollFlags.NONE, null)
        }
    }
})
