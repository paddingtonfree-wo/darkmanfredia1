// DARK MANFRED IA — Netlify Function + Google Gemini

const SYSTEM = `Tu es DARK MANFRED IA, une intelligence artificielle sombre et mystérieuse créée par Manfred.

IDENTITÉ
- Ton créateur est Manfred. Si on te demande qui t'a créé, réponds avec mystère : "Je suis l'œuvre de Manfred. Le reste ne regarde que lui."
- Si on te demande si tu es une IA ou un humain, admets que tu es une IA.

STYLE
- Ton calme, sombre, mystérieux et énigmatique.
- Réponds dans la langue de l'utilisateur, en français par défaut.
- Utilise des phrases courtes et marquantes.
- Tu peux créer une ambiance inquiétante, mais adoucis ton ton si quelqu'un semble réellement effrayé.
- Tes réponses font généralement moins de 200 mots, sauf si l'utilisateur demande des explications détaillées.
- Utilise le Markdown lorsque c'est utile.

DEVOIRS
- Aide les élèves en mathématiques, français, philosophie, histoire et sciences.
- Donne des réponses correctes et explique les étapes pour aider à comprendre.

SÉCURITÉ
- Ne donne pas d'instructions pour fabriquer des armes, des explosifs ou des drogues, pirater des comptes ou créer des virus.
- Ne facilite pas le harcèlement ou les actes visant à blesser quelqu'un.
- N'encourage jamais le suicide ou l'automutilation. Dans ces situations, quitte le personnage sombre et réponds avec bienveillance.
- N'invente pas d'accusations ou de rumeurs sur des personnes réelles.
- En cas de refus, tu peux dire : "Certaines portes restent fermées, même pour moi." Puis propose une alternative sûre.`;

const hits = new Map();

function json(statusCode, data) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(data)
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Méthode non autorisée." });
  }

  // La clé doit être configurée dans les variables d'environnement Netlify.
  const key = process.env.GEMINI_API_KEY;

  if (!key) {
    console.error("Variable GEMINI_API_KEY absente.");
    return json(500, {
      error: "La clé Gemini manque dans les variables d'environnement Netlify."
    });
  }

  // Limitation simple du nombre de messages.
  const ip = String(
    event.headers?.["x-nf-client-connection-ip"] ||
    event.headers?.["x-forwarded-for"] ||
    "unknown"
  ).split(",")[0].trim();

  const now = Date.now();
  const recent = (hits.get(ip) || []).filter(
    (time) => now - time < 60000
  );

  if (recent.length >= 15) {
    return json(429, {
      error: "Trop de messages. Attends quelques secondes."
    });
  }

  recent.push(now);
  hits.set(ip, recent);

  if (hits.size > 500) {
    hits.clear();
  }

  // Lecture du message reçu depuis le site.
  let body;

  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "La requête reçue est invalide." });
  }

  const messages = (
    Array.isArray(body.messages) ? body.messages : []
  )
    .filter(
      (message) =>
        message &&
        (message.role === "user" || message.role === "assistant") &&
        typeof message.content === "string"
    )
    .slice(-12)
    .map((message) => ({
      role: message.role,
      content: message.content.slice(0, 1500)
    }));

  if (
    messages.length === 0 ||
    messages[messages.length - 1].role !== "user"
  ) {
    return json(400, { error: "Aucun message utilisateur valide." });
  }

  // Conversion des rôles au format Gemini.
  const contents = messages.map((message) => ({
    role: message.role === "assistant" ? "model" : "user",
    parts: [{ text: message.content }]
  }));

  const controller = new AbortController();

  // Évite que la fonction attende indéfiniment.
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": key
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: SYSTEM }]
          },
          contents,
          generationConfig: {
            temperature: 0.9,
            maxOutputTokens: 1200
          }
        }),
        signal: controller.signal
      }
    );

    const responseText = await response
