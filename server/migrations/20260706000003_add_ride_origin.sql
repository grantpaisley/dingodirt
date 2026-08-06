-- Ride origin: whose track this is.
-- 'self'  = recorded by the user (default; all pre-existing rides)
-- 'other' = imported from someone else (tag wins over sensor data for heatmap classing)
CREATE TYPE ride_origin AS ENUM ('self', 'other');

ALTER TABLE rides ADD COLUMN origin ride_origin NOT NULL DEFAULT 'self';
