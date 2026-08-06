# Android — Share sheet → Later

**Two taps: Share → Later. No app store, no APK.** Later installs as a PWA and registers itself as a share target.

## Setup (~1 minute)

1. Open your Later URL in **Chrome** on the phone
2. Menu (⋮) → **Add to Home screen** → **Install**
3. That's it

Now open TikTok or Instagram, tap Share, and **Later** appears in the sheet alongside your other apps.

> **You'll know it worked when** Later has its own icon on your home screen and opens without browser chrome. If "Add to Home screen" offers a bookmark rather than an install, see below.

## What happens when you share

The share lands on a page with the text already filled in, and you press **Save it**. One extra tap compared to iOS, and it's deliberate: the alternative (`method: POST` in the manifest) needs a service worker to intercept the request, which is more moving parts for a marginally slicker result. The reasoning is in [ADR-0011](../../docs/adr/0011-frontend-server-rendered-no-framework.md), and it's flagged for revisit if the extra tap proves annoying in real use.

## Requirements

Chrome will only offer to install if all of these hold. If the install option doesn't appear, one of them is the reason:

- **HTTPS.** A `localhost` instance can be installed for testing, but a deployment on plain `http` cannot. This is a browser rule, not ours.
- **A manifest with an icon of at least 192px.** Later serves both 192 and 512. Check `/manifest.webmanifest` loads and returns JSON.
- **Reachable from the phone.** A Later running on your laptop at `localhost:8787` is not reachable from your phone — you need a deployment or a tunnel.

## Firefox and others

`share_target` is a Chromium feature. Firefox on Android does not implement it, so Later will not appear in the share sheet there. Use Chrome, or use the [Telegram bot](../telegram/README.md), which works from any app on any OS and needs no install at all.

## Troubleshooting

| What you see | Cause |
|---|---|
| No "Install" option, only "Add shortcut" | Not served over HTTPS, or the manifest failed to load. Open `/manifest.webmanifest` directly. |
| Later missing from the share sheet | Installed as a bookmark rather than a PWA. Uninstall and reinstall via **Install**, not **Add shortcut**. |
| Shared, but the page says "Not connected yet" | No Google account connected. Press **Connect Google** first. |
| Opens in a browser tab rather than standalone | Same cause as the bookmark case above. |

## iOS

iOS doesn't support `share_target` at all — Safari ignores it. That's why the [iOS Shortcut](../ios/README.md) exists, and it's a better experience anyway: genuinely two taps with no confirmation screen.
