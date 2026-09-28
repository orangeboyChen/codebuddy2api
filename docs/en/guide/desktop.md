# Desktop App

Every release ships Electron desktop builds alongside the Docker image: macOS (Apple silicon and Intel), Windows, and Linux (x86_64 and arm64).

## What it is

The desktop app is an Electron window plus a backend for the console. What the window renders is always the copy bundled into the installer; the backend only decides where the data comes from — the gateway bundled into the same installer, or a deployment you already run.

- With the local backend, the main process starts the gateway — the same Next.js standalone server the Docker image runs — waits for `/health` to answer, and then opens the console window.
- The gateway listens on `127.0.0.1` only; it is never exposed to the LAN.
- With the local backend, the default port is `8001`, and it can be changed in the dialog a first launch asks in or under Settings → Desktop app. Once a port has been settled — saved here, or named with `CODEBUDDY_DESKTOP_PORT` — a taken one is not swapped for another: the app asks which port to use.
- On macOS the gateway keeps running after the console window is closed, so `/v1/*` stays available; quitting the app stops it.
- There is only ever one window and one gateway: launching the app again, or clicking the menu bar item, just brings the open window forward. On macOS there is no dock icon at all — the menu bar item is the only way in.
- There is no sign-in while the backend is this machine: the console listens on loopback only, so the only processes that can open it are the ones already running as you on this machine. No login page, and no Security settings. With a deployment as the backend both come back — see below.

## Backend

A first launch asks which backend to use — and which port to serve on — in a dialog of the computer's own: AppKit's on macOS, a WinForms form on Windows, the one zenity draws on Linux. Nothing on the screen is drawn by this app, so it is the appearance the desktop is in, the buttons its other dialogs use, and the language the console is showing. The menu bar item's menu can change both later with Settings…. An answer that never came quits the app: the gateway is the thing the answer decides, and starting one nobody chose is not an answer. A machine with no desktop to draw a dialog on — a headless session, a test run — asks in the app's own window instead: `CODEBUDDY_DESKTOP_ASK=window`.

- **This machine**: starts the gateway bundled into the installer, keeps the data on this machine, and asks for no sign-in. This is the default.
- **A deployment I already run**: an `http://` or `https://` address. The app still starts its own gateway to render the console, and forwards `/admin-api/*` and `/v1/*` to that deployment — so what appears in the window is always the console this app shipped, never a page that deployment answered with. The address is probed at `/health` first, to confirm it really is a CodeBuddy2API deployment; when it is not, a window says which it was (nothing answered, or something that is not this app) and offers to try again, to change the backend, or to open it in the browser. That deployment handles the sign-in; the desktop app stores no password of yours.
- With the network down, or the address wrong, the app does not open an empty window: it opens that window, saying why.

With a remote backend the menu names its address in the Backend row; Copy address copies the local console's address, which works as an API endpoint too because `/v1/*` is forwarded. The port setting — which belongs to the local gateway — disappears from the settings page.

## Sign-in

A desktop install has no admin password. The gateway listens on `127.0.0.1` only, so a password would only lock you out of a console nobody else can reach — the trade-off is that any process on this machine can open it, which makes it a personal-device install.

Only a self-hosted deployment needs an admin password; `/admin-api/auth/setup` answers 404 in the desktop app.

With a deployment as the backend, the sign-in page and the password are that deployment's. Typing the password in the app works: it is sent to the deployment, whose session cookie the console then keeps.

A passkey saved for the deployment cannot be used from the app, and neither can the passwords your browser or your system saved for it: both belong to the deployment's address, while this console is served from `127.0.0.1` — a browser only offers a credential for the origin it is on, and it would not match the rpId the deployment was configured with anyway. The sign-in page says so instead of offering a button that would fail, and links to the deployment's own page; following that link opens it in your browser, where the passkey and the saved passwords do work.

## Menu bar status

On macOS a status item sits in the menu bar and shows today's token usage (input / output, refreshed every minute) beside the icon. Its menu shows which backend is in use and at which address, opens the console, copies the address, opens the window that settles the backend and the port, or quits the app. Windows and Linux get the same item in the tray, with the status and the usage in its tooltip and a click that opens the console.

The menu speaks the language the console is showing.

## Versions and updates

The bottom of the menu lists the desktop version, and — when the backend is a deployment you run — that deployment's version, which may differ from the app's. With the bundled gateway there is no server version to list: that gateway is the app.

An item at the bottom of the same menu — **CodeBuddy2API on GitHub** — opens the project's repository in the browser.

Check for updates… in the same menu asks GitHub for the newest release. When there is one it asks before doing anything, then downloads the installer built for this machine and hands it to the system to open: a disk image to mount on macOS, a setup program on Windows, an AppImage on Linux. A release with no build for this computer opens the releases page instead so you can pick one yourself. Nothing is replaced in the background.

## Port

Change the port in the dialog a first launch asks in, or under Settings → Desktop app. Saving it restarts the gateway and takes the window to the new address. A port that has been saved or named is never swapped for another one on its own: when it is taken the app asks, in the same dialog, which port to use instead — or for whatever is holding it to be stopped, and then Try again. The menu bar says which port is taken until it is settled. An install that has saved nothing yet walks upwards instead, so it still works next to a deployment already serving 8001.

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

The macOS builds in a release are signed and notarized, so the dmg opens on a double-click. On Windows, dismiss the SmartScreen prompt with Run anyway.

If macOS says the app is damaged and cannot be opened, drag it into `Applications` and run:

```sh
xattr -cr /Applications/CodeBuddy2API.app
```
