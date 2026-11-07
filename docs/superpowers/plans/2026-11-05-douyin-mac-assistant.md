# Mac Assistant Implementation Plan

**Goal:** Install a double-click application on this user's Apple Silicon Mac so pairing, browser login and execution do not require terminal commands.

**Architecture:** A local AppKit window embeds a loopback-only control panel. The application bundles the existing Node runtime, Playwright and Chromium. A controller reuses the existing device configuration, journal and execution queue. Service access is stored separately in a private user file, never inside the app or source.

**Scope decision:** The user explicitly requested direct setup. This installs a working application on the current Mac; a signed public DMG distribution is a separate task. Existing CLI remains available. No login, collection or send job starts automatically; login and running have separate buttons. QR login and any security challenge remain user actions.

## Tasks

- [x] Implement and test the non-interactive execution controller with existing journal locking and single-attempt semantics.
- [x] Implement and test local HTTP session, CSRF/Origin/Host restrictions and private pairing import.
- [x] Build the native launcher and install a bundle with Node, dependencies and the matching Chromium; place a desktop shortcut.
- [x] Store the existing site's access credential securely on this Mac, verify the app launch and UI, then hand off device pairing/QR login if user interaction is still needed.

## Verification

Use fake adapters for controller tests and loopback HTTP for authorization tests. Re-run existing browser fixtures. Verify the application from a path containing Chinese characters and spaces, with no reliance on the shell PATH or development browser cache. Do not send test messages to real people or silently execute queued jobs.

## Results

- Installed in `~/Applications/抖音获客助手.app` with a desktop shortcut. Node and Chromium are bundled; bundled Chromium launched successfully without using the development browser cache.
- Native window startup, local authenticated control panel, JSON file chooser and closing the window were verified. Closing the window exited its launcher and Node process and closed the local listening port.
- The current Mac routes the workbench through its existing system proxy. Native CFNetwork resolution now passes the matching static proxy to the child Node process with `--use-env-proxy`, excluding loopback addresses; no system network setting was changed.
- Private gateway access was verified against the business endpoint using an intentionally invalid device identity. The endpoint returned its JSON device-authentication rejection, confirming network and gateway access without claiming a real task.
- All 18 desktop/controller/server/native-proxy tests passed; targeted ESLint passed. The final full suite passed 547 tests with 5 opt-in browser fixtures skipped. The updated application was reopened and its child process proxy/bundled-browser configuration verified.
- First device pairing remains pending because browser automation of the workbench page timed out. The application is open at the pairing screen. The user needs to create/download one pairing configuration, import it with the button, then scan the Douyin QR code and explicitly start execution. No real account collection or message send was performed.
