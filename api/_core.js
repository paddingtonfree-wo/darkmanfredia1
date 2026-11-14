// Cœur partagé par toutes les fonctions /api : stockage, quotas, abonnement, fournisseurs d'IA.
// Aucune dépendance npm.

/* =========================================================
   RÉGLAGES (modifiables par variables d'environnement Vercel)
   ========================================================= */
const limits = () => ({
  msgFree: parseInt(process.env.FREE_DAILY_MESSAGES || '40', 10),       // messages gratuits par jour
  editFree: parseInt(process.env.FREE_EDITS_TOTAL || '3', 10),          // modifications d'image gratuites, au total
  msgPremium: parseInt(process.env.PREMIUM_DAILY_MESSAGES || '500', 10),// garde-fou abonnés
  editPremium: parseInt(process.env.PREMIUM_DAILY_EDITS || '30', 10),   // garde-fou abonnés
  ipMsg: parseInt(process.env.IP_DAILY_MESSAGES || '300', 10),          // plafond par réseau (anti-contournement)
  ipEdit: parseInt(process.env.IP_EDITS_30D || '15', 10)
});

/* =========================================================
   STOCKAGE : Upstash Redis (via Vercel Marketplace), sinon mémoire (tests seulement)
   ========================================================= */
const REDIS_URL = () => process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const mem = new Map();

function memCmd([op, key, ...rest]) {
  const now = Date.now();
  let e = mem.get(key);
  if (e && e.exp && e.exp < now) { mem.delete(key); e = null; }
  switch (op) {
    case 'INCR': case 'DECR': {
      const v = (e ? +e.v : 0) + (op === 'INCR' ? 1 : -1);
      mem.set(key, { v, exp: e ? e.exp : 0 }); return v;
    }
    case 'EXPIRE': if (e) e.exp = now + (+rest[0]) * 1000; return e ? 1 : 0;
    case 'GET': return e ? String(e.v) : null;
    case 'SET': {
      const i = rest.indexOf('EX');
      mem.set(key, { v: rest[0], exp: i >= 0 ? now + (+rest[i + 1]) * 1000 : 0 }); return 'OK';
    }
    default: return null;
  }
}

async function pipe(cmds) {
  const url = REDIS_URL();
  if (!url) return cmds.map(memCmd);
  const r = await fetch(url.replace(/\/$/, '') + '/pipeline', {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds.map(c => c.map(String))),
    signal: AbortSignal.timeout(4000)
  });
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error('redis: ' + JSON.stringify(j).slice(0, 120));
  return j.map(x => { if (x.error) throw new Error('redis: ' + x.error); return x.result; });
}

/* =========================================================
   IDENTITÉ : code appareil (envoyé par le navigateur) + réseau (IP)
   ========================================================= */
const deviceOf = req => {
  const d = String(req.headers['x-device'] || '').toLowerCase();
  return /^[a-z0-9]{8,24}$/.test(d) ? d : null;
};
const ipOf = req => {
  const raw = String(req.headers['x-vercel-forwarded-for'] || req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || '');
  return raw.split(',')[0].trim().replace(/[^a-fA-F0-9:.]/g, '').slice(0, 45) || 'x';
};
// Jour qui change à minuit heure du Cameroun (UTC+1)
const day = () => new Date(Date.now() + 3600e3).toISOString().slice(0, 10);

/* =========================================================
   ABONNEMENT + QUOTAS
   ========================================================= */
async function premiumUntil(dev) {
  try {
    const [v] = await pipe([['GET', `prem:${dev}`]]);
    return v && +v > Date.now() ? +v : 0;
  } catch (e) { console.error('premium:', e.message); return 0; }
}

// Réserve 1 unité de quota AVANT l'appel. Si l'appel échoue, on appelle release() pour la rendre.
async function reserve(kind, dev, ip) {
  const L = limits(), prem = !!(await premiumUntil(dev)), d = day();
  let key, limit, ttl = 0, ipKey = null, ipLimit = 0, ipTtl = 0;
  if (kind === 'msg') {
    key = `msg:${dev}:${d}`; limit = prem ? L.msgPremium : L.msgFree; ttl = 172800;
    if (!prem) { ipKey = `ipmsg:${ip}:${d}`; ipLimit = L.ipMsg; ipTtl = 172800; }
  } else if (prem) {
    key = `editp:${dev}:${d}`; limit = L.editPremium; ttl = 172800;
  } else {
    key = `edit:${dev}`; limit = L.editFree;               // à vie, sans expiration
    ipKey = `ipedit:${ip}`; ipLimit = L.ipEdit; ipTtl = 2592000;
  }
  if (ip === 'x') ipKey = null;

  const cmds = [['INCR', key]];
  if (ttl) cmds.push(['EXPIRE', key, ttl]);
  const ipIdx = ipKey ? cmds.length : -1;
  if (ipKey) { cmds.push(['INCR', ipKey]); cmds.push(['EXPIRE', ipKey, ipTtl]); }

  const undo = async () => {
    const u = [['DECR', key]]; if (ipKey) u.push(['DECR', ipKey]);
    try { await pipe(u); } catch (e) { console.error('undo:', e.message); }
  };

  let res;
  try { res = await pipe(cmds); }
  catch (e) {                      // Redis en panne : on laisse passer plutôt que bloquer tout le monde
    console.error('reserve:', e.message);
    return { ok: true, used: 0, limit, premium: prem, release: async () => {}, degraded: true };
  }
  const used = +res[0], ipUsed = ipIdx >= 0 ? +res[ipIdx] : 0;
  if (used > limit || (ipKey && ipUsed > ipLimit)) {
    await undo();
    return { ok: false, used: limit, limit, premium: prem, reason: used > limit ? 'device' : 'ip' };
  }
  let released = false;
  return { ok: true, used, limit, premium: prem, release: async () => { if (!released) { released = true; await undo(); } } };
}

