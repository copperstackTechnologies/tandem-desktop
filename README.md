# Tandem Desktop

Tray app that receives files and links between your phone and PC over Wi-Fi. No cloud, no accounts.

## Run
```
npm install
npm start          # development
npm test           # server + renderer tests
npm run dist       # installer for the current OS (electron-builder) -> dist/
```
Requires Node 18+.

## What it does
- **Tray menu:** status and address, last 5 items, open folder, history, pair, settings, quit.
- **History window:** live list, filter by type, search, Open / Show in folder / Copy link, Remove (optionally move the file to trash).
- **Pair window:** QR code with 5-minute countdown, new code on expiry, success state when the phone pairs. Opens automatically on first run.
- **Settings:** save folder, sort into Images/Audio/Video/Files, notifications, start on sign-in, paired phones (revoke), address, certificate fingerprint.
- Files are saved to `Documents/Tandem` by default.

## Desktop updates

Installed Windows builds check the latest published GitHub Release and download its installer update over HTTPS. `electron-updater` validates the downloaded installer with the SHA-512 digest in the release's `latest.yml`. To publish a release, bump `version` in `package.json`, commit and push the change, then push the matching `v<version>` tag. The `Build and publish Tandem desktop release` workflow builds the NSIS installer and uploads it with `latest.yml` and its blockmap. A source-code push by itself is not an app update.

Builds older than 1.0.2 do not contain the updater. Install a current installer once to switch existing installations to the new release feed. Later Windows releases install through the app. macOS and Linux automatic updates are not configured yet.

## Phone API (HTTPS, self-signed certificate)
The QR code contains JSON: `{ "v":1, "n":"PC name", "h":"192.168.x.x", "p":48200, "s":"<one-time secret>", "f":"<SHA-256 cert fingerprint>" }`.
The phone must pin the fingerprint `f` and not trust any other certificate. The port can differ from 48200 if that port was busy; always use `p`.

| Method | Path | Auth | Body | Result |
|---|---|---|---|---|
| POST | `/pair` | none | JSON `{secret, deviceName}` | `{token, pcName}`. Secret is one-time, expires in 5 minutes, 5 attempts. |
| GET | `/ping` | Bearer token | none | `{ok, name}` |
| POST | `/upload` | Bearer token | multipart, one `file` part | `{ok, id, name}`. Max 200 MB. Type taken from the part's content type, else the extension. |
| POST | `/link` | Bearer token | JSON `{url, title?}` | `{ok, id}`. http/https only. |
| DELETE | `/pair` | Bearer token | none | Unpairs this phone. |

Discovery: the PC advertises `_tandem._tcp` (and `_phonesaves._tcp`) over mDNS with TXT `fp=<fingerprint without colons>`.
Use header `Authorization: Bearer <token>`. Tokens are stored hashed on the PC.

## Data locations
Electron `userData` folder: `db.json` (history, settings, paired phones), `cert.pem`, `key.pem`.

## Notes
- Windows will ask for a firewall permission on first run; allow private networks.
- Guest or public Wi-Fi often blocks device-to-device traffic.
- Start on sign-in applies only to the installed (packaged) app.
- History is stored in a JSON file, which is fine for thousands of items.
