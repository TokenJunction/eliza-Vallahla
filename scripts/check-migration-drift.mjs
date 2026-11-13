#!/usr/bin/env node

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const MIGRATION_FILE = /^(\d{14})_(.+)\.sql$/;
const DEFAULT_API = 'https://api.supabase.com/v1';

export function parseLocalMigrationFiles(files) {
  const migrations = [];
  const seen = new Map();

  for (const file of files) {
    const match = MIGRATION_FILE.exec(file);
    if (!match) continue;

    const [, version, name] = match;
    if (seen.has(version)) {
      throw new Error(
        `Duplicate migration version ${version}: ${seen.get(version)} and ${file}`,
      );
    }

    seen.set(version, file);
    migrations.push({ version, name, file });
  }

  return migrations.sort((a, b) => a.version.localeCompare(b.version));
}

export function compareMigrations(local, remote) {
  const localVersions = new Set(local.map((migration) => migration.version));
  const remoteVersions = new Set(remote.map((migration) => migration.version));

  return {
    pending: local.filter((migration) => !remoteVersions.has(migration.version)),
    remoteOnly: remote.filter((migration) => !localVersions.has(migration.version)),
  };
}

async function readLocalMigrations(directory) {
  let entries;

  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  return parseLocalMigrationFiles(
    entries.filter((entry) => entry.isFile()).map((entry) => entry.name),
  );
}

async function fetchRemoteMigrations({ ref, token }) {
  const response = await fetch(
    `${DEFAULT_API}/projects/${encodeURIComponent(ref)}/database/migrations`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(30_000),
    },
  );

  if (!response.ok) {
    const body = (await response.text()).slice(0, 500);
    throw new Error(
      `Supabase Management API returned ${response.status} ${response.statusText}: ${body}`,
    );
  }

  const payload = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error('Supabase Management API returned an unexpected response');
  }

  return payload.map((migration) => ({
    version: String(migration.version),
    name: migration.name ? String(migration.name) : '',
  }));
}

async function main() {
  const token = process.env.SUPABASE_ACCESS_TOKEN?.trim();
  const ref = process.env.SUPABASE_PROJECT_REF?.trim();
  const directory = path.resolve(
    process.env.MIGRATIONS_DIR || 'supabase/migrations',
  );

  if (!token) {
    throw new Error('SUPABASE_ACCESS_TOKEN is required');
  }
  if (!ref) {
    throw new Error('SUPABASE_PROJECT_REF is required');
  }

  const local = await readLocalMigrations(directory);
  const remote = await fetchRemoteMigrations({ ref, token });
  const { pending, remoteOnly } = compareMigrations(local, remote);

  console.log(`Local migrations: ${local.length}`);
  console.log(`Applied migrations: ${remote.length}`);
  console.log(`Local migrations missing from history: ${pending.length}`);
  console.log(`Applied migrations without a local file: ${remoteOnly.length}`);

  if (remoteOnly.length > 0) {
    console.log(
      `::warning::${remoteOnly.length} applied migration version(s) have no local file: ${remoteOnly
        .map((migration) => migration.version)
        .join(', ')}`,
    );
  }

  if (pending.length > 0) {
    console.error(
      `::error::${pending.length} local migration version(s) are not applied: ${pending
        .map((migration) => `${migration.version}_${migration.name}`)
        .join(', ')}`,
    );
    process.exitCode = 1;
    return;
  }

  console.log('No local migrations are pending.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  });
}