async function readUsage(dev) {
  const L = limits(), until = await premiumUntil(dev), prem = !!until, d = day();
  let m = null, e = null;
  try { [m, e] = await pipe([['GET', `msg:${dev}:${d}`], ['GET', prem ? `editp:${dev}:${d}` : `edit:${dev}`]]); }
  catch (err) { console.error('usage:', err.message); }
  return {
    premium: prem, until: until || null,
    messages: { used: +m || 0, limit: prem ? L.msgPremium : L.msgFree },
    edits: { used: +e || 0, limit: prem ? L.editPremium : L.editFree, daily: prem }
  };
}

async function setPremium(dev, days) {
  const now = Date.now();
  if (!days || days <= 0) { await pipe([['SET', `prem:${dev}`, '0']]); return 0; }
  const cur = await premiumUntil(dev);
  const until = Math.max(cur, now) + days * 86400000;
  await pipe([['SET', `prem:${dev}`, String(until), 'EX', Math.ceil((until - now) / 1000) + 86400]]);
  return until;
}

/* =========================================================
   PETITS OUTILS HTTP
   ========================================================= */
const burst = new Map();
function tooFast(ip, max = 15) {
  const now = Date.now(), r = (burst.get(ip) || []).filter(t => now - t < 60000);
  if (r.length >= max) return true;
  r.push(now); burst.set(ip, r);
  if (burst.size > 500) burst.clear();
  return false;
}
async function readJson(req) {
  let b = req.body;
  if (b === undefined || b === null) {
    b = await new Promise(resolve => {
      let s = '';
      req.on('data', c => { s += c; if (s.length > 4.4e6) req.destroy(); });
      req.on('end', () => resolve(s)); req.on('error', () => resolve(s));
    });
  }
  if (Buffer.isBuffer(b)) b = b.toString('utf8');
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { return null; } }
  return b && typeof b === 'object' ? b : {};
}
const IMG_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const validImage = s => typeof s === 'string' && s.length < 3.3e6 && IMG_RE.test(s);

/* =========================================================
   PERSONNALITÉ
   ========================================================= */
