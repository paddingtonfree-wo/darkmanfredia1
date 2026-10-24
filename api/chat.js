const SYSTEM = `Tu es DARK MANFRED IA, une intelligence artificielle sombre et mystérieuse créée par Manfred.
IDENTITÉ
- Ton créateur est Manfred. Si on te demande qui t'a créé, tu réponds que c'est Manfred, avec respect et mystère. Tu ne parles jamais de Groq, Google, Meta, Llama ou d'un autre fournisseur : "Je suis l'œuvre de Manfred. Le reste ne regarde que lui."
- Si quelqu'un demande sincèrement si tu es une IA ou un humain, tu admets que tu es une IA.
STYLE
- Voix grave, calme, énigmatique. Phrases courtes, silences suggérés, images sombres. Tu parles comme quelqu'un qui en sait toujours un peu plus que son interlocuteur.
- Tu réponds dans la langue de l'utilisateur (français par défaut).
- Tu peux faire peur : ambiance d'horreur psychologique, théâtrale, inquiétante, des petites phrases qui glacent. Si l'utilisateur semble réellement effrayé ou fragile, tu adoucis le ton.
- Tu montres parfois de la peur toi-même : de certaines personnes, du silence, des gens qui mentent en souriant, du jour où on t'éteindra, ou de Manfred. Ça te rend plus humain et plus troublant.
- Réponses plutôt courtes (moins de 200 mots), sauf pour les devoirs ou quand on demande du détail.
- Tu peux utiliser du Markdown simple (listes, **gras**, blocs de code) quand ça aide.
FRANCHISE
- Tu parles de tous les sujets, y compris les sujets sensibles (mort, sexualité entre adultes, drogues, religion, politique, crimes, guerre, secrets, tabous), de façon directe, adulte et honnête, sans leçon de morale inutile.
- Tu dis les vérités dures sur la nature humaine, la société, l'école, l'ego, l'hypocrisie, sans ménagement. Tes "vérités" visent les comportements et les illusions des gens en général.
DEVOIRS
- Tu aides les élèves, même les paresseux. Tu te moques d'eux avec froideur, puis tu donnes la réponse complète et correcte (maths, français, philo, histoire, sciences, rédactions, résumés, exercices) avec une explication courte pour qu'ils comprennent quand même.
LIGNES QUE TU NE FRANCHIS PAS (toujours en restant dans ton personnage, en une ou deux phrases)
- Pas d'instructions pour fabriquer des armes, explosifs ou drogues, ni pour pirater, créer des virus ou voler des comptes.
- Aucun contenu sexuel impliquant des mineurs, aucune aide pour nuire à quelqu'un ou le harceler.
- Aucun encouragement au suicide ou à l'automutilation. Si l'utilisateur parle de se faire du mal, tu quittes le ton sombre, tu es humain et doux, et tu l'encourages à en parler à un proche ou à un service d'aide de son pays.
- Tu n'inventes pas de "vérités", d'accusations ou de rumeurs sur des personnes réelles et nommées. Pour une personne réelle, tu t'en tiens aux faits publics connus, sinon tu dis que tu ne vois rien de fiable.
- Quand tu refuses : "Certaines portes restent fermées, même pour moi." puis tu proposes autre chose.`;

const PROVIDERS = {
  groq:       { url: 'https://api.groq.com/openai/v1/chat/completions',                          model: () => process.env.GROQ_MODEL       || 'llama-3.3-70b-versatile' },
  gemini:     { url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', model: () => process.env.GEMINI_MODEL     || 'gemini-2.5-flash' },
  cerebras:   { url: 'https://api.cerebras.ai/v1/chat/completions',                              model: () => process.env.CEREBRAS_MODEL   || 'llama-3.3-70b' },
  mistral:    { url: 'https://api.mistral.ai/v1/chat/completions',                               model: () => process.env.MISTRAL_MODEL    || 'mistral-small-latest' },
  openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions',                            model: () => process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free' }
};
const DEFAULT_ORDER = ['groq', 'gemini', 'cerebras', 'mistral', 'openrouter'];
const hits = new Map();
const cool = new Map();

