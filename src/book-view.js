import GObject from 'gi://GObject?version=2.0'
import GLib from 'gi://GLib?version=2.0'
import Gio from 'gi://Gio?version=2.0'
import Gdk from 'gi://Gdk?version=4.0'
import Gtk from 'gi://Gtk?version=4.0'
import WebKit from 'gi://WebKit?version=6.0'

import { MODULE_DIR } from './config.js'
import { DEBUG, debug, summarize } from './log.js'

Gio._promisify(WebKit.WebView.prototype, 'call_async_javascript_function')
Gio._promisify(Gio.File.prototype, 'read_async')
Gio._promisify(Gio.File.prototype, 'query_info_async')

// The reader page, foliate-js, and the book itself are all served from this
// scheme so that ES modules and fetch() work without file:// restrictions.
const SCHEME = 'reader'
const PAGE_URI = `${SCHEME}:///reader/reader.html`
const STATIC_DIRS = ['/reader/', '/foliate-js/']
const MIME_TYPES = {
    html: 'text/html',
    js: 'text/javascript',
    css: 'text/css',
    svg: 'image/svg+xml',
}

const notFound = request => request.finish_error(new GLib.Error(
    Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND, 'Not found'))

const serveBook = async request => {
    const file = request.get_web_view()?.file
    if (!file) return notFound(request)
    try {
        const info = await file.query_info_async(Gio.FILE_ATTRIBUTE_STANDARD_SIZE,
            Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null)
        const stream = await file.read_async(GLib.PRIORITY_DEFAULT, null)
        request.finish(stream, info.get_size(), 'application/octet-stream')
    } catch (e) {
        request.finish_error(e)
    }
}

const serveStatic = request => {
    const path = request.get_path()
    if (path.includes('..') || !STATIC_DIRS.some(dir => path.startsWith(dir)))
        return notFound(request)
    const file = Gio.File.new_for_path(GLib.build_filenamev([MODULE_DIR, path]))
    const mime = MIME_TYPES[path.split('.').pop()] ?? 'application/octet-stream'
    try {
        request.finish(file.read(null), -1, mime)
    } catch {
        notFound(request)
    }
}

let schemeRegistered = false
const registerScheme = () => {
    if (schemeRegistered) return
    schemeRegistered = true
    WebKit.WebContext.get_default().register_uri_scheme(SCHEME, request => {
        if (request.get_path().startsWith('/book/')) serveBook(request)
        else serveStatic(request)
    })
}

const launchUri = uri => new Gtk.UriLauncher({ uri }).launch(null, null, null)

// Overscroll is measured in pixels; one notch of a mouse wheel counts as this
const PIXELS_PER_WHEEL_STEP = 70

// Calls made on every scroll event, logged only if they're slow
const SCROLL_CALLS = new Set(['overscroll', 'scrollBy'])
const SLOW_CALL_MS = 500

// Calls `f` right away, then ignores calls until there's a `ms` pause
const leadingDebounce = (f, ms) => {
    let source = 0
    return (...args) => {
        if (source) GLib.source_remove(source)
        else f(...args)
        source = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            source = 0
            return GLib.SOURCE_REMOVE
        })
    }
}

