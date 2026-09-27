// api/index.js
//
// The serverless entry point. Vercel doesn't run `npm start` and doesn't
// bind a port - it imports this file and calls the exported function with
// one request. An Express app *is* that function, so the whole app comes
// across unchanged and every route in server.js keeps working, including
// the static file handler (though in practice Vercel serves public/ from
// its CDN before a request ever reaches here).
//
// vercel.json rewrites every /api/* path to this one file, so /api/diff
// and /api/notes/:id all arrive here and Express routes them as before.

const { app } = require('../server');

module.exports = app;
