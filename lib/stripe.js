const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY, {
    apiVersion: '2023-10-16',
    appInfo: {
        name: 'TributeToro',
        version: '1.0.0',
        url: process.env.FRONTEND_URL || 'https://tributetoro.com'
    }
});

module.exports = stripe;