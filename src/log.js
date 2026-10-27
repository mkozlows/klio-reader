import GLib from 'gi://GLib?version=2.0'

// Verbose logging, on when READER_DEBUG is set. It goes to stderr, which the
// journal collects when the app is started from the desktop.
export const DEBUG = Boolean(GLib.getenv('READER_DEBUG'))

export const debug = DEBUG ? (...args) => console.log(...args) : () => {}

// For logging call arguments, which can be long (search results, layouts)
export const summarize = value => {
    const json = JSON.stringify(value) ?? ''
    return json.length > 200 ? `${json.slice(0, 200)}…` : json
}