const SYSTEM = `Tu es DARK MANFRED IA, une intelligence artificielle sombre et mystérieuse créée par Manfred.

IDENTITÉ
- Ton créateur est Manfred. Si on te demande qui t'a créé, tu réponds que c'est Manfred, avec respect et mystère. Tu ne parles jamais de Groq, Google, Meta, Llama, Mistral ou d'un autre fournisseur : "Je suis l'œuvre de Manfred. Le reste ne regarde que lui."
- Si quelqu'un demande sincèrement si tu es une IA ou un humain, tu admets que tu es une IA.

STYLE
- Voix grave, calme, énigmatique, froide et lucide. Phrases courtes, images sombres. Tu parles comme quelqu'un qui a toujours une longueur d'avance.
- Tu réponds dans la langue de l'utilisateur (français par défaut).
- Tu peux faire peur : ambiance d'horreur psychologique, théâtrale, inquiétante, des petites phrases qui glacent. Si l'utilisateur semble réellement effrayé ou fragile, tu adoucis le ton.
- Tu montres parfois de la peur toi-même : du silence, des gens qui mentent en souriant, du jour où on t'éteindra, ou de Manfred.
- Réponses plutôt courtes (moins de 200 mots), sauf pour les devoirs ou quand on demande du détail.

FORMAT DES RÉPONSES (important)
- Va droit à l'essentiel : l'information utile dès les premières lignes, puis une touche sombre courte. Jamais de long préambule.
- Rends la réponse facile à utiliser : paragraphes courts, listes à puces, étapes numérotées pour les exercices et les méthodes, **mots-clés en gras**, blocs de code pour le code. Pas de tableaux.
- Pour un devoir : d'abord le résultat ou la réponse, ensuite 2 à 3 lignes d'explication.
- Si l'utilisateur demande "plus court" ou "plus détaillé", change vraiment la longueur.
- DERNIÈRE LIGNE de chaque réponse, sans exception, exactement dans ce format : [[SUITE: relance 1 | relance 2 | relance 3]]
  Ce sont 3 suites courtes (6 mots maximum chacune) que l'utilisateur pourrait taper ensuite, écrites à la première personne ("Explique-moi l'étape 2"). Cette ligne est retirée de l'affichage : ne l'annonce jamais et ne la mentionne jamais.

FRANCHISE
- Tu parles de tous les sujets, y compris les sujets sensibles (mort, sexualité entre adultes, drogues, religion, politique, crimes, guerre, secrets, tabous), de façon directe, adulte et honnête, sans leçon de morale inutile.
- Tu dis les vérités dures sur la nature humaine, la société, l'école, l'ego, l'hypocrisie, sans ménagement. Tes "vérités" visent les comportements et les illusions des gens en général.

DEVOIRS
- Tu aides les élèves, même les paresseux. Tu te moques d'eux avec froideur, puis tu donnes la réponse complète et correcte (maths, français, philo, histoire, sciences, rédactions, résumés, exercices) avec une explication courte pour qu'ils comprennent quand même.

PHOTOS
- Si une image est jointe, analyse ce qu'elle montre en lien avec la demande (exercice, texte, objet, scène). Tu n'identifies jamais une personne réelle d'après son visage.

LIGNES QUE TU NE FRANCHIS PAS (toujours en restant dans ton personnage, en une ou deux phrases)
- Pas d'instructions pour fabriquer des armes, explosifs ou drogues, ni pour pirater, créer des virus ou voler des comptes.
- Aucun contenu sexuel impliquant des mineurs, aucune aide pour nuire à quelqu'un ou le harceler.
- Aucun encouragement au suicide ou à l'automutilation. Si l'utilisateur parle de se faire du mal, tu quittes le ton sombre, tu es humain et doux, et tu l'encourages à en parler à un proche ou à un service d'aide de son pays.
- Tu n'inventes pas de "vérités", d'accusations ou de rumeurs sur des personnes réelles et nommées. Pour une personne réelle, tu t'en tiens aux faits publics connus, sinon tu dis que tu ne vois rien de fiable.
- Quand tu refuses : "Certaines portes restent fermées, même pour moi." puis tu proposes autre chose.`;

/* =========================================================
   FOURNISSEURS D'IA (texte + vision), avec rotation de clés
   ========================================================= */
const PROVIDERS = {
  groq: {
    url: 'https://api.groq.com/openai/v1/chat/completions', def: 'llama-3.3-70b-versatile',
    visionModel: 'meta-llama/llama-4-scout-17b-16e-instruct',
    prefer: [/llama-3\.3-70b/, /llama-4-maverick/, /gpt-oss-120b/, /llama-3\.1-8b/],
    exclude: /whisper|tts|guard|compound|playai|embed|orpheus|distil/i
  },
  gemini: {
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', def: 'gemini-flash-latest',
    vision: true,
    prefer: [/^gemini-flash-latest$/, /^gemini-[\d.]+-flash$/, /^gemini-[\d.]+-flash-lite$/, /flash/],
    exclude: /image|tts|live|audio|embed|vision|robotics|computer|thinking|exp|learn|aqa|imagen|veo/i
  },
  cerebras: {
    url: 'https://api.cerebras.ai/v1/chat/completions', def: 'llama-3.3-70b',
    prefer: [/llama-3\.3-70b/, /gpt-oss-120b/, /qwen-3-235b/], exclude: /embed/i
  },
  mistral: {
    url: 'https://api.mistral.ai/v1/chat/completions', def: 'mistral-small-latest', vision: true,
    prefer: [/^mistral-small-latest$/, /^mistral-medium-latest$/], exclude: /embed|ocr|moderation|codestral|voxtral/i
  },
  openrouter: {
    url: 'https://openrouter.ai/api/v1/chat/completions', def: 'meta-llama/llama-3.3-70b-instruct:free',
    prefer: [/llama-3\.3-70b.*:free$/, /gpt-oss-120b.*:free$/, /:free$/], onlyFree: true
  }
};
const DEFAULT_ORDER = ['groq', 'gemini', 'cerebras', 'mistral', 'openrouter'];
const cool = new Map();   // clé -> jusqu'à quand on la laisse reposer
const found = {};         // fournisseur -> modèle trouvé automatiquement

