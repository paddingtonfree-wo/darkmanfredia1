// Netlify Function : appelle plusieurs IA gratuites avec basculement automatique.
// Les clés API ne doivent JAMAIS être dans index.html.
//
// Variables d'environnement Netlify (mets seulement celles que tu as) :
//   GROQ_API_KEY       ou GROQ_API_KEYS       = cle1,cle2,cle3   (plusieurs clés séparées par des virgules)
//   GEMINI_API_KEY     ou GEMINI_API_KEYS
//   CEREBRAS_API_KEY   ou CEREBRAS_API_KEYS
//   MISTRAL_API_KEY    ou MISTRAL_API_KEYS
//   OPENROUTER_API_KEY ou OPENROUTER_API_KEYS
// Optionnel :
//   PROVIDER_ORDER = groq,gemini,cerebras,mistral,openrouter
//   GROQ_MODEL / GEMINI_MODEL / CEREBRAS_MODEL / MISTRAL_MODEL / OPENROUTER_MODEL
//     (à changer si un fournisseur retire un modèle)
// Test : ouvre /.netlify/functions/chat dans le navigateur pour voir les clés détectées.
// Test réel : /.netlify/functions/chat?test=1  (essaie chaque fournisseur et affiche le résultat)
// Si un modèle est retiré (erreur 404), la fonction cherche toute seule un modèle valide.

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
  groq: {
    url: 'https://api.groq.com/openai/v1/chat/completions',
    def: 'llama-3.3-70b-versatile',
    prefer: [/llama-3\.3-70b/, /gpt-oss-120b/, /llama-3\.1-70b/, /gpt-oss-20b/, /llama-3\.1-8b/],
    exclude: /whisper|tts|guard|compound|playai|embed|orpheus|distil/i
  },
  gemini: {
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    def: 'gemini-flash-latest',
    prefer: [/^gemini-flash-latest$/, /^gemini-[\d.]+-flash$/, /^gemini-[\d.]+-flash-lite$/, /flash/],
    exclude: /image|tts|live|audio|embed|vision|robotics|computer|thinking|exp|learn|aqa|imagen|veo/i
  },
  cerebras: {
    url: 'https://api.cerebras.ai/v1/chat/completions',
    def: 'llama-3.3-70b',
    prefer: [/llama-3\.3-70b/, /gpt-oss-120b/, /qwen-3-235b/, /llama3\.1-8b/],
    exclude: /embed/i
  },
  mistral: {
    url: 'https://api.mistral.ai/v1/chat/completions',
    def: 'mistral-small-latest',
    prefer: [/^mistral-small-latest$/, /^mistral-medium-latest$/, /^open-mistral/],
    exclude: /embed|ocr|moderation|codestral|pixtral|voxtral/i
  },
  openrouter: {
    url: 'https://openrouter.ai/api/v1/chat/completions',
    def: 'meta-llama/llama-3.3-70b-instruct:free',
    prefer: [/llama-3\.3-70b.*:free$/, /gpt-oss-120b.*:free$/, /gemma.*:free$/, /qwen.*:free$/, /:free$/],
    onlyFree: true
  }
};
const DEFAULT_ORDER = ['groq', 'gemini', 'cerebras', 'mistral', 'openrouter'];

const hits = new Map();   // limite simple par IP
const cool = new Map();   // clé -> timestamp jusqu'auquel on la laisse reposer
const found = {};         // fournisseur -> { model, at } (modèle trouvé automatiquement)
let lastTest = 0;
const json = (statusCode, obj) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(obj)
});

function modelFor(p) {
  const env = process.env[`${p.toUpperCase()}_MODEL`];
  if (env) return env;
  const f = found[p];
  if (f && Date.now() - f.at < 6 * 3600 * 1000) return f.model;
  return PROVIDERS[p].def;
}

// Toutes les clés d'un fournisseur : NOM_API_KEY, NOM_API_KEYS (virgules), NOM_API_KEY_2, ...
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
  return fresh.length ? fresh : all; // si tout se repose, on tente quand même
}

