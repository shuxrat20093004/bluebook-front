# Development notification integration

The app must be served by its Node development server; opening the HTML directly as a file or using a static server will not provide the notification proxy. The sign-in form is client-side: any valid email and non-empty password pass, and the values are never sent to a server. When it serves the app page, the local server issues a loopback-only demo session cookie; the proxy checks that session on notification requests. This is not real account authentication—do not expose it to a network or deploy it.

Set these variables in the server process environment (never in browser code):

- `NOTIFICATIONS_API_URL` — notification backend base URL, for example `http://localhost:3000`
- `API_SECRET` — bearer token for the notification backend
- `SESSION_SECRET` — random session-signing secret (at least 32 characters)
- `APP_PORT` — optional app port; defaults to `3001` because the notification backend uses `3000`
- `APP_HOST` — optional loopback bind host; defaults to `127.0.0.1`
- `APP_PUBLIC_ORIGIN` — optional exact browser origin when a trusted local HTTPS reverse proxy is used
- `COOKIE_SECURE` — set to `true` only when serving the app over HTTPS

For example, in PowerShell:

```powershell
$env:NOTIFICATIONS_API_URL = "http://localhost:3000"
$env:API_SECRET = "<notification backend secret>"
$env:SESSION_SECRET = (node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))")
node server.js
```

Then open `http://127.0.0.1:3001`. The server binds to loopback only. Enter any valid email and non-empty password in the student sign-in form, or use the ticket form. Login is local-only and does not call an auth endpoint. The app server creates an HttpOnly, SameSite demo session when serving the page; notification requests are session-checked, validated, and forwarded with the server-only `API_SECRET`. The notification backend is only contacted for notification requests.

The proxy allows only the configured test lifecycle, break, and subject-module events; module metadata is limited to section/module numbers. Notification requests use an `Idempotency-Key`, and the frontend retries transient failures with the same key. Failures are shown in the app toast.

Run the server tests with `node --test server.test.js`.
