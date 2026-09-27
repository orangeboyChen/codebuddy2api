# Desktop App

Every release ships Electron desktop builds alongside the Docker image: macOS (Apple silicon and Intel), Windows, and Linux (x86_64 and arm64).

## What it is

The desktop app is an Electron window plus a backend for the console, and there are two to pick from: the gateway bundled into the same installer, or a deployment you already run.

- With the local backend, the main process starts the gateway — the same Next.js standalone server the Docker image runs — waits for `/health` to answer, and then opens the console window.
- The gateway listens on `127.0.0.1` only; it is never exposed to the LAN.
- With the local backend, the default port is `8001`, and it can be changed under Settings → Desktop app. When it is taken the app walks to the next free port.
- On macOS the gateway keeps running after the console window is closed, so `/v1/*` stays available; quitting the app stops it.
- There is only ever one window and one gateway: launching the app again, clicking the dock icon, or clicking the menu bar item just brings the open window forward.
- There is no sign-in: the console listens on loopback only, so the only processes that can open it are the ones already running as you on this machine. The login page and the Security settings are not shown in the desktop app.

## Backend

A first launch asks which backend to use, and the menu bar item's menu can change it later with Change backend…:

- **This machine**: starts the gateway bundled into the installer, keeps the data on this machine, and asks for no sign-in. This is the default.
- **A deployment I already run**: an `http://` or `https://` address. The app then starts no gateway of its own and opens that console instead — which may ask you to sign in. That deployment handles the sign-in; the desktop app stores no password of yours.

With a remote backend the menu shows its address instead of a port, Copy address copies it, and the port setting — which belongs to the local gateway — disappears from the settings page.

## Sign-in

A desktop install has no admin password. The gateway listens on `127.0.0.1` only, so a password would only lock you out of a console nobody else can reach — the trade-off is that any process on this machine can open it, which makes it a personal-device install.

Only a self-hosted deployment needs an admin password; `/admin-api/auth/setup` answers 404 in the desktop app.

## Menu bar status

On macOS a status item sits in the menu bar and shows today's token usage (input / output, refreshed every minute) beside the icon. Its menu shows which backend is in use and at which address, opens the console, copies the address, changes the backend, or quits the app. Windows and Linux get the same item in the tray, with the status and the usage in its tooltip and a click that opens the console.

The menu speaks the language the console is showing.

## Versions

The console's About tab shows the desktop version, and — when the backend is a deployment you run — that deployment's version, which may differ from the app's. With the bundled gateway there is no server version to show: that gateway is the app.

## Port

Change the port under Settings → Desktop app. Saving it restarts the gateway and takes the window to the new address. If the port is already taken the app moves to the next free one, and the menu bar shows the port actually in use.

`CODEBUDDY_DESKTOP_PORT` still works for an install that has never saved a port; once one is saved in the console, the saved value wins.

## Storage

The desktop app is fixed to SQLite: it serves this machine only, with no second process to share a database with, so there is nothing to choose between. `CODEBUDDY_STORAGE_BACKEND`, `DATABASE_URL` and `CODEBUDDY_STORAGE_PG_URL` are ignored, and the storage backend in the settings page is a disabled field.

It generates its own encryption key on first launch, so credentials and access keys are encrypted at rest. **Deleting `storage-encryption-key` makes already encrypted data unreadable** — the same contract as a self-hosted deployment, so back up the database together with the key.

## Where the data lives

Everything is written inside Electron's `userData` directory, not next to the installed bundle:

| Path                     | Contents                                                       |
| ------------------------ | -------------------------------------------------------------- |
| `data/`                  | File storage directory, and `storage.sqlite` by default        |
| `credentials/`           | CodeBuddy credential files                                     |
| `storage-encryption-key` | Storage encryption key generated on first launch (mode `0600`) |
| `desktop-settings.json`  | The app's own settings: the backend and the port               |

## Signing

The builds are not code-signed. On macOS, right-click the app and choose Open the first time; on Windows, dismiss the SmartScreen prompt with Run anyway.

## Building from source

```bash
bun install
bun run build
bun run desktop:prepare   # assemble the gateway, bundle the main process, rebuild better-sqlite3 for Electron
bun run desktop:dist      # the same, plus electron-builder packaging
```

Arguments after `desktop:dist` are forwarded to electron-builder, so a single target looks like this:

```bash
bun run desktop:dist -- --mac --arm64
```

Artifacts land in `build/desktop`. Native modules are compiled for the architecture of the machine that builds them, so an x86 Mac has to be built on an x86 Mac.
