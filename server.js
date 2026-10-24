// Serveur pour Render (ou tout hébergeur Node). Aucune dépendance à installer.
// Il sert index.html et réutilise la même fonction que Netlify : le projet marche sur les deux.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { handler } = require('./netlify/functions/chat.js');

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
        const out = await handler({ httpMethod: req.method, headers: req.headers, body });
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
