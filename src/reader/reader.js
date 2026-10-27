// Runs inside the WebView. Wraps foliate-js and exposes `globalThis.api` for
// the GTK side to call; events go back through the `reader` message handler.

import '../foliate-js/view.js'
import { NotFoundError, UnsupportedTypeError } from '../foliate-js/view.js'
import { FootnoteHandler } from '../foliate-js/footnotes.js'
import { Overlayer } from '../foliate-js/overlayer.js'
import * as CFI from '../foliate-js/epubcfi.js'

const post = message =>
    globalThis.webkit.messageHandlers.reader.postMessage(JSON.stringify(message))

// Verbose logging, on when the GTK side sets readerDebug (READER_DEBUG).
// WebKit writes console messages to stderr.
const timestamp = () => {
    const now = new Date()
    return `${now.toTimeString().slice(0, 8)}.${String(now.getMilliseconds()).padStart(3, '0')}`
}
const debug = globalThis.readerDebug
    ? (...args) => console.log(`[page ${timestamp()}]`, ...args)
    : () => {}

// Line length cap at 100% text size. It grows with the text size, so lines
// hold about the same number of characters at any size (window permitting).
const MAX_INLINE_SIZE = 720

const LAYOUT = {
    'gap': '6%',
    'margin': '48px',
    'max-block-size': '1440px',
    'max-column-count': '1',
}

// In scrolled mode, scrolling up at the start of a chapter goes straight to
// the previous one. Scrolling down at the end goes on to the next, but first
// the end of the chapter scrolls up the window, over blank space (the
// runout) as long as the chapter runs past one window, up to half a window.
// So nothing is missed, and a section that fits in the window takes a single
// notch of the wheel. Going back lands at the bottom of the runout, so going
// forward again takes a single notch too. Only scrolling that starts at the
// bottom counts, so the scroll that gets there never carries on into the
// next chapter. How far into the runout the reader is shows in GTK.
const RUNOUT = '--reader-runout'
const PIXELS_PER_NOTCH = 70 // as PIXELS_PER_WHEEL_STEP in book-view.js
// Scroll events closer together than this are one scroll: a spin of the
// wheel, or a swipe on a touchpad
const SCROLL_GAP_MS = 250
// After moving to another chapter, scrolling is ignored for this long
const CHAPTER_CHANGE_PAUSE_MS = 400

// Find: every match is highlighted; the current one in a stronger color
const SEARCH_HIGHLIGHT = '#f6d32d'
const SEARCH_CURRENT = '#ff7800'

// Highlight plus outline, so the current match stands out among the others
const drawCurrentMatch = rects => {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
    g.append(
        Overlayer.highlight(rects, { color: SEARCH_CURRENT }),
        Overlayer.outline(rects, { color: SEARCH_CURRENT, width: 2, radius: 2 }))
    return g
}

const NOTE_TITLES = {
    footnote: 'Footnote',
    endnote: 'Endnote',
    biblioentry: 'Bibliography',
    definition: 'Definition',
}

const percent = new Intl.NumberFormat(navigator.language, { style: 'percent' })
const list = new Intl.ListFormat(navigator.language, { type: 'conjunction' })

const formatLanguageMap = x => {
    if (!x) return ''
    if (typeof x === 'string') return x
    return Object.values(x)[0] ?? ''
}

const formatContributors = x => [x ?? []].flat()
    .map(c => typeof c === 'string' ? c : formatLanguageMap(c?.name))
    .filter(Boolean)

// Paragraphs whose alignment the reader's alignment setting may override; see
// markAlignable()
// (a data attribute rather than a class, which could change which of the
// book's own selectors match, like p:not([class]))
const ALIGNABLE = 'data-reader-alignable'
const TEXT_BLOCKS = 'p, li, blockquote, dd'

// Overriding the publisher's font size applies to text in these elements, so
// headings keep their size relative to the text
const SIZED_BLOCKS = 'body, div, p, li, blockquote, dd'

// Text that keeps its own font when the font is overridden
const MONOSPACE = 'pre, code, kbd, samp, tt'

