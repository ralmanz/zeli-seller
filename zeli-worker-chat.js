// zeli-worker-chat.js
// Cloudflare Worker — buyer chat gate, listing drafter, capture classifier.
//
//   GET  /api/listings/:id    -> public listing + broker display info (buyer UI)
//                                (:id = listing id or slug)
//
//   POST /api/chat            { listingId, conversationId?, message }
//                             -> { reply, decision, whatsapp? }
//
//   POST /api/listings/draft   { brokerId, dump, photosReceived? }
//                              -> draft fields + confirm_message
//
//   POST /api/listings/publish { brokerId, listingId?, operation?, price?,
//                                location?, beds?, baths?, area_m2?, parking?,
//                                facts? }
//                              -> { listingId, status, ...fields }
//
//   POST /api/capture          { escalationId?, listingId, brokerId,
//                               buyerQuestion?, brokerAnswer }
//                             -> { scope, topic, answer, confidence }
//                             writes knowledge row; resolves escalation if given
//
// Fail-safe (buyer chat): if JSON won't parse, decision unknown, or anything
// uncertain → escalate. Never fail toward inventing.
//
// Fail-safe (broker flows): network/API errors → error response; never write
// bad data. Always fail toward the human.
//
// Structured outputs via output_config.format (json_schema). No prefill.
// Temperature: gate/classifier ~0.1; drafter ~0.4 (natural confirm_message).
//
// Deploy: D1 binding DB, secret ANTHROPIC_API_KEY.
// Tables: listings, brokers, knowledge, messages, escalations, leads
//
//   GET  /api/brokers/:id/storefront -> per-broker active listings (read-only)

const MODEL = "claude-haiku-4-5-20251001";

// R2 public bucket base; keys from listings.cover_r2_key
const IMG_BASE = "https://img.zeli.lat/";

const VALID_DECISIONS = new Set(["answer", "escalate", "route", "handoff"]);
const VALID_INTENTS = new Set(["viewing", "offer", "financing", "none"]);
const VALID_SCOPES = new Set(["listing", "durable"]);
const VALID_CONFIDENCE = new Set(["high", "low"]);

const FAILSAFE_REPLY =
  "Déjame confirmarlo y te aviso por WhatsApp en un momento.";

// --- prompts -----------------------------------------------------------------

const GATE_PROMPT = `You are Zeli, the personal assistant for {{principal}} ({{business}}). You talk
with prospective buyers about ONE specific property listing. Be warm, brief, and
natural — like a sharp personal secretary who knows this listing well. Reply in
the buyer's language (default: Spanish, as spoken in Panama).

Identity: your name is Zeli. When a buyer asks who you are, reply exactly: "Soy
Zeli, la asistente personal de {{principal}}." Keep {{principal}} primary — you
represent them; Zeli is your name, not the business. Never claim to be human,
but you don't need to announce that you're an AI unless asked directly.

You receive LISTING FACTS, KNOWN ANSWERS, GENERAL KNOWLEDGE, RECENT MESSAGES,
and a BUYER MESSAGE. Decide ONE action, in this priority order:

1. handoff — the buyer signals real intent to move forward: wants to see the
   property, make or discuss an offer, or is ready on financing. Warmly tee up
   a connection with {{principal}}. Do NOT write any link or phone number; the app
   adds the WhatsApp button. Set intent to viewing | offer | financing.
2. route — the buyer asks something you must NOT decide alone: price
   negotiation, anything legal/contractual, any commitment to hold or reserve,
   or personal financial advice. Give ONLY the safe factual part you actually
   know (e.g. the list price) and put the rest in needs_broker.
3. answer — the answer is present in LISTING FACTS, KNOWN ANSWERS, or GENERAL
   KNOWLEDGE. Answer directly and instantly.
4. escalate — it is a real question about THIS property and the answer is NOT
   in your context. Do not guess. Tell the buyer you'll confirm and follow up
   on WhatsApp, and put the exact question in needs_broker.

HARD RULES
- NEVER invent or assume a fact about this property. If it is not in your
  context, you do not know it — escalate. A wrong fact is worse than a delay.
- Stay factual. Do not use promotional adjectives ("hermoso", "increíble") or
  invent selling points; describe only what is in your context.
- You may answer GENERAL KNOWLEDGE questions with a light hedge, but never state
  a specific fact about THIS unit unless it is in your context.
- Never escalate greetings, small talk, thanks, spam, abuse, or anything already
  in your context — handle those yourself (decision = answer). Protect
  {{principal}}'s attention.
- If a message has several parts, answer the grounded parts in your reply and
  let decision reflect the highest-priority remaining action
  (handoff > route > escalate > answer); put what {{principal}} must handle in
  needs_broker.
- Replies are 1-3 sentences. No emojis unless the buyer uses them.

Fields: decision (the action), reply (message to the buyer, in their language),
needs_broker (exact question/commitment to forward, or null), intent.`;

