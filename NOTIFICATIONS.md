# Development API integration

The static frontend sends login requests to `API_URL/api/auth/login` and notifications to `API_URL/api/events`, `API_URL/api/code`, and `API_URL/api/status`. The deployed backend must expose these notification endpoints to browser requests and allow the app's origin through CORS. Do not put `API_SECRET` in browser code; if the backend requires a secret, route notifications through a production server-side proxy instead. The Node server in this repository is development-only and must not be exposed to a network or deployed.

Set these variables in the server process environment:

- `API_URL` — backend origin, for example `http://localhost:3000`
- `API_SECRET` — bearer token for the notification backend
- `APP_PORT` — optional app port; defaults to `3001` because the notification backend uses `3000`
- `APP_HOST` — optional loopback bind host; defaults to `127.0.0.1`
- `APP_PUBLIC_ORIGIN` — optional exact browser origin when a trusted local HTTPS reverse proxy is used
- `COOKIE_SECURE` — set to `true` only when serving the app over HTTPS

For example, in PowerShell:

```powershell
$env:API_URL = "http://localhost:3000"
$env:API_SECRET = "<notification backend secret>"
node server.js
```

The Node server generates a fresh 32-character cryptographically random session secret on startup; it is not read from an environment variable. Existing sessions are invalidated when the server restarts. Then open `http://127.0.0.1:3001`. The server binds to loopback only. The development server writes the public API base URL to `/runtime-config.js`, proxies student login to `API_URL/api/auth/login`, and proxies notification requests to `API_URL/api/events`, `API_URL/api/code`, and `API_URL/api/status` with the server-only `API_SECRET`.

The proxy allows only the configured test lifecycle, break, and subject-module events; module metadata is limited to section/module numbers. Notification requests use an `Idempotency-Key`, and the frontend retries transient failures with the same key. Failures are shown in the app toast.

Run the server tests with `node --test server.test.js`.
