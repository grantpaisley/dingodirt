-- Add FIT metadata columns to rides table
-- Track original sport/sub_sport from FIT files
ALTER TABLE rides
ADD COLUMN IF NOT EXISTS fit_sport TEXT;
ALTER TABLE rides
ADD COLUMN IF NOT EXISTS fit_sub_sport TEXT;
ALTER TABLE rides
ADD COLUMN IF NOT EXISTS device_manufacturer TEXT;
ALTER TABLE rides
ADD COLUMN IF NOT EXISTS device_product TEXT;
COMMENT ON COLUMN rides.fit_sport IS 'Original FIT sport type (e.g., cycling, running)';
COMMENT ON COLUMN rides.fit_sub_sport IS 'Original FIT sub-sport type (e.g., mountain, road)';
COMMENT ON COLUMN rides.device_manufacturer IS 'Recording device manufacturer';
COMMENT ON COLUMN rides.device_product IS 'Recording device product name';
