'use strict';

const webpush = require('web-push');
const keys = webpush.generateVAPIDKeys();
process.stdout.write('Set these in Vercel. Do not commit them.\n');
process.stdout.write('VAPID_PUBLIC_KEY=' + keys.publicKey + '\n');
process.stdout.write('VAPID_PRIVATE_KEY=' + keys.privateKey + '\n');
process.stdout.write('VAPID_SUBJECT=mailto:you@example.com\n');
