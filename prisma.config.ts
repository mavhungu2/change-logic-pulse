import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // The CLI — migrate, db push, db pull — connects as the OWNER role, which
    // is the only role allowed to create and alter tables.
    //
    // This is deliberately not DATABASE_URL. The API connects as the
    // restricted pulse_app role via DATABASE_URL and a driver adapter; the two
    // connection strings never meet.
    url: process.env['MIGRATION_DATABASE_URL'],
  },
});
