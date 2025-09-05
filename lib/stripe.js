const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY, {
    apiVersion: '2023-10-16', // Pin the API version
    // It's good practice to set appInfo for Stripe Connect platforms
    appInfo: {
        name: 'TributeToro',
        version: '1.0.0',
        url: 'https://tributetoro.com' // Replace with your production URL
    }
});

module.exports = stripe;