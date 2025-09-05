const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY, {
    apiVersion: '2023-10-16',
    appInfo: {
        name: 'TributeToro',
        version: '1.0.0',
        url: process.env.FRONTEND_URL || 'https://tributetoro.com'
    }
});

console.log('[DIAGNOSTIC] lib/stripe.js: Stripe instance created. typeof stripe.countries:', typeof stripe.countries);

module.exports = stripe;