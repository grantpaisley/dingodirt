-- The road-pair normalization in dingo_geo::turns orders (road_a, road_b)
-- with Rust's byte-wise string comparison, but the original CHECK compared
-- with the database collation — accented / mixed-case road names order
-- differently there, and 177 rides failed the 2026-08-03 backfill on it.
-- Pin the constraint to byte order (COLLATE "C") to match the writer.

ALTER TABLE turn_marks DROP CONSTRAINT turn_marks_check;
ALTER TABLE turn_marks
    ADD CONSTRAINT turn_marks_check CHECK ((road_a COLLATE "C") <= (road_b COLLATE "C"));
