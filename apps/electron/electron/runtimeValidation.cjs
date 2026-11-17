'use strict';

// Input and diagnostic normalization shared by native services.


function errorMessage(error, fallback = 'Operation failed') {
  try {
    if (typeof error?.message === 'string' && error.message) return error.message;
    if (typeof error === 'string' && error) return error;
    return String(error || fallback);
  } catch {
    return fallback;
  }
}

function nonblankString(value) {
  try {
    return typeof value === 'string' && value.trim() !== '' ? value : null;
  } catch {
    return null;
  }
}

function normalizeQos(value) {
  if (value === 0 || value === 1 || value === 2) return value;
  if (value === '0' || value === '1' || value === '2') return Number(value);
  return null;
}

module.exports = { errorMessage, nonblankString, normalizeQos };
