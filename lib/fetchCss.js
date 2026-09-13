// lib/fetchCss.js
//
// Some archived stylesheets come back without CORS headers, which is what
// stops the browser from reading their rules via document.styleSheets
// (that's a browser-enforced restriction tied to whether the response sent
// Access-Control-Allow-Origin, nothing more). A plain server-to-server
// request isn't subject to CORS at all - Node doesn't care who's asking.
// So this fetches the raw CSS text here, on the server, and hands it back
// as plain text. The client then re-parses it by injecting it as an inline
// <style> tag, which resets its origin to "authored right here" and makes
// its rules fully queryable with the normal CSSOM APIs.

const { schedule } = require('./rateLimiter');
const { fetchText } = require('./httpGet');

async function fetchStylesheetText(url) {
  return schedule(() => fetchText(url, { timeoutMs: 15000 }));
}

module.exports = { fetchStylesheetText };
