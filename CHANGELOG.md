# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!-- Example:

## [9.99.999] - 9090-09-09

VS Code v99.99.999

### Changed
### Added
### Deprecated
### Removed
### Fixed
### Security

-->

## [Unreleased](https://github.com/cdr/code-server/releases)

VS Code v1.63.0

code-server has been rebased on upstream's newly open-sourced server
implementation (#4414).

### Changed

- Web socket compression has been made the default (when supported). This means
  the `--enable` flag will no longer take `permessage-deflate` as an option.
- Extra extension directories have been removed. The `--extra-extensions-dir`
  and `--extra-builtin-extensions-dir` will no longer be accepted.
- The `--install-source` and `--locale` flags have been removed.
- The static endpoint can no longer reach outside code-server. However the
  vscode-remote-resource endpoint still can.
- OpenVSX has been made the default marketplace. However this means web
  extensions like Vim are now broken.

## [3.12.0](https://github.com/cdr/code-server/releases/tag/v3.12.0) - 2021-09-15

VS Code v1.60.0

### Changed

- Upgrade VS Code to 1.60.0.

### Fixed

- Fix logout when using a base path (#3608).

## [3.11.1](https://github.com/cdr/code-server/releases/tag/v3.11.1) - 2021-08-06

Undocumented (see releases page).

## [3.11.0](https://github.com/cdr/code-server/releases/tag/v3.11.0) - 2021-06-14

Undocumented (see releases page).

## [3.10.2](https://github.com/cdr/code-server/releases/tag/v3.10.2) - 2021-05-21

VS Code v1.56.1

### Added

- Support `extraInitContainers` in helm chart values (#3393).

### Changed

- Change `extraContainers` to support templating in helm chart (#3393).

### Fixed

- Fix "Open Folder" on welcome page (#3437).

## [3.10.1](https://github.com/cdr/code-server/releases/tag/v3.10.1) - 2021-05-17

VS Code v1.56.1

### Fixed

- Check the logged user instead of $USER (#3330).
- Fix broken node_modules.asar symlink in npm package (#3355).
- Update cloud agent to fix version issue (#3342).

### Changed

- Use xdgBasedir.runtime instead of tmp (#3304).

## [3.10.0](https://github.com/cdr/code-server/releases/tag/v3.10.0) - 2021-05-10

VS Code v1.56.0

### Changed

- Update to VS Code 1.56.0 (#3269).
- Minor connections refactor (#3178). Improves connection stability.
- Use ptyHostService (#3308). This brings us closer to upstream VS Code.

### Added

- Add flag for toggling permessage-deflate (#3286). The default is off so
  compression will no longer be used by default. Use the --enable flag to
  toggle it back on.

### Fixed

- Make rate limiter not count against successful logins (#3141).
- Refactor logout (#3277). This fixes logging out in some scenarios.
- Make sure directories exist (#3309). This fixes some errors on startup.

### Security

- Update dependencies with CVEs (#3223).

## Previous versions

This was added with `3.10.0`, which means any previous versions are not
documented in the changelog.

To see those, please visit the [Releases page](https://github.com/cdr/code-server/releases).
