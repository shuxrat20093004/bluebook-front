# API integration and deployment

Deploy this app as a Render Web Service, not a static site. The Node server serves the frontend and receives same-origin notification requests, then forwards them to the existing backend routes `API_URL/api/events`, `API_URL/api/code`, and `API_URL/api/status` with the server-only `API_SECRET`. The frontend login destination remains `https://bluebook-vmqh.onrender.com/api/auth/login`; do not put `API_SECRET` in browser code.

Set these variables in the server process environment:

- `API_URL` — backend origin, for example `http://localhost:3000`
- `API_SECRET` — bearer token for the notification backend
- `NODE_ENV` — set to `production` on Render
- `ALLOW_PRODUCTION_DEPLOYMENT` — set to `true` for the intentional production deployment
- `APP_PUBLIC_ORIGIN` — exact public origin of the deployed app, e.g. `https://your-service.onrender.com`
- `PORT` — supplied by Render; local development can use `APP_PORT` (defaults to `3001`)
- `APP_HOST` — optional bind host; defaults to `0.0.0.0` in production and `127.0.0.1` locally
- `COOKIE_SECURE` — optional locally; production cookies are always Secure

For example, in PowerShell:

```powershell
$env:API_URL = "http://localhost:3000"
$env:API_SECRET = "<notification backend secret>"
node server.js
```

For Render, create a Web Service with build command `node --check server.js`, start command `npm start`, and configure the environment variables above. Set `API_URL` to the existing backend origin `https://bluebook-vmqh.onrender.com`; the upstream API paths are unchanged. The service must be the same origin serving the frontend so the browser's session cookie reaches the notification proxy.

For local development, set `API_URL` and `API_SECRET`, run `node server.js`, then open `http://127.0.0.1:3001`. The server writes the public API base URL to `/runtime-config.js` and proxies notification requests with the server-only `API_SECRET`.

The proxy allows only the configured test lifecycle, break, and subject-module events; module metadata is limited to section/module numbers. Notification requests use an `Idempotency-Key`, and the frontend retries transient failures with the same key. Failures are shown in the app toast.

Run the server tests with `node --test server.test.js`.
