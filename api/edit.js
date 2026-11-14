// POST /api/edit : modifie une photo selon une consigne. 3 modifications gratuites par personne, à vie.
// Utilise Gemini (modèle d'image) avec les mêmes clés GEMINI_API_KEY que le chat.
const C = require('./_core');

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const imgModel = { name: null, at: 0 };

// Refus immédiat des demandes de nudité / sexualisation sur des photos
const BLOCK = /\b(nu|nue|nus|nues|d[ée]shabill\w*|d[ée]nud\w*|topless|nude|naked|undress\w*|lingerie|sexy|porn\w*|sexuel\w*|seins?|fesses?)\b/i;
const PREFIX = "Modifie cette photo selon la demande suivante. Garde tout le reste fidèle à l'original (visages, proportions, lumière, cadrage) sauf si la demande dit le contraire. Demande : ";

function modelName() {
  return process.env.GEMINI_IMAGE_MODEL || (imgModel.name && Date.now() - imgModel.at < 6 * 3600e3 ? imgModel.name : 'gemini-2.5-flash-image');
}

// Si le modèle d'image est retiré (404), on cherche tout seul un modèle d'image valide
async function discoverImageModel(key) {
  try {
    const r = await fetch(`${BASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    const d = await r.json();
    const ids = (d.models || [])
      .filter(m => /image/i.test(m.name) && !/imagen/i.test(m.name) && (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => m.name.replace(/^models\//, ''));
    ids.sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
    return ids.find(i => /flash-image/.test(i)) || ids[0] || null;
  } catch (e) { return null; }
}

async function callImage(key, mime, b64, prompt, ms) {
  const model = modelName();
  const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(`${BASE}/models/${model}:generateContent`, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ parts: [{ text: PREFIX + prompt }, { inlineData: { mimeType: mime, data: b64 } }] }],
        generationConfig: { responseModalities: ['IMAGE', 'TEXT'] }
      })
    });
    if (!r.ok) {
      const t = (await r.text()).slice(0, 300);
      console.error(`[edit] HTTP ${r.status} (${model})`, t);
      return { ok: false, status: r.status, code: C.errCode(t) };
    }
    const j = await r.json();
    const parts = j.candidates?.[0]?.content?.parts || [];
    const img = parts.find(p => p.inlineData || p.inline_data);
    const d = img && (img.inlineData || img.inline_data);
    if (!d || !d.data) {
      return { ok: false, status: 'refus', code: j.promptFeedback?.blockReason || j.candidates?.[0]?.finishReason || '' };
    }
    return {
      ok: true,
      image: `data:${d.mimeType || d.mime_type || 'image/png'};base64,${d.data}`,
      text: parts.filter(p => p.text).map(p => p.text).join(' ').trim().slice(0, 400)
    };
  } catch (e) {
    console.error('[edit]', e.name === 'AbortError' ? 'timeout' : e.message);
    return { ok: false, status: e.name === 'AbortError' ? 'timeout' : 'réseau' };
  } finally { clearTimeout(timer); }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée.' });

  const dev = C.deviceOf(req), ip = C.ipOf(req);
  if (!dev) return res.status(400).json({ error: 'Appareil non reconnu. Recharge la page.' });
  if (C.tooFast('e' + ip + dev, 6)) return res.status(429).json({ error: 'Doucement… attends un instant.' });

  const body = await C.readJson(req);
  if (!body) return res.status(400).json({ error: 'Requête invalide.' });
  const prompt = String(body.prompt || '').trim().slice(0, 500);
  if (prompt.length < 3) return res.status(400).json({ error: 'Décris la modification à faire.' });
  if (!C.validImage(body.image)) return res.status(400).json({ error: 'Image invalide ou trop lourde.' });
  if (BLOCK.test(prompt)) return res.status(422).json({ error: 'Certaines portes restent fermées, même pour moi. Demande-moi une autre modification.' });

  const keys = C.keysFor('gemini');
  if (!keys.length) return res.status(500).json({ error: "La modification d'image demande une clé GEMINI_API_KEY sur le serveur." });

  const q = await C.reserve('edit', dev, ip);
  if (!q.ok) {
    return res.status(402).json({
      paywall: 'edit',
      error: `Tes ${q.limit} modifications d'image gratuites sont utilisées. Abonne-toi pour continuer.`,
      usage: { edits: { used: q.limit, limit: q.limit }, premium: false }
    });
  }

  const [, mime, b64] = body.image.match(/^data:(image\/[a-z]+);base64,(.+)$/);
  const deadline = Date.now() + 52000;
  const shuffled = [...keys].sort(() => Math.random() - 0.5).filter(k => (C.cool.get(k) || 0) < Date.now());
  const notes = [];
  let result = null;

  try {
    for (const k of (shuffled.length ? shuffled : keys).slice(0, 3)) {
      const left = deadline - Date.now();
      if (left < 6000) break;
      let r = await callImage(k, mime, b64, prompt, Math.min(40000, left - 500));
      if (!r.ok && r.status === 404 && !process.env.GEMINI_IMAGE_MODEL && deadline - Date.now() > 12000) {
        const m = await discoverImageModel(k);
        if (m) { imgModel.name = m; imgModel.at = Date.now(); r = await callImage(k, mime, b64, prompt, Math.min(40000, deadline - Date.now() - 500)); }
      }
      if (r.ok) { result = r; break; }
      notes.push(`${r.status}${r.code ? ':' + r.code : ''}`);
      if (r.status === 'refus') break;   // refus de contenu : inutile d'essayer une autre clé
      C.cool.set(k, Date.now() + (r.status === 429 ? 60000 : (r.status === 401 || r.status === 403) ? 600000 : 20000));
    }
  } catch (e) { console.error('edit:', e); }

  if (!result) {
    await q.release();   // une modification ratée ne compte pas
    const refused = notes[0] && notes[0].startsWith('refus');
    return res.status(refused ? 422 : 502).json({
      error: refused
        ? "Je n'ai pas pu faire cette modification (demande refusée ou trop floue). Reformule autrement : elle ne t'a rien coûté."
        : `Le service de retouche est indisponible pour le moment. Réessaie : rien n'a été décompté. (${notes.join(', ') || 'délai'})`
    });
  }

  res.status(200).json({
    image: result.image,
    text: result.text,
    usage: { edits: { used: q.used, limit: q.limit, daily: q.premium }, premium: q.premium }
  });
};