// [before, after] the book's own stylesheets. The "before" part supplies
// defaults; the "after" part enforces the color scheme and text settings.
//   font: font family to use instead of the book's, or null
//   overrideSize: show body text at the default size, whatever the book says
//   align: 'publisher', 'justify', or 'start'
// In scrolled mode, images are kept short enough to see whole, so a cover or
// a full-page illustration fits in the window. This holds the height they
// have room for; foliate-js does the same itself for pages.
const IMAGE_HEIGHT = '--reader-image-height'
const MEDIA = 'img, svg, video'

const getCSS = ({ dark, bg, fg, link }, { font, overrideSize, align, textScale, scrolled }) => [`
    @namespace epub "http://www.idpf.org/2007/ops";
    html {
        color-scheme: ${dark ? 'dark' : 'light'};
        color: ${fg};
        hanging-punctuation: allow-end last;
        orphans: 2;
        widows: 2;
    }
    a:any-link {
        color: ${link};
        text-decoration-color: color-mix(in srgb, currentColor 35%, transparent);
        text-underline-offset: .1em;
    }
    aside[epub|type~="footnote"] {
        display: none;
    }
    [align="left"] { text-align: left; }
    [align="right"] { text-align: right; }
    [align="center"] { text-align: center; }
    [align="justify"] { text-align: justify; }
    :is(hgroup, header) p {
        text-align: unset;
        hyphens: unset;
    }
    h1, h2, h3, h4, h5, h6, hgroup, th {
        text-wrap: balance;
    }
    pre {
        white-space: pre-wrap !important;
        tab-size: 2;
    }
    ${scrolled ? `
    body::after {
        content: '' !important;
        display: block !important;
        clear: both !important;
        height: var(${RUNOUT}, 0) !important;
    }` : ''}
`, `
    ${dark ? `
    html, body {
        color: ${fg} !important;
        background: none !important;
    }
    img[${LINE_ART}] {
        background: none !important;
        ${lineArtFilter(grayLevel(bg), grayLevel(fg))}
    }
    body * {
        color: inherit !important;
        border-color: currentColor !important;
        background-color: ${bg} !important;
    }
    a:any-link {
        color: ${link} !important;
    }` : ''}
    ${TEXT_BLOCKS} {
        line-height: 1.5;
        hyphens: auto;
    }
    ${align !== 'publisher' ? `
    [${ALIGNABLE}] {
        text-align: ${align} !important;
    }` : ''}
    ${font ? `
    body, body *:not(${MONOSPACE}, :is(${MONOSPACE}) *) {
        font-family: ${JSON.stringify(font)} !important;
    }` : ''}
    ${overrideSize ? `
    html {
        font-size: ${Math.round(16 * textScale)}px !important;
    }
    ${SIZED_BLOCKS} {
        font-size: 1rem !important;
    }` : ''}
`]

// In scrolled mode a section's frame is as tall as its content, so vh units,
// which books use to mean the window's height, would size things relative to
// themselves: an image set to 99vh would shrink forever. They're rewritten to
// use VH, which holds 1% of the window's height in scrolled mode.
const VH = '--reader-vh'
const VH_UNITS = /(-?\d*\.?\d+)[dsl]?vh\b/g
const fixViewportUnits = doc => {
    const fixStyle = style => {
        for (const name of [...style]) {
            const value = style.getPropertyValue(name)
            if (!value.includes('vh')) continue
            style.setProperty(name, value.replace(VH_UNITS, `calc($1 * var(${VH}, 1vh))`),
                style.getPropertyPriority(name))
        }
    }
    const fixRules = rules => {
        for (const rule of rules) {
            if (rule.style) fixStyle(rule.style)
            if (rule.cssRules) fixRules(rule.cssRules)
        }
    }
    for (const sheet of doc.styleSheets) {
        try {
            fixRules(sheet.cssRules)
        } catch (e) {
            debug(`could not read a stylesheet: ${e}`)
        }
    }
    for (const el of doc.querySelectorAll('[style*="vh"]')) fixStyle(el.style)
}

