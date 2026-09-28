# Desktop App

Every release ships Electron desktop builds alongside the Docker image: macOS (Apple silicon and Intel), Windows, and Linux (x86_64 and arm64).

## What it is

The desktop app is an Electron window plus a backend for the console. What the window renders is always the copy bundled into the installer; the backend only decides where the data comes from — the gateway bundled into the same installer, or a deployment you already run.

- With the local backend, the main process starts the gateway — the same Next.js standalone server the Docker image runs — waits for `/health` to answer, and then opens the console window.
- The gateway listens on `127.0.0.1` only; it is never exposed to the LAN.
- With the local backend, the default port is `8001`, and it can be changed in the dialog a first launch asks in, in the menu's Settings…, or under Settings → Desktop app. Naming a deployment instead asks for its address alone: the port it is served on keeps its current value. Once a port has been settled — saved here, or named with `CODEBUDDY_DESKTOP_PORT` — a taken one is not swapped for another: the app asks which port to use.
- On macOS the gateway keeps running after the console window is closed, so `/v1/*` stays available; quitting the app stops it.
- There is only ever one window and one gateway: launching the app again, or clicking the menu bar item, just brings the open window forward. On macOS the app keeps its dock icon, so the console is one window among the rest: it comes back from the dock or from Cmd+Tab as well as from the menu bar item.
- There is no sign-in while the backend is this machine: the console listens on loopback, and is served to the app's own window. No login page, and no Security settings. With a deployment as the backend both come back — see below.
- The console is served to the app's own window: the shell makes up a token when it starts, hands it to the gateway through the environment and to the window as a cookie, and anything else — a browser, a script — is answered 404 at `127.0.0.1`. `/v1/*` and `/health` are left out of it, being what the gateway runs for.

## Backend

A first launch asks which backend to use in a dialog of the computer's own: AppKit's on macOS, a WinForms form on Windows, the one zenity draws on Linux. The port belongs to this machine's gateway, so it is part of the question only when this machine is the answer — a deployment is reached through its address, and the number the console is served on stays the one already saved. Nothing on the screen is drawn by this app, so it is the appearance the desktop is in, the buttons its other dialogs use, and the language the console is showing. The menu bar item's menu can change both later with Settings…. An answer that never came quits the app: the gateway is the thing the answer decides, and starting one nobody chose is not an answer. A computer with no dialog of its own to ask in — a headless session — is told so in one of its own message boxes rather than in a page this app drew; on a first launch it quits. `CODEBUDDY_DESKTOP_ASK=window` asks in the app's own window instead, which is what the test suite needs, since a native dialog is nothing a test can click.

- **This machine**: starts the gateway bundled into the installer, keeps the data on this machine, and asks for no sign-in. This is the default.
- **A deployment I already run**: an `http://` or `https://` address. The app still starts its own gateway to render the console, and forwards `/admin-api/*` and `/v1/*` to that deployment — so what appears in the window is always the console this app shipped, never a page that deployment answered with. The address is probed at `/health` first, to confirm it really is a CodeBuddy2API deployment; when it is not, a window says which it was (nothing answered, or something that is not this app) and offers to try again, to change the backend, or to open it in the browser. That deployment handles the sign-in; the desktop app stores no password of yours.
- With the network down, or the address wrong, the app does not open an empty window: it opens that window, saying why.

With a remote backend the menu names its address in the Backend row; Copy address copies the local console's address, which works as an API endpoint too because `/v1/*` is forwarded. The port is the one this machine's gateway serves the console on, so it stays editable whichever backend is in use.

## Settings

Settings… in the menu bar item's menu opens one dialog of the computer's own, with the computer's own tabs in it: AppKit's tab view, inside the alert AppKit draws, on macOS; a WinForms `TabControl` on Windows. Both are the control every other dialog on that computer uses, in the appearance the desktop is in, with the buttons its other dialogs use and the language the console is showing: nothing on the screen is drawn by this app. On Linux zenity has no tab control to offer, so the sections are chosen from a list and the chosen one is asked in the dialogs zenity does have, a section that only says things being shown as one of its message boxes.

The three tabs:

- **General**: the same question a first launch asks — this machine or a deployment you already run, and the port this machine's gateway serves the console on. When the last answer could not be used — an address that is not one, say — that is said at the top of this tab.
- **Data**: with the local backend, the paths of the data folder and of the database file, and below them a link that opens that folder in whatever file manager this desktop uses, without closing the dialog. With a remote backend the data is on that deployment, so this tab says so and names where.
- **About**: the app's version, the backend in use (and, when it is a deployment, that deployment's version), and a link to the project's repository, which opens it in the browser. That is why the menu carries no GitHub row of its own.

Nothing is written until Save is pressed, and saving a new backend or port restarts the gateway and takes the window to the new address; Cancel changes nothing. Under `CODEBUDDY_DESKTOP_ASK=window` the question is asked in the app's own window instead, which is what the test suite needs, since a native dialog is nothing a test can click.

