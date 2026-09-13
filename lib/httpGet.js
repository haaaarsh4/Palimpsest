// lib/httpGet.js
//
// Why this file exists: Node's built-in fetch() is supposed to
// auto-decompress a response based on its Content-Encoding header, but
// that only kicks in when fetch chose the encoding itself, and even then,
// older Node versions have had real bugs with Brotli specifically. And
// archive.org's CDN doesn't reliably honor a client's Accept-Encoding
// request anyway.
//
// So instead of hoping fetch gets this right, we go one level lower: make
// the request with Node's core `https` module, read the raw response
// bytes ourselves, look at whatever Content-Encoding the server actually
// sent back, and decompress it ourselves. This handles gzip, deflate, and
// Brotli via Node's built-in zlib, and Zstandard (zstd) via the small,
// pure-JS "fzstd" package, since Node's own zlib only gained zstd support
// very recently and can't be relied on. Anything we still don't recognize
// fails loudly with a clear error instead of silently handing back
// unreadable bytes as if they were text.

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const fzstd = require('fzstd');

const MAX_REDIRECTS = 5;

function fetchText(rawUrl, { timeoutMs = 25000, redirectsLeft = MAX_REDIRECTS } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(rawUrl);
    } catch (err) {
      reject(new Error(`Invalid URL: ${rawUrl}`));
      return;
    }

    const client = url.protocol === 'http:' ? http : https;

    const req = client.get(
      url,
      {
        headers: {
          'User-Agent': 'Palimpsest/1.0 (research tool)',
          'Accept-Encoding': 'gzip, deflate, br, zstd',
        },
        timeout: timeoutMs,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) {
            reject(new Error('Too many redirects while fetching that snapshot.'));
            return;
          }
          const nextUrl = new URL(res.headers.location, url).toString();
          fetchText(nextUrl, { timeoutMs, redirectsLeft: redirectsLeft - 1 }).then(resolve, reject);
          return;
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          reject(new Error(`Request failed: ${res.statusCode}`));
          return;
        }

        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          const encoding = (res.headers['content-encoding'] || '').toLowerCase();
          try {
            let decoded;
            if (encoding === 'br') {
              decoded = zlib.brotliDecompressSync(buffer);
            } else if (encoding === 'gzip' || encoding === 'x-gzip') {
              decoded = zlib.gunzipSync(buffer);
            } else if (encoding === 'deflate') {
              decoded = zlib.inflateSync(buffer);
            } else if (encoding === 'zstd') {
              decoded = Buffer.from(fzstd.decompress(new Uint8Array(buffer)));
            } else if (encoding === '' || encoding === 'identity') {
              decoded = buffer;
            } else {
              reject(
                new Error(
                  `The server sent back content compressed as "${encoding}", which this app doesn't know how to decode yet.`
                )
              );
              return;
            }
            const text = decoded.toString('utf-8');
            const replacementCount = (text.match(/\uFFFD/g) || []).length;
            if (text.length > 200 && replacementCount / text.length > 0.05) {
              reject(
                new Error(
                  `The response for this snapshot looks corrupted after decoding (encoding was "${encoding || 'none'}"). This may be a Wayback Machine issue with this specific snapshot rather than this app.`
                )
              );
              return;
            }
            resolve(text);
          } catch (err) {
            reject(
              new Error(
                `Could not decode the response body (Content-Encoding was "${encoding || 'none'}"): ${err.message}`
              )
            );
          }
        });
      }
    );

    req.on('timeout', () => req.destroy(new Error('__timeout__')));
    req.on('error', (err) => {
      if (err.message === '__timeout__') reject(new Error('The request timed out.'));
      else reject(err);
    });
  });
}

module.exports = { fetchText };