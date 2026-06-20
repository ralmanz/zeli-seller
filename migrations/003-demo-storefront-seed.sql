-- Demo data for storefront (2+ active listings under broker-vega).
-- Safe to re-run on existing databases.

UPDATE listings SET slug = 'san-francisco-venta' WHERE id = 'listing-sf-demo' AND (slug IS NULL OR slug = '' OR slug = id);

INSERT OR IGNORE INTO listings (
  id, slug, broker_id, operation, price, currency, location,
  beds, baths, area_m2, parking, facts_json, status
) VALUES (
  'listing-pp-rent',
  'punta-pacifica-alquiler',
  'broker-vega',
  'rent',
  2200,
  'USD',
  'Punta Pacífica, Ciudad de Panamá',
  1,
  1,
  68,
  1,
  '["vista al mar","amoblado","gym"]',
  'active'
);
