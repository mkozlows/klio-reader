import GLib from 'gi://GLib?version=2.0'
import Gdk from 'gi://Gdk?version=4.0'
import Graphene from 'gi://Graphene?version=1.0'
import Gtk from 'gi://Gtk?version=4.0'
import Pango from 'gi://Pango?version=1.0'
import PangoCairo from 'gi://PangoCairo?version=1.0'

// Layout of the image, in logical pixels; the PNG is rendered at SCALE
const WIDTH = 1080
const PADDING = 96
const SCALE = 2
const MAX_CHARS = 1500

const BLACK = new Gdk.RGBA({ red: 0, green: 0, blue: 0, alpha: 1 })
const WHITE = new Gdk.RGBA({ red: 1, green: 1, blue: 1, alpha: 1 })
// The quotation marks, a pale watermark behind the text
const MARK_COLOR = new Gdk.RGBA({ red: 0.85, green: 0.9, blue: 0.97, alpha: 1 })
const MARK_SIZE = 200
// How far into the margin the marks sit, from the edge of the card
const MARK_INSET = 24

// Shorter quotes get bigger text
const textSize = length =>
    length <= 140 ? 44 : length <= 300 ? 38 : length <= 600 ? 32 : 27

// Cut long quotes at a word boundary
const truncate = paragraphs => {
    const result = []
    let length = 0
    for (const p of paragraphs) {
        if (length + p.length <= MAX_CHARS) {
            result.push(p)
            length += p.length
            continue
        }
        const room = p.slice(0, MAX_CHARS - length)
        const cut = room.replace(/\s+\S*$/, '') || (result.length ? '' : room)
        if (cut) result.push(`${cut}…`)
        else result[result.length - 1] += '…'
        break
    }
    return result
}

const makeLayout = (context, { family, size, style = Pango.Style.NORMAL, width, spacing }) => {
    const layout = Pango.Layout.new(context)
    const font = new Pango.FontDescription()
    font.set_family(family)
    font.set_absolute_size(size * Pango.SCALE)
    font.set_style(style)
    layout.set_font_description(font)
    layout.set_wrap(Pango.WrapMode.WORD_CHAR)
    if (width) layout.set_width(width * Pango.SCALE)
    if (spacing) layout.set_line_spacing(spacing)
    return layout
}

// Render a passage as a quote on a white card, with the book's author and
// title underneath. Returns a Gdk.Texture.
//   paragraphs: the passage's paragraphs, as plain text
//   font: font family for the text
export const renderQuoteImage = (renderer, { paragraphs, title, author, font }) => {
    paragraphs = truncate(paragraphs)
    const length = paragraphs.reduce((n, p) => n + p.length, 0)
    const size = textSize(length)
    const width = WIDTH - 2 * PADDING

    const context = PangoCairo.FontMap.get_default().create_context()
    context.set_round_glyph_positions(false)

    // [layout, y] pairs, laid out top to bottom
    const items = []
    let y = PADDING

    for (const [i, text] of paragraphs.entries()) {
        const layout = makeLayout(context, { family: font, size, width, spacing: 1.15 })
        layout.set_text(text, -1)
        if (i > 0) y += size * 0.75
        items.push([layout, y])
        y += layout.get_pixel_extents()[1].height
    }
    const textBottom = y

    // Attribution: a short rule, then "Author, Title"
    const escape = s => GLib.markup_escape_text(s, -1)
    const creditMarkup = [author && escape(author), title && `<i>${escape(title)}</i>`]
        .filter(Boolean).join(', ')
    let ruleY = null
    if (creditMarkup) {
        y += size * 1.2
        ruleY = y
        y += size * 0.9
        const credit = makeLayout(context, { family: font, size: Math.max(22, size * 0.6), width })
        credit.set_markup(creditMarkup, -1)
        items.push([credit, y])
        y += credit.get_pixel_extents()[1].height
    }
    y += PADDING

    const height = Math.ceil(y)
    const snapshot = new Gtk.Snapshot()
    snapshot.scale(SCALE, SCALE)
    snapshot.append_color(WHITE, new Graphene.Rect().init(0, 0, WIDTH, height))

    // Quotation marks in the margins: the opening one level with the first
    // line, the closing one with the last
    const mark = (text, opening) => {
        const layout = makeLayout(context, { family: font, size: MARK_SIZE })
        layout.set_text(text, -1)
        const [ink] = layout.get_pixel_extents()
        snapshot.save()
        snapshot.translate(new Graphene.Point().init(
            (opening ? MARK_INSET : WIDTH - MARK_INSET - ink.width) - ink.x,
            (opening ? PADDING - ink.height * 0.4 : textBottom - ink.height * 0.6) - ink.y))
        snapshot.append_layout(layout, MARK_COLOR)
        snapshot.restore()
    }
    mark('“', true)
    mark('”', false)

    if (ruleY !== null)
        snapshot.append_color(BLACK, new Graphene.Rect().init(PADDING, ruleY, 64, 2))
    for (const [layout, top] of items) {
        snapshot.save()
        snapshot.translate(new Graphene.Point().init(PADDING, top))
        snapshot.append_layout(layout, BLACK)
        snapshot.restore()
    }
    const node = snapshot.to_node()
    return renderer.render_texture(node,
        new Graphene.Rect().init(0, 0, WIDTH * SCALE, height * SCALE))
}
