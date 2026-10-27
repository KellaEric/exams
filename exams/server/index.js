// Stand-alone server (VPS, Render, Railway, local). On Vercel the app runs from api/index.js and Vercel serves /dist itself.
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { createApp } from './app.js';

const port = Number(process.env.PORT || 3001);
const app = await createApp();
const dist = path.resolve('dist');
if (fs.existsSync(path.join(dist, 'index.html'))) {
  const root = express();
  root.use(app);                                                            // /api/* handled by the API app
  root.use(express.static(dist, { index: false, maxAge: '1h', setHeaders: (res, p) => { if (p.endsWith('index.html')) res.setHeader('Cache-Control', 'no-store'); } }));
  root.get('*', (req, res) => res.sendFile(path.join(dist, 'index.html')));
  root.listen(port, () => console.log(`KellasTech Exam Portal on http://localhost:${port} (db: ${app.ctx.db.kind}, storage: ${app.ctx.storage.kind})`));
} else {
  app.listen(port, () => console.log(`KellasTech Exam Portal API on http://localhost:${port} (db: ${app.ctx.db.kind}); run "npm run build" to serve the UI too.`));
}
