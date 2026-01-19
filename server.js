const http = require('http');
const https = require('https');
const url = require('url');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const parsedUrl = url.parse(req.url, true);
  const targetSite = parsedUrl.query.site;

  if (!targetSite) {
    res.writeHead(400);
    res.end('Missing ?site= parameter. Usage: /?site=https://pump.fun');
    return;
  }

  const targetUrl = new URL(targetSite + (parsedUrl.path.replace(/^\/?\?site=[^&]+&?/, '').replace(/^&/, '?')));

  const options = {
    hostname: targetUrl.hostname,
    port: targetUrl.port || 443,
    path: targetUrl.pathname + targetUrl.search,
    method: req.method,
    headers: {
      ...req.headers,
      host: targetUrl.hostname,
    },
  };

  delete options.headers['x-forwarded-for'];
  delete options.headers['x-forwarded-proto'];
  delete options.headers['x-forwarded-host'];

  const proxyReq = https.request(options, (proxyRes) => {
    // Remove iframe-blocking headers
    const headers = { ...proxyRes.headers };
    delete headers['x-frame-options'];
    delete headers['content-security-policy'];
    delete headers['content-security-policy-report-only'];

    res.writeHead(proxyRes.statusCode, headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error('Proxy error:', err);
    res.writeHead(500);
    res.end('Proxy error: ' + err.message);
  });

  req.pipe(proxyReq);
});

server.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
});
