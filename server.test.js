const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { createAppServer, loadConfig } = require('./server');

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    resolve(`http://127.0.0.1:${server.address().port}`);
  }));
}

function close(server) {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test('requires server-only configuration and rejects production mode', () => {
  assert.throws(() => loadConfig({}), /Missing required server environment variables/);
  assert.throws(() => loadConfig({
    API_SECRET: 'secret',
    API_URL: 'http://localhost:3000',
    NODE_ENV: 'production'
  }), /development-only/);
  const config = loadConfig({
    API_SECRET: 'secret',
    API_URL: 'https://api.example.com'
  });
  assert.equal(config.apiUrl, 'https://api.example.com');
  assert.equal(config.loginApiUrl, 'https://api.example.com/api/auth/login');
  assert.match(config.sessionSecret, /^[a-f0-9]{32}$/);
  assert.notEqual(config.sessionSecret, loadConfig({
    API_SECRET: 'secret',
    API_URL: 'https://api.example.com'
  }).sessionSecret);
  assert.throws(() => loadConfig({
    API_SECRET: 'secret',
    API_URL: 'https://api.example.com/v1'
  }), /API_URL must be an HTTP\(S\) origin/);
});

test('requires a server-issued local session and forwards allowlisted requests', async t => {
  const received = [];
  const loginRequests = [];
  let rejectEvents = false;
  let unconfirmedDelivery = false;
  const notificationServer = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    if (request.url === '/api/auth/login') {
      const payload = JSON.parse(body);
      loginRequests.push({
        authorization: request.headers.authorization,
        body: payload
      });
      if (payload.email === 'invalid@example.com') {
        response.writeHead(401, { 'Content-Type': 'application/json' });
        response.end('{"success":false,"error":"invalid_credentials"}');
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        success: true,
        user: { firstName: 'Test', lastName: 'Student' },
        token: 'test-jwt-token'
      }));
      return;
    }
    received.push({
      path: request.url,
      authorization: request.headers.authorization,
      idempotencyKey: request.headers['idempotency-key'],
      body: JSON.parse(body)
    });
    if (request.url === '/api/events' && rejectEvents) {
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end('{"error":"event name is unsupported"}');
      return;
    }
    if (request.url === '/api/code' && unconfirmedDelivery) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{"success":true,"delivered":false}');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{"success":true,"delivered":true,"duplicate":false}');
  });
  const notificationUrl = await listen(notificationServer);
  const appServer = createAppServer({
    ...loadConfig({
      API_URL: notificationUrl,
      API_SECRET: 'server-only-token'
    }),
    secureCookie: false
  });
  const appUrl = await listen(appServer);
  t.after(async () => {
    await close(appServer);
    await close(notificationServer);
  });

  const homepage = await fetch(`${appUrl}/`);
  assert.equal(homepage.status, 200);
  const homepageHtml = await homepage.text();
  assert.match(homepageHtml, /<title>Bluebook™<\/title>/);
  assert.match(homepageHtml, /<script src="\/runtime-config\.js"><\/script>/);
  assert.match(homepage.headers.get('set-cookie'), /HttpOnly/);
  assert.match(homepage.headers.get('set-cookie'), /SameSite=Strict/);
  const cookie = homepage.headers.get('set-cookie').split(';')[0];

  const runtimeConfig = await fetch(`${appUrl}/runtime-config.js`);
  assert.equal(runtimeConfig.status, 200);
  assert.match(await runtimeConfig.text(), new RegExp(`"apiUrl":"${notificationUrl}"`));

  const login = await fetch(`${appUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      Origin: appUrl,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ email: 'student@example.com', password: 'student-password' })
  });
  assert.equal(login.status, 200);
  assert.deepEqual(await login.json(), {
    success: true,
    user: { firstName: 'Test', lastName: 'Student' },
    token: 'test-jwt-token'
  });
  assert.deepEqual(loginRequests[0], {
    authorization: undefined,
    body: { email: 'student@example.com', password: 'student-password' }
  });

  const invalidLogin = await fetch(`${appUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      Origin: appUrl,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ email: 'invalid@example.com', password: 'wrong-password' })
  });
  assert.equal(invalidLogin.status, 401);
  assert.deepEqual(await invalidLogin.json(), {
    success: false,
    error: 'invalid_credentials'
  });

  const unauthorized = await fetch(`${appUrl}/api/notifications/events`, {
    method: 'POST',
    headers: {
      Origin: appUrl,
      'Content-Type': 'application/json',
      'Idempotency-Key': 'event-1'
    },
    body: JSON.stringify({ event: 'break_started' })
  });
  assert.equal(unauthorized.status, 401);

  const crossOriginRequest = await fetch(`${appUrl}/api/notifications/events`, {
    method: 'POST',
    headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'break_started' })
  });
  assert.equal(crossOriginRequest.status, 403);

  const invalidCode = await fetch(`${appUrl}/api/notifications/code`, {
    method: 'POST',
    headers: {
      Origin: appUrl,
      Cookie: cookie,
      'Content-Type': 'application/json',
      'Idempotency-Key': 'code-invalid'
    },
    body: JSON.stringify({ code: '12345a' })
  });
  assert.equal(invalidCode.status, 400);

  const invalidMetadata = await fetch(`${appUrl}/api/notifications/events`, {
    method: 'POST',
    headers: {
      Origin: appUrl,
      Cookie: cookie,
      'Content-Type': 'application/json',
      'Idempotency-Key': 'event-invalid'
    },
    body: JSON.stringify({
      event: 'break_started',
      metadata: { arbitrary: 'not allowed' }
    })
  });
  assert.equal(invalidMetadata.status, 400);

  const event = await fetch(`${appUrl}/api/notifications/events`, {
    method: 'POST',
    headers: {
      Origin: appUrl,
      Cookie: cookie,
      'Content-Type': 'application/json',
      'Idempotency-Key': 'event-2'
    },
    body: JSON.stringify({
      event: 'module_started',
      message: 'Math module 1 started.'
    })
  });
  assert.equal(event.status, 200);
  assert.deepEqual(await event.json(), {
    success: true,
    delivered: true,
    duplicate: false
  });
  assert.deepEqual(received, [{
    path: '/api/events',
    authorization: 'Bearer server-only-token',
    idempotencyKey: 'event-2',
    body: {
      event: 'module_started',
      message: 'Math module 1 started.'
    }
  }]);

  const validCode = await fetch(`${appUrl}/api/notifications/code`, {
    method: 'POST',
    headers: {
      Origin: appUrl,
      Cookie: cookie,
      'Content-Type': 'application/json',
      'Idempotency-Key': 'code-valid'
    },
    body: JSON.stringify({ code: '123456' })
  });
  assert.equal(validCode.status, 200);
  assert.equal(received[1].path, '/api/code');
  assert.deepEqual(received[1].body, { code: '123456' });

  const status = await fetch(`${appUrl}/api/notifications/status`, {
    method: 'POST',
    headers: {
      Origin: appUrl,
      Cookie: cookie,
      'Content-Type': 'application/json',
      'Idempotency-Key': 'test-status'
    },
    body: JSON.stringify({ status: 'completed', message: 'Practice test completed.' })
  });
  assert.equal(status.status, 200);
  assert.equal(received[2].path, '/api/status');
  assert.deepEqual(received[2].body, {
    status: 'completed',
    message: 'Practice test completed.'
  });

  unconfirmedDelivery = true;
  const unconfirmedCode = await fetch(`${appUrl}/api/notifications/code`, {
    method: 'POST',
    headers: {
      Origin: appUrl,
      Cookie: cookie,
      'Content-Type': 'application/json',
      'Idempotency-Key': 'code-unconfirmed'
    },
    body: JSON.stringify({ code: '654321' })
  });
  assert.equal(unconfirmedCode.status, 502);
  assert.deepEqual(await unconfirmedCode.json(), {
    success: false,
    delivered: false,
    error: 'Notification service did not confirm delivery.'
  });

  rejectEvents = true;
  const rejectedEvent = await fetch(`${appUrl}/api/notifications/events`, {
    method: 'POST',
    headers: {
      Origin: appUrl,
      Cookie: cookie,
      'Content-Type': 'application/json',
      'Idempotency-Key': 'event-rejected'
    },
    body: JSON.stringify({ event: 'module_started', message: 'Reading & Writing module 2 started.' })
  });
  assert.equal(rejectedEvent.status, 502);
  assert.match((await rejectedEvent.json()).error, /HTTP 400\): event name is unsupported/);
});
