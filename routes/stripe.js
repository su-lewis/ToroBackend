// backend/routes/stripe.js
const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY, {
    apiVersion: '2023-10-16',
});
const prisma = require('../lib/prisma');
const { authMiddleware } = require('../middleware/auth');

// Helper function to map country to a common currency
const getCurrencyForCountry = (countryCode) => {
    const currencyMap = { 'US': 'usd', 'CA': 'cad', 'GB': 'gbp', 'AU': 'aud', 'DE': 'eur', 'FR': 'eur', 'ES': 'eur', 'IT': 'eur', 'IE': 'eur', 'NL': 'eur', 'PT': 'eur' };
    const currency = currencyMap[countryCode.toUpperCase()];
    if (!currency) {
        return 'usd';
    }
    return currency;
};

// 1. Create Stripe Connect Account and Onboarding Link
// (This route's logic is fine and doesn't need to change)
router.post('/connect/onboard-user', authMiddleware, async (req, res) => { /* ... */ });

// 2. Get Stripe Account Status
// (This route's logic is fine and doesn't need to change)
router.get('/connect/account-status', authMiddleware, async (req, res) => { /* ... */ });

// 3. Create Stripe Checkout Session (MODEL: Simple Add-On Fee)
router.post('/create-checkout-session', async (req, res) => {
    try {
        if (!req.body) return res.status(400).json({ message: 'Request body missing.' });
        const { amount: amountForCreatorDollars, recipientUsername } = req.body;
        if (!recipientUsername || isNaN(parseFloat(amountForCreatorDollars)) || parseFloat(amountForCreatorDollars) < 1.00) {
            return res.status(400).json({ message: 'Valid amount for creator (min $1.00 equivalent) and recipient required.' });
        }
        const recipientUser = await prisma.user.findUnique({
            where: { username: recipientUsername },
            select: { id: true, username: true, displayName: true, stripeAccountId: true, stripeOnboardingComplete: true }
        });
        if (!recipientUser || !recipientUser.stripeAccountId || !recipientUser.stripeOnboardingComplete) {
            return res.status(400).json({ message: 'This creator is not set up for payments.' });
        }
        const connectedAccount = await stripe.accounts.retrieve(recipientUser.stripeAccountId);
        const chargeCurrency = connectedAccount.default_currency || getCurrencyForCountry(connectedAccount.country);

        // --- THIS IS THE CORRECTED "SIMPLE ADD-ON" CALCULATION ---
        const creatorReceivesAmount = parseFloat(amountForCreatorDollars);
        const platformFeePercentage = 0.15; // Your 15% platform fee

        // Calculate a simple 15% fee on top of the creator's amount
        const platformFeeDollars = creatorReceivesAmount * platformFeePercentage;
        // The total amount the donor will be charged is the simple sum
        const grossAmountDollars = creatorReceivesAmount + platformFeeDollars;
        
        // Convert to cents for Stripe
        const grossAmountInCents = Math.round(grossAmountDollars * 100); // For $50 gift, this will be 5750
        const creatorReceivesAmountInCents = Math.round(creatorReceivesAmount * 100);
        const platformFeeInCents = grossAmountInCents - creatorReceivesAmountInCents; // For $50 gift, this will be 750
        // --- END CALCULATION CORRECTION ---

        let minChargeInCents = 50; if (chargeCurrency === 'gbp' || chargeCurrency === 'eur') minChargeInCents = 30;
        if (grossAmountInCents < minChargeInCents) {
            return res.status(400).json({ message: `Calculated charge amount is too small.` });
        }
        const productName = `Support for ${recipientUser.displayName || recipientUser.username}`;
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: chargeCurrency,
                    product_data: { name: productName },
                    unit_amount: grossAmountInCents // Charge the donor the new total (e.g., 5750)
                },
                quantity: 1
            }],
            mode: 'payment',
            success_url: `${process.env.FRONTEND_URL}/payment-success?recipient=${recipientUsername}&amount_sent=${creatorReceivesAmount.toFixed(2)}`,
            cancel_url: `${process.env.FRONTEND_URL}/${recipientUsername}?payment_cancelled=true`,
            payment_intent_data: {
                transfer_data: { 
                    destination: recipientUser.stripeAccountId,
                    // The amount transferred is now explicitly the creator's portion
                    amount: creatorReceivesAmountInCents,
                },
                on_behalf_of: recipientUser.stripeAccountId,
            },
            metadata: {
                appRecipientUserId: recipientUser.id,
                grossAmountChargedToDonor: grossAmountInCents.toString(),
                intendedAmountForCreator: creatorReceivesAmountInCents.toString(),
                platformFeeCalculated: platformFeeInCents.toString(),
                paymentCurrency: chargeCurrency,
            },
        });
        res.json({ id: session.id });
    } catch (error) {
        console.error('[/create-checkout-session] Error:', error.message, error.stack);
        res.status(500).json({ message: 'Error creating payment session', error: error.message });
    }
});

// 4. CREATE STRIPE EXPRESS DASHBOARD LOGIN LINK
// (This route's logic is fine and doesn't need to change)
router.post('/create-express-dashboard-link', authMiddleware, async (req, res) => { /* ... */ });

module.exports = router;