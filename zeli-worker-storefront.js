// zeli-worker-storefront.js
// Reference implementation — merged into zeli-worker-chat.js (handleStorefront).
// Per-broker storefront data. ONE broker's active inventory, pure navigation.
//
//   GET /api/brokers/:id/storefront
//     -> 200 { broker, listings: [...] }     broker has 2+ active listings
//     -> 200 { redirect: "/<slug>" }         exactly 1 active listing (no storefront)
//     -> 404 { error: "not_found" }          0 active listings, or no such broker
//
// Deploy: Cloudflare Worker with a D1 binding named DB.
// Tables: brokers, listings (see build plan schema). Read-only — no LLM, no writes.
//
// THE TRIPWIRE: every query here is scoped to a single broker_id. There is no
// path in this file that reads another broker's rows. Do not add a "similar
// nearby" / "otras opciones" query — that is the cross-broker aggregation we
// ruled out, and this endpoint is exactly where it would sneak in.

// Where listing cover photos are served from (R2 public bucket or an /img worker
// route). Set to your bucket's public base; keys come from listings.cover_r2_key.
const IMG_BASE = "https://img.zeli.lat/";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/api\/brokers\/([^/]+)\/storefront\/?$/);
    if (!m || request.method !== "GET") {
      return json({ error: "not_found" }, 404);
    }
    const brokerId = decodeURIComponent(m[1]);

    try {
      const broker = await env.DB.prepare(
        `SELECT id, name, agency, wa_number
           FROM brokers
          WHERE id = ?1`
      ).bind(brokerId).first();

      if (!broker) return json({ error: "not_found" }, 404);

      const { results } = await env.DB.prepare(
        `SELECT slug, price, location, beds, baths, area_m2, parking,
                facts_json, cover_r2_key
           FROM listings
          WHERE broker_id = ?1 AND status = 'active'
          ORDER BY updated_at DESC`
      ).bind(brokerId).all();

      const rows = results || [];

      // 0 active -> nothing to show.
      if (rows.length === 0) return json({ error: "not_found" }, 404);

      // 1 active -> the storefront would dead-end on the listing you're already
      // on, which looks broken. Send straight to that one listing instead.
      if (rows.length === 1) {
        return json({ redirect: `/${rows[0].slug}` });
      }

      // 2+ -> the real storefront.
      return json({
        broker: {
          name: broker.name,
          agency: broker.agency,
          wa_number: broker.wa_number,
        },
        listings: rows.map(shapeListing),
      });
    } catch (err) {
      return json({ error: "server_error" }, 500);
    }
  },
};

function shapeListing(r) {
  let facts = {};
  try { facts = r.facts_json ? JSON.parse(r.facts_json) : {}; } catch {}

  // operation: "venta" (default) | "alquiler"
  const operation = facts.operation === "alquiler" ? "alquiler" : "venta";

  return {
    slug: r.slug,
    title: facts.title || r.location || "",
    location: r.location || "",
    operation,
    price_label: priceLabel(r.price, operation),
    beds: r.beds,
    baths: r.baths,
    area_m2: r.area_m2,
    parking: r.parking,
    cover: r.cover_r2_key ? IMG_BASE + r.cover_r2_key : null,
  };
}

function priceLabel(price, operation) {
  if (price == null) return "Consultar";
  const n = Number(price).toLocaleString("en-US"); // 165000 -> "165,000"
  return operation === "alquiler" ? `$${n}/mes` : `$${n}`;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=60",
    },
  });
}
