const REQUIRED_PRODUCTION_VARIABLES = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'MASTER_ADMIN_EMAIL',
  'LEADER_EMAIL',
];

function isSet(env, name) {
  return typeof env[name] === 'string' && env[name].trim() !== '';
}

function validateUrl(env, name, protocols, errors) {
  if (!isSet(env, name)) return;
  try {
    const url = new URL(env[name]);
    if (!protocols.includes(url.protocol)) throw new Error('invalid protocol');
  } catch {
    errors.push(`${name} must be a valid ${protocols.join(' or ')} URL.`);
  }
}

function validateEnv(env = process.env) {
  const errors = [];
  const production = env.NODE_ENV === 'production';

  if (production) {
    for (const name of REQUIRED_PRODUCTION_VARIABLES) {
      if (!isSet(env, name)) errors.push(`${name} is required in production.`);
    }
  }

  validateUrl(env, 'SUPABASE_URL', production ? ['https:'] : ['https:', 'http:'], errors);
  validateUrl(env, 'REDIS_URL', production ? ['rediss:'] : ['redis:', 'rediss:'], errors);

  if (isSet(env, 'MASTER_ADMIN_EMAIL') && isSet(env, 'LEADER_EMAIL')) {
    const masterEmail = env.MASTER_ADMIN_EMAIL.trim().toLowerCase();
    const leaderEmail = env.LEADER_EMAIL.trim().toLowerCase();
    if (masterEmail !== leaderEmail) {
      errors.push('MASTER_ADMIN_EMAIL must match the Google-authenticated LEADER_EMAIL secret.');
    }
  }

  if (env.VALHALLA_QUEUE_ENABLED === 'true') {
    if (!isSet(env, 'REDIS_URL')) errors.push('REDIS_URL is required when the queue is enabled.');
    if (!isSet(env, 'VALHALLA_DISPATCH_TOKEN') || Buffer.byteLength(env.VALHALLA_DISPATCH_TOKEN) < 32) {
      errors.push('VALHALLA_DISPATCH_TOKEN must be at least 32 bytes when the queue is enabled.');
    }
  }

  if (errors.length) {
    throw new Error(`Invalid production configuration:\n- ${errors.join('\n- ')}`);
  }
  return true;
}

if (require.main === module) {
  try {
    validateEnv();
    console.info('Environment configuration validated.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { validateEnv };