## Sign-in

A desktop install has no admin password. The gateway listens on `127.0.0.1`, and the console is served to the app's own window, so a password would only lock you out of a console nobody else can reach.

Only a self-hosted deployment needs an admin password; `/admin-api/auth/setup` answers 404 in the desktop app.

With a deployment as the backend, the sign-in page and the password are that deployment's. Typing the password in the app works: it is sent to the deployment, whose session cookie the console then keeps.

A passkey saved for the deployment cannot be used from the app, and neither can the passwords your browser or your system saved for it: both belong to the deployment's address, while this console is served from `127.0.0.1` — a browser only offers a credential for the origin it is on, and it would not match the rpId the deployment was configured with anyway. The sign-in page says so instead of offering a button that would fail, and links to the deployment's own page; following that link opens it in your browser, where the passkey and the saved passwords do work.

## Signing in with a device code

That is also why the app has a way to be signed in from the browser instead: the menu carries **Sign in…** whenever the backend is a deployment you run. It asks that deployment for two codes — one the app waits with, one it shows you — and opens the deployment's own page in your browser, with the code already filled in. Sign in there however that deployment asks (a passkey, a password your browser saved, both), approve the code, and the app picks up a token on its own: no password is ever typed into the window at `127.0.0.1`.

While it waits, the menu says so instead of offering a second code. Approval is good for ten minutes; a code that runs out is simply the end of that offer, and you sign in again. Once signed in, the menu says **Signed in** and offers **Sign out**, which forgets the token on this machine and asks the deployment to forget it too.

The token is kept in `userData` next to the settings, readable by nobody but the user the app runs as, and it belongs to the address it was given for — pointing the app at another deployment starts over. Every request forwarded to that deployment carries it, so the window is signed in until you sign out; a deployment that asks for no sign-in at all is answered with that, rather than with a code nobody can approve.

## Menu bar status

On macOS a status item sits in the menu bar and shows today's token usage (input / output, refreshed every minute) beside the icon. Its menu shows which backend is in use and at which address, opens the console, copies the address, opens Settings…, or quits the app. Windows and Linux get the same item in the tray, with the status and the usage in its tooltip and a click that opens the console.

The menu speaks the language the console is showing.

## Versions and updates

The bottom of the menu lists the desktop version, and — when the backend is a deployment you run — that deployment's version, which may differ from the app's. With the bundled gateway there is no server version to list: that gateway is the app.

The About tab of Settings… lists the same versions and links to the project's repository, which is why the menu carries no GitHub row of its own.

Check for updates… in the same menu asks GitHub for the newest release. When there is one it asks before doing anything, then downloads the installer built for this machine and hands it to the system to open: a disk image to mount on macOS, a setup program on Windows, an AppImage on Linux. A release with no build for this computer opens the releases page instead so you can pick one yourself. Nothing is replaced in the background.

## Port

Change the port in the dialog a first launch asks in, in the General tab of the menu's Settings…, or under Settings → Desktop app. Saving it restarts the gateway and takes the window to the new address. A port that has been saved or named is never swapped for another one on its own: when it is taken the app asks, in the same dialog, which port to use instead — or for whatever is holding it to be stopped, and then Try again. The menu bar says which port is taken until it is settled. An install that has saved nothing yet walks upwards instead, so it still works next to a deployment already serving 8001.

`CODEBUDDY_DESKTOP_PORT` still works for an install that has never saved a port; once one is saved in the console, the saved value wins.

## Storage

The desktop app is fixed to SQLite: it serves this machine only, with no second process to share a database with, so there is nothing to choose between. `CODEBUDDY_STORAGE_BACKEND`, `DATABASE_URL` and `CODEBUDDY_STORAGE_PG_URL` are ignored, and the storage backend in the settings page is a disabled field.

It generates its own encryption key on first launch, so credentials and access keys are encrypted at rest. **Deleting `storage-encryption-key` makes already encrypted data unreadable** — the same contract as a self-hosted deployment, so back up the database together with the key.

## Where the data lives

Everything is written inside Electron's `userData` directory, not next to the installed bundle:

| Path                        | Contents                                                                  |
| --------------------------- | ------------------------------------------------------------------------- |
| `data/`                     | File storage directory, and `storage.sqlite` by default                   |
| `credentials/`              | CodeBuddy credential files                                                |
| `storage-encryption-key`    | Storage encryption key generated on first launch (mode `0600`)            |
| `desktop-settings.json`     | The app's own settings: the backend and the port                          |
| `desktop-device-token.json` | The token a deployment handed this app when you approved it (mode `0600`) |

## Signing

The macOS builds in a release are signed and notarized, so the dmg opens on a double-click. On Windows, dismiss the SmartScreen prompt with Run anyway.

If macOS says the app is damaged and cannot be opened, drag it into `Applications` and run:

```sh
xattr -cr /Applications/CodeBuddy2API.app
```
