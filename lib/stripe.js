const secretKey = process.env.STRIPE_SECRET_KEY;
console.log(`[DIAGNOSTIC] STRIPE_SECRET_KEY loaded: ${secretKey ? `Exists (starts with ${secretKey.substring(0, 8)}...)` : '!!! NOT FOUND !!!'}`);

const stripe = require('stripe')(secretKey, {
    apiVersion: '2023-10-16',
    appInfo: {
        name: 'TributeToro',
        version: '1.0.0',
        url: process.env.FRONTEND_URL || 'https://tributetoro.com'
    }
});

console.log('[DIAGNOSTIC] lib/stripe.js: Stripe instance created. typeof stripe.countries:', typeof stripe.countries);

module.exports = stripe;