const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const SESSION_COOKIE = 'bluebook_dev_session';
const SESSION_LIFETIME_SECONDS = 8 * 60 * 60;
const MAX_BODY_BYTES = 16 * 1024;
const VALID_EVENTS = new Set([
  'break_started',
  'break_ended',
  'module_started'
]);
const VALID_STATUSES = new Set(['started', 'completed']);
const NOTIFICATION_PATHS = new Set([
  '/api/notifications/events',
  '/api/notifications/code',
  '/api/notifications/status'
]);
const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/bigfuture_graduates.jpg': ['bigfuture_graduates.jpg', 'image/jpeg']
};

function safeEqual(left, right) {
  return crypto.timingSafeEqual(
    crypto.createHash('sha256').update(left).digest(),
    crypto.createHash('sha256').update(right).digest()
  );
}

function signSession(payload, secret) {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(encodedPayload).digest('base64url');
  return `${encodedPayload}.${signature}`;
}

function readSession(cookieHeader, secret, activeSessions) {
  const cookies = (cookieHeader || '').split(';');
  const sessionCookie = cookies.find(cookie => cookie.trim().startsWith(`${SESSION_COOKIE}=`));
  if (!sessionCookie) return null;

  const token = sessionCookie.trim().slice(SESSION_COOKIE.length + 1);
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [encodedPayload, signature] = parts;
  const expectedSignature = crypto.createHmac('sha256', secret).update(encodedPayload).digest('base64url');
  if (!safeEqual(signature, expectedSignature)) return null;

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    if (!Number.isInteger(payload.expiresAt) || payload.expiresAt <= Date.now()) return null;
    if (typeof payload.sessionId !== 'string' || !activeSessions.has(payload.sessionId)) return null;
    if (typeof payload.name !== 'string' || payload.name.length > 100) return null;
    return payload;
  } catch {
    return null;
  }
}

function sendJson(response, statusCode, body, headers = {}) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  });
  response.end(JSON.stringify(body));
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', chunk => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body is too large.'), { statusCode: 413 }));
        request.destroy();
      }
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(Object.assign(new Error('Request body must be valid JSON.'), { statusCode: 400 }));
      }
    });
    request.on('error', reject);
  });
}

function hasExpectedOrigin(request, publicOrigin) {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (!origin || !host) return false;
  try {
    const parsedOrigin = new URL(origin);
    if (publicOrigin) return parsedOrigin.origin === publicOrigin;
    const expectedProtocol = request.socket.encrypted ? 'https:' : 'http:';
    return parsedOrigin.host === host && parsedOrigin.protocol === expectedProtocol;
  } catch {
    return false;
  }
}

function validateMetadata(metadata) {
  if (metadata === undefined) return true;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  const keys = Object.keys(metadata);
  if (keys.some(key => key !== 'section' && key !== 'module')) return false;
  return (metadata.section === undefined || [1, 2].includes(metadata.section))
    && (metadata.module === undefined || [1, 2].includes(metadata.module));
}

function validateEventPayload(payload) {
  return payload
    && typeof payload === 'object'
    && !Array.isArray(payload)
    && VALID_EVENTS.has(payload.event)
    && (payload.message === undefined || (typeof payload.message === 'string' && payload.message.length <= 500))
    && validateMetadata(payload.metadata);
}

function validateStatusPayload(payload) {
  return payload
    && typeof payload === 'object'
    && !Array.isArray(payload)
    && VALID_STATUSES.has(payload.status)
    && typeof payload.message === 'string'
    && payload.message.trim().length > 0
    && payload.message.length <= 500;
}

function createSessionCookie(config, activeSessions) {
  const now = Date.now();
  for (const [sessionId, expiresAt] of activeSessions) {
    if (expiresAt <= now) activeSessions.delete(sessionId);
  }

  const sessionId = crypto.randomBytes(32).toString('base64url');
  const expiresAt = now + SESSION_LIFETIME_SECONDS * 1000;
  activeSessions.set(sessionId, expiresAt);
  const token = signSession({
    sessionId,
    name: 'Local Student',
    expiresAt
  }, config.sessionSecret);
  const cookieParts = [
    `${SESSION_COOKIE}=${token}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${SESSION_LIFETIME_SECONDS}`
  ];
  if (config.secureCookie) cookieParts.push('Secure');
  return cookieParts.join('; ');
}

async function forwardNotification(config, endpoint, payload, idempotencyKey) {
  const response = await fetch(new URL(endpoint, `${config.apiUrl.replace(/\/+$/, '')}/`), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiSecret}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000)
  });

  if (!response.ok) {
    let rejectionReason = '';
    try {
      const errorBody = await response.json();
      const reason = errorBody && (errorBody.error || errorBody.message || errorBody.detail);
      if (typeof reason === 'string') {
        rejectionReason = reason
          .split(config.apiSecret).join('[redacted]')
          .replace(/[\r\n\t]/g, ' ')
          .slice(0, 200);
      }
    } catch {
      rejectionReason = '';
    }

    return {
      statusCode: 502,
      body: {
        error: `Notification service rejected the request (HTTP ${response.status})${rejectionReason ? `: ${rejectionReason}` : '.'}`
      }
    };
  }
  return { statusCode: 200, body: { ok: true } };
}

async function forwardLogin(payload, endpoint) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000)
  });
  const body = await response.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {
      statusCode: 502,
      body: { success: false, error: 'Login service returned an invalid response.' }
    };
  }
  return { statusCode: response.status, body };
}

function createAppServer(config) {
  const activeSessions = new Map();
  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url, 'http://localhost');
    const pathname = requestUrl.pathname;

    if (request.method === 'GET' && pathname === '/runtime-config.js') {
      const source = `window.APP_CONFIG = Object.freeze(${JSON.stringify({ apiUrl: config.apiUrl }).replace(/</g, '\\u003c')});`;
      response.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      response.end(source);
      return;
    }

    if (request.method === 'POST' && pathname.startsWith('/api/')) {
      if (!hasExpectedOrigin(request, config.publicOrigin)) {
        return sendJson(response, 403, { error: 'Request origin is not allowed.' });
      }
      if (pathname === '/api/auth/login') {
        let payload;
        try {
          payload = await readJsonBody(request);
        } catch (error) {
          return sendJson(response, error.statusCode || 400, { error: error.message });
        }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)
          || typeof payload.email !== 'string' || !payload.email.trim()
          || typeof payload.password !== 'string' || !payload.password) {
          return sendJson(response, 400, { success: false, error: 'Email and password are required.' });
        }
        try {
          const result = await forwardLogin({
            email: payload.email.trim(),
            password: payload.password
          }, config.loginApiUrl);
          return sendJson(response, result.statusCode, result.body);
        } catch {
          return sendJson(response, 502, {
            success: false,
            error: 'Login service could not be reached. Please try again shortly.'
          });
        }
      }
      if (!NOTIFICATION_PATHS.has(pathname)) {
        return sendJson(response, 404, { error: 'Not found.' });
      }

      let payload;
      try {
        payload = await readJsonBody(request);
      } catch (error) {
        return sendJson(response, error.statusCode || 400, { error: error.message });
      }

      const session = readSession(request.headers.cookie, config.sessionSecret, activeSessions);
      if (!session) return sendJson(response, 401, { error: 'Sign in to send notifications.' });

      const idempotencyKey = request.headers['idempotency-key'];
      if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)) {
        return sendJson(response, 400, { error: 'A valid Idempotency-Key header is required.' });
      }

      let endpoint;
      if (pathname === '/api/notifications/events' && validateEventPayload(payload)) {
        endpoint = '/api/events';
      } else if (pathname === '/api/notifications/code'
        && payload && typeof payload.code === 'string' && /^\d{6}$/.test(payload.code)) {
        endpoint = '/api/code';
      } else if (pathname === '/api/notifications/status' && validateStatusPayload(payload)) {
        endpoint = '/api/status';
      } else {
        return sendJson(response, 400, { error: 'Notification request is invalid.' });
      }

      try {
        const result = await forwardNotification(config, endpoint, payload, idempotencyKey);
        return sendJson(response, result.statusCode, result.body);
      } catch {
        return sendJson(response, 502, { error: 'Notification service is unavailable.' });
      }
    }

    if (request.method === 'GET' && STATIC_FILES[pathname]) {
      const [filename, contentType] = STATIC_FILES[pathname];
      fs.readFile(path.join(__dirname, filename), (error, contents) => {
        if (error) return sendJson(response, 404, { error: 'File not found.' });
        const headers = {
          'Content-Type': contentType,
          'X-Content-Type-Options': 'nosniff'
        };
        if (filename === 'index.html'
          && !readSession(request.headers.cookie, config.sessionSecret, activeSessions)) {
          headers['Set-Cookie'] = createSessionCookie(config, activeSessions);
        }
        response.writeHead(200, headers);
        response.end(contents);
      });
      return;
    }

    return sendJson(response, 404, { error: 'Not found.' });
  });

  return server;
}

function loadConfig(environment) {
  const required = ['API_SECRET', 'API_URL'];
  const missing = required.filter(key => !environment[key]);
  if (missing.length) {
    throw new Error(`Missing required server environment variables: ${missing.join(', ')}`);
  }
  if (environment.NODE_ENV === 'production') {
    throw new Error('This local demo session server is development-only.');
  }
  const apiUrl = new URL(environment.API_URL);
  if (!['http:', 'https:'].includes(apiUrl.protocol)
    || apiUrl.username
    || apiUrl.password
    || apiUrl.pathname !== '/'
    || apiUrl.search
    || apiUrl.hash) {
    throw new Error('API_URL must be an HTTP(S) origin without embedded credentials or a path.');
  }

  let publicOrigin;
  if (environment.APP_PUBLIC_ORIGIN) {
    const parsedOrigin = new URL(environment.APP_PUBLIC_ORIGIN);
    if (!['http:', 'https:'].includes(parsedOrigin.protocol)
      || parsedOrigin.username
      || parsedOrigin.password
      || parsedOrigin.pathname !== '/'
      || parsedOrigin.search
      || parsedOrigin.hash) {
      throw new Error('APP_PUBLIC_ORIGIN must be an HTTP(S) origin without a path or credentials.');
    }
    publicOrigin = parsedOrigin.origin;
  }

  return {
    apiSecret: environment.API_SECRET,
    apiUrl: apiUrl.origin,
    loginApiUrl: new URL('/api/auth/login', apiUrl).toString(),
    sessionSecret: crypto.randomBytes(16).toString('hex'),
    publicOrigin,
    secureCookie: environment.COOKIE_SECURE === 'true'
  };
}

if (require.main === module) {
  try {
    const config = loadConfig(process.env);
    const host = process.env.APP_HOST || '127.0.0.1';
    const port = Number(process.env.APP_PORT || 3001);
    if (!['127.0.0.1', '::1', 'localhost'].includes(host)) {
      throw new Error('APP_HOST must be a loopback address for development-only authentication.');
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('APP_PORT must be a valid TCP port.');
    }

    createAppServer(config).listen(port, host, () => {
      console.log(`Bluebook development app listening at http://${host}:${port}`);
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { createAppServer, loadConfig };