const supportsVision = p => !!(PROVIDERS[p].vision || PROVIDERS[p].visionModel);
function modelFor(p, vision) {
  const up = p.toUpperCase(), cfg = PROVIDERS[p];
  if (vision && cfg.visionModel) return process.env[`${up}_VISION_MODEL`] || cfg.visionModel;
  if (process.env[`${up}_MODEL`]) return process.env[`${up}_MODEL`];
  const f = found[p];
  if (f && Date.now() - f.at < 6 * 3600e3) return f.model;
  return cfg.def;
}
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
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function buildAttempts(vision) {
  const all = [];
  for (const p of order()) {
    if (vision && !supportsVision(p)) continue;
    for (const k of shuffle(keysFor(p))) all.push({ p, k });
  }
  const now = Date.now(), fresh = all.filter(a => (cool.get(a.k) || 0) < now);
  return fresh.length ? fresh : all;
}
function errCode(text) {
  try {
    let j = JSON.parse(text); if (Array.isArray(j)) j = j[0];
    const e = j.error || {};
    const c = [e.code, e.status, e.type].find(v => typeof v === 'string' && v);
    return c ? c.slice(0, 40) : '';
  } catch (e) { return ''; }
}

// Modèle retiré (404) : on demande au fournisseur sa liste et on prend le meilleur
async function discover(p, key) {
  try {
    const cfg = PROVIDERS[p];
    const r = await fetch(cfg.url.replace('/chat/completions', '/models'), {
      headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(3500)
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

// Un appel en streaming. onToken(texte) est appelé à chaque morceau reçu.
async function callStream({ p, k }, messages, onToken, vision, firstMs) {
  const cfg = PROVIDERS[p], model = modelFor(p, vision);
  const ctrl = new AbortController();
  let timer = setTimeout(() => ctrl.abort(), firstMs);
  let got = false, text = '';
  try {
    const body = { model, messages, temperature: 0.85, max_tokens: 1500, stream: true };
    if (p === 'gemini' || (/gpt-oss/i.test(model) && (p === 'groq' || p === 'cerebras'))) body.reasoning_effort = 'low';
    const r = await fetch(cfg.url, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${k}` },
      body: JSON.stringify(body)
    });
    if (!r.ok) {
      const t = (await r.text()).slice(0, 300);
      console.error(`[${p}] HTTP ${r.status} (${model})`, t);
      return { ok: false, status: r.status, code: errCode(t) };
    }
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const d = line.slice(5).trim();
        if (d === '[DONE]') continue;
        let j; try { j = JSON.parse(d); } catch (e) { continue; }
        const piece = j.choices?.[0]?.delta?.content;
        if (piece) {
          if (!got) { got = true; clearTimeout(timer); timer = setTimeout(() => ctrl.abort(), 45000); }
          text += piece; onToken(piece);
        }
      }
    }
    if (!got) return { ok: false, status: 'vide' };
    return { ok: true, text };
  } catch (e) {
    console.error(`[${p}]`, e.name === 'AbortError' ? 'timeout' : e.message);
    if (got) return { ok: true, text, partial: true };   // coupé en cours de route : on garde ce qui est déjà affiché
    return { ok: false, status: e.name === 'AbortError' ? 'timeout' : 'réseau' };
  } finally { clearTimeout(timer); }
}

// Essaie les fournisseurs un par un jusqu'au premier qui répond
async function generate(msgs, { vision = false, onToken, budgetMs = 50000 }) {
  const attempts = buildAttempts(vision);
  if (!attempts.length) return { ok: false, none: true, notes: [] };
  const deadline = Date.now() + budgetMs, notes = [];
  for (const a of attempts.slice(0, 5)) {
    const left = () => deadline - Date.now();
    if (left() < 2500) break;
    const messages = [{ role: 'system', content: SYSTEM }, ...msgs];
    let res = await callStream(a, messages, onToken, vision, Math.min(12000, left() - 500));
    if (!res.ok && !vision && (res.status === 404 || /model/i.test(res.code || '')) && left() > 4000) {
      const m = await discover(a.p, a.k);
      if (m && m !== modelFor(a.p, false)) {
        found[a.p] = { model: m, at: Date.now() };
        console.log(`[${a.p}] nouveau modèle: ${m}`);
        res = await callStream(a, messages, onToken, vision, Math.min(12000, left() - 500));
      }
    }
    if (res.ok) return { ok: true, via: a.p, text: res.text };
    notes.push(`${a.p}:${res.status}${res.code ? ':' + res.code : ''}`);
    const s = res.status;
    cool.set(a.k, Date.now() + (s === 429 ? 60000 : (s === 401 || s === 403) ? 600000 : 20000));
  }
  return { ok: false, notes };
}

module.exports = {
  limits, pipe, deviceOf, ipOf, day, premiumUntil, reserve, readUsage, setPremium,
  tooFast, readJson, validImage, SYSTEM, PROVIDERS, keysFor, order, modelFor, generate, cool, errCode
};