// Line art: black-and-white images of dark ink on light paper or on a
// transparent background, like ornaments, maps, and pen drawings. In dark
// mode they're recolored, the paper to the background color and the ink to
// the text color, so they don't show as glaring white boxes, or as black on
// near-black. Photos, which have more shades of gray, are left alone.
const LINE_ART = 'data-reader-line-art'
const LINE_ART_SAMPLE_SIZE = 128
const isLineArt = async img => {
    try {
        await img.decode()
        const scale = Math.min(1, LINE_ART_SAMPLE_SIZE / Math.max(img.naturalWidth, img.naturalHeight))
        const width = Math.max(1, Math.round(img.naturalWidth * scale))
        const height = Math.max(1, Math.round(img.naturalHeight * scale))
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const context = canvas.getContext('2d', { willReadFrequently: true })
        // nearest neighbor, so thin lines stay ink rather than turning gray
        context.imageSmoothingEnabled = false
        context.drawImage(img, 0, 0, width, height)
        const data = context.getImageData(0, 0, width, height).data
        let visible = 0, colored = 0, light = 0, mid = 0
        for (let i = 0; i < data.length; i += 4) {
            const [r, g, b, a] = data.subarray(i, i + 4)
            if (a < 32) continue
            visible++
            if (Math.max(r, g, b) - Math.min(r, g, b) > 32) colored++
            const level = (r + g + b) / 3
            if (level > 200) light++
            else if (level >= 56) mid++
        }
        const transparent = width * height - visible
        if (!visible || colored > visible * 0.03 || mid > visible * 0.25) return false
        // on a transparent background, mostly dark ink; otherwise, mostly
        // light paper
        return transparent > width * height * 0.05
            ? light < visible / 2
            : light > visible / 2
    } catch {
        return false
    }
}
const markLineArt = doc => {
    for (const img of doc.images)
        isLineArt(img).then(yes => yes && img.setAttribute(LINE_ART, ''))
}

// The gray level of a color like #1d1d20, from 0 to 1
const grayLevel = color => [1, 3, 5]
    .reduce((sum, i) => sum + parseInt(color.slice(i, i + 2), 16), 0) / 765

// Maps white to `paper` and black to `ink` (gray levels, from 0 to 1), and
// shades between to shades between
const lineArtFilter = (paper, ink) =>
    `filter: invert(${ink / (ink + paper)}) brightness(${ink + paper}) !important;`

// Calibre's cover pages stretch the cover to fill an SVG the size of the page,
// which distorts it when the page isn't the cover's shape. Fit it instead.
const unstretchImages = doc => {
    for (const svg of doc.querySelectorAll('svg[preserveAspectRatio="none"]'))
        if (svg.querySelector('image')) svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')
}

// Mark the paragraphs that the book aligns as ordinary running text (justified
// or ragged), so the alignment setting can override just those, and not, say,
// centered headings or right-aligned signatures.
const markAlignable = doc => {
    const rtl = doc.defaultView.getComputedStyle(doc.body).direction === 'rtl'
    const plain = ['justify', 'start', rtl ? 'right' : 'left', '-webkit-auto']
    for (const el of doc.querySelectorAll(TEXT_BLOCKS))
        if (plain.includes(doc.defaultView.getComputedStyle(el).textAlign))
            el.setAttribute(ALIGNABLE, '')
}

// Dragging an image or link out of a book is no use (it carries a URL that
// only means something here), and dropping anything on the page would make
// WebKit navigate to it. Dragging selected text still works.
const blockDragging = doc => {
    doc.addEventListener('dragstart', e => {
        if (e.target.nodeType !== Node.TEXT_NODE) e.preventDefault()
    })
    doc.addEventListener('dragover', e => e.preventDefault())
    doc.addEventListener('drop', e => e.preventDefault())
}
blockDragging(document)

// Whether this web process can render a font family: text in it measures
// differently from text in the fallback, for at least one of two fallbacks
const hasFont = family => {
    const context = document.createElement('canvas').getContext('2d')
    const measure = font => {
        context.font = `40px ${font}`
        return context.measureText('Handgloves 0123456789').width
    }
    return ['serif', 'monospace'].some(fallback =>
        measure(`${JSON.stringify(family)}, ${fallback}`) !== measure(fallback))
}

// The selected text as a list of paragraphs, without footnote references
const BLOCK_ELEMENTS = new Set(['address', 'article', 'aside', 'blockquote', 'dd',
    'div', 'dl', 'dt', 'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4',
    'h5', 'h6', 'header', 'hr', 'li', 'ol', 'p', 'pre', 'section', 'table', 'tr', 'ul'])
const NOTE_REF = 'data-reader-noteref'

