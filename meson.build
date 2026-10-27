project('klio-reader',
  version: '0.3.1',
  meson_version: '>= 1.1.0',
  license: 'GPL-3.0-or-later',
  license_files: 'LICENSE',
)

app_id = 'org.klio.Reader'
gnome = import('gnome')

pkgdatadir = get_option('prefix') / get_option('datadir') / app_id

subdir('src')
subdir('data')

gnome.post_install(
  gtk_update_icon_cache: true,
  update_desktop_database: true,
)
