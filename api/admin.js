// POST /api/admin : active ou retire un abonnement pour un code appareil.
// Corps : { key, code, days }   (days = 0 pour retirer). La clé = variable ADMIN_KEY.
const crypto = require('crypto');
const C = require('./_core');

const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée.' });
  const admin = process.env.ADMIN_KEY;
  if (!admin) return res.status(500).json({ error: "ADMIN_KEY n'est pas définie sur Vercel." });
  if (C.tooFast('admin' + C.ipOf(req), 10)) return res.status(429).json({ error: 'Trop de tentatives.' });

  const b = await C.readJson(req);
  if (!b || !same(b.key || '', admin)) return res.status(401).json({ error: 'Clé admin incorrecte.' });

  const code = String(b.code || '').trim().toLowerCase();
  if (!/^[a-z0-9]{8,24}$/.test(code)) return res.status(400).json({ error: 'Code appareil invalide.' });
  const days = Math.max(0, Math.min(365, parseInt(b.days, 10) || 0));
  const until = await C.setPremium(code, days);
  res.status(200).json({ ok: true, code, until: until || null, message: until ? `Abonné jusqu'au ${new Date(until).toLocaleDateString('fr-FR')}` : 'Abonnement retiré.' });
};
