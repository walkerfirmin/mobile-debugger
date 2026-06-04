# dump-console-logs

A small CLI (`dump-logs`) that captures **deep, fully-serialised** DevTools
console logs from **Android and iOS** Capacitor WebViews — including the main
app WebView and any **in-app-browser (IAB)** WebView — and, optionally, the
host app's **native** device logs (Android `logcat` / iOS `os_log`). Everything
is written to **NDJSON** plus a **self-contained HTML viewer**.

> **iOS support** bridges WebKit's Web Inspector protocol to Chrome DevTools
> Protocol via [`ios-webkit-debug-proxy`](https://github.com/google/ios-webkit-debug-proxy),
> so the same capture pipeline works on both platforms. Both physical devices
> and the iOS Simulator are supported. See [Prerequisites](#prerequisites).

---

## Why this exists

Chrome DevTools' "Save as…" on the Console panel saves only the *rendered
text*. Object previews are lazy and lose fidelity once the page navigates or
the inspector closes. None of the "More tools" panels (Performance monitor,
Memory inspector, Recorder, etc.) provide a deep object dump either.

`dump-logs` solves that by speaking CDP directly:

- **Page-side `console` shim** wraps every `console.*` call and emits a
  pre-serialised JSON payload that handles circular refs, `Error`+`cause`,
  `Map`/`Set`, `Date`, `RegExp`, `BigInt`, `Symbol`, `Function`, DOM nodes,
  `TypedArray`s, and `Promise`s, with depth/length/entry caps.
- **CDP fallback expander** uses `Runtime.getProperties` recursively (with
  cycle guard and `releaseObject` cleanup) for events that fire before the
  shim is active or where the shim cannot be installed.
- **Auto-attach** to any new page target that appears, so logs from the
  in-app-browser WebView are captured automatically.
- **Native log capture** (opt-in via `--native`) streams the host app's
  platform logs alongside the WebView console: Android `adb logcat` and iOS
  `os_log` (`xcrun simctl log stream` for simulators, `idevicesyslog` for
  devices). Native records share the same NDJSON file and viewer, tagged with
  `channel: "native"`.

---

## Prerequisites

- **Node.js ≥ 18.17**

**Android**

- **`adb`** on `PATH` (Android Platform Tools)
- An Android device with **USB debugging** enabled and authorised, OR
  an Android emulator running
- The Capacitor app must be **debuggable** — debug builds enable
  `WebView.setWebContentsDebuggingEnabled(true)` automatically; release
  builds do not. To force-enable for a release build, add this to your
  app's `MainActivity` (or any early-init code) and rebuild:

  ```kotlin
  if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)
  ```

**iOS**

- **`ios-webkit-debug-proxy`** on `PATH` for WebView (web) capture
  (`brew install ios-webkit-debug-proxy`).
- **Xcode Command Line Tools** (`xcode-select --install`) for the iOS
  Simulator and `xcrun simctl` native logs.
- **`libimobiledevice`** (`brew install libimobiledevice`) for physical
  devices — provides `idevice_id` and `idevicesyslog`.
- The WebView must be **inspectable**. On iOS 16.4+ this means
  `WKWebView.isInspectable = true` (Capacitor debug builds set this) **and**
  enabling *Settings ▸ Safari ▸ Advanced ▸ Web Inspector* on the device. This
  is the iOS analogue of Android's `setWebContentsDebuggingEnabled`.

---

## Install

```sh
git clone <this repo>
cd dump-console-logs
npm install
npm run build
npm link        # exposes `dump-logs` globally
```

You can also run without linking via `node dist/cli.js …` or
`npm run dev -- …` (uses `tsx`).

---

## Quick start

```sh
# Android
adb devices                                    # confirm device
dump-logs targets                              # list WebView sockets + page targets
dump-logs live --target all --out ./logs       # live tail (Ctrl-C to stop)
dump-logs live --target all --native           # also stream native logcat
# or:
dump-logs dump --duration 30s --out ./logs     # fixed-window capture

# iOS (simulator or paired device)
dump-logs targets --platform ios                       # list devices/sims + targets
dump-logs live --platform ios --target all             # WebView console logs
dump-logs live --platform ios --native --bundle-id com.example.app
open ./logs/session-*.html                     # open the viewer
```

---

## Testing on iOS Simulator

### Testing a Hybrid App with WebView (com.standard.shell.app)

To capture both **WebView console logs** and **native device logs** from the iOS simulator:

#### Prerequisites

1. Ensure the iOS simulator is running:
   ```sh
   # Check for booted simulators
   xcrun simctl list | grep Booted
   ```

2. Ensure `ios-webkit-debug-proxy` is installed:
   ```sh
   brew install ios-webkit-debug-proxy
   ```

3. **For WebView capture**, the app must have an inspectable WebView:
   - In your app code (e.g., `AppDelegate.swift`), set:
     ```swift
     WKWebView.isInspectable = true  // iOS 16.4+
     ```
   - On the simulator, enable *Settings ▸ Safari ▸ Advanced ▸ Web Inspector* (if available)
   - Without these steps, WebView capture will fail but native logs will still work.

#### Capturing native logs only (recommended for native apps)

Native logs capture `os_log` output from the app and system, useful when the app doesn't expose a WebView or it's not inspectable:

```sh
# Start capture of all iOS native logs (no WebView)
node dist/cli.js dump --platform ios --env simulator --no-web --native \
  --duration 15s --out ./logs

# If the app has a bundle-id filter (optional):
node dist/cli.js dump --platform ios --env simulator --no-web --native \
  --bundle-id com.standard.shell.app --duration 15s --out ./logs
```

**Note:** The `--bundle-id` filter may not exclude system logs; to see only app-related logs, review the output and filter in the HTML viewer or post-process the NDJSON.

#### Capturing WebView + native logs together

If the app is a Capacitor hybrid app with an inspectable WebView:

```sh
# Live tail (Ctrl-C to stop)
node dist/cli.js live --platform ios --env simulator --target all --native \
  --bundle-id com.standard.shell.app

# Fixed 30-second capture
node dist/cli.js dump --platform ios --env simulator --target all --native \
  --bundle-id com.standard.shell.app --duration 30s --out ./logs
```

#### View captured logs

Open the generated HTML viewer in your browser:

```sh
# View the latest session
open ./logs/session-*.html
```

The viewer allows you to:
- Filter by level (log, info, warn, error, debug, etc.)
- Filter by source (console, log, exception, native)
- Filter by channel (web, native)
- Search across all log entries
- Expand JSON tree for any record

---

## Commands

### `dump-logs targets`

List connected devices (Android via ADB, iOS via libimobiledevice / `simctl`),
and the CDP page targets reachable on the first WebView endpoint.

```sh
dump-logs targets                              # Android (default)
dump-logs targets -d emulator-5554
dump-logs targets --platform ios               # iOS device + simulator
dump-logs targets --platform ios --env simulator
```

| Option | Default | Description |
| --- | --- | --- |
| `-p, --platform <name>` | `android` | `android` or `ios`. |
| `-d, --device <id>` | first device | ADB serial (Android) or device/simulator UDID (iOS). |
| `--env <which>` | `auto` | iOS only: `device`, `simulator`, or `auto`. |

Sample output:

```
Devices:
  emulator-5554 device

WebView sockets:
  pid=1781        webview_devtools_remote_1781

Targets on webview_devtools_remote_1781:
  33B1467F29B1CF92C0B7472FEA844A85  page  The Standard  https://localhost/login
```

If you see `(none — make sure the app was built in debug…)`, the app is not
debuggable from CDP — see [Prerequisites](#prerequisites) above.

---

### `dump-logs live`

Attach to one or more page targets and stream logs to stdout (and NDJSON +
viewer files) until you press **Ctrl-C**.

```sh
dump-logs live --target all
dump-logs live --target main --out ./logs --redact 'authorization|password|token'
dump-logs live --pid 1781 --depth 20 --max-string 50000
```

### `dump-logs dump`

Like `live`, but exits after a fixed duration. Convenient for scripted bug
repros.

```sh
dump-logs dump --duration 30s
dump-logs dump --duration 2m --target all --out ./logs --no-tty
dump-logs dump --duration 5000ms --redact 'Bearer\s+\S+'
```

| Option | Default | Description |
| --- | --- | --- |
| `--duration <d>` | `30s` | Capture window. Accepts `<n>ms`, `<n>s`, `<n>m`. |

The remaining flags are shared between `live` and `dump`:

#### Common capture flags

| Flag | Default | Description |
| --- | --- | --- |
| `-p, --platform <name>` | `android` | `android` or `ios`. Selects the device backend. |
| `-d, --device <id>` | first device | ADB serial (Android) or device/simulator UDID (iOS). Required when more than one target is connected. |
| `--env <which>` | `auto` | iOS only: `device`, `simulator`, or `auto`. |
| `--pid <pid>` | first WebView | Android: PID of the WebView host process. Use when multiple apps are debuggable. |
| `--port <port>` | — | Use an already-forwarded/proxied local TCP port. Skips `adb forward` / `ios-webkit-debug-proxy`. |
| `--no-web` | web on | Disable WebView (web) console capture (e.g. native-only runs). |
| `--native` | off | Also capture native device logs (Android `logcat` / iOS `os_log`). |
| `--bundle-id <id>` | — | Native filter: app bundle id (iOS) / package name (Android). |
| `--process <name>` | — | Native filter: process name. |
| `-t, --target <which>` | `all` | `main` = first page only · `all` = every page (incl. IAB) · `<targetId>` = a specific id from `dump-logs targets`. |
| `-o, --out <dir>` | `./logs` | Output directory (created if missing). |
| `--depth <n>` | `10` | Max object nesting depth before values are summarised as `…`. |
| `--max-string <n>` | `10000` | Strings longer than this are truncated and tagged with their original length. |
| `--max-entries <n>` | `200` | Max entries per array / object / `Map` / `Set`. |
| `--no-inject` | inject on | Disable the page-side `console` shim; rely on CDP expansion only. Useful if a CSP blocks `eval` (the shim is installed via `Runtime.evaluate`). |
| `--network` | off | Also enable the CDP `Network` domain. (Headers/URLs only — bodies are not captured.) |
| `--redact <regex>` | — | JS regex; matches inside serialised strings are replaced with `***`. Applied recursively to every string field. Example: `--redact 'authorization|cookie|password'`. |
| `--no-tty` | tty on | Disable pretty-printed live tail to stdout (NDJSON file is still written). Useful when piping to another process. |

> **Re-using a forwarded port.** If you already ran `adb forward tcp:9222
> localabstract:webview_devtools_remote_<pid>`, pass `--port 9222` and
> `dump-logs` will skip the forward step and use it directly. The forward
> is left intact on exit.

---

## Output

Each `live` / `dump` run writes two files into `--out`:

```
logs/
├── session-<ISO>.ndjson      # one record per line
└── session-<ISO>.html        # self-contained viewer (open in any browser)
```

If no records are captured (e.g. the app didn't log during the window) the
empty NDJSON is removed and a warning is printed instead of leaving 0-byte
artifacts.

### NDJSON record schema

Every line is a JSON object with these fields:

| Field | Type | Description |
| --- | --- | --- |
| `ts` | `string` (ISO-8601) | When the event was observed. |
| `targetId` | `string` | CDP target id (page id from `/json/list`). |
| `targetLabel` | `string` | Friendly label: `main` or `iab:1`, `iab:2`, … |
| `url` | `string` | URL of the page target at capture time. |
| `level` | `string` | `log`, `info`, `warn`, `error`, `debug`, `trace`, `dir`, `groupCollapsed`, `groupEnd`, `timeEnd`, `assert`, … |
| `source` | `string` | `console` (from `Runtime.consoleAPICalled` / shim) · `log` (from `Log.entryAdded`, e.g. network errors, deprecation warnings) · `exception` (from `Runtime.exceptionThrown`) · `native` (device log from `logcat` / `os_log`). |
| `platform` | `string?` | `android` or `ios` (when known). |
| `channel` | `string?` | `web` (WebView console) or `native` (device log). |
| `args` | `SerializedValue[]` | Pre-serialised arguments. See below. |
| `stack` | `string?` | Pretty-printed call stack (top frame first). |
| `executionContextId` | `number?` | CDP execution context id. |

Each `SerializedValue` is one of:

```jsonc
{ "t": "string",   "value": "hello"      }
{ "t": "number",   "value": 42           }
{ "t": "boolean",  "value": true         }
{ "t": "null"  }
{ "t": "undefined" }
{ "t": "bigint",   "value": "12345"      }
{ "t": "symbol",   "description": "Symbol(foo)" }
{ "t": "function", "name": "myFn", "src": "function myFn(){…}" }
{ "t": "date",     "iso": "2026-06-04T01:02:03Z" }
{ "t": "regexp",   "src": "/abc/gi"      }
{ "t": "error",    "name": "TypeError", "message": "…", "stack": "…", "cause": SerializedValue? }
{ "t": "array",    "values": SerializedValue[], "truncated": true? }
{ "t": "object",   "ctor": "Foo", "entries": [[key, SerializedValue], …] }
{ "t": "map",      "entries": [[SerializedValue, SerializedValue], …] }
{ "t": "set",      "values": SerializedValue[] }
{ "t": "node",     "tag": "DIV", "id": "...", "classes": ["..."], "html": "<div …>" }
{ "t": "typedarray", "ctor": "Uint8Array", "length": 1024, "preview": [1,2,3,…] }
{ "t": "promise",  "state": "pending|fulfilled|rejected", "value": SerializedValue? }
{ "t": "circular", "ref": "$.path.to.value" }
{ "t": "truncated-string", "value": "…", "originalLength": 12345 }
```

### HTML viewer

Open `session-<ISO>.html` in any browser (offline — no CDN). The viewer
gives you:

- Level filter (multi-select).
- Target filter (`main`, `iab:1`, …).
- Source filter (`console`, `log`, `exception`, `native`).
- Platform filter (`android`, `ios`).
- Channel filter (`web`, `native`).
- Free-text search across stringified args.
- Expandable JSON tree per record.
- Per-row "copy as JSON" button.

The viewer is built by inlining the NDJSON into the page; the file is fully
self-contained.

---

## Examples

### Capture all WebViews while reproducing a bug

```sh
dump-logs dump --duration 60s --target all --out ./bug-1234 \
  --depth 20 --max-string 50000 --network
# … reproduce the bug in the app …
# Then attach ./bug-1234/session-*.html to the bug ticket.
```

### Live tail only errors / warnings

```sh
dump-logs live --no-tty | grep -E '"level":"(error|warn)"'
```

### Pipe to `jq` for ad-hoc analysis

```sh
cat logs/session-*.ndjson | jq -c 'select(.level=="error") | {ts,url,args}'
```

### Redact secrets before sharing

```sh
dump-logs dump --duration 30s \
  --redact 'authorization|cookie|password|token|Bearer\s+\S+'
```

### Use an already-forwarded port

```sh
adb forward tcp:9222 localabstract:webview_devtools_remote_$(adb shell pidof com.example.app)
dump-logs live --port 9222 --target all
```

### Capture iOS WebView + native logs together

```sh
# Simulator (auto-detected) — web console + os_log, filtered to the app.
dump-logs live --platform ios --target all --native --bundle-id com.example.app

# Physical device — pass the UDID when more than one is connected.
dump-logs dump --platform ios --env device -d <udid> --duration 60s --native
```

---

## Troubleshooting

**`No WebView sockets found.`**
The app isn't exposing a DevTools socket. Either it's a release build
without `WebView.setWebContentsDebuggingEnabled(true)`, or no Capacitor
WebView is currently alive. Re-launch the app and try again.

**`socket hang up` / `Empty reply from server`.**
Android System WebView's embedded DevTools HTTP server only serves **one
HTTP request per TCP connection** and mishandles keep-alive. `dump-logs`
already works around this (bare `http.request` with `agent: false` and
`Connection: close`, plus `local: true` to skip `/json/protocol`). If you
still hit this, you almost certainly have **another DevTools client
attached** — Chrome on `chrome://inspect`, another `dump-logs` instance, a
puppeteer/playwright session, etc. **Only one DevTools client per WebView**
is allowed; close the others and retry.

**`giving up on /json/list polling`.**
After 5 consecutive HTTP failures the polling loop exits cleanly to avoid
infinite spam. Causes: the app crashed, the WebView was destroyed, USB
disconnected, or another inspector grabbed the socket. Re-launch and
re-run.

**No records captured.**
The app didn't log anything during the window. Try `--target all` to
include the IAB, increase `--duration`, or trigger an action in the app
that you know logs.

**Logs missing for a brief navigation.**
CDP cannot retrieve console events that fired *before* the debugger
attached. Start `dump-logs` *before* you reproduce the issue.

**Page CSP blocks the shim.**
A strict `Content-Security-Policy` can block `Runtime.evaluate` (used to
install the shim). Pass `--no-inject` to fall back to the CDP expander
only — slightly less rich serialisation but works under any CSP.

**iOS / Safari.**
iOS WebViews are supported via `ios-webkit-debug-proxy` (see
[Prerequisites](#prerequisites)). If `dump-logs targets --platform ios` shows
no page targets, confirm the proxy is installed, the WebView is inspectable
(`WKWebView.isInspectable` + *Settings ▸ Safari ▸ Advanced ▸ Web Inspector*),
and — for physical devices — that the device is paired (`idevice_id -l`).

**`ios-webkit-debug-proxy did not become ready on port …`**
This error occurs when WebView capture fails. Common causes:
1. **Native-only app:** The app doesn't have an inspectable WebView. Use
   `--no-web --native` to capture native logs instead.
2. **WebView not inspectable:** Ensure `WKWebView.isInspectable = true` in
   the app code and *Settings ▸ Safari ▸ Advanced ▸ Web Inspector* is
   enabled on the simulator.
3. **No WebView alive:** The app may have crashed or not created a WebView
   during startup. Re-launch the app and try again.
4. **Another debugger attached:** Close Safari Web Inspector or other
   DevTools clients on the device/simulator.

**Native logs not appearing (iOS).**
If `--native` captures device logs but your app isn't in the output:
- The app may not be logging to `os_log`. Add explicit `print()` or
  `NSLog()` calls in your Swift/Objective-C code.
- Without a `--bundle-id` or `--process` filter, you'll see *all* system
  logs (DTServiceHub, gamecontrollerd, etc.). Use the HTML viewer's
  search/filter to find app-specific entries.
- On simulators, `--bundle-id` filtering works better if the app is actively
  running. Launch it just before running the capture.

---

## Architecture

```
        Android device (debug)                 iOS device / simulator
   ┌──────────────────────────┐          ┌──────────────────────────┐
   │ Capacitor / IAB WebView  │          │ Capacitor / IAB WebView  │
   │  localabstract: webview_…│          │  WebKit Web Inspector    │
   └───────────┬──────────────┘          └───────────┬──────────────┘
        adb forward                        ios-webkit-debug-proxy
               ▼                                       ▼
        127.0.0.1:<port>  /json/list           127.0.0.1:<port>  /json
               └───────────────────┬───────────────────┘
                                   ▼
   ┌───────────────────────────────────────────────────────────┐
   │  src/platform.ts        acquire local CDP endpoint        │
   │  src/cdp/http.ts        bare http.request, no keep-alive  │
   │  src/cdp/connect.ts     poll target list, attach per page │
   │  src/cdp/capture.ts     enable Runtime/Log/Page domains   │
   │  src/cdp/expand.ts      Runtime.getProperties fallback    │
   │  src/inject/console-shim.ts   page-side serialiser        │
   │  src/native/*.ts        logcat / os_log streamers         │
   │  src/output/ndjson.ts   append + fsync NDJSON             │
   │  src/output/viewer.ts   build self-contained HTML         │
   │  src/output/tty.ts      colourised one-line live tail     │
   │  src/cli.ts             commander wiring                  │
   └───────────────────────────────────────────────────────────┘
```

---

## Development

```sh
npm run dev -- targets        # run TS via tsx
npm run typecheck             # tsc --noEmit
npm test                      # vitest
npm run build                 # emit dist/
```

### Layout

```
src/
├── cli.ts                  # commander entrypoint
├── adb.ts                  # Android: device list, /proc/net/unix parsing, forward
├── platform.ts            # acquire a local CDP endpoint (Android + iOS)
├── ios/
│   ├── devices.ts          # iOS device / simulator discovery
│   └── iwdp.ts             # ios-webkit-debug-proxy bridge
├── cdp/
│   ├── http.ts             # no-keep-alive HTTP for Android WebView
│   ├── connect.ts          # target-list polling + auto-attach
│   ├── capture.ts          # per-target session
│   └── expand.ts           # Runtime.getProperties walker
├── inject/
│   ├── console-shim.ts     # page-side IIFE
│   └── parse-marker.ts     # decode shim marker
├── native/
│   ├── streamer.ts         # native line → LogRecord
│   ├── android-logcat.ts   # adb logcat streamer + parser
│   └── ios-syslog.ts       # simctl / idevicesyslog streamer + parser
└── output/
    ├── ndjson.ts
    ├── viewer.ts
    └── tty.ts

viewer/
└── template.html           # __NDJSON__ placeholder

test/
├── shim.test.ts
├── expand.test.ts
├── parse-marker.test.ts
├── android-logcat.test.ts
├── ios-syslog.test.ts
└── ndjson-viewer.test.ts
```

---

## Known limitations

- **No pre-attach buffer.** CDP cannot retrieve events that fired before the
  debugger attached. `dump --duration` is "capture for N seconds and exit",
  not "scrape the existing buffer."
- **Single DevTools client per WebView.** Android WebView allows exactly one
  CDP client. Close `chrome://inspect` and other tools before running.
- **No native bridge bytecode.** Capacitor plugin events that never go
  through `console.*` are not visible. Add `console.debug(...)` from JS if
  you want them captured.
- **No request/response bodies.** `--network` enables the `Network` domain
  for URLs/headers/timings but does not stream bodies.
- **iOS web capture needs `ios-webkit-debug-proxy`.** iOS WebViews speak the
  WebKit Web Inspector protocol; the proxy bridges it to CDP. It must be on
  `PATH`. Physical-device native logs additionally need `libimobiledevice`.

---

## Licence

ISC.
