#!/bin/sh
# Creates the two database roles the project depends on.
#
#   pulse_owner  owns the database and every table; Prisma migrations run as it
#   pulse_app    the role the API connects as; owns nothing, so RLS always applies
#
# The split is what makes Row-Level Security trustworthy: a table's owner
# silently bypasses its own RLS policies, so the application must never be the
# owner. Neither role is a superuser and neither has BYPASSRLS.
#
# Runs once, on first initialisation of an empty data directory.
set -eu

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  -v owner_role="$OWNER_ROLE" \
  -v owner_password="$OWNER_PASSWORD" \
  -v app_role="$APP_ROLE" \
  -v app_password="$APP_PASSWORD" \
  -v db_name="$POSTGRES_DB" <<-'EOSQL'
	-- CREATEDB is needed for the shadow database Prisma builds during `migrate dev`.
	CREATE ROLE :"owner_role" LOGIN PASSWORD :'owner_password'
	  NOSUPERUSER NOCREATEROLE CREATEDB NOBYPASSRLS;

	CREATE ROLE :"app_role" LOGIN PASSWORD :'app_password'
	  NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;

	ALTER DATABASE :"db_name" OWNER TO :"owner_role";
	ALTER SCHEMA public OWNER TO :"owner_role";

	-- Explicit grants only: the app role may use the schema but never create in
	-- it, because anything it created it would own — and own means bypass.
	REVOKE ALL ON SCHEMA public FROM PUBLIC;
	REVOKE ALL ON DATABASE :"db_name" FROM PUBLIC;
	GRANT CONNECT ON DATABASE :"db_name" TO :"app_role";
	GRANT USAGE ON SCHEMA public TO :"app_role";

	-- Tables created later by migrations are reachable by the app role without a
	-- follow-up GRANT, but are still owned by pulse_owner.
	ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" IN SCHEMA public
	  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app_role";
	ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" IN SCHEMA public
	  GRANT USAGE, SELECT ON SEQUENCES TO :"app_role";
EOSQL
