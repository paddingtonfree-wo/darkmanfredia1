// Serveur pour Render (ou tout hébergeur Node). Aucune dépendance à installer.
// Il sert index.html et réutilise la même fonction que Netlify : le projet marche sur les deux.
const http = require('http');
const fs = require('fs');
const path = require('path');
// chat.js peut être dans netlify/functions/ (Netlify) OU à la racine du dépôt (plus simple à envoyer depuis un téléphone)
function loadHandler() {
  for (const p of ['./netlify/functions/chat.js', './chat.js']) {
    try { return require(p).handler; }
    catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
  }
  console.error('chat.js introuvable : mets-le dans netlify/functions/ ou à la racine du dépôt.');
  process.exit(1);
}
const handler = loadHandler();

const PORT = process.env.PORT || 10000;
const ROUTE = '/.netlify/functions/chat'; // même adresse que sur Netlify : index.html n'a pas besoin de changer
const INDEX = path.join(__dirname, 'index.html');

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];

  if (url === ROUTE) {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 20000) req.destroy(); // messages trop gros : on coupe
    });
    req.on('end', async () => {
      try {
        const query = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
        const out = await handler({ httpMethod: req.method, headers: req.headers, body, queryStringParameters: query });
        res.writeHead(out.statusCode, out.headers || { 'Content-Type': 'application/json' });
        res.end(out.body);
      } catch (e) {
        console.error('handler:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Erreur serveur.' }));
      }
    });
    return;
  }

  if (url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }

  if (url === '/' || url === '/index.html') {
    fs.readFile(INDEX, (err, data) => {
      if (err) { res.writeHead(500); return res.end('index.html introuvable'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Introuvable');
});

server.listen(PORT, () => console.log(`Dark Manfred IA prêt sur le port ${PORT}`));