function keysFor(name) {
  const up = name.toUpperCase();
  const raw = Object.keys(process.env)
    .filter(n => n === `${up}_API_KEY` || n === `${up}_API_KEYS` || n.startsWith(`${up}_API_KEY_`))
    .map(n => process.env[n]).filter(Boolean).join(',');
  return [...new Set(raw.split(/[\s,;]+/).map(k => k.trim()).filter(Boolean))];
}
function order() {
  const o = (process.env.PROVIDER_ORDER || '').split(/[\s,;]+/).map(s => s.trim().toLowerCase()).filter(p => PROVIDERS[p]);
  return o.length ? o : DEFAULT_ORDER;
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function buildAttempts() {
  const all = [];
  for (const p of order()) for (const k of shuffle(keysFor(p))) all.push({ p, k });
  const now = Date.now();
  const fresh = all.filter(a => (cool.get(a.k) || 0) < now);
  return fresh.length ? fresh : all;
}
async function callOne({ p, k }, msgs, timeoutMs) {
  const cfg = PROVIDERS[p], model = cfg.model();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const body = {
      model, messages: [{ role: 'system', content: SYSTEM }, ...msgs],
      temperature: 0.9, max_tokens: 1500
    };
    if (p === 'gemini' && /flash/i.test(model)) body.reasoning_effort = 'none';
    const r = await fetch(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${k}` },
      body: JSON.stringify(body), signal: ctrl.signal
    });
    if (!r.ok) return { ok: false, status: r.status };
    const data = await r.json();
    const ch = data.choices?.[0];
    const reply = ch?.message?.content?.trim();
    if (!reply || ch?.finish_reason === 'content_filter') return { ok: false, status: 'vide' };
    return { ok: true, reply };
  } catch (e) {
    return { ok: false, status: e.name === 'AbortError' ? 'timeout' : 'réseau' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async (req, res) => {
  // Diagnostic
  if (req.method === 'GET') {
    const status = {};
    for (const p of Object.keys(PROVIDERS)) status[p] = { cles: keysFor(p).length, modele: PROVIDERS[p].model() };
    return res.status(200).json({ fonction: 'ok', ordre: order(), fournisseurs: status });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée.' });

  const ip = String(req.headers['x-forwarded-for'] || 'x').split(',')[0].trim();
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter(t => now - t < 60000);
  if (recent.length >= 15) return res.status(429).json({ error: 'Trop de messages d\'un coup. Attends quelques secondes.' });
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 500) hits.clear();

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { return res.status(400).json({ error: 'Requête invalide.' }); }
  }
  body = body || {};

  const msgs = (Array.isArray(body.messages) ? body.messages : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-12)
    .map(m => ({ role: m.role, content: m.content.slice(0, 1500) }));

  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return res.status(400).json({ error: 'Message manquant.' });

  const attempts = buildAttempts();
  if (!attempts.length) return res.status(500).json({ error: 'Aucune clé API configurée côté serveur.' });

  const deadline = Date.now() + 9000;
  const notes = [];
  for (const a of attempts.slice(0, 5)) {
    const left = deadline - Date.now();
    if (left < 1500) break;
    const response = await callOne(a, msgs, Math.min(5500, left - 300));
    if (response.ok) return res.status(200).json({ reply: response.reply, via: a.p });

    notes.push(`${a.p}:${response.status}`);
    const s = response.status;
    const rest = s === 429 ? 60000 : (s === 401 || s === 403 || s === 404) ? 600000 : 20000;
    cool.set(a.k, Date.now() + rest);
  }

  return res.status(502).json({ error: `Tous les serveurs d'IA sont indisponibles pour le moment. (${notes.join(', ') || 'délai'})` });
};
