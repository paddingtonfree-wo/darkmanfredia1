// POST /api/chat : réponse de l'IA en streaming (SSE), avec quota de 40 messages/jour.
const C = require('./_core');

module.exports = async (req, res) => {
  if (req.method === 'GET') {   // diagnostic (ne montre jamais les clés)
    const f = {};
    for (const p of Object.keys(C.PROVIDERS)) f[p] = { cles: C.keysFor(p).length, modele: C.modelFor(p, false) };
    return res.status(200).json({ fonction: 'ok', ordre: C.order(), fournisseurs: f, stockage: !!(process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL) });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée.' });

  const dev = C.deviceOf(req), ip = C.ipOf(req);
  if (!dev) return res.status(400).json({ error: 'Appareil non reconnu. Recharge la page.' });
  if (C.tooFast(ip + dev)) return res.status(429).json({ error: "Trop de messages d'un coup. Attends quelques secondes." });

  const body = await C.readJson(req);
  if (!body) return res.status(400).json({ error: 'Requête invalide.' });

  const msgs = (Array.isArray(body.messages) ? body.messages : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-12)
    .map(m => ({ role: m.role, content: m.content.slice(0, 1500) }));
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return res.status(400).json({ error: 'Message manquant.' });

  // Photo jointe (uniquement sur le dernier message)
  let vision = false;
  if (body.image !== undefined && body.image !== null) {
    if (!C.validImage(body.image)) return res.status(400).json({ error: 'Image invalide ou trop lourde.' });
    const last = msgs[msgs.length - 1];
    last.content = [{ type: 'text', text: last.content }, { type: 'image_url', image_url: { url: body.image } }];
    vision = true;
  }

  const q = await C.reserve('msg', dev, ip);
  if (!q.ok) {
    return res.status(402).json({
      paywall: 'msg',
      error: `Tu as utilisé tes ${q.limit} messages du jour. Reviens demain, ou débloque l'accès illimité.`,
      usage: { messages: { used: q.limit, limit: q.limit }, premium: false }
    });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no'
  });
  if (res.flushHeaders) res.flushHeaders();
  const send = o => res.write(`data: ${JSON.stringify(o)}\n\n`);

  try {
    const out = await C.generate(msgs, { vision, onToken: t => send({ t }) });
    if (out.ok) {
      send({ done: true, via: out.via, usage: { messages: { used: q.used, limit: q.limit }, premium: q.premium } });
    } else {
      await q.release();   // l'échec ne coûte rien à l'utilisateur
      send({
        error: out.none
          ? (vision ? "Aucune IA capable de lire les images n'est configurée (ajoute une clé GEMINI_API_KEY ou GROQ_API_KEY)." : 'Aucune clé API configurée côté serveur.')
          : `Tous les serveurs d'IA sont indisponibles pour le moment. Réessaie dans un instant. (${out.notes.join(', ') || 'délai dépassé'})`
      });
    }
  } catch (e) {
    console.error('chat:', e);
    await q.release();
    send({ error: 'Erreur serveur.' });
  }
  res.end();
};
