-- Connect to the old, dedicated Studio database. The store ID is an operator-supplied identity check.
\set ON_ERROR_STOP on
BEGIN;
SELECT set_config('search_path',quote_ident(:'schema'),'t');
SELECT pg_advisory_xact_lock(7264040,hashtext(current_schema()::text));
SELECT set_config('mangekyo.expected_store',:'store_id','t');
DO $$
BEGIN
  IF current_database() IN ('postgres','template0','template1') OR
     EXISTS (SELECT FROM pg_namespace WHERE nspname NOT LIKE 'pg\_%'
             AND nspname NOT IN ('information_schema','public',current_schema())) OR
     EXISTS (SELECT FROM pg_class WHERE relnamespace='public'::regnamespace AND current_schema()<>'public') THEN
    RAISE EXCEPTION 'Cutover requires a dedicated Studio database';
  END IF;
  IF (SELECT store_id FROM kernel_runtime_identity WHERE singleton) IS DISTINCT FROM current_setting('mangekyo.expected_store')
     OR COALESCE((SELECT max(version) FROM kernel_schema_migrations),0) NOT IN (6,7) THEN
    RAISE EXCEPTION 'Expected the supplied v6/v7 store';
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS kernel_v8_cutover (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), source_name name NOT NULL,
  database_oid oid NOT NULL, store_id text NOT NULL
);
INSERT INTO kernel_v8_cutover(source_name,database_oid,store_id)
  SELECT datname,oid,current_setting('mangekyo.expected_store') FROM pg_database WHERE datname=current_database()
  ON CONFLICT DO NOTHING;
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM kernel_v8_cutover c JOIN pg_database d ON d.oid=c.database_oid
                 WHERE c.source_name=d.datname AND d.datname=current_database()
                   AND c.store_id=current_setting('mangekyo.expected_store')) THEN
    RAISE EXCEPTION 'Cutover marker belongs to a different database';
  END IF;
END $$;
SELECT current_database() AS source_name, oid AS source_oid,
       'mangekyo_v8_' || lower(:'store_id') AS destination FROM pg_database WHERE datname=current_database() \gset
COMMIT;
-- PostgreSQL refuses this rename while another session or prepared transaction owns the database.
\connect postgres
-- Refuse if the catalog identity changed while reconnecting to the maintenance database.
SELECT (SELECT oid FROM pg_database WHERE datname=:'source_name') = :'source_oid'::oid AS same_source \gset
\if :same_source
SELECT format('ALTER DATABASE %I RENAME TO %I', :'source_name', :'destination') \gexec
\else
DO $$ BEGIN RAISE EXCEPTION 'Source database changed during cutover'; END $$;
\endif
\echo Reconnect v8 processes to :destination with the original schema and store-specific Temporal queue.