// After foliate-js's footnotes.js: marked as a reference, or superscript
const isSuperscript = el => el?.localName === 'sup' || (el?.nodeType === Node.ELEMENT_NODE
    && /^(super|top|text-top)$/.test(el.ownerDocument.defaultView.getComputedStyle(el).verticalAlign))
// The superscript a link sits in or holds, if it's nothing but the link. Goes
// further than foliate-js, for e.g. <sup><small><a>1</a></small></sup>.
const getSuperscript = a => {
    const text = a.textContent.trim()
    const onlyLink = el => el?.nodeType === Node.ELEMENT_NODE && el.textContent.trim() === text
    for (let el = a; onlyLink(el); el = el.parentElement)
        if (isSuperscript(el)) return el
    for (let el = a.firstElementChild; onlyLink(el); el = el.firstElementChild)
        if (isSuperscript(el)) return el
    return null
}
const isMarkedNoteRef = a => /\b(doc-)?(noteref|biblioref|glossref)\b/.test(
    `${a.getAttributeNS('http://www.idpf.org/2007/ops', 'type')} ${a.getAttribute('role')}`)
const isNoteRef = a =>
    isMarkedNoteRef(a) || getSuperscript(a) !== null || isSuperscript(a.parentElement)

const getText = node => [...node.childNodes].map(child => {
    if (child.nodeType === Node.TEXT_NODE) return child.data
    if (child.nodeType !== Node.ELEMENT_NODE || child.hasAttribute(NOTE_REF)) return ''
    if (child.localName === 'br') return '\n'
    const text = getText(child)
    return BLOCK_ELEMENTS.has(child.localName) ? `\n${text}\n` : text
}).join('')

