// backend/routes/stripe.js
const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const prisma = require('../lib/prisma');
const { authMiddleware } = require('../middleware/auth');

console.log("[Stripe Router] File loaded and router instance created for non-webhook routes.");

// Helper function to map country to currency (still needed for /create-checkout-session)
const getCurrencyForCountry = (countryCode) => {
    const currencyMap = { 'US': 'usd', 'CA': 'cad', 'GB': 'gbp', 'AU': 'aud', 'DE': 'eur', 'FR': 'eur', 'ES': 'eur', 'IT': 'eur', 'IE': 'eur', 'NL': 'eur', 'PT': 'eur' };
    const currency = currencyMap[countryCode.toUpperCase()];
    if (!currency) {
        console.warn(`[Currency Mapper] No explicit currency for country ${countryCode}. Defaulting to USD.`);
        return 'usd';
    }
    return currency;
};

// 1. Create Stripe Connect Account and Onboarding Link (SIMPLIFIED - NO country/phone from frontend)
router.post('/connect/onboard-user', authMiddleware, async (req, res) => {
    try {
        if (!req.localUser?.id) return res.status(403).json({ message: 'Application profile setup required first.' });
        
        const appUserId = req.localUser.id;
        const appProfile = req.localUser;
        const emailForStripe = req.user?.email || appProfile?.email;
        if (!emailForStripe) return res.status(400).json({ message: 'An email address is required.' });
        
        const platformBaseUrl = process.env.FRONTEND_URL;
        if (!platformBaseUrl || !platformBaseUrl.startsWith('http')) {
            return res.status(500).json({ message: 'Server configuration error: A valid FRONTEND_URL is required.' });
        }

        let stripeAccountId = appProfile.stripeAccountId;
        if (!stripeAccountId) {
            const userProfileUrlOnPlatform = `${platformBaseUrl}/${appProfile.username}`;
            const productDescriptionOnPlatform = `Receiving tips and support via ${process.env.PLATFORM_DISPLAY_NAME || 'our platform'}.`;
            
            const accountParams = {
                type: 'express',
                // country: IS REMOVED. Stripe will now ask the user for it.
                email: emailForStripe,
                business_type: 'individual',
                business_profile: {
                    url: userProfileUrlOnPlatform,
                    mcc: '5815', // Digital Goods Media - a good generic for content creators
                    product_description: productDescriptionOnPlatform,
                },
                capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
            };
            
            const account = await stripe.accounts.create(accountParams);
            stripeAccountId = account.id;
            
            await prisma.user.update({
                where: { id: appUserId },
                data: { stripeAccountId: stripeAccountId, stripeOnboardingComplete: false },
            });
            console.log(`[/onboard-user] Created Stripe Account ${stripeAccountId} for user ${appUserId}.`);
        }

        const accountLink = await stripe.accountLinks.create({
            account: stripeAccountId,
            refresh_url: `${platformBaseUrl}/connect-stripe?reauth=true`,
            return_url: `${platformBaseUrl}/connect-stripe?status=success`,
            type: 'account_onboarding',
        });

        res.json({ url: accountLink.url });
    } catch (error) {
        console.error('[/onboard-user] Error:', error.message, error.stack);
        res.status(500).json({ message: 'Error creating Stripe onboarding link', error: error.message });
    }
});

// 2. Get Stripe Account Status
// (No changes needed - this logic is fine)
router.get('/connect/account-status', authMiddleware, async (req, res) => {
    try {
        if (!req.localUser?.id) return res.status(403).json({ message: 'User profile not found.' });
        const user = req.localUser;
        if (!user.stripeAccountId) return res.status(404).json({ message: 'Stripe account not connected.' });
        const account = await stripe.accounts.retrieve(user.stripeAccountId);
        const onboardingComplete = !!(account.charges_enabled && account.details_submitted && account.payouts_enabled);
        if (user.stripeOnboardingComplete !== onboardingComplete) {
            await prisma.user.update({ where: { id: user.id }, data: { stripeOnboardingComplete }});
        }
        res.json({ onboardingComplete, stripeAccountId: user.stripeAccountId, detailsSubmitted: account.details_submitted, chargesEnabled: account.charges_enabled, payoutsEnabled: account.payouts_enabled, accountCountry: account.country, defaultCurrency: account.default_currency });
    } catch (error) {
        console.error('[/account-status] Error:', error.message, error.stack);
        res.status(500).json({ message: 'Error fetching Stripe status', error: error.message });
    }
});

// 3. Create Stripe Checkout Session
// (No changes needed - this logic correctly fetches country from Stripe account)
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
        const creatorReceivesAmount = parseFloat(amountForCreatorDollars);
        const platformFeePercentage = 0.10;
        const grossAmountDollarsEquivalent = creatorReceivesAmount / (1 - platformFeePercentage);
        const grossAmountInCents = Math.round(grossAmountDollarsEquivalent * 100);
        const platformFeeInCents = grossAmountInCents - Math.round(creatorReceivesAmount * 100);
        let minChargeInCents = 50; if (chargeCurrency === 'gbp' || chargeCurrency === 'eur') minChargeInCents = 30;
        if (grossAmountInCents < minChargeInCents) {
            return res.status(400).json({ message: `Calculated charge amount is too small. Minimum is ${(minChargeInCents/100).toFixed(2)} ${chargeCurrency.toUpperCase()}.` });
        }
        const productName = `Support for ${recipientUser.displayName || recipientUser.username}`;
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{ price_data: { currency: chargeCurrency, product_data: { name: productName }, unit_amount: grossAmountInCents }, quantity: 1 }],
            mode: 'payment',
            success_url: `${process.env.FRONTEND_URL}/payment-success?recipient=${recipientUsername}&amount_sent=${creatorReceivesAmount.toFixed(2)}`,
            cancel_url: `${process.env.FRONTEND_URL}/${recipientUsername}?payment_cancelled=true`,
            payment_intent_data: {
                application_fee_amount: platformFeeInCents > 0 ? platformFeeInCents : undefined,
                transfer_data: { destination: recipientUser.stripeAccountId },
                on_behalf_of: recipientUser.stripeAccountId,
            },
            metadata: {
                appRecipientUserId: recipientUser.id,
                grossAmountChargedToDonor: grossAmountInCents.toString(),
                intendedAmountForCreator: Math.round(creatorReceivesAmount * 100).toString(),
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
// (No changes needed)
router.post('/create-express-dashboard-link', authMiddleware, async (req, res) => {
    try {
        if (!req.localUser?.id) return res.status(403).json({ message: 'User profile not found.' });
        if (!req.localUser.stripeAccountId || !req.localUser.stripeOnboardingComplete) {
            return res.status(400).json({ message: 'Stripe account not fully set up.' });
        }
        const loginLink = await stripe.accounts.createLoginLink(req.localUser.stripeAccountId);
        res.json({ url: loginLink.url });
    } catch (error) {
        console.error('[/create-express-dashboard-link] Error:', error);
        res.status(500).json({ message: 'Error creating dashboard link', error: error.message });
    }
});

// Export ONLY the router. The webhook handler is in index.js
module.exports = router;