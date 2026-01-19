const http = require('http');
const https = require('https');
const url = require('url');
const zlib = require('zlib');

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
  let targetSite = parsedUrl.query.site;

  // If no site param, check if we have a path that starts with /proxy/
  if (!targetSite && parsedUrl.pathname.startsWith('/proxy/')) {
    targetSite = decodeURIComponent(parsedUrl.pathname.replace('/proxy/', ''));
  }

  if (!targetSite) {
    res.writeHead(400);
    res.end('Missing ?site= parameter. Usage: /?site=https://pump.fun');
    return;
  }

  // Parse the target URL
  let targetUrl;
  try {
    targetUrl = new URL(targetSite);
  } catch (e) {
    res.writeHead(400);
    res.end('Invalid URL: ' + targetSite);
    return;
  }

  const proxyBaseUrl = `https://${req.headers.host}`;

  const options = {
    hostname: targetUrl.hostname,
    port: targetUrl.port || 443,
    path: targetUrl.pathname + targetUrl.search,
    method: req.method,
    headers: {
      ...req.headers,
      host: targetUrl.hostname,
      'accept-encoding': 'gzip, deflate',
    },
  };

  delete options.headers['x-forwarded-for'];
  delete options.headers['x-forwarded-proto'];
  delete options.headers['x-forwarded-host'];

  const proxyReq = https.request(options, (proxyRes) => {
    const contentType = proxyRes.headers['content-type'] || '';
    const isText = contentType.includes('text/html') ||
                   contentType.includes('text/css') ||
                   contentType.includes('javascript') ||
                   contentType.includes('application/json');

    // Remove iframe-blocking headers
    const headers = { ...proxyRes.headers };
    delete headers['x-frame-options'];
    delete headers['content-security-policy'];
    delete headers['content-security-policy-report-only'];
    delete headers['content-length']; // We'll be modifying content

    // Handle redirects
    if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
      let redirectUrl = proxyRes.headers.location;
      if (redirectUrl.startsWith('/')) {
        redirectUrl = `${targetUrl.protocol}//${targetUrl.host}${redirectUrl}`;
      }
      headers.location = `${proxyBaseUrl}/?site=${encodeURIComponent(redirectUrl)}`;
    }

    if (!isText) {
      // For non-text content, just pipe through
      delete headers['content-encoding'];
      res.writeHead(proxyRes.statusCode, headers);

      const encoding = proxyRes.headers['content-encoding'];
      if (encoding === 'gzip') {
        proxyRes.pipe(zlib.createGunzip()).pipe(res);
      } else if (encoding === 'deflate') {
        proxyRes.pipe(zlib.createInflate()).pipe(res);
      } else {
        proxyRes.pipe(res);
      }
      return;
    }

    // For text content, collect and rewrite
    let chunks = [];
    const encoding = proxyRes.headers['content-encoding'];

    let stream = proxyRes;
    if (encoding === 'gzip') {
      stream = proxyRes.pipe(zlib.createGunzip());
    } else if (encoding === 'deflate') {
      stream = proxyRes.pipe(zlib.createInflate());
    }

    stream.on('data', chunk => chunks.push(chunk));
    stream.on('end', () => {
      let body = Buffer.concat(chunks).toString('utf8');

      const baseUrl = `${targetUrl.protocol}//${targetUrl.host}`;

      // Rewrite URLs in the content
      // Absolute URLs with same host
      body = body.replace(new RegExp(`(href|src|action)=["']${baseUrl}(/[^"']*)?["']`, 'gi'), (match, attr, path) => {
        const fullUrl = baseUrl + (path || '/');
        return `${attr}="${proxyBaseUrl}/?site=${encodeURIComponent(fullUrl)}"`;
      });

      // Relative URLs starting with /
      body = body.replace(/(href|src|action)=["']\/([^"'\/][^"']*)["']/gi, (match, attr, path) => {
        const fullUrl = `${baseUrl}/${path}`;
        return `${attr}="${proxyBaseUrl}/?site=${encodeURIComponent(fullUrl)}"`;
      });

      // Root relative URL
      body = body.replace(/(href|src|action)=["']\/["']/gi, (match, attr) => {
        return `${attr}="${proxyBaseUrl}/?site=${encodeURIComponent(baseUrl + '/')}"`;
      });

      // URLs in CSS url()
      body = body.replace(/url\(["']?\/([^"')]+)["']?\)/gi, (match, path) => {
        const fullUrl = `${baseUrl}/${path}`;
        return `url("${proxyBaseUrl}/?site=${encodeURIComponent(fullUrl)}")`;
      });

      // Fetch/XHR URLs in JS
      body = body.replace(/fetch\(["']\/([^"']+)["']/gi, (match, path) => {
        const fullUrl = `${baseUrl}/${path}`;
        return `fetch("${proxyBaseUrl}/?site=${encodeURIComponent(fullUrl)}"`;
      });

      // Next.js specific: /_next/ paths
      body = body.replace(/(["'])(\/_next\/[^"']+)(["'])/gi, (match, q1, path, q2) => {
        const fullUrl = `${baseUrl}${path}`;
        return `${q1}${proxyBaseUrl}/?site=${encodeURIComponent(fullUrl)}${q2}`;
      });

      // Script/link tags with relative paths
      body = body.replace(/(["'])(\/[a-zA-Z0-9_\-\.\/]+\.(js|css|json|woff2?|ttf|png|jpg|jpeg|gif|svg|ico|webp))(\?[^"']*)?["']/gi, (match, q1, path, ext, query) => {
        const fullUrl = `${baseUrl}${path}${query || ''}`;
        return `${q1}${proxyBaseUrl}/?site=${encodeURIComponent(fullUrl)}${q1}`;
      });

      // Inject base tag for relative URLs that we might miss
      if (contentType.includes('text/html')) {
        const baseTag = `<base href="${proxyBaseUrl}/?site=${encodeURIComponent(baseUrl)}/">`;
        if (body.includes('<head>')) {
          body = body.replace('<head>', `<head>${baseTag}`);
        } else if (body.includes('<HEAD>')) {
          body = body.replace('<HEAD>', `<HEAD>${baseTag}`);
        }
      }

      delete headers['content-encoding'];
      res.writeHead(proxyRes.statusCode, headers);
      res.end(body);
    });

    stream.on('error', (err) => {
      console.error('Stream error:', err);
      res.writeHead(500);
      res.end('Stream error');
    });
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
