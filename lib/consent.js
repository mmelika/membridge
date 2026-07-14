'use strict';
const util = require('./util');
const hooks = require('./hooks');

function needsConsentPrompt(config) {
  if (!config || !config.distill) return false;
  if (config.distill.enabled === false) return false;
  return config.distill.consent == null;
}

function applyConsent(decision) {
  const raw = util.loadUserConfig();
  if (!raw.distill) raw.distill = {};
  raw.distill.consent = decision;
  util.saveUserConfig(raw);
  if (decision === 'granted') {
    hooks.setupHooks();
    return 'Session summaries enabled — Stop hook installed.';
  }
  return 'Session summaries declined — no hook installed.';
}

module.exports = { needsConsentPrompt, applyConsent };
