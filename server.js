// Serveur pour Render, Vercel ou tout hébergeur Node. Aucune dépendance à installer.
// - Render / PC : `node server.js` démarre un serveur web.
// - Vercel : le fichier exporte simplement la fonction qui répond aux requêtes.
// Il sert index.html et réutilise la même fonction chat.js que Netlify.
const http = require('http');
const fs = require('fs');
const path = require('path');

// Sur Render il n'y a pas de limite de 10 s : on laisse plus de temps aux IA.
// (Sur Vercel on garde des délais courts.) Modifiable avec les variables d'environnement.
if (!process.env.VERCEL) {
  process.env.TIME_BUDGET_MS = process.env.TIME_BUDGET_MS || '25000';
  process.env.ATTEMPT_TIMEOUT_MS = process.env.ATTEMPT_TIMEOUT_MS || '15000';
}

// chat.js peut être dans netlify/functions/ OU à la racine du dépôt.
// Les require sont écrits "en dur" exprès : Vercel repère ainsi les fichiers à embarquer.
let handler = null;
try { handler = require('./netlify/functions/chat.js').handler; }
catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
if (!handler) {
  try { handler = require('./chat.js').handler; }
  catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
}
if (!handler) console.error('chat.js introuvable : mets-le dans netlify/functions/ ou à la racine du dépôt.');

let INDEX = null;
try { INDEX = fs.readFileSync(path.join(__dirname, 'index.html')); }
catch (e) { console.error('index.html introuvable à la racine du dépôt.'); }

// Adresses acceptées pour le chat : /chat (la nouvelle, simple), /api/chat et l'ancienne adresse Netlify.
const isChatRoute = (u) => /(^|\/)(api\/chat|chat|\.netlify\/functions\/chat)\/?$/.test(u);

function sendJSON(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    // Vercel peut avoir déjà lu le corps de la requête
    if (req.body !== undefined && req.body !== null) {
      const b = req.body;
      return resolve(typeof b === 'string' ? b : Buffer.isBuffer(b) ? b.toString('utf8') : JSON.stringify(b));
    }
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 20000) req.destroy(); // messages trop gros : on coupe
    });
    req.on('end', () => resolve(body));
    req.on('error', () => resolve(body));
  });
}

async function app(req, res) {
  const url = (req.url || '/').split('?')[0];

  if (isChatRoute(url)) {
    if (!handler) return sendJSON(res, 500, { error: 'Fichier chat.js introuvable sur le serveur (mets-le à la racine du dépôt ou dans netlify/functions/).' });
    try {
      const body = req.method === 'POST' ? await readBody(req) : '';
      const query = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
      const out = await handler({ httpMethod: req.method, headers: req.headers, body, queryStringParameters: query });
      res.writeHead(out.statusCode, out.headers || { 'Content-Type': 'application/json' });
      res.end(out.body);
    } catch (e) {
      console.error('handler:', e.message);
      sendJSON(res, 500, { error: 'Erreur serveur.' });
    }
    return;
  }

  if (url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }

  if (url.startsWith('/favicon')) {
    res.writeHead(204);
    return res.end();
  }

  if (url === '/' || url === '/index.html') {
    if (!INDEX) { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('index.html introuvable'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(INDEX);
  }

  // JSON + chemin vu par le serveur : le site l'affiche, ça aide à comprendre une erreur 404
  sendJSON(res, 404, { error: `Route introuvable sur le serveur (${req.method} ${url}).` });
}

module.exports = app; // Vercel utilise cette fonction

if (require.main === module) { // Render / lancement direct : on démarre le serveur
  const PORT = process.env.PORT || 10000;
  http.createServer(app).listen(PORT, () => console.log(`Dark Manfred IA prêt sur le port ${PORT}`));
}