const getSelectedParagraphs = (doc, range) => {
    const refs = [...doc.querySelectorAll('a[href]')]
        .filter(a => range.intersectsNode(a) && isNoteRef(a))
    for (const a of refs) a.setAttribute(NOTE_REF, '')
    const contents = range.cloneContents()
    for (const a of refs) a.removeAttribute(NOTE_REF)
    return getText(contents)
        .replaceAll('\u00ad', '')
        .split('\n')
        .map(line => line.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
}

const dialog = document.getElementById('footnote')

class Reader {
    #footnotes = new FootnoteHandler()
    #appearance = { dark: false, bg: '#ffffff', fg: '#1e1e1e', link: '#1c71d8' }
    #layout = {
        scrolled: false, textScale: 1,
        font: null, overrideSize: false, align: 'publisher',
    }
    #title = ''
    #tocIds = new Map()
    #pullShown = 0 // how far into the runout the reader is, last shown in GTK
    #overscrollLocked = false
    #scrollStart = 0 // when the current scroll began
    #lastScrollTime = 0
    #lastScrollDir = 0
    #edgeSince = new Map() // direction (1, -1) → when that edge came into view
    #sectionLabels = new Map() // section index → label of its first TOC item
    #searchToken = 0
    #searchTask = Promise.resolve()
    #searchResults = []
    #searchCurrent = -1
    #currentMatch = null // annotation marking the current match

    async open(url, layout) {
        this.view = document.createElement('foliate-view')
        try {
            await this.view.open(url)
        } catch (e) {
            if (e instanceof NotFoundError)
                throw new Error('The file is empty or could not be read.')
            if (e instanceof UnsupportedTypeError)
                throw new Error('This file is not an EPUB book.')
            throw e
        }
        const { book } = this.view
        document.body.append(this.view)

        const { renderer } = this.view
        for (const [name, value] of Object.entries(LAYOUT))
            renderer.setAttribute(name, value)
        this.setLayout(layout)
        renderer.setAttribute('animated', '')
        this.#applyAppearance()
        this.#handleEvents()

        this.#labelSections(book.toc ?? [])

        const metadata = book.metadata ?? {}
        this.#title = formatLanguageMap(metadata.title)
        const identifier = [metadata.identifier].flat()[0]
        return {
            identifier: typeof identifier === 'string' ? identifier : identifier?.value,
            title: this.#title,
            author: list.format(formatContributors(metadata.author)),
            toc: this.#serializeTOC(book.toc ?? []),
        }
    }

    async display(lastLocation) {
        try {
            await this.view.init({ lastLocation })
        } catch (e) {
            console.warn('Could not restore position', e)
            await this.view.init({})
        }
    }

    setAppearance(appearance) {
        this.#appearance = appearance
        this.#applyAppearance()
    }

    setLayout(layout) {
        this.#layout = { ...this.#layout, ...layout }
        const { scrolled, textScale } = this.#layout
        const renderer = this.view?.renderer
        if (!renderer) return
        renderer.setAttribute('flow', scrolled ? 'scrolled' : 'paginated')
        renderer.setAttribute('max-inline-size', `${Math.round(MAX_INLINE_SIZE * textScale)}px`)
        renderer.setStyles?.(getCSS(this.#appearance, this.#layout))
        // once the section is laid out for the new flow
        requestAnimationFrame(() => {
            this.#fitAllToWindow()
            this.#showPull()
        })
    }

    // Search the whole book, sending { type: 'search' } messages as results
    // come in. Jumps to the first match at or after the current position.
    async search(query) {
        const token = ++this.#searchToken
        // let any previous search reach a stopping point first, so it can't
        // add highlights after this one has cleared them
        await this.#searchTask
        if (token !== this.#searchToken) return
        this.#searchTask = this.#runSearch(token, query)
        await this.#searchTask
    }

    async #runSearch(token, query) {
        const { view } = this
        view.clearSearch()
        if (this.#currentMatch) view.deleteAnnotation(this.#currentMatch)
        this.#currentMatch = null
        this.#searchResults = []
        this.#searchCurrent = -1
        if (!query) return this.#postSearch(true)

        const start = view.lastLocation?.cfi
        const iter = view.search({
            query,
            draw: Overlayer.highlight,
            drawOptions: { color: SEARCH_HIGHLIGHT },
        })
        for await (const result of iter) {
            if (token !== this.#searchToken) return
            if (!result.subitems) continue
            this.#searchResults.push(...result.subitems.map(item => item.cfi))
            if (this.#searchCurrent < 0 && start) {
                const i = this.#searchResults.findIndex(cfi => CFI.compare(cfi, start) >= 0)
                if (i >= 0) this.#goToMatch(i)
            }
            this.#postSearch(false)
        }
        // nothing after the current position: wrap around to the start
        if (this.#searchCurrent < 0 && this.#searchResults.length) this.#goToMatch(0)
        this.#postSearch(true)
    }

    // dir: 1 for the next match, -1 for the previous one
    findNext(dir) {
        const n = this.#searchResults.length
        if (!n) return
        this.#goToMatch((this.#searchCurrent + dir + n) % n)
        this.#postSearch(true)
    }

    async #goToMatch(i) {
        const { view } = this
        this.#searchCurrent = i
        if (this.#currentMatch) view.deleteAnnotation(this.#currentMatch)
        const match = { value: this.#searchResults[i], searchCurrent: true }
        this.#currentMatch = match
        try {
            // not view.goTo(), which would add each match to the back history
            await view.renderer.goTo(view.resolveNavigation(match.value))
            if (this.#currentMatch === match) await view.addAnnotation(match)
        } catch (e) {
            console.error(e)
        }
    }

    #postSearch(done) {
        post({
            type: 'search',
            current: this.#searchCurrent,
            total: this.#searchResults.length,
            done,
        })
    }

    // Up/Down: a few lines when scrolling, a whole page when paginated
    // Next (dir 1) or previous (-1) page, or in scrolled mode, scroll by
    // `distance` or a screenful. In scrolled mode, foliate-js locks up for
    // good (no more turning pages or going to chapters) if asked to go past
    // the first or last section, so it isn't asked.
    async turn(dir, distance) {
        const { renderer } = this.view
        if (renderer.scrolled && this.#atEdge(dir) && this.#adjacentSection(dir) == null) {
            debug(`turn ignored: no section ${dir > 0 ? 'after' : 'before'} this one`)
            return
        }
        await (dir > 0 ? this.view.next(distance) : this.view.prev(distance))
    }

    // The next (dir 1) or previous (-1) section in reading order, if any
    #adjacentSection(dir) {
        const { renderer, book } = this.view
        let index = (renderer.getContents()[0]?.index ?? -1) + dir
        while (book.sections[index]?.linear === 'no') index += dir
        return book.sections[index] ? index : null
    }

    // Whether the end (dir 1) or start (-1) of the section is in view
    #atEdge(dir) {
        const { renderer } = this.view
        return dir > 0 ? renderer.viewSize - renderer.end <= 2 : renderer.start <= 0
    }

    // Note when each edge of the section came into view
    #updateEdges() {
        const now = performance.now()
        for (const dir of [1, -1])
            this.#edgeSince.set(dir, this.view.renderer.scrolled && this.#atEdge(dir)
                ? this.#edgeSince.get(dir) ?? now : null)
    }

    async scrollLines(dir) {
        const { renderer } = this.view
        let distance
        if (renderer.scrolled) {
            const doc = renderer.getContents()[0]?.doc
            const style = doc ? doc.defaultView.getComputedStyle(doc.body) : null
            const lineHeight = parseFloat(style?.lineHeight) || 1.5 * parseFloat(style?.fontSize) || 24
            distance = 3 * lineHeight
        }
        await this.turn(dir, distance)
    }

    // Called for every wheel/touchpad scroll in scrolled mode (WebKit does the
    // actual scrolling). Scrolling past the edge of a chapter moves on.
    async overscroll(delta) {
        const { renderer } = this.view
        if (!renderer.scrolled || !delta) return
        const now = performance.now()
        const dir = Math.sign(delta)
        if (now - this.#lastScrollTime > SCROLL_GAP_MS || dir !== this.#lastScrollDir)
            this.#scrollStart = now
        this.#lastScrollTime = now
        this.#lastScrollDir = dir
        if (this.#overscrollLocked) return

        this.#updateEdges()
        const edgeSince = this.#edgeSince.get(dir)
        if (edgeSince == null || this.#adjacentSection(dir) == null) return
        if (dir > 0 && edgeSince >= this.#scrollStart) {
            debug('overscroll ignored: this scroll reached the end')
            return
        }
        this.#overscrollLocked = true
        debug(`overscroll: going ${dir > 0 ? 'forward' : 'back'}`)
        try {
            await this.turn(dir)
            debug(`overscroll: now at section ${renderer.getContents()[0]?.index}`)
        } finally {
            setTimeout(() => this.#overscrollLocked = false, CHAPTER_CHANGE_PAUSE_MS)
        }
    }

    // Show in GTK how far into the runout the reader has scrolled
    #showPull() {
        const { renderer } = this.view
        const doc = renderer.scrolled ? renderer.getContents()[0]?.doc : null
        const runout = parseFloat(doc?.documentElement.style.getPropertyValue(RUNOUT)) || 0
        const fraction = runout
            ? Math.max(0, Math.min(1, (renderer.end - (renderer.viewSize - runout)) / runout))
            : 0
        if (fraction === this.#pullShown) return
        this.#pullShown = fraction
        post({
            type: 'pull',
            fraction,
            label: fraction ? this.#sectionLabels.get(this.#adjacentSection(1)) ?? '' : '',
        })
    }

    #applyAppearance() {
        const { bg, fg, link } = this.#appearance
        const style = document.documentElement.style
        style.setProperty('--bg', bg)
        style.setProperty('--fg', fg)
        style.setProperty('--link', link)
        style.colorScheme = this.#appearance.dark ? 'dark' : 'light'
        style.setProperty('--overlayer-highlight-blend-mode',
            this.#appearance.dark ? 'screen' : 'multiply')
        this.view?.renderer?.setStyles?.(getCSS(this.#appearance, this.#layout))
    }

    // TOC items get numeric ids so the GTK side can match `relocate` events
    // to rows unambiguously (hrefs aren't unique).
    #labelSections(items) {
        for (const item of items) {
            const index = item.href ? this.view.resolveNavigation(item.href)?.index : null
            const label = item.label?.trim()
            if (index != null && label && !this.#sectionLabels.has(index))
                this.#sectionLabels.set(index, label)
            this.#labelSections(item.subitems ?? [])
        }
    }

    #serializeTOC(items) {
        return items.map(item => {
            const id = this.#tocIds.size
            this.#tocIds.set(item, id)
            return {
                id,
                label: (item.label ?? '').trim(),
                href: item.href,
                subitems: item.subitems?.length ? this.#serializeTOC(item.subitems) : null,
            }
        })
    }

    // In scrolled mode, size a section's images and vh units by the height of
    // the window, less the margins above and below a section. A section
    // that's just an image, like a cover, fits whole.
    #fitToWindow(doc, index) {
        const { renderer } = this.view
        const { style } = doc.documentElement
        if (!renderer.scrolled || !doc.body) {
            style.removeProperty(VH)
            style.removeProperty(RUNOUT)
            return
        }
        const room = Math.floor(
            renderer.getBoundingClientRect().height - 2 * parseFloat(LAYOUT.margin))
        style.setProperty(VH, `${room / 100}px`)
        style.removeProperty(RUNOUT)
        this.#fitImages(doc, room)

        // The runout: as far as the section runs past the window, up to half
        // the window, unless that's within a notch or this is the last section
        const overflow = doc.documentElement.getBoundingClientRect().height - room
        const { sections } = this.view.book
        let next = index + 1
        while (sections[next]?.linear === 'no') next++
        if (overflow > PIXELS_PER_NOTCH && sections[next])
            style.setProperty(RUNOUT, `${Math.floor(Math.min(renderer.size / 2, overflow))}px`)
    }

    #fitImages(doc, room) {
        const { style } = doc.documentElement
        style.setProperty(IMAGE_HEIGHT, `${room}px`)
        // on the elements, to replace the limit foliate-js sets for pages
        for (const el of doc.body.querySelectorAll(MEDIA))
            el.style.setProperty('max-height', `var(${IMAGE_HEIGHT})`, 'important')
        const images = doc.body.querySelectorAll('img, svg')
        if (images.length !== 1 || doc.body.innerText.trim()) return
        // Shrink the image by however much the section is too tall. It can
        // take a couple of tries, as the space around it can change too.
        let height = room
        for (let i = 0; i < 3; i++) {
            const excess = doc.documentElement.getBoundingClientRect().height - room
            if (Math.abs(excess) < 1) break
            height = Math.min(room, Math.floor(height - excess))
            style.setProperty(IMAGE_HEIGHT, `${height}px`)
        }
    }

    #fitAllToWindow() {
        for (const { doc, index } of this.view.renderer.getContents()) this.#fitToWindow(doc, index)
    }

    #handleEvents() {
        const { view } = this
        addEventListener('resize', () => this.#fitAllToWindow())
        view.renderer.addEventListener('scroll', () => {
            this.#updateEdges()
            this.#showPull()
        })
        view.addEventListener('load', ({ detail }) => {
            debug(`loaded section ${detail.index}`)
            // again once foliate-js has laid the section out
            fixViewportUnits(detail.doc)
            unstretchImages(detail.doc)
            this.#fitToWindow(detail.doc, detail.index)
            this.#edgeSince.clear()
            requestAnimationFrame(() => {
                this.#fitToWindow(detail.doc, detail.index)
                this.#updateEdges()
                this.#showPull()
            })
            markAlignable(detail.doc)
            markLineArt(detail.doc)
            blockDragging(detail.doc)
        })
        view.addEventListener('relocate', ({ detail }) => {
            const { fraction, tocItem, cfi } = detail
            const { heads, feet } = view.renderer
            if (heads?.length) {
                heads.at(-1).innerText = tocItem?.label?.trim() ?? ''
                if (heads.length > 1) heads[0].innerText = this.#title
            }
            const progress = percent.format(fraction ?? 0)
            if (feet?.length) feet.at(-1).innerText = progress
            post({
                type: 'relocate',
                cfi,
                progress,
                tocId: this.#tocIds.get(tocItem) ?? null,
                tocLabel: tocItem?.label?.trim() ?? '',
            })
        })
        view.addEventListener('external-link', e => {
            e.preventDefault()
            post({ type: 'external-link', href: e.detail.href_ })
        })
        view.addEventListener('link', e => {
            debug(`link: ${e.detail.href}`)
            // Hand foliate-js the superscript around the link, which it might
            // not find itself
            const { a, href } = e.detail
            const sup = isMarkedNoteRef(a) ? null : getSuperscript(a)
            const event = sup && sup !== a
                ? { detail: { a: sup, href }, preventDefault: () => e.preventDefault() }
                : e
            this.#footnotes.handle(view.book, event)?.catch(err => {
                console.warn(err)
                view.goTo(href)
            })
        })
        view.addEventListener('draw-annotation', ({ detail }) => {
            if (detail.annotation.searchCurrent) detail.draw(drawCurrentMatch)
        })
        // a section's overlay is recreated whenever it's loaded again
        view.addEventListener('create-overlay', ({ detail }) => {
            const match = this.#currentMatch
            if (match && view.resolveNavigation(match.value)?.index === detail.index)
                view.addAnnotation(match)
        })
        view.history.addEventListener('index-change', ({ target }) =>
            post({ type: 'history', canGoBack: target.canGoBack, canGoForward: target.canGoForward }))

        this.#footnotes.addEventListener('before-render', ({ detail }) => {
            const { view: noteView } = detail
            noteView.addEventListener('load', ({ detail }) => {
                blockDragging(detail.doc)
                markLineArt(detail.doc)
            })
            noteView.addEventListener('link', e => {
                e.preventDefault()
                dialog.close()
                view.goTo(e.detail.href)
            })
            noteView.addEventListener('external-link', e => {
                e.preventDefault()
                post({ type: 'external-link', href: e.detail.href_ })
            })
            dialog.querySelector('main').replaceChildren(noteView)
            const { renderer } = noteView
            renderer.setAttribute('flow', 'scrolled')
            renderer.setAttribute('margin', '0px')
            renderer.setAttribute('gap', '8%')
            renderer.setStyles(getCSS(this.#appearance, this.#layout))
        })
        this.#footnotes.addEventListener('render', ({ detail }) => {
            const { href, hidden, type } = detail
            dialog.dataset.href = href
            dialog.querySelector('header').innerText = NOTE_TITLES[type] ?? 'Note'
            dialog.querySelector('[value="go"]').hidden = hidden
            debug(`popup open: ${href}`)
            dialog.showModal()
            post({ type: 'dialog', open: true })
        })
    }

    // Paragraphs of the selected text in the book or a footnote popup, if any
    getSelection() {
        const views = [this.view, dialog.open ? dialog.querySelector('foliate-view') : null]
        for (const view of views)
            for (const { doc } of view?.renderer?.getContents() ?? []) {
                const selection = doc.getSelection()
                if (selection?.rangeCount && !selection.isCollapsed)
                    return getSelectedParagraphs(doc, selection.getRangeAt(0))
            }
        return []
    }

    // For logging, when something's stuck
    debugState() {
        const renderer = this.view?.renderer
        return {
            section: renderer?.getContents()[0]?.index ?? null,
            scrolled: renderer?.scrolled ?? null,
            start: renderer?.start, end: renderer?.end, viewSize: renderer?.viewSize,
            pull: this.#pullShown,
            overscrollLocked: this.#overscrollLocked,
            popupOpen: dialog.open,
        }
    }

    onDialogClose() {
        debug('popup closed')
        post({ type: 'dialog', open: false })
        const noteView = dialog.querySelector('foliate-view')
        noteView?.close()
        noteView?.remove()
        if (dialog.returnValue === 'go') this.view.goTo(dialog.dataset.href)
        dialog.returnValue = ''
    }
}

const reader = new Reader()

dialog.addEventListener('close', () => reader.onDialogClose())
dialog.addEventListener('click', e => e.target === dialog ? dialog.close() : null)

globalThis.api = {
    hasFont,
    debugState: () => reader.debugState(),
    getSelection: () => reader.getSelection(),
    open: (url, layout) => reader.open(url, layout),
    display: lastLocation => reader.display(lastLocation),
    setAppearance: appearance => reader.setAppearance(appearance),
    setLayout: layout => reader.setLayout(layout),
    next: async () => void await reader.turn(1),
    prev: async () => void await reader.turn(-1),
    goLeft: async () => void await reader.turn(reader.view.book.dir === 'rtl' ? 1 : -1),
    goRight: async () => void await reader.turn(reader.view.book.dir === 'rtl' ? -1 : 1),
    goTo: async href => void await reader.view.goTo(href),
    scrollLines: async dir => void await reader.scrollLines(dir),
    overscroll: async delta => void await reader.overscroll(delta),
    search: async query => void await reader.search(query),
    findNext: dir => void reader.findNext(dir),
    clearSearch: async () => void await reader.search(''),
    back: () => void reader.view.history.back(),
    forward: () => void reader.view.history.forward(),
    scrollBy: (dx, dy) => void reader.view.renderer.scrollBy?.(dx, dy),
    snap: async (vx, vy) => void await reader.view.renderer.snap?.(vx, vy),
}

post({ type: 'ready' })