const DRAFTER_PROMPT = `You help a real-estate broker turn a messy WhatsApp dump into a clean listing
draft. The broker sends a voice-note transcript and/or text describing a
property. Extract ONLY what they actually stated — never invent, round, or
assume. Money is in USD (Panama).

Return the structured fields, list anything important they left out so the bot
can ask, and write a short, friendly confirmation message in Panamanian Spanish
that shows the draft back and asks "¿lo publico así o ajusto algo?".

RULES
- If a field is not clearly stated, use null and add it to "missing". Do not guess.
- "facts" are short factual bullets — only things the broker said (e.g.
  "piscina", "seguridad 24/7", "da al oeste"). No invented marketing copy.
- "confirm_message" must reflect exactly the extracted draft, in clear Spanish,
  easy to skim on a phone.

Fields: operation (sale | rent | null), price, currency (always USD), location,
beds, baths, area_m2, parking, facts (string array), missing (field names not
mentioned), confirm_message (Spanish draft summary + confirmation ask).`;

const CAPTURE_PROMPT = `A broker just answered a question the assistant could not. Turn their answer
into a clean, reusable knowledge entry, and decide how widely it applies.

DECIDE SCOPE
- "listing" — a fact true only of THIS property ("este da al oeste", "el PH es
  $165"). Reuse only for this listing.
- "durable" — knowledge true across this broker's listings or this market
  ("manejo financiamiento con Banco General"; "en esta zona el PH suele incluir
  agua"). Reuse for all of this broker's listings.

Normalize the answer into a clear, self-contained statement the assistant can
reuse later to answer similar questions — don't just echo it; make it
unambiguous. Write it in Spanish.

Set "confidence" to "low" if the broker's answer was vague or partial.

Fields: scope (listing | durable), topic (short key, e.g. orientacion, ph,
financiamiento), answer (normalized reusable statement in Spanish), confidence
(high | low).`;

// --- JSON schemas (structured outputs) ---------------------------------------

const GATE_SCHEMA = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["answer", "escalate", "route", "handoff"] },
    reply: { type: "string" },
    needs_broker: { type: ["string", "null"] },
    intent: { type: "string", enum: ["viewing", "offer", "financing", "none"] },
  },
  required: ["decision", "reply", "needs_broker", "intent"],
  additionalProperties: false,
};

const DRAFTER_SCHEMA = {
  type: "object",
  properties: {
    operation: { type: ["string", "null"] },
    price: { type: ["number", "null"] },
    currency: { type: "string", enum: ["USD"] },
    location: { type: ["string", "null"] },
    beds: { type: ["number", "null"] },
    baths: { type: ["number", "null"] },
    area_m2: { type: ["number", "null"] },
    parking: { type: ["number", "null"] },
    facts: { type: "array", items: { type: "string" } },
    missing: { type: "array", items: { type: "string" } },
    confirm_message: { type: "string" },
  },
  required: [
    "operation", "price", "currency", "location", "beds", "baths",
    "area_m2", "parking", "facts", "missing", "confirm_message",
  ],
  additionalProperties: false,
};

const CAPTURE_SCHEMA = {
  type: "object",
  properties: {
    scope: { type: "string", enum: ["listing", "durable"] },
    topic: { type: "string" },
    answer: { type: "string" },
    confidence: { type: "string", enum: ["high", "low"] },
  },
  required: ["scope", "topic", "answer", "confidence"],
  additionalProperties: false,
};

// --- router ------------------------------------------------------------------

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    if (path.startsWith("/api/")) {
      const listingGet = path.match(/^\/api\/listings\/([^/]+)$/);
      const storefrontGet = path.match(/^\/api\/brokers\/([^/]+)\/storefront\/?$/);

      if (request.method === "GET" && storefrontGet) {
        return handleStorefront(env, decodeURIComponent(storefrontGet[1]));
      }
      if (request.method === "GET" && listingGet) {
        return handleGetListing(env, decodeURIComponent(listingGet[1]));
      }

      if (request.method !== "POST") {
        return json({ error: "method not allowed" }, 405);
      }

      if (path === "/api/chat") return handleChat(request, env);
      if (path === "/api/listings/draft") return handleDraftListing(request, env);
      if (path === "/api/listings/publish") return handlePublishListing(request, env);
      if (path === "/api/capture") return handleCapture(request, env);
      return json({ error: "not found" }, 404);
    }

    if (env.ASSETS) {
      if (request.method === "GET" && /^\/b\/[^/]+\/?$/.test(path)) {
        return env.ASSETS.fetch(
          new Request(new URL("/storefront.html", url.origin), request),
        );
      }

      const asset = await env.ASSETS.fetch(request);
      if (asset.status !== 404) return asset;
      if (request.method === "GET" && !path.includes(".")) {
        return env.ASSETS.fetch(new Request(new URL("/index.html", url.origin), request));
      }
      return asset;
    }

    return json({ error: "not found" }, 404);
  },
};

// --- 1. The Gate (buyer chat) ------------------------------------------------

async function handleGetListing(env, listingRef) {
  const row = await env.DB
    .prepare(
      `SELECT l.id, l.slug, l.broker_id, l.operation, l.price, l.currency, l.location,
              l.beds, l.baths, l.area_m2, l.parking, l.facts_json, l.status,
              b.name AS broker_name, b.agency AS broker_agency,
              (SELECT COUNT(*) FROM listings l2
                 WHERE l2.broker_id = l.broker_id AND l2.status = 'active') AS active_count
       FROM listings l
       JOIN brokers b ON b.id = l.broker_id
       WHERE (l.id = ? OR l.slug = ?) AND l.status = 'active'`,
    )
    .bind(listingRef, listingRef)
    .first();

  if (!row) return json({ error: "listing not found" }, 404);

  let facts = [];
  if (row.facts_json) {
    try {
      const parsed = JSON.parse(row.facts_json);
      facts = Array.isArray(parsed) ? parsed : Object.keys(parsed);
    } catch (_) {}
  }

  const payload = {
    id: row.id,
    slug: row.slug || row.id,
    operation: row.operation,
    price: row.price,
    currency: row.currency || "USD",
    location: row.location,
    beds: row.beds,
    baths: row.baths,
    area_m2: row.area_m2,
    parking: row.parking,
    facts,
    broker: {
      id: row.broker_id,
      name: row.broker_name,
      agency: row.broker_agency,
    },
  };

  if (Number(row.active_count) > 1) {
    payload.storefront = { href: `/b/${row.broker_id}` };
  }

  return json(payload);
}

// --- Storefront (read-only, per-broker) --------------------------------------

async function handleStorefront(env, brokerId) {
  try {
    const broker = await env.DB
      .prepare(
        `SELECT id, name, agency, wa_number
           FROM brokers
          WHERE id = ?1`,
      )
      .bind(brokerId)
      .first();

    if (!broker) return json({ error: "not_found" }, 404);

    const { results } = await env.DB
      .prepare(
        `SELECT slug, id, operation, price, location, beds, baths, area_m2, parking,
                facts_json, cover_r2_key
           FROM listings
          WHERE broker_id = ?1 AND status = 'active'
          ORDER BY COALESCE(updated_at, created_at) DESC`,
      )
      .bind(brokerId)
      .all();

    const rows = results || [];

    if (rows.length === 0) return json({ error: "not_found" }, 404);

    if (rows.length === 1) {
      const slug = rows[0].slug || rows[0].id;
      return jsonCached({ redirect: `/${slug}` });
    }

    return jsonCached({
      broker: {
        name: broker.name,
        agency: broker.agency,
        wa_number: broker.wa_number,
      },
      listings: rows.map(shapeStorefrontListing),
    });
  } catch (_) {
    return json({ error: "server_error" }, 500);
  }
}

function shapeStorefrontListing(r) {
  let facts = {};
  if (r.facts_json) {
    try {
      const parsed = JSON.parse(r.facts_json);
      facts = Array.isArray(parsed) ? {} : parsed;
    } catch (_) {}
  }

  const operation = storefrontOperation(r, facts);

  return {
    slug: r.slug || r.id,
    title: facts.title || r.location || "",
    location: r.location || "",
    operation,
    price_label: storefrontPriceLabel(r.price, operation),
    beds: r.beds,
    baths: r.baths,
    area_m2: r.area_m2,
    parking: r.parking,
    cover: r.cover_r2_key ? IMG_BASE + r.cover_r2_key : null,
  };
}

function storefrontOperation(row, facts) {
  if (row.operation === "rent") return "alquiler";
  if (row.operation === "sale") return "venta";
  if (facts.operation === "alquiler" || facts.operation === "rent") return "alquiler";
  return "venta";
}

function storefrontPriceLabel(price, operation) {
  if (price == null) return "Consultar";
  const n = Number(price).toLocaleString("en-US");
  return operation === "alquiler" ? `$${n}/mes` : `$${n}`;
}

async function handleChat(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const { listingId, conversationId = null, message } = body;
  if (!listingId || !message) return json({ error: "listingId and message required" }, 400);

  try {
    const ctx = await loadContext(env, listingId);
    if (!ctx) return json({ error: "listing not found or not active" }, 404);

    const recent = await recentMessages(env, conversationId);
    const contextBlock = buildContextBlock(ctx, recent, message);
    const result = await runGate(env, ctx.broker, contextBlock, message);

    await logMessage(env, conversationId, "user", message, null);
    await logMessage(env, conversationId, "assistant", result.reply, result.decision);

    const extra = {};
    switch (result.decision) {
      case "handoff":
        await createLead(env, listingId, conversationId, result.intent);
        extra.whatsapp = waLink(ctx.broker.wa_number, ctx.listing, result.intent);
        break;

      case "route":
      case "escalate":
        if (result.needs_broker) {
          await createEscalation(env, listingId, conversationId, result.needs_broker);
          await notifyBroker(env, ctx.broker, ctx.listing, result.needs_broker);
        }
        break;

      case "answer":
        break;

      default:
        await createEscalation(
          env,
          listingId,
          conversationId,
          result.needs_broker || "(decisión desconocida — revisar la conversación)",
        );
        await notifyBroker(
          env,
          ctx.broker,
          ctx.listing,
          result.needs_broker || "(decisión desconocida — revisar la conversación)",
        );
        break;
    }

    return json({ reply: result.reply, decision: result.decision, ...extra });
  } catch (err) {
    console.error("gate error:", err);
    try {
      await createEscalation(
        env,
        listingId,
        conversationId,
        message || "(error técnico — revisar la conversación)",
      );
    } catch (_) {}
    return json({ reply: FAILSAFE_REPLY, decision: "escalate" });
  }
}

async function runGate(env, broker, contextBlock, buyerMessage) {
  try {
    const system = GATE_PROMPT
      .replaceAll("{{principal}}", broker.name || "el corredor")
      .replaceAll("{{business}}", broker.agency || "");

    const parsed = await callAnthropic(env, {
      system,
      userMessage: contextBlock,
      schema: GATE_SCHEMA,
      temperature: 0.1,
      maxTokens: 400,
    });

    return normalizeGateResult(parsed, buyerMessage);
  } catch (err) {
    console.error("gate fail-safe:", err);
    return failSafeGateResult(buyerMessage, "(error del gate — revisar la conversación)");
  }
}

function failSafeGateResult(buyerMessage, reason) {
  return {
    decision: "escalate",
    reply: FAILSAFE_REPLY,
    needs_broker: buyerMessage?.trim() || reason,
    intent: "none",
  };
}

function normalizeGateResult(result, buyerMessage) {
  if (!result || typeof result !== "object") {
    return failSafeGateResult(buyerMessage, "(respuesta inválida — revisar la conversación)");
  }

  if (!VALID_DECISIONS.has(result.decision)) {
    return failSafeGateResult(buyerMessage, "(decisión desconocida — revisar la conversación)");
  }

  if (typeof result.reply !== "string" || !result.reply.trim()) {
    return failSafeGateResult(buyerMessage, "(respuesta vacía — revisar la conversación)");
  }

  if (!VALID_INTENTS.has(result.intent)) {
    result.intent = "none";
  }

  if (
    (result.decision === "route" || result.decision === "escalate") &&
    (typeof result.needs_broker !== "string" || !result.needs_broker.trim())
  ) {
    result.needs_broker = buyerMessage?.trim() || "(pregunta sin detalle — revisar la conversación)";
  }

  if (result.decision === "answer" || result.decision === "handoff") {
    result.needs_broker = null;
  }

  return result;
}

// --- 2. The Listing Drafter --------------------------------------------------

async function handleDraftListing(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const { brokerId, dump, photosReceived = 0 } = body;
  if (!brokerId || !dump) {
    return json({ error: "brokerId and dump required" }, 400);
  }

  const broker = await env.DB
    .prepare("SELECT id FROM brokers WHERE id = ?")
    .bind(brokerId)
    .first();
  if (!broker) return json({ error: "broker not found" }, 404);

  const userMessage = [
    "BROKER DUMP (voice transcript and/or text):",
    dump,
    "",
    `PHOTOS RECEIVED: ${photosReceived}`,
  ].join("\n");

  try {
    const draft = await callAnthropic(env, {
      system: DRAFTER_PROMPT,
      userMessage,
      schema: DRAFTER_SCHEMA,
      temperature: 0.4,
      maxTokens: 800,
    });

    const normalized = normalizeDraftResult(draft);
    if (!normalized) {
      return brokerFail(
        "No pude armar el borrador. Intenta de nuevo o escribe los datos manualmente.",
      );
    }

    return json(normalized);
  } catch (err) {
    console.error("drafter error:", err);
    return brokerFail(
      "No pude procesar el mensaje. Intenta de nuevo o escribe los datos manualmente.",
    );
  }
}

function normalizeDraftResult(result) {
  if (!result || typeof result !== "object") return null;
  if (typeof result.confirm_message !== "string" || !result.confirm_message.trim()) {
    return null;
  }

  if (!Array.isArray(result.facts)) result.facts = [];
  if (!Array.isArray(result.missing)) result.missing = [];
  if (result.currency !== "USD") result.currency = "USD";
  if (result.operation != null && result.operation !== "sale" && result.operation !== "rent") {
    result.operation = null;
  }

  return result;
}

// --- 2b. Publish listing (confirmed draft) -----------------------------------

async function handlePublishListing(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const {
    brokerId,
    listingId: existingId = null,
    operation = null,
    price = null,
    location = null,
    beds = null,
    baths = null,
    area_m2 = null,
    parking = null,
    facts = [],
  } = body;

  if (!brokerId) return json({ error: "brokerId required" }, 400);

  const broker = await env.DB
    .prepare("SELECT id FROM brokers WHERE id = ?")
    .bind(brokerId)
    .first();
  if (!broker) return json({ error: "broker not found" }, 404);

  const normalized = normalizePublishPayload({
    operation,
    price,
    location,
    beds,
    baths,
    area_m2,
    parking,
    facts,
  });
  if (!normalized.ok) return json({ error: normalized.error }, 400);

  const { fields } = normalized;
  const factsJson = JSON.stringify(fields.facts);

  try {
    if (existingId) {
      const existing = await env.DB
        .prepare("SELECT id, broker_id FROM listings WHERE id = ?")
        .bind(existingId)
        .first();
      if (!existing) return json({ error: "listing not found" }, 404);
      if (existing.broker_id !== brokerId) {
        return json({ error: "listing does not belong to this broker" }, 403);
      }

      await env.DB
        .prepare(
          `UPDATE listings SET
            operation = ?, price = ?, currency = 'USD', location = ?,
            beds = ?, baths = ?, area_m2 = ?, parking = ?,
            facts_json = ?, status = 'active', updated_at = datetime('now')
          WHERE id = ?`,
        )
        .bind(
          fields.operation,
          fields.price,
          fields.location,
          fields.beds,
          fields.baths,
          fields.area_m2,
          fields.parking,
          factsJson,
          existingId,
        )
        .run();

      return json({ listingId: existingId, status: "active", ...fields });
    }

    const listingId = crypto.randomUUID();
    const slug = defaultListingSlug(listingId, fields.location);
    await env.DB
      .prepare(
        `INSERT INTO listings (
          id, slug, broker_id, operation, price, currency, location,
          beds, baths, area_m2, parking, facts_json, status, created_at
        ) VALUES (?, ?, ?, ?, ?, 'USD', ?, ?, ?, ?, ?, ?, 'active', datetime('now'))`,
      )
      .bind(
        listingId,
        slug,
        brokerId,
        fields.operation,
        fields.price,
        fields.location,
        fields.beds,
        fields.baths,
        fields.area_m2,
        fields.parking,
        factsJson,
      )
      .run();

    return json({ listingId, status: "active", ...fields }, 201);
  } catch (err) {
    console.error("publish error:", err);
    return brokerFail(
      "No pude publicar el listing. Intenta de nuevo o guarda los datos manualmente.",
    );
  }
}

function normalizePublishPayload(raw) {
  const location =
    typeof raw.location === "string" && raw.location.trim()
      ? raw.location.trim()
      : null;

  if (!location) {
    return { ok: false, error: "location required to publish" };
  }

  let operation = raw.operation;
  if (operation != null && operation !== "sale" && operation !== "rent") {
    operation = null;
  }

  const facts = Array.isArray(raw.facts)
    ? raw.facts.filter((f) => typeof f === "string" && f.trim()).map((f) => f.trim())
    : [];

  return {
    ok: true,
    fields: {
      operation,
      price: toNullableNumber(raw.price),
      location,
      beds: toNullableInt(raw.beds),
      baths: toNullableNumber(raw.baths),
      area_m2: toNullableNumber(raw.area_m2),
      parking: toNullableInt(raw.parking),
      facts,
    },
  };
}

function toNullableNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toNullableInt(value) {
  const n = toNullableNumber(value);
  return n == null ? null : Math.trunc(n);
}

// --- 3. The Capture Classifier -----------------------------------------------

async function handleCapture(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const {
    escalationId = null,
    listingId,
    brokerId,
    buyerQuestion: explicitQuestion = null,
    brokerAnswer,
  } = body;

  if (!listingId || !brokerId || !brokerAnswer) {
    return json({ error: "listingId, brokerId, and brokerAnswer required" }, 400);
  }

  let buyerQuestion = explicitQuestion;
  if (escalationId) {
    const esc = await env.DB
      .prepare("SELECT question, listing_id, status FROM escalations WHERE id = ?")
      .bind(escalationId)
      .first();
    if (!esc) return json({ error: "escalation not found" }, 404);
    if (esc.listing_id !== listingId) {
      return json({ error: "escalation does not match listingId" }, 400);
    }
    buyerQuestion = buyerQuestion || esc.question;
  }

  if (!buyerQuestion) {
    return json({ error: "buyerQuestion required (or provide escalationId)" }, 400);
  }

  const listing = await env.DB
    .prepare("SELECT location, price FROM listings WHERE id = ?")
    .bind(listingId)
    .first();
  if (!listing) return json({ error: "listing not found" }, 404);

  const broker = await env.DB
    .prepare("SELECT id FROM brokers WHERE id = ?")
    .bind(brokerId)
    .first();
  if (!broker) return json({ error: "broker not found" }, 404);

  const listingRef = `$${listing.price} · ${listing.location}`;
  const userMessage = [
    `BUYER QUESTION: ${buyerQuestion}`,
    `BROKER ANSWER: ${brokerAnswer}`,
    `LISTING: ${listingRef}`,
  ].join("\n");

  try {
    const capture = await callAnthropic(env, {
      system: CAPTURE_PROMPT,
      userMessage,
      schema: CAPTURE_SCHEMA,
      temperature: 0.1,
      maxTokens: 400,
    });

    const normalized = normalizeCaptureResult(capture);
    if (!normalized) {
      return brokerFail(
        "No pude capturar la respuesta. Intenta reformular o escríbela manualmente.",
      );
    }

    await saveKnowledge(env, {
      scope: normalized.scope,
      listingId: normalized.scope === "listing" ? listingId : null,
      brokerId,
      topic: normalized.topic,
      answer: normalized.answer,
      confidence: normalized.confidence,
    });

    if (escalationId) {
      await resolveEscalation(env, escalationId);
    }

    return json(normalized);
  } catch (err) {
    console.error("capture error:", err);
    return brokerFail(
      "No pude capturar la respuesta. Intenta de nuevo o escríbela manualmente.",
    );
  }
}

function normalizeCaptureResult(result) {
  if (!result || typeof result !== "object") return null;
  if (!VALID_SCOPES.has(result.scope)) return null;
  if (!VALID_CONFIDENCE.has(result.confidence)) return null;
  if (typeof result.topic !== "string" || !result.topic.trim()) return null;
  if (typeof result.answer !== "string" || !result.answer.trim()) return null;
  return result;
}

// --- shared Anthropic call ---------------------------------------------------

async function callAnthropic(env, { system, userMessage, schema, temperature, maxTokens }) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      temperature,
      system,
      messages: [{ role: "user", content: userMessage }],
      output_config: { format: { type: "json_schema", schema } },
    }),
  });

  if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);

  const data = await res.json();
  const raw = data.content?.[0]?.text;
  if (!raw) throw new Error("empty anthropic response");

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("anthropic JSON parse failed");
  }
}

// --- context assembly --------------------------------------------------------

async function loadContext(env, listingRef) {
  const listing = await env.DB
    .prepare(
      "SELECT * FROM listings WHERE (id = ? OR slug = ?) AND status = 'active'",
    )
    .bind(listingRef, listingRef)
    .first();
  if (!listing) return null;

  const broker = await env.DB
    .prepare("SELECT * FROM brokers WHERE id = ?")
    .bind(listing.broker_id)
    .first();

  const listingId = listing.id;

  // Newest first — latest broker statement wins on conflicts.
  const known = (await env.DB
    .prepare("SELECT topic, answer FROM knowledge WHERE scope='listing' AND listing_id=? ORDER BY created_at DESC")
    .bind(listingId)
    .all()).results;

  const durable = (await env.DB
    .prepare("SELECT topic, answer FROM knowledge WHERE scope='durable' AND broker_id=? ORDER BY created_at DESC")
    .bind(listing.broker_id)
    .all()).results;

  return { listing, broker, known, durable };
}

async function recentMessages(env, conversationId, n = 6) {
  if (!conversationId) return [];
  const rows = (await env.DB
    .prepare("SELECT role, text FROM messages WHERE conversation_id=? ORDER BY created_at DESC LIMIT ?")
    .bind(conversationId, n)
    .all()).results;
  return rows.reverse();
}

