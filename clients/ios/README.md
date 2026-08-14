# iOS — Share sheet → Later

**Two taps: Share → Later. Nothing to install from the App Store.**

You have two routes. **The manual one is recommended** — it takes about two minutes, needs no settings changes, and you end up understanding what the shortcut does.

---

## Route A — Build it by hand (recommended, ~2 minutes)

Open the **Shortcuts** app.

1. Tap **+** (top right) to create a new shortcut.
2. Tap the **ⓘ** info button at the bottom, then turn on **"Show in Share Sheet"**.
   - Under **"Share Sheet Types"**, make sure **URLs** and **Text** are both ticked. Untick the rest — it keeps Later out of share sheets where it makes no sense.
3. Tap **Done** on that panel, then search for and add **"Get Contents of URL"**.
4. Configure it:
   - **URL**: `https://YOUR-LATER-URL/api/ingest`
   - Tap **Show More**
   - **Method**: `POST`
   - **Headers** → tap **Add new header**
     - Key: `Authorization`
     - Value: `Bearer YOUR-INGEST-TOKEN` — the word `Bearer`, one space, then your token
   - **Request Body**: `JSON`
     - Add field, type **Text**, key `text`, value: tap the value box and pick **Shortcut Input** from the variable bar
     - Add field, type **Text**, key `source`, value `ios-shortcut`
5. *(Optional but nice)* Add **"Show Notification"** below it, with body `Sent to Later`. Later answers in milliseconds, so this appears instantly rather than making you wait.
6. Rename the shortcut to **Later** (tap the name at the top). The name is what you'll see in the share sheet.

Done. Open TikTok or Instagram, tap Share, scroll to **Later**.

> **You'll know it worked when** the notification appears immediately, and the video shows up in your `Later` playlist within a second or two. Also check the web UI — the item should show a **saved** badge and the real video title.

---

## Route B — Import the shipped file

[`Later.plist`](Later.plist) in this folder is a ready-built version of exactly the above.

**The catch, stated plainly:** iOS only imports shortcut files frictionlessly from an **iCloud link**, and iCloud links can only be created by a person tapping Share on a real device — so nobody can generate one for you. Importing a plain file instead requires enabling **Settings → Shortcuts → Allow Untrusted Shortcuts**, which is off by default and only becomes available after you've run at least one shortcut.

If you're happy with that:

1. AirDrop or email `Later.plist` to your phone
2. Open it — Shortcuts offers to import
3. Edit the two placeholders: `LATER-BASE-URL-HERE` and `LATER-INGEST-TOKEN-HERE`
4. Check **"Show in Share Sheet"** is on in the shortcut's ⓘ panel

**This file has not been tested on a physical device** — there's no iPhone in the build environment. If it fails to import or behaves oddly, use Route A and please open an issue saying what happened; the generator is `scripts/build-ios-shortcut.py` and it's a fixable bug.

---

## Making it a one-tap favourite

The share sheet remembers what you use, but you can pin Later to the top row: tap Share → scroll right in the actions row → **Edit Actions** → tap **+** next to Later, then drag it up.

That gets you Share → Later with no scrolling.

---

## Troubleshooting

| What you see | Cause |
|---|---|
| `401` | The `Authorization` header is wrong. It must be `Bearer ` then the token — check for a trailing space or newline in the pasted value, which is the most common cause. |
| `401` even though the token is right | You have `INGEST_HMAC_SECRET` set. Shortcuts cannot compute an HMAC, so signed mode breaks this client. Unset it. ([ADR-0008](../../docs/adr/0008-ingest-authentication.md)) |
| `409 not_connected` | No Google account is connected yet. Open your Later URL and press **Connect Google**. |
| `429` | Rate limited — more than 30 shares in a minute. Almost always a retry loop rather than a person. |
| Notification appears, video never arrives | `202` means *accepted*, not *added*. Check the item's state in the web UI; [TROUBLESHOOTING.md](../../TROUBLESHOOTING.md) explains each one. |
| Later isn't in the share sheet | "Show in Share Sheet" is off, or URLs/Text aren't ticked under Share Sheet Types. |

## Why the token sits on your phone in plain text

It does, inside the shortcut, and that's an accepted trade-off. Its blast radius is bounded to *adding videos to one playlist* — it can't read your YouTube data or reach anything else. Rotating it means changing `INGEST_TOKEN` and updating this shortcut. See [SECURITY.md](../../SECURITY.md).
