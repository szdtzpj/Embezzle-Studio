import http from 'node:http';

const port = Number.parseInt(process.env.WEB_PROXY_PORT ?? '8787', 10);
const maxBodyBytes = 50 * 1024 * 1024;

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(body);
}

function sendCorsPreflight(response) {
  response.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  });
  response.end();
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    request.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBodyBytes) {
        reject(new Error('Proxy request body is too large.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function cleanHeaders(headers) {
  const result = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    const lowerKey = key.toLowerCase();
    if (['host', 'connection', 'content-length'].includes(lowerKey)) {
      continue;
    }
    if (typeof value === 'string') {
      result[key] = value;
    }
  }
  return result;
}

function waitForDrain(response) {
  return new Promise((resolve) => {
    response.once('drain', resolve);
  });
}

async function pipeUpstreamBody(upstream, response) {
  if (!upstream.body) {
    const body = await upstream.arrayBuffer();
    response.end(Buffer.from(body));
    return;
  }

  const reader = upstream.body.getReader();

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      if (value && !response.write(Buffer.from(value))) {
        await waitForDrain(response);
      }
    }
  } finally {
    response.end();
  }
}

async function handleProxy(request, response) {
  let payload;
  try {
    payload = JSON.parse(await readBody(request));
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : 'Invalid JSON body.' });
    return;
  }

  const targetUrl = typeof payload.url === 'string' ? payload.url : '';
  let parsedUrl;
  try {
    parsedUrl = new URL(targetUrl);
  } catch {
    sendJson(response, 400, { error: 'Invalid target URL.' });
    return;
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    sendJson(response, 400, { error: 'Only http and https targets are allowed.' });
    return;
  }

  try {
    const upstream = await fetch(parsedUrl, {
      method: typeof payload.method === 'string' ? payload.method : 'GET',
      headers: cleanHeaders(payload.headers),
      body: payload.body == null ? undefined : String(payload.body),
    });
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache, no-transform',
      'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
      'X-Accel-Buffering': 'no',
    };

    response.writeHead(upstream.status, headers);
    await pipeUpstreamBody(upstream, response);
  } catch (error) {
    sendJson(response, 502, {
      error: error instanceof Error ? error.message : 'Proxy upstream request failed.',
    });
  }
}

const server = http.createServer((request, response) => {
  if (request.method === 'OPTIONS') {
    sendCorsPreflight(response);
    return;
  }

  if (request.method !== 'POST' || request.url !== '/proxy') {
    sendJson(response, 404, { error: 'Not found.' });
    return;
  }

  handleProxy(request, response);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Embezzle Studio dev proxy listening on http://127.0.0.1:${port}`);
});
