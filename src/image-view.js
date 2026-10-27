import GObject from 'gi://GObject?version=2.0'
import GLib from 'gi://GLib?version=2.0'
import Gdk from 'gi://Gdk?version=4.0'
import Gtk from 'gi://Gtk?version=4.0'
import Adw from 'gi://Adw?version=1'

const MAX_ZOOM = 8
const ZOOM_STEP = 1.25

// A zoomable view of one image. It starts fitted to the view (never enlarged);
// the mouse wheel, pinching, and the zoom buttons and keys zoom it, and it
// pans by dragging. Emits 'close' when the reader is done with it.
export const ImageView = GObject.registerClass({
    GTypeName: 'ReaderImageView',
    CssName: 'image-view',
    Signals: { 'close': {} },
}, class ImageView extends Gtk.Widget {
    #picture = new Gtk.Picture({
        can_shrink: true,
        content_fit: Gtk.ContentFit.SCALE_DOWN,
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
    })
    #scrolled = new Gtk.ScrolledWindow({
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vscrollbar_policy: Gtk.PolicyType.NEVER,
        child: this.#picture,
    })
    #zoomLabel = new Gtk.Label({ width_chars: 5, css_classes: ['numeric'] })
    #zoom = null // null when fitted to the view
    #lineArt = false
    #pointer = null // [x, y] in the view, while the pointer is over it

    constructor(params) {
        super({ focusable: true, hexpand: true, vexpand: true, ...params })
        const overlay = new Gtk.Overlay({ child: this.#scrolled })
        overlay.set_parent(this)

        const close = new Gtk.Button({
            icon_name: 'window-close-symbolic',
            tooltip_text: 'Back to Book',
            halign: Gtk.Align.END,
            valign: Gtk.Align.START,
            margin_top: 12,
            margin_end: 12,
            css_classes: ['osd', 'circular'],
        })
        close.connect('clicked', () => this.emit('close'))
        overlay.add_overlay(close)

        const zoomBox = new Gtk.Box({
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.END,
            margin_bottom: 12,
            css_classes: ['osd', 'toolbar', 'image-view-zoom'],
        })
        const zoomOut = new Gtk.Button({ icon_name: 'zoom-out-symbolic', tooltip_text: 'Zoom Out' })
        zoomOut.connect('clicked', () => this.#zoomBy(1 / ZOOM_STEP))
        const fit = new Gtk.Button({ child: this.#zoomLabel, tooltip_text: 'Fit or Show at 100%' })
        fit.connect('clicked', () => this.#toggleFit())
        const zoomIn = new Gtk.Button({ icon_name: 'zoom-in-symbolic', tooltip_text: 'Zoom In' })
        zoomIn.connect('clicked', () => this.#zoomBy(ZOOM_STEP))
        for (const button of [zoomOut, fit, zoomIn]) zoomBox.append(button)
        overlay.add_overlay(zoomBox)

        this.#setupInput()
        const styleManager = Adw.StyleManager.get_default()
        const id = styleManager.connect('notify::dark', () => this.#updateLineArt())
        this.connect('destroy', () => styleManager.disconnect(id))
    }

    vfunc_dispose() {
        this.get_first_child()?.unparent()
        super.vfunc_dispose()
    }

    vfunc_measure(orientation, forSize) {
        return this.get_first_child().measure(orientation, forSize)
    }

    vfunc_size_allocate(width, height, baseline) {
        this.get_first_child().allocate(width, height, baseline, null)
        // the fitted zoom changes with the size; not during allocation, as
        // that would change the label's size
        if (this.#zoom === null) GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this.#updateLabel()
            return GLib.SOURCE_REMOVE
        })
    }

    #updateLabel() {
        this.#zoomLabel.label = `${Math.round(this.#currentZoom * 100)}%`
    }

    // Show `texture`, fitted to the view. lineArt: whether to recolor it in
    // dark mode, as line art is in the book.
    show(texture, { lineArt = false } = {}) {
        this.#picture.paintable = texture
        this.#lineArt = lineArt
        this.#updateLineArt()
        this.#setZoom(null)
        this.grab_focus()
    }

    clear() {
        this.#picture.paintable = null
    }

    #updateLineArt() {
        if (this.#lineArt && Adw.StyleManager.get_default().dark)
            this.#picture.add_css_class('line-art')
        else this.#picture.remove_css_class('line-art')
    }

    get #imageSize() {
        const paintable = this.#picture.paintable
        return paintable
            ? [paintable.get_intrinsic_width(), paintable.get_intrinsic_height()]
            : [1, 1]
    }

    // The zoom at which the image fits in the view, if that shrinks it
    get #fitZoom() {
        const [width, height] = this.#imageSize
        return Math.min(1,
            this.#scrolled.get_width() / width, this.#scrolled.get_height() / height)
    }

    get #currentZoom() {
        return this.#zoom ?? this.#fitZoom
    }

    #zoomBy(factor, point) {
        this.#setZoom(this.#currentZoom * factor, point)
    }

    // Fit, or if fitted, show at 100% (or twice the size, for an image that
    // fits at 100%), keeping `point` in place
    #toggleFit(point) {
        if (this.#zoom !== null) this.#setZoom(null)
        else this.#setZoom(this.#fitZoom < 1 ? 1 : 2, point)
    }

    // Zoom to `zoom` (null to fit), keeping the image under `point` (in view
    // coordinates; by default the pointer, or the middle) in place
    #setZoom(zoom, point = this.#pointer) {
        if (zoom !== null) {
            zoom = Math.min(MAX_ZOOM, zoom)
            if (zoom <= this.#fitZoom) zoom = null
        }
        const viewWidth = this.#scrolled.get_width()
        const viewHeight = this.#scrolled.get_height()
        const [x, y] = point ?? [viewWidth / 2, viewHeight / 2]
        const hadj = this.#scrolled.hadjustment
        const vadj = this.#scrolled.vadjustment
        const [width, height] = this.#imageSize
        const oldZoom = this.#currentZoom
        // the image point under (x, y), from 0 to 1
        const offset = (size, view) => Math.max(0, (view - size) / 2)
        const imageX = (hadj.value + x - offset(width * oldZoom, viewWidth)) / (width * oldZoom)
        const imageY = (vadj.value + y - offset(height * oldZoom, viewHeight)) / (height * oldZoom)

        this.#zoom = zoom
        const fitted = zoom === null
        const policy = fitted ? Gtk.PolicyType.NEVER : Gtk.PolicyType.AUTOMATIC
        this.#scrolled.hscrollbar_policy = policy
        this.#scrolled.vscrollbar_policy = policy
        this.#picture.can_shrink = fitted
        this.#picture.content_fit = fitted ? Gtk.ContentFit.SCALE_DOWN : Gtk.ContentFit.FILL
        this.#picture.set_size_request(
            fitted ? -1 : Math.round(width * zoom), fitted ? -1 : Math.round(height * zoom))
        this.#updateLabel()
        if (fitted) return

        // Scroll once the new size is laid out, which is after the next
        // frame's tick
        let ticks = 0
        this.add_tick_callback(() => {
            if (ticks++ === 0) return GLib.SOURCE_CONTINUE
            const newWidth = width * zoom
            const newHeight = height * zoom
            hadj.value = imageX * newWidth + offset(newWidth, viewWidth) - x
            vadj.value = imageY * newHeight + offset(newHeight, viewHeight) - y
            return GLib.SOURCE_REMOVE
        })
    }

    #setupInput() {
        const motion = new Gtk.EventControllerMotion()
        motion.connect('enter', (_, x, y) => this.#pointer = [x, y])
        motion.connect('motion', (_, x, y) => this.#pointer = [x, y])
        motion.connect('leave', () => this.#pointer = null)
        this.#scrolled.add_controller(motion)

        // The mouse wheel zooms; touchpads scroll, unless Ctrl is held
        const scroll = new Gtk.EventControllerScroll({
            flags: Gtk.EventControllerScrollFlags.VERTICAL,
            propagation_phase: Gtk.PropagationPhase.CAPTURE,
        })
        scroll.connect('scroll', (_, _dx, dy) => {
            const ctrl = scroll.get_current_event_state() & Gdk.ModifierType.CONTROL_MASK
            if (scroll.get_unit() !== Gdk.ScrollUnit.WHEEL && !ctrl) return false
            const steps = scroll.get_unit() === Gdk.ScrollUnit.WHEEL ? dy : dy / 50
            this.#zoomBy(ZOOM_STEP ** -steps)
            return true
        })
        this.#scrolled.add_controller(scroll)

        let pinchStart = 1
        const pinch = new Gtk.GestureZoom()
        pinch.connect('begin', () => pinchStart = this.#currentZoom)
        pinch.connect('scale-changed', (_, scale) => {
            const [, x, y] = pinch.get_bounding_box_center()
            this.#setZoom(pinchStart * scale, [x, y])
        })
        this.#scrolled.add_controller(pinch)

        // Drag to pan
        let start = null
        const drag = new Gtk.GestureDrag()
        drag.connect('drag-begin', () => {
            if (this.#zoom === null) return
            start = [this.#scrolled.hadjustment.value, this.#scrolled.vadjustment.value]
            this.#scrolled.set_cursor_from_name('grabbing')
        })
        drag.connect('drag-update', (_, dx, dy) => {
            if (!start) return
            this.#scrolled.hadjustment.value = start[0] - dx
            this.#scrolled.vadjustment.value = start[1] - dy
        })
        drag.connect('drag-end', () => {
            start = null
            this.#scrolled.set_cursor_from_name(null)
        })
        this.#scrolled.add_controller(drag)

        const click = new Gtk.GestureClick()
        click.connect('pressed', (_, n, x, y) => {
            if (n === 2) this.#toggleFit([x, y])
        })
        this.#scrolled.add_controller(click)

        const back = new Gtk.GestureClick({ button: 8 })
        back.connect('pressed', () => this.emit('close'))
        this.add_controller(back)

        const keys = new Gtk.ShortcutController()
        const shortcuts = {
            'Escape|BackSpace|<Alt>Left': () => this.emit('close'),
            'plus|equal|KP_Add': () => this.#zoomBy(ZOOM_STEP),
            'minus|KP_Subtract': () => this.#zoomBy(1 / ZOOM_STEP),
            '0|KP_0': () => this.#setZoom(null),
            '1|KP_1': () => this.#setZoom(1),
        }
        for (const [trigger, f] of Object.entries(shortcuts))
            keys.add_shortcut(new Gtk.Shortcut({
                trigger: Gtk.ShortcutTrigger.parse_string(trigger),
                action: Gtk.CallbackAction.new(() => (f(), true)),
            }))
        this.add_controller(keys)
    }
})
