-- Semrush now uses one backend environment key like other server-configured
-- providers. Remove the superseded company connection, named-admin, budget,
-- and reservation persistence in dependency order.
DROP TABLE IF EXISTS "SemrushUsageReservation";
DROP TABLE IF EXISTS "CompanySemrushAdminGrant";
DROP TABLE IF EXISTS "CompanySemrushPolicy";
DROP TABLE IF EXISTS "CompanySemrushConnection";
