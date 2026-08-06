-- Ride difficulty grade 1-5 (Grant's published scale: 1 easiest bitumen/
-- gravel → 5 expert singletrack). Manually assigned (detail pane, bulk on a
-- selection); never auto-assigned — hardness is partly conditions and
-- judgment. NULL = ungraded.
ALTER TABLE rides ADD COLUMN grade smallint CHECK (grade BETWEEN 1 AND 5);
