// GET /api/usage : quotas restants de l'appareil + infos d'abonnement.
const C = require('./_core');

module.exports = async (req, res) => {
  const dev = C.deviceOf(req);
  if (!dev) return res.status(400).json({ error: 'Appareil non reconnu.' });
  const u = await C.readUsage(dev);
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    ...u,
    payUrl: process.env.PAYMENT_URL || '',
    price: process.env.PRICE_LABEL || '',
    stockage: !!(process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL)
  });
};
