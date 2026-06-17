-- Demo seed for the buyer client (matches smart_listing_client_empty_state mockup)
-- Apply after schema.sql:
--   wrangler d1 execute zeli-seller --local --file=seed.sql

INSERT OR IGNORE INTO brokers (id, name, agency, wa_number)
VALUES ('broker-vega', 'Ana Vega', 'Inmobiliaria Vega', '50760001234');

INSERT OR IGNORE INTO listings (
  id, broker_id, operation, price, currency, location,
  beds, baths, area_m2, parking, facts_json, status
) VALUES (
  'listing-sf-demo',
  'broker-vega',
  'sale',
  189000,
  'USD',
  'San Francisco, Ciudad de Panamá',
  2,
  2,
  95,
  1,
  '["piscina","seguridad 24/7","área social"]',
  'active'
);

INSERT OR IGNORE INTO knowledge (scope, listing_id, broker_id, topic, answer, confidence)
VALUES
  ('listing', 'listing-sf-demo', 'broker-vega', 'disponibilidad',
   'Sí, sigue disponible.', 'high'),
  ('listing', 'listing-sf-demo', 'broker-vega', 'ph',
   'El PH es de $180 al mes e incluye seguridad 24/7, piscina y área social.', 'high'),
  ('listing', 'listing-sf-demo', 'broker-vega', 'orientacion',
   'La sala y el balcón dan al oeste. Da a la calle interna, así que es bien tranquilo.', 'high');
