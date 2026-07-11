# Remote Inbox setup

Remote Inbox accepts notes only while Text Editor is running. It listens on `127.0.0.1` and is intended to be reached through Cloudflare Tunnel and Cloudflare Access, never directly from a LAN.

1. Prepare a hostname in a domain managed by Cloudflare.
2. Install `cloudflared` for Windows using Cloudflare's current installation guide, then create and run a Tunnel.
3. Configure the Tunnel public hostname service as `http://127.0.0.1:48731` (or the port selected in Text Editor). Do not use `0.0.0.0` or a LAN address.
4. In Cloudflare Zero Trust, add Google as an Identity Provider.
5. Create a **Self-hosted** Access application for the public hostname and add an **Allow** policy for exactly your Google email address.
6. Copy the Team Domain (for example `https://example.cloudflareaccess.com`) and the application's Audience (AUD) tag.
7. In Text Editor Settings > Remote writing, enable it and enter the port, target tab name, Team Domain, AUD, and the allowed email address. The server will show a local status and URL.
8. Visit the protected public hostname in iPhone Safari, authenticate with Google, then send a note. You may add the page to the iPhone home screen.

Cloudflare Access remains responsible for the Google sign-in. Text Editor validates the signed `Cf-Access-Jwt-Assertion` itself (RS256 signature, issuer, audience, expiration/not-before, and exact lower-cased email match). It does not request Google Drive, Gmail, Calendar, or OAuth client-secret access.

The remote page has **Remote Inbox** and **Tab viewing** modes. Remote Inbox mode can load, replace, append, copy, reload, and clear configured inbox targets. Full saves use a revision number and return HTTP 409 instead of overwriting content changed by another browser or by the PC clear action. On the PC those inbox targets are CodeMirror read-only documents; selection, copying, and the confirmed inbox-only clear action remain available.

Tab viewing mode exposes only normal tabs explicitly selected in Settings > Remote writing. It supports viewing, copying, reloading, and searching, but has no mutation API. Remote Inbox targets are excluded from that list. All read and mutation APIs require the same Cloudflare Access assertion and allowed-email validation; mutations also require CSRF validation. Reads, replacements, clears, tab-list reads, and tab-content reads are audited without storing note content.

The workspace export includes the Remote Inbox Team Domain, AUD, and allowed email because these are workspace settings. It never includes JWTs, cookies, or submitted note content. Keep exported workspace archives private.

`cloudflared` is deliberately not installed or launched by Text Editor. Follow Cloudflare's current documentation if you want to run the tunnel as a Windows service.