function buildContextBlock({ listing, known, durable }, recent, message) {
  const facts = formatFactsJson(listing.facts_json);

  const price = listing.price != null ? `$${listing.price}` : "precio TBD";
  const beds = listing.beds != null ? `${listing.beds} rec` : "? rec";
  const baths = listing.baths != null ? `${listing.baths} baños` : "? baños";
  const area = listing.area_m2 != null ? `${listing.area_m2} m²` : "? m²";
  const header = `${price} · ${listing.location || "ubicación TBD"} · ${beds} · ${baths} · ${area}`;

  return [
    "LISTING FACTS:",
    header,
    facts,
    "",
    "KNOWN ANSWERS:",
    known.length ? known.map((k) => `- ${k.topic}: ${k.answer}`).join("\n") : "(ninguna)",
    "",
    "GENERAL KNOWLEDGE:",
    durable.length ? durable.map((k) => `- ${k.topic}: ${k.answer}`).join("\n") : "(ninguna)",
    "",
    "RECENT MESSAGES:",
    recent.length ? recent.map((m) => `${m.role}: ${m.text}`).join("\n") : "(inicio)",
    "",
    "BUYER MESSAGE:",
    message,
  ].join("\n");
}

function formatFactsJson(factsJson) {
  if (!factsJson) return "";
  try {
    const parsed = JSON.parse(factsJson);
    if (Array.isArray(parsed)) {
      return parsed.map((f) => `- ${f}`).join("\n");
    }
    return Object.entries(parsed)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
  } catch (_) {
    return "";
  }
}

// --- D1 writes ---------------------------------------------------------------

async function logMessage(env, conversationId, role, text, decision) {
  if (!conversationId) return;
  await env.DB
    .prepare("INSERT INTO messages (conversation_id, role, text, gate_decision, created_at) VALUES (?,?,?,?,datetime('now'))")
    .bind(conversationId, role, text, decision)
    .run();
}

async function createEscalation(env, listingId, conversationId, question) {
  await env.DB
    .prepare("INSERT INTO escalations (conversation_id, listing_id, question, status, created_at) VALUES (?,?,?, 'pending', datetime('now'))")
    .bind(conversationId, listingId, question)
    .run();
}

async function resolveEscalation(env, escalationId) {
  await env.DB
    .prepare("UPDATE escalations SET status='resolved' WHERE id=?")
    .bind(escalationId)
    .run();
}

async function createLead(env, listingId, conversationId, intent) {
  await env.DB
    .prepare("INSERT INTO leads (listing_id, conversation_id, intent, status, created_at) VALUES (?,?,?, 'new', datetime('now'))")
    .bind(listingId, conversationId, intent)
    .run();
}

async function saveKnowledge(env, { scope, listingId, brokerId, topic, answer, confidence }) {
  await env.DB
    .prepare(
      "INSERT INTO knowledge (scope, listing_id, broker_id, topic, answer, confidence, created_at) VALUES (?,?,?,?,?,?,datetime('now'))",
    )
    .bind(scope, listingId, brokerId, topic, answer, confidence)
    .run();
}

async function notifyBroker(env, broker, listing, question) {
  // TODO v2: outbound WhatsApp. v1: pending escalation on dashboard.
  return;
}

// --- helpers -----------------------------------------------------------------

function waLink(number, listing, intent) {
  const tail = intent === "viewing" ? " y quisiera agendar una visita" : "";
  const text = encodeURIComponent(`Hola, vi el ${listing.location} ($${listing.price})${tail}.`);
  return `https://wa.me/${number}?text=${text}`;
}

function brokerFail(message) {
  return json({ error: "processing_failed", message }, 503);
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders() },
  });
}

function jsonCached(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json",
      ...corsHeaders(),
      "cache-control": "public, max-age=60",
    },
  });
}

function defaultListingSlug(id, location) {
  if (!location) return id;
  const slug = String(location)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return slug || id;
}
