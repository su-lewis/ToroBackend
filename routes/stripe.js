// backend/routes/stripe.js
const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY, {
    apiVersion: '2023-10-16', // It's good practice to pin the API version
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
// (This route's logic is fine and doesn't need to change, but including for completeness)
router.post('/connect/onboard-user', authMiddleware, async (req, res) => {
    try {
        if (!req.localUser?.id) return res.status(403).json({ message: 'Application profile setup required first.' });
        const appUserId = req.localUser.id;
        let appProfile = req.localUser;
        if (!appProfile.username) return res.status(400).json({ message: 'A username is required in your profile to connect with Stripe.' });
        const emailForStripe = req.user?.email || appProfile?.email;
        if (!emailForStripe) return res.status(400).json({ message: 'An email address is required to connect with Stripe.' });
        const platformBaseUrl = process.env.FRONTEND_URL;
        if (!platformBaseUrl || !platformBaseUrl.startsWith('http')) return res.status(500).json({ message: 'Server configuration error: A valid FRONTEND_URL is required.' });
        let stripeAccountId = appProfile.stripeAccountId;
        if (!stripeAccountId) {
            const userProfileUrlOnPlatform = `${platformBaseUrl}/${appProfile.username}`;
            const platformDisplayName = process.env.PLATFORM_DISPLAY_NAME || 'Our Platform';
            const productDescriptionOnPlatform = `Receiving support and tips via ${platformDisplayName}.`;
            const accountParams = {
                type: 'express',
                email: emailForStripe,
                business_type: 'individual',
                business_profile: { url: userProfileUrlOnPlatform, mcc: '5815', product_description: productDescriptionOnPlatform, },
                capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
            };
            const account = await stripe.accounts.create(accountParams);
            stripeAccountId = account.id;
            await prisma.user.update({ where: { id: appUserId }, data: { stripeAccountId: stripeAccountId, stripeOnboardingComplete: false },});
        }
        const accountLink = await stripe.accountLinks.create({ account: stripeAccountId, refresh_url: `${platformBaseUrl}/connect-stripe?reauth=true`, return_url: `${platformBaseUrl}/connect-stripe?status=success`, type: 'account_onboarding' });
        res.json({ url: accountLink.url });
    } catch (error) {
        console.error('[/onboard-user] Error:', error.message, error.stack);
        res.status(500).json({ message: 'Error creating Stripe onboarding link', error: error.message });
    }
});

// 2. Get Stripe Account Status
// (This route's logic is fine and doesn't need to change, but including for completeness)
router.get('/connect/account-status', authMiddleware, async (req, res) => {
    try {
        if (!req.localUser?.id) return res.status(403).json({ message: 'User profile not found.' });
        const user = req.localUser;
        if (!user.stripeAccountId) return res.status(404).json({ message: 'Stripe account not connected for this user.' });
        const account = await stripe.accounts.retrieve(user.stripeAccountId);
        const onboardingComplete = !!(account.charges_enabled && account.details_submitted && account.payouts_enabled);
        if (user.stripeOnboardingComplete !== onboardingComplete) {
            await prisma.user.update({ where: { id: user.id }, data: { stripeOnboardingComplete: onboardingComplete }});
        }
        res.json({ stripeAccountId: user.stripeAccountId, detailsSubmitted: account.details_submitted, chargesEnabled: account.charges_enabled, payoutsEnabled: account.payouts_enabled, onboardingComplete: onboardingComplete, accountCountry: account.country, defaultCurrency: account.default_currency, });
    } catch (error) {
        console.error('[/account-status] Error:', error.message, error.stack);
        res.status(500).json({ message: 'Error fetching Stripe account status', error: error.message });
    }
});


// 3. Create Stripe Checkout Session (MODEL: Simple Add-On Fee, Implicit Fee for Stripe)
router.post('/create-checkout-session', async (req, res) => {
    try {
        if (!req.body) return res.status(400).json({ message: 'Request body is missing.' });
        const { amount: amountForCreatorDollars, recipientUsername, donorName } = req.body;
        
        const MINIMUM_SEND_AMOUNT = 5.00;
        if (!recipientUsername || isNaN(parseFloat(amountForCreatorDollars)) || parseFloat(amountForCreatorDollars) < MINIMUM_SEND_AMOUNT) {
            return res.status(400).json({ message: `Valid amount for creator (min $${MINIMUM_SEND_AMOUNT.toFixed(2)} equivalent) and recipient username required.` });
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

        const creatorReceivesAmount = parseFloat(amountForCreatorDollars);
        const platformFeePercentage = 0.15;
        const platformFeeDollars = creatorReceivesAmount * platformFeePercentage;
        const grossAmountDollars = creatorReceivesAmount + platformFeeDollars;
        
        const grossAmountInCents = Math.round(grossAmountDollars * 100);
        const creatorReceivesAmountInCents = Math.round(creatorReceivesAmount * 100);
        const platformFeeInCents = grossAmountInCents - creatorReceivesAmountInCents;

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
                    unit_amount: grossAmountInCents
                },
                quantity: 1
            }],
            mode: 'payment',
            success_url: `${process.env.FRONTEND_URL}/payment-success?recipient=${recipientUsername}&amount_sent=${creatorReceivesAmount.toFixed(2)}`,
            cancel_url: `${process.env.FRONTEND_URL}/${recipientUsername}?payment_cancelled=true`,
            payment_intent_data: {
                // --- THIS IS THE FIX ---
                // REMOVE application_fee_amount when transfer_data.amount is specified.
                // application_fee_amount: platformFeeInCents > 0 ? platformFeeInCents : undefined,
                
                transfer_data: { 
                    destination: recipientUser.stripeAccountId,
                    // By setting this amount, Stripe will automatically calculate
                    // the platform fee as (unit_amount - this_amount).
                    amount: creatorReceivesAmountInCents,
                },
                on_behalf_of: recipientUser.stripeAccountId,
            },
            metadata: {
                // Metadata remains the same and is very useful for your webhook
                appRecipientUserId: recipientUser.id,
                grossAmountChargedToDonor: grossAmountInCents.toString(),
                intendedAmountForCreator: creatorReceivesAmountInCents.toString(),
                platformFeeCalculated: platformFeeInCents.toString(),
                paymentCurrency: chargeCurrency,
                donorName: donorName ? donorName.substring(0, 100) : 'Anonymous',
            },
        });
        res.json({ id: session.id });
    } catch (error) {
        console.error('[/create-checkout-session] Error:', error.message, error.stack);
        res.status(500).json({ message: 'Error creating payment session', error: error.message });
    }
});

// 4. CREATE STRIPE EXPRESS DASHBOARD LOGIN LINK
// (This route's logic is fine and doesn't need to change, but including for completeness)
router.post('/create-express-dashboard-link', authMiddleware, async (req, res) => {
    try {
        if (!req.localUser?.id) return res.status(403).json({ message: 'User profile not found.' });
        if (!req.localUser.stripeAccountId || !req.localUser.stripeOnboardingComplete) return res.status(400).json({ message: 'Stripe account not fully set up.' });
        const loginLink = await stripe.accounts.createLoginLink(req.localUser.stripeAccountId);
        res.json({ url: loginLink.url });
    } catch (error) {
        console.error('[/create-express-dashboard-link] Error:', error);
        res.status(500).json({ message: 'Error creating dashboard link', error: error.message });
    }
});

module.exports = router;