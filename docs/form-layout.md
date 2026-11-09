# Existing form layout

Both desktop renderers share `packages/workbench/src/styles/desktop.css`.
Modal captions use an explicit line height so Latin captions (Client ID) and
Chinese captions above equal-width fields produce the same input top. Existing
36px inputs, weighted protocol/host/port columns, switches, schedule controls,
editors and values retain their contracts.

Run from the repository root:

```sh
npx playwright test -c packages/workbench/playwright.form-layout.config.js
npm run lint
npm run build:renderers
```

The form suite uses isolated preview adapters at both renderer entries in
Chromium and WebKit. Each entry/engine runs all 16 combinations of light/dark,
normal/large font, expanded/collapsed sidebar and 1440×900 / 920×620 viewport.
It measures field edges, full-width fill, equal-width same-row input tops and
heights within 1px, dialog bounds/footer, settings, subscription and composer
schedule controls, including a host-validation error. Screenshots and JSON
measurements use Playwright's configurable output directory.

The matrix also opens the existing connection editor and copy-subscription
dialog. Modal row comparisons use their actual `.modal__row` membership, so
protocol/host/port columns with different widths are checked even after a
validation message changes a field's height.

The collapsed connection dialog is a background-state fixture: the new action
is in the expanded sidebar, so the test opens the dialog then invokes the
existing collapse handler underneath it. No native window behavior is implied.
The current connection dialog has credentials and keepalive; it has no TLS
certificate, will or separate advanced form. The subscription dialog exposes
QoS and message format, without a separate advanced form.

920×620 is a browser stress viewport below the actual 1120×720 native main-window
minimum. Browser evidence does not constitute native Electron/Tauri, installed
package, Windows or Linux verification.

## Focused scroll and focus regression

The additional `focused scroll narrow large form reachability` case exercises
920×620 dark/large forms using real scrolling and focused elements. Run only this
case at both WebKit renderer entries with:

```sh
npx playwright test -c packages/workbench/playwright.form-layout.config.js --project=electron-webkit --project=tauri-webkit --grep 'focused scroll narrow'
```

It records actual scroll offsets, control/scroll-viewport bounds and screenshots.
Modal footer actions are reached with Tab; the normal workbench bottom action is
focused directly without imposing a modal focus trap on the workbench.
