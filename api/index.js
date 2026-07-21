// Vercel serverless entry point.
//
// The vercel.json "routes" send EVERY request here, so this single Express app
// serves the static pages (index.html / dashboard.html) AND the /api routes,
// all behind the Basic Auth gate — matching the Render deployment exactly.
//
// server.js only calls app.listen() when run directly (npm start on Render);
// when imported here it just exports the configured Express app, which Vercel
// invokes as the request handler.
import app from '../server.js';

export default app;