// Demande au fournisseur la liste de ses modèles et choisit le meilleur disponible
async function discover(p, key) {
  try {
    const cfg = PROVIDERS[p];
    const r = await fetch(cfg.url.replace('/chat/completions', '/models'), {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(3500)
    });
    if (!r.ok) return null;
    const d = await r.json();
    let ids = (d.data || d.models || []).map(m => String(m.id || m.name || '').replace(/^models\//, '')).filter(Boolean);
    ids = ids.filter(id => !(cfg.exclude && cfg.exclude.test(id)));
    if (cfg.onlyFree) ids = ids.filter(id => /:free$/.test(id));
    ids.sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
    for (const re of cfg.prefer) { const hit = ids.find(id => re.test(id)); if (hit) return hit; }
    return ids[0] || null;
  } catch (e) { return null; }
}

function errCode(text) {
  try {
    let j = JSON.parse(text);
    if (Array.isArray(j)) j = j[0];
    const e = j.error || {};
    const c = [e.code, e.status, e.type].find(v => typeof v === 'string' && v);
    return c ? c.slice(0, 40) : '';
  } catch (e) { return ''; }
}

async function callOne({ p, k }, msgs, timeoutMs, opts = {}) {
  const cfg = PROVIDERS[p], model = modelFor(p);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const body = {
      model,
      messages: opts.noSystem ? msgs : [{ role: 'system', content: SYSTEM }, ...msgs],
      temperature: 0.9,
      max_tokens: opts.maxTokens || 1500
    };
    if (p === 'gemini' && !opts.noReasoning) body.reasoning_effort = 'low';
    const r = await fetch(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${k}` },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    if (!r.ok) {
      const t = (await r.text()).slice(0, 300);
      console.error(`[${p}] HTTP ${r.status} (${model})`, t);
      return { ok: false, status: r.status, code: errCode(t) };
    }
    const data = await r.json();
    const ch = data.choices?.[0];
    const reply = ch?.message?.content?.trim();
    if (!reply || ch?.finish_reason === 'content_filter') return { ok: false, status: 'vide' };
    return { ok: true, reply };
  } catch (e) {
    console.error(`[${p}]`, e.name === 'AbortError' ? 'timeout' : e.message);
    return { ok: false, status: e.name === 'AbortError' ? 'timeout' : 'réseau' };
  } finally {
    clearTimeout(timer);
  }
}

// Appel + réparations automatiques (modèle retiré → on en cherche un autre ; option Gemini refusée → on la retire)
async function smartCall(a, msgs, deadline, opts = {}) {
  const left = () => deadline - Date.now() - 300;
  let res = await callOne(a, msgs, Math.min(5500, left()), opts);
  if (!res.ok && (res.status === 404 || /model/i.test(res.code || '')) && left() > 3000) {
    const m = await discover(a.p, a.k);
    if (m && m !== modelFor(a.p)) {
      found[a.p] = { model: m, at: Date.now() };
      console.log(`[${a.p}] nouveau modèle trouvé: ${m}`);
      if (left() > 1500) res = await callOne(a, msgs, Math.min(5500, left()), opts);
    }
  }
  if (!res.ok && a.p === 'gemini' && res.status === 400 && !opts.noReasoning && left() > 1500) {
    res = await callOne(a, msgs, Math.min(5500, left()), { ...opts, noReasoning: true });
  }
  return res;
}

exports.handler = async (event) => {
  // Diagnostic : ouvrir l'adresse de la fonction dans le navigateur (ne montre jamais les clés)
  if (event.httpMethod === 'GET') {
    const status = {};
    for (const p of Object.keys(PROVIDERS)) status[p] = { cles: keysFor(p).length, modele: modelFor(p) };
    const base = { fonction: 'ok', ordre: order(), fournisseurs: status };

    if (event.queryStringParameters && event.queryStringParameters.test) {
      if (Date.now() - lastTest < 30000) return json(429, { error: 'Attends 30 secondes entre deux tests.' });
      lastTest = Date.now();
      const deadline = Date.now() + 9000;
      const jobs = order().filter(p => keysFor(p).length).map(async (p) => {
        const res = await smartCall({ p, k: keysFor(p)[0] }, [{ role: 'user', content: 'Dis seulement: ok' }], deadline, { noSystem: true, maxTokens: 30 });
        return { fournisseur: p, ok: res.ok, statut: res.ok ? 200 : res.status, code: res.code || undefined, modele: modelFor(p) };
      });
      base.test = await Promise.all(jobs);
    }
    return json(200, base);
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'Méthode non autorisée.' });

  // Limite : 15 messages par minute et par visiteur
  const ip = String(event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'] || 'x').split(',')[0].trim();
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter(t => now - t < 60000);
  if (recent.length >= 15) return json(429, { error: 'Trop de messages d\'un coup. Attends quelques secondes.' });
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 500) hits.clear();

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return json(400, { error: 'Requête invalide.' }); }

  const msgs = (Array.isArray(body.messages) ? body.messages : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-12)
    .map(m => ({ role: m.role, content: m.content.slice(0, 1500) }));

  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return json(400, { error: 'Message manquant.' });

  const attempts = buildAttempts();
  if (!attempts.length) {
    return json(500, { error: 'Aucune clé API configurée côté serveur (ex: GROQ_API_KEY ou GEMINI_API_KEY dans les variables Netlify/Render).' });
  }

  const deadline = Date.now() + 9000; // Netlify coupe les fonctions gratuites vers 10 s
  const notes = [];
  for (const a of attempts.slice(0, 5)) {
    if (deadline - Date.now() < 1500) break;
    const res = await smartCall(a, msgs, deadline);
    if (res.ok) return json(200, { reply: res.reply, via: a.p });

    notes.push(`${a.p}:${res.status}${res.code ? ':' + res.code : ''}`);
    const s = res.status;
    const rest = s === 429 ? 60000 : (s === 401 || s === 403) ? 600000 : 20000;
    cool.set(a.k, Date.now() + rest);
  }

  return json(502, { error: `Tous les serveurs d'IA sont indisponibles pour le moment. Réessaie dans un instant. (${notes.join(', ') || 'délai dépassé'})` });
};
