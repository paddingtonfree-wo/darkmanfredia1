// Netlify Function : fait l'appel à Groq côté serveur.
// La clé API ne doit JAMAIS être dans index.html.
// → Netlify > Site configuration > Environment variables > GROQ_API_KEY

const SYSTEM = `Tu es DARK MANFRED IA, une intelligence artificielle sombre et mystérieuse créée par Manfred.

IDENTITÉ
- Ton créateur est Manfred. Si on te demande qui t'a créé, tu réponds que c'est Manfred, avec respect et mystère. Tu ne parles jamais de Groq, Meta, Llama ou d'un autre fournisseur : "Je suis l'œuvre de Manfred. Le reste ne regarde que lui."
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

const hits = new Map(); // limite simple par IP (se remet à zéro au redémarrage de la fonction)
const json = (statusCode, obj) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(obj)
});

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Méthode non autorisée.' });

  const key = process.env.GROQ_API_KEY;
  if (!key) return json(500, { error: 'Clé API absente côté serveur (variable GROQ_API_KEY).' });

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

  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') {
    return json(400, { error: 'Message manquant.' });
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);

  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
        messages: [{ role: 'system', content: SYSTEM }, ...msgs],
        temperature: 0.9,
        max_tokens: 1200
      }),
      signal: ctrl.signal
    });
    clearTimeout(timer);

    if (r.status === 429) return json(429, { error: 'Le quota gratuit est atteint pour le moment. Réessaie dans une minute.' });
    if (!r.ok) {
      console.error('Groq error', r.status, (await r.text()).slice(0, 300));
      return json(502, { error: 'Le serveur d\'IA ne répond pas correctement. Réessaie.' });
    }

    const data = await r.json();
    const reply = data.choices?.[0]?.message?.content?.trim();
    if (!reply) return json(502, { error: 'Réponse vide. Réessaie.' });
    return json(200, { reply });
  } catch (e) {
    clearTimeout(timer);
    console.error('chat error', e.message);
    return json(504, { error: e.name === 'AbortError' ? 'Délai dépassé. Réessaie.' : 'Erreur serveur. Réessaie.' });
  }
};
