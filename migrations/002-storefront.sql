-- Storefront columns (slug URLs, R2 cover keys). Safe to re-run on D1.
ALTER TABLE listings ADD COLUMN slug TEXT;
ALTER TABLE listings ADD COLUMN cover_r2_key TEXT;

UPDATE listings SET slug = id WHERE slug IS NULL OR slug = '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_listings_slug ON listings (slug);
