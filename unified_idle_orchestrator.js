'use strict';

const express = require('express');

const ALLOWED_ORIGINS = [
  'https://valhalla-elizaos.onrender.com',
  'https://valhalla-app.xyz',
  'https://valhalla-site.onrender.com',
];

const MASTER_API_URL = process.env.MASTER_API_URL || 'https://valhalla-app.xyz';
const MASTER_FALLBACK_URL = 'https://valhalla-elizaos.onrender.com';
const DISPATCH_PATH = '/api/valhalla/dispatch';

function corsMiddleware(req, res, next) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
}

// Slave nodes register with the primary master and fall back to the Render endpoint.
async function registerSlaveNode(payload, token = process.env.VALHALLA_DISPATCH_TOKEN) {
  const bases = [...new Set([MASTER_API_URL, MASTER_FALLBACK_URL])];
  let lastError;
  for (const base of bases) {
    try {
      const response = await fetch(base + DISPATCH_PATH, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(payload),
      });
      if (response.ok) return response;
      lastError = new Error(`dispatch_failed_${response.status}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function createApp() {
  const app = express();
  app.use(corsMiddleware);
  app.use(express.json({ limit: '8kb' }));
  return app;
}

module.exports = {
  ALLOWED_ORIGINS,
  MASTER_API_URL,
  MASTER_FALLBACK_URL,
  corsMiddleware,
  registerSlaveNode,
  createApp,
};