export const BookView = GObject.registerClass({
    GTypeName: 'ReaderBookView',
    Signals: {
        'relocate': { param_types: [GObject.TYPE_JSOBJECT] },
        'history-changed': { param_types: [GObject.TYPE_BOOLEAN, GObject.TYPE_BOOLEAN] },
        // Ctrl+scroll: +1 for larger text, -1 for smaller
        'zoom': { param_types: [GObject.TYPE_INT] },
        // { current, total, done }: current is -1 when there's no match
        'search-changed': { param_types: [GObject.TYPE_JSOBJECT] },
        // "Copy Share Image" chosen: the selected paragraphs, as strings
        'share-selection': { param_types: [GObject.TYPE_JSOBJECT] },
        // Scrolled mode, scrolling past the end of a chapter: { fraction, label }.
        // fraction is how far it is to moving on to the next chapter, 0 when
        // not past the end; label is the next chapter's title, or ''.
        'pull': { param_types: [GObject.TYPE_JSOBJECT] },
    },
}, class BookView extends WebKit.WebView {
    file = null
    #pageReady = null
    #dialogOpen = false
    #displayed = false // a book is loaded and showing
    #calls = new Map() // calls into the page not yet finished: id → { name, start }
    #lastCallId = 0
    #layout = {
        scrolled: false, textScale: 1,
        font: null, overrideSize: false, align: 'publisher',
    }

    constructor() {
        registerScheme()
        super({
            settings: new WebKit.Settings({
                enable_developer_extras: DEBUG,
                enable_write_console_messages_to_stdout: true,
                enable_back_forward_navigation_gestures: false,
                enable_html5_database: false,
                enable_html5_local_storage: false,
                enable_smooth_scrolling: false,
                // WebKitGTK defaults to sans-serif; books expect serif. See
                // also `setLayout()`.
                default_font_family: 'serif',
            }),
            vexpand: true,
            hexpand: true,
        })

        const manager = this.get_user_content_manager()
        manager.connect('script-message-received::reader', (_, value) => {
            try {
                this.#onMessage(JSON.parse(value.to_string()))
            } catch (e) {
                console.error(e)
            }
        })
        manager.register_script_message_handler('reader', null)
        if (DEBUG) manager.add_script(new WebKit.UserScript(
            'globalThis.readerDebug = true', WebKit.UserContentInjectedFrames.TOP_FRAME,
            WebKit.UserScriptInjectionTime.START, null, null))

        this.connect('decide-policy', (_, decision, type) => this.#decidePolicy(decision, type))
        const shareAction = new Gio.SimpleAction({ name: 'share-selection' })
        shareAction.connect('activate', () => this.#shareSelection())
        this.connect('context-menu', (_, menu, hit) => {
            // Copy is the only browser action that makes sense in a book
            for (const item of menu.get_items())
                if (item.get_stock_action() !== WebKit.ContextMenuAction.COPY)
                    menu.remove(item)
            if (hit.context_is_selection() && this.#displayed)
                menu.append(WebKit.ContextMenuItem.new_from_gaction(
                    shareAction, 'Copy Share Image', null))
            return menu.get_n_items() === 0
        })
        this.connect('web-process-terminated', (_, reason) => {
            if (reason !== WebKit.WebProcessTerminationReason.TERMINATED_BY_API)
                console.error(`Web process terminated (${reason})`)
        })

        this.#setupScrolling()
        this.#setupZoom()
        this.#setupMouseButtons()
    }

    // Load a book. Resolves with { identifier, title, author, toc } once the
    // book is parsed; call `display()` afterwards to show it.
    async open(file) {
        // fail early with a useful message (e.g. "No such file or directory")
        await file.query_info_async(Gio.FILE_ATTRIBUTE_STANDARD_SIZE,
            Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null)
        this.file = file
        this.#displayed = false
        this.#dialogOpen = false
        this.emit('history-changed', false, false)
        let failed
        await new Promise((resolve, reject) => {
            this.#pageReady = resolve
            failed = this.connect('load-failed', (_v, _e, _uri, error) => {
                reject(error)
                return true
            })
            this.load_uri(PAGE_URI)
        }).finally(() => this.disconnect(failed))
        const url = `/book/${encodeURIComponent(file.get_basename())}`
        return this.#call('open', url, this.#layout)
    }

    get scrolled() {
        return this.#layout.scrolled
    }

    // Any of:
    //   scrolled: scrolled (true) or paginated (false) layout
    //   textScale: text size relative to the default
    //   defaultFont: font family for text the book doesn't set a font for, or
    //     sets only to serif
    //   font: font family to use instead of the book's, or null
    //   overrideSize: show body text at the default size, whatever the book says
    //   align: 'publisher', 'justify', or 'start'
    setLayout(layout) {
        Object.assign(this.#layout, layout)
        const { textScale, defaultFont } = this.#layout
        const settings = this.get_settings()
        settings.default_font_family = defaultFont ?? 'serif'
        settings.serif_font_family = defaultFont ?? 'serif'
        settings.default_font_size = Math.round(16 * textScale)
        settings.default_monospace_font_size = Math.round(13 * textScale)
        this.#call('setLayout', this.#layout).catch(() => {})
    }

    async display(lastLocation) {
        await this.#call('display', lastLocation)
        this.#displayed = true
    }

    // Whether the page can render a font family. WebKit's web process reads
    // the list of installed fonts only when it starts.
    async hasFont(family) {
        return this.#call('hasFont', family)
    }

    // Start a new web process, which will see fonts installed since the
    // current one started. Reopen the book afterwards.
    restartWebProcess() {
        debug('restarting the web process')
        this.#displayed = false
        this.terminate_web_process()
    }

    setAppearance(appearance) {
        return this.#call('setAppearance', appearance).catch(() => {})
    }

    // Navigation. These are fire-and-forget (errors are logged), and return
    // false if ignored because no book is showing or a footnote popup has
    // the focus.
    next() { return this.#do('next') }
    prev() { return this.#do('prev') }
    goLeft() { return this.#do('goLeft') }
    goRight() { return this.#do('goRight') }
    goTo(href) { return this.#do('goTo', href) }

    // Find. Results arrive through the 'search-changed' signal.
    search(query) {
        if (this.#displayed) this.#call('search', query).catch(e => console.error(e))
    }
    findNext() { this.#do('findNext', 1) }
    findPrevious() { this.#do('findNext', -1) }
    clearSearch() {
        if (this.#displayed) this.#call('clearSearch').catch(() => {})
    }
    scrollDown() { return this.#do('scrollLines', 1) }
    scrollUp() { return this.#do('scrollLines', -1) }
    back() { return this.#do('back') }
    forward() { return this.#do('forward') }

    async #call(name, ...args) {
        const id = ++this.#lastCallId
        const start = Date.now()
        const quiet = SCROLL_CALLS.has(name)
        if (!quiet) debug(`call ${id}: ${name}(${summarize(args).slice(1, -1)})`)
        this.#calls.set(id, { name, start })
        try {
            const body = `const result = await globalThis.api[name](...JSON.parse(args))
                return JSON.stringify(result ?? null)`
            const params = new GLib.Variant('a{sv}', {
                name: new GLib.Variant('s', name),
                args: new GLib.Variant('s', JSON.stringify(args)),
            })
            const value = await this.call_async_javascript_function(
                body, -1, params, null, null, null)
            return JSON.parse(value.to_string())
        } catch (e) {
            debug(`call ${id}: ${name} failed: ${e.message}`)
            throw e
        } finally {
            this.#calls.delete(id)
            const ms = Date.now() - start
            if (!quiet || ms > SLOW_CALL_MS) debug(`call ${id}: ${name} done in ${ms} ms`)
        }
    }

    // Log what the view and the page are doing, for when something's stuck
    async logState() {
        const now = Date.now()
        const calls = [...this.#calls].map(([id, { name, start }]) =>
            `${id} ${name} (${now - start} ms)`)
        console.log(`State: displayed ${this.#displayed}, popup open ${this.#dialogOpen}, `
            + `unfinished calls: ${calls.join(', ') || 'none'}`)
        const timeout = new Promise((_, reject) => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000,
            () => (reject(new Error('no answer in 2 s')), GLib.SOURCE_REMOVE)))
        try {
            console.log(`Page state: ${JSON.stringify(
                await Promise.race([this.#call('debugState'), timeout]))}`)
        } catch (e) {
            console.log(`Page state: ${e.message}`)
        }
    }

    async #shareSelection() {
        try {
            const paragraphs = await this.#call('getSelection')
            if (paragraphs.length) this.emit('share-selection', paragraphs)
        } catch (e) {
            console.error(e)
        }
    }

    #do(name, ...args) {
        if (!this.#displayed || this.#dialogOpen) {
            debug(`${name} ignored: ${this.#displayed ? 'popup open' : 'no book showing'}`)
            return false
        }
        this.#call(name, ...args).catch(e => console.error(e))
        return true
    }

    #onMessage(message) {
        if (message.type !== 'search') debug(`message: ${summarize(message)}`)
        switch (message.type) {
            case 'ready':
                this.#pageReady?.()
                this.#pageReady = null
                break
            case 'relocate':
                this.emit('relocate', message)
                break
            case 'search':
                this.emit('search-changed', message)
                break
            case 'pull':
                this.emit('pull', message)
                break
            case 'history':
                this.emit('history-changed', message.canGoBack, message.canGoForward)
                break
            case 'dialog':
                this.#dialogOpen = message.open
                break
            case 'external-link':
                launchUri(message.href)
                break
        }
    }

    #decidePolicy(decision, type) {
        const { NAVIGATION_ACTION, NEW_WINDOW_ACTION } = WebKit.PolicyDecisionType
        if (type !== NAVIGATION_ACTION && type !== NEW_WINDOW_ACTION) return false
        const uri = decision.get_navigation_action().get_request().get_uri()
        const scheme = GLib.Uri.peek_scheme(uri)
        if (type === NAVIGATION_ACTION && [SCHEME, 'blob', 'about'].includes(scheme))
            return false
        decision.ignore()
        if (['http', 'https', 'mailto'].includes(scheme)) launchUri(uri)
        return true
    }

    // Paginated: the mouse wheel turns pages; touchpads drag the page and snap
    // to the nearest. Scrolled: WebKit scrolls, and we watch for the reader
    // pulling past the end of a chapter.
    #setupScrolling() {
        let discrete = true
        let last = null
        const turnPage = leadingDebounce((dx, dy) => {
            if (Math.abs(dx) > Math.abs(dy)) dx > 0 ? this.goRight() : this.goLeft()
            else dy > 0 ? this.next() : this.prev()
        }, 100)
        const controller = new Gtk.EventControllerScroll({
            flags: Gtk.EventControllerScrollFlags.BOTH_AXES,
        })
        controller.connect('scroll-begin', () => discrete = false)
        controller.connect('scroll', (_, dx, dy) => {
            if (this.#dialogOpen) {
                debug('scroll ignored: popup open')
                return false
            }
            if (this.#layout.scrolled) {
                const delta = controller.get_unit() === Gdk.ScrollUnit.WHEEL
                    ? dy * PIXELS_PER_WHEEL_STEP : dy
                if (delta) this.#call('overscroll', delta).catch(() => {})
                return false
            }
            if (discrete) turnPage(dx, dy)
            else {
                last = [dx, dy]
                this.#call('scrollBy', dx, dy).catch(() => {})
            }
            return true
        })
        controller.connect('scroll-end', () => {
            if (last) this.#call('snap', ...last).catch(() => {})
            discrete = true
            last = null
        })
        this.add_controller(controller)
    }

    // Ctrl+scroll changes the text size. Capture phase, so WebKit doesn't
    // also scroll the page.
    #setupZoom() {
        let accumulated = 0
        const controller = new Gtk.EventControllerScroll({
            flags: Gtk.EventControllerScrollFlags.VERTICAL,
            propagation_phase: Gtk.PropagationPhase.CAPTURE,
        })
        controller.connect('scroll', (_, _dx, dy) => {
            const state = controller.get_current_event_state()
            if (!(state & Gdk.ModifierType.CONTROL_MASK)) return false
            // a step per wheel notch, or per this many pixels on a touchpad
            const step = controller.get_unit() === Gdk.ScrollUnit.WHEEL ? 1 : 50
            if (Math.sign(dy) !== Math.sign(accumulated)) accumulated = 0
            accumulated += dy
            while (Math.abs(accumulated) >= step) {
                const dir = Math.sign(accumulated)
                accumulated -= dir * step
                this.emit('zoom', -dir)
            }
            return true
        })
        controller.connect('scroll-end', () => accumulated = 0)
        this.add_controller(controller)
    }

    #setupMouseButtons() {
        for (const [button, action] of [[8, () => this.back()], [9, () => this.forward()]]) {
            const gesture = new Gtk.GestureClick({ button })
            gesture.connect('pressed', action)
            this.add_controller(gesture)
        }
    }
})
