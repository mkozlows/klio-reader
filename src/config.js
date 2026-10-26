import GLib from 'gi://GLib?version=2.0'

export const APP_ID = 'org.klio.Reader'
export const APP_NAME = 'Klio Reader'
export const VERSION = '0.1.0'

// directory holding main.js, reader/ and foliate-js/ (source tree or install dir)
export const MODULE_DIR = GLib.path_get_dirname(
    GLib.filename_from_uri(import.meta.url)[0])
