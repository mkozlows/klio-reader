%global app_id org.klio.Reader

Name:           klio-reader
Version:        0.1.0
Release:        1%{?dist}
Summary:        Simple EPUB viewer for GNOME

# Klio Reader is GPL-3.0-or-later; the bundled foliate-js is MIT
License:        GPL-3.0-or-later AND MIT
URL:            https://github.com/mkozlows/klio-reader
Source0:        %{url}/releases/download/v%{version}/%{name}-%{version}.tar.xz

BuildArch:      noarch

BuildRequires:  meson
BuildRequires:  gjs
BuildRequires:  desktop-file-utils
BuildRequires:  appstream
# meson.build looks up the icon cache tool, though it doesn't run it here
BuildRequires:  /usr/bin/gtk4-update-icon-cache

# The app loads these through GObject introspection, so rpm can't detect them
Requires:       gjs
Requires:       gtk4 >= 4.10
Requires:       libadwaita >= 1.8
Requires:       webkitgtk6.0
Requires:       hicolor-icon-theme

Provides:       bundled(js-foliate-js)

%description
Klio Reader is a simple e-book viewer for GNOME. Open an EPUB file and
read it; there's no library to manage. It has paginated or continuous
scrolling layouts, a table of contents, footnote popups, find in book,
adjustable text, light and dark styles, and remembers where you left off.

%prep
%autosetup

%build
%meson
%meson_build

%install
%meson_install

%check
%meson_test

%files
%license LICENSE
%doc README.md
%{_bindir}/%{app_id}
%{_datadir}/%{app_id}/
%{_datadir}/applications/%{app_id}.desktop
%{_datadir}/metainfo/%{app_id}.metainfo.xml
%{_datadir}/icons/hicolor/scalable/apps/%{app_id}.svg
%{_datadir}/icons/hicolor/symbolic/apps/%{app_id}-symbolic.svg

%changelog
* Mon Oct 26 2026 Mike Kozlowski <mike@klio.org> - 0.1.0-1
- First release
