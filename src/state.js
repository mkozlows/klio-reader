import GLib from 'gi://GLib?version=2.0'

import { APP_ID } from './config.js'

// Small JSON file for things worth remembering between runs: window size,
// text size, and the last reading position of each book.

const MAX_BOOKS = 1000
const SAVE_DELAY_MS = 1000

const dir = GLib.build_filenamev([GLib.get_user_state_dir(), APP_ID])
const path = GLib.build_filenamev([dir, 'state.json'])
const decoder = new TextDecoder()

const load = () => {
    try {
        const [, contents] = GLib.file_get_contents(path)
        return JSON.parse(decoder.decode(contents))
    } catch {
        return {}
    }
}

const data = Object.assign({ textScale: 1, scrolled: false, colorScheme: 'default',
    customFont: false, fontFamily: 'Serif', overrideFontSize: false, textAlign: 'publisher', width: 900, height: 1000, maximized: false, books: {} }, load())
let saveSource = 0

const saveNow = () => {
    if (saveSource) GLib.source_remove(saveSource)
    saveSource = 0
    try {
        GLib.mkdir_with_parents(dir, 0o700)
        GLib.file_set_contents(path, JSON.stringify(data))
    } catch (e) {
        console.error(`Could not save state: ${e.message}`)
    }
}

const save = () => {
    if (saveSource) return
    saveSource = GLib.timeout_add(GLib.PRIORITY_LOW, SAVE_DELAY_MS, () => {
        saveSource = 0
        saveNow()
        return GLib.SOURCE_REMOVE
    })
}

export const state = {
    get(key) {
        return data[key]
    },
    set(key, value) {
        data[key] = value
        save()
    },
    getPosition(bookKey) {
        return data.books[bookKey]?.cfi ?? null
    },
    setPosition(bookKey, cfi) {
        data.books[bookKey] = { cfi, time: Date.now() }
        const keys = Object.keys(data.books)
        if (keys.length > MAX_BOOKS) {
            keys.sort((a, b) => data.books[a].time - data.books[b].time)
            for (const key of keys.slice(0, keys.length - MAX_BOOKS))
                delete data.books[key]
        }
        save()
    },
    flush() {
        if (saveSource) saveNow()
    },
}
