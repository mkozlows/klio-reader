gjs = find_program('gjs')

install_data(
  'main.js',
  'config.js',
  'application.js',
  'window.js',
  'book-view.js',
  'toc-view.js',
  'state.js',
  'preferences.js',
  'share-image.js',
  'image-view.js',
  'log.js',
  install_dir: pkgdatadir,
)

install_subdir('reader', install_dir: pkgdatadir)

# Only what's needed to render books: no tests, demo UI, or PDF support
install_subdir('foliate-js',
  install_dir: pkgdatadir,
  exclude_directories: ['.github', 'tests', 'rollup', 'ui', 'vendor/pdfjs'],
  exclude_files: [
    '.git', '.gitignore', '.gitattributes', 'README.md',
    'package.json', 'package-lock.json', 'eslint.config.js', 'rollup.config.js',
    'reader.html', 'reader.js', 'pdf.js', 'opds.js', 'uri-template.js',
    'quote-image.js', 'dict.js',
  ],
)

configure_file(
  input: 'launcher.js.in',
  output: app_id,
  configuration: {
    'GJS': gjs.full_path(),
    'PKGDATADIR': pkgdatadir,
  },
  install: true,
  install_dir: get_option('bindir'),
  install_mode: 'rwxr-xr-x',
)
