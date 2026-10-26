#!/usr/bin/env -S gjs -m
import GLib from 'gi://GLib?version=2.0'
import 'gi://Gtk?version=4.0'
import 'gi://Adw?version=1'
import 'gi://WebKit?version=6.0'
import { programInvocationName, programArgs, exit } from 'system'
import { setConsoleLogDomain } from 'console'

import { APP_ID, APP_NAME } from './config.js'

GLib.set_prgname(APP_ID)
GLib.set_application_name(APP_NAME)
setConsoleLogDomain(APP_ID)

const { Application } = await import('./application.js')
exit(await new Application().runAsync([programInvocationName, ...programArgs]))
