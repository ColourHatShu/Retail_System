// Runs before each test file, before db.ts is imported.
import crypto from 'crypto';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

process.env.NODE_ENV = 'test';

// Prefer a dedicated test database; fall back to the configured one.
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

// Every test file gets its own throwaway schema so files can run in parallel
// and never touch the real public schema. helpers.ts creates and drops it.
process.env.DB_SCHEMA = `test_${crypto.randomBytes(4).toString('hex')}`;

if (!process.env.DATABASE_URL) {
  console.warn(
    '\n[tests] DATABASE_URL is not set, so every database-backed suite is SKIPPED.\n' +
      '        Put DATABASE_URL (or TEST_DATABASE_URL) in server/.env to run them.\n',
  );
}
