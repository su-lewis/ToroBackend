// backend/routes/stripe.js

const express = require('express');
const router = express.Router(); // This is the Express router instance
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY); // Stripe instance for this module
const prisma = require('../lib/prisma');
const { authMiddleware } = require('../middleware/auth');

// Environment variable checks for this router
if (!process.env.STRIPE_SECRET_KEY) {
    console.error("FATAL BACKEND ERROR: STRIPE_SECRET_KEY is not defined in .env. Stripe routes will fail.");
}
if (!process.env.FRONTEND_URL) {
    console.warn("WARNING: FRONTEND_URL is not defined in .env. Stripe redirects may fail.");
}

console.log("[Stripe Router] File loaded and router instance created for non-webhook routes.");


// 1. Create Stripe Connect Account and Onboarding Link
router.post('/connect/onboard-user', authMiddleware, async (req, res) => {
    console.log("--- [Stripe Router] POST /connect/onboard-user START ---");
    try {
        if (!req.localUser || !req.localUser.id) {
            return res.status(403).json({ message: 'Application profile setup is required before connecting Stripe.' });
        }
        const appUserId = req.localUser.id;
        let appProfile = req.localUser;

        if (!appProfile.username) {
            return res.status(400).json({ message: 'A username is required in your profile to connect with Stripe.' });
        }
        const emailForStripe = req.user?.email || appProfile?.email;
        if (!emailForStripe) {
            return res.status(400).json({ message: 'An email address is required to connect with Stripe.' });
        }

        // --- REMOVED --- No longer need to get country from the request body
        // const userCountry = req.body.countryCode; 
        // if (!userCountry || typeof userCountry !== 'string' || userCountry.length !== 2) {
        //     return res.status(400).json({ message: 'A valid 2-letter country code (e.g., "US") is required to connect with Stripe.' });
        // }

        const platformBaseUrl = process.env.FRONTEND_URL;
        if (!platformBaseUrl || !platformBaseUrl.startsWith('http')) {
            return res.status(500).json({ message: 'Server configuration error: A valid FRONTEND_URL is required.' });
        }

        let stripeAccountId = appProfile.stripeAccountId;
        if (!stripeAccountId) {
            const userProfileUrlOnPlatform = `${platformBaseUrl}/${appProfile.username}`;
            const platformDisplayName = process.env.PLATFORM_DISPLAY_NAME || 'Our Platform';
            const productDescriptionOnPlatform = `Receiving support and tips via ${platformDisplayName}.`;
            
            const accountParams = {
                type: 'express',
                // --- REMOVED --- Let Stripe's onboarding determine the country
                // country: userCountry, 
                email: emailForStripe,
                business_type: 'individual',
                business_profile: {
                    url: userProfileUrlOnPlatform,
                    mcc: '8999', // Professional Services
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
            console.log(`[/onboard-user] Created Stripe Account ${stripeAccountId} for user ${appUserId}. Country will be set during onboarding.`);
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
router.get('/connect/account-status', authMiddleware, async (req, res) => {
    console.log("[Stripe Router] GET /connect/account-status hit.");
    try {
        if (!req.localUser?.id) {
            return res.status(403).json({ message: 'User profile not found.' });
        }
        const user = req.localUser;
        if (!user.stripeAccountId) {
            return res.status(404).json({ message: 'Stripe account not connected for this user.' });
        }
        const account = await stripe.accounts.retrieve(user.stripeAccountId);
        const onboardingComplete = !!(account.charges_enabled && account.details_submitted && account.payouts_enabled);

        if (user.stripeOnboardingComplete !== onboardingComplete) {
            await prisma.user.update({
                where: { id: user.id },
                data: { stripeOnboardingComplete: onboardingComplete }
            });
            console.log(`[/account-status] Onboarding status for user ${user.id} updated to ${onboardingComplete}.`);
        }
        res.json({
            stripeAccountId: user.stripeAccountId,
            detailsSubmitted: account.details_submitted,
            chargesEnabled: account.charges_enabled,
            payoutsEnabled: account.payouts_enabled,
            onboardingComplete: onboardingComplete,
            accountCountry: account.country, // Return the account's country
            defaultCurrency: account.default_currency, // Return the account's default currency
        });
    } catch (error) {
        console.error('[/account-status] Error:', error.message, error.stack);
        res.status(500).json({ message: 'Error fetching Stripe account status', error: error.message });
    }
});

// 3. Create Stripe Checkout Session (using the "donor pays fees" model - Direct Charge & Application Fee)
router.post('/create-checkout-session', async (req, res) => {
    console.log("[Stripe Router] POST /create-checkout-session. Body:", req.body);
    if (!req.body) {
        return res.status(400).json({ message: 'Request body is missing.' });
    }

    const { amount: amountForCreatorDollars, recipientUsername } = req.body;
    if (!recipientUsername || isNaN(parseFloat(amountForCreatorDollars)) || parseFloat(amountForCreatorDollars) < 1.00) {
        return res.status(400).json({ message: 'Valid amount for creator (min $1.00 equivalent) and recipient username required.' });
    }

    try {
        const recipientUser = await prisma.user.findUnique({
            where: { username: recipientUsername },
            select: { id: true, username: true, displayName: true, stripeAccountId: true, stripeOnboardingComplete: true }
        });
        if (!recipientUser || !recipientUser.stripeAccountId || !recipientUser.stripeOnboardingComplete) {
            return res.status(400).json({ message: 'This creator is not currently set up to receive payments.' });
        }

        // --- NEW: Retrieve the connected account details to get its country/default currency ---
        const connectedAccount = await stripe.accounts.retrieve(recipientUser.stripeAccountId);
        const recipientCountryCode = connectedAccount.country;
        const chargeCurrency = getCurrencyForCountry(recipientCountryCode); // Determine currency based on recipient's country

        // Sanity check for currency before proceeding
        if (!chargeCurrency) {
            return res.status(500).json({ message: `Server configuration error: Could not determine charge currency for recipient's country (${recipientCountryCode}).` });
        }

        const creatorReceivesAmount = parseFloat(amountForCreatorDollars);
        const platformFeePercentage = 0.15; // Your 10% platform fee

        // Calculate the gross amount to charge the donor (creator receives X, so donor pays X / (1 - fee_rate))
        const grossAmountDollarsEquivalent = creatorReceivesAmount / (1 - platformFeePercentage);
        
        // Convert to cents (or appropriate smallest currency unit) for Stripe
        const grossAmountInCents = Math.round(grossAmountDollarsEquivalent * 100);
        const creatorReceivesAmountInCents = Math.round(creatorReceivesAmount * 100);
        const platformFeeInCents = grossAmountInCents - creatorReceivesAmountInCents;

        // --- NEW: Check against Stripe's currency-specific minimum charge ---
        // These are common minimums. For production, consider using Stripe's API to get exact min.
        let minChargeInCents = 50; // Default for USD, CAD
        if (chargeCurrency === 'gbp') minChargeInCents = 30; // 30 pence
        else if (chargeCurrency === 'eur') minChargeInCents = 30; // 30 euro cents
        else if (chargeCurrency === 'aud') minChargeInCents = 50; // 50 cents

        if (grossAmountInCents < minChargeInCents) {
            return res.status(400).json({ message: `Calculated charge amount is too small. Minimum for ${chargeCurrency.toUpperCase()} is ${minChargeInCents / 100}.` });
        }

        const platformDisplayName = process.env.PLATFORM_DISPLAY_NAME || 'Our Platform';
        const productName = `Support for ${recipientUser.displayName || recipientUser.username}`;
        const productDescription = `Total payment of ${ (grossAmountInCents / 100).toFixed(2) } ${chargeCurrency.toUpperCase()} via ${platformDisplayName}.`;
        
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: chargeCurrency, // <-- NOW DYNAMIC based on recipient
                    product_data: { name: productName, description: productDescription },
                    unit_amount: grossAmountInCents
                },
                quantity: 1
            }],
            mode: 'payment',
            success_url: `${process.env.FRONTEND_URL}/payment-success?recipient=${recipientUsername}&amount_sent=${creatorReceivesAmount.toFixed(2)}`,
            cancel_url: `${process.env.FRONTEND_URL}/${recipientUsername}?payment_cancelled=true`,
            payment_intent_data: {
                application_fee_amount: platformFeeInCents > 0 ? platformFeeInCents : undefined,
                transfer_data: { destination: recipientUser.stripeAccountId },
                on_behalf_of: recipientUser.stripeAccountId, // <-- CRUCIAL FOR CROSS-REGION SETTLEMENT
            },
            metadata: {
                appRecipientUserId: recipientUser.id,
                appRecipientUsername: recipientUser.username,
                platformFeeCalculated: platformFeeInCents.toString(),
                grossAmountChargedToDonor: grossAmountInCents.toString(),
                intendedAmountForCreator: creatorReceivesAmountInCents.toString(),
                paymentCurrency: chargeCurrency, // <-- Add currency to metadata for webhook
            },
        });
        res.json({ id: session.id });
    } catch (error) {
        console.error('[/create-checkout-session] Error:', error.message, error.stack);
        // More descriptive error for client
        let errorMessage = 'Error creating payment session';
        if (error.type === 'StripeInvalidRequestError') {
            if (error.code === 'country_unsupported_by_account') {
                errorMessage = 'Payment cannot be processed for the recipient\'s country. Please contact support.';
            } else if (error.code === 'charge_too_small') {
                errorMessage = 'The payment amount is too small for the selected currency.';
            }
        }
        res.status(500).json({ message: errorMessage, error: error.message });
    }
});


// 4. CREATE STRIPE EXPRESS DASHBOARD LOGIN LINK
router.post('/create-express-dashboard-link', authMiddleware, async (req, res) => {
    console.log("[Stripe Router] POST /create-express-dashboard-link");
    try {
        if (!req.localUser?.id) {
            return res.status(403).json({ message: 'User profile not found.' });
        }
        const user = req.localUser;
        if (!user.stripeAccountId || !user.stripeOnboardingComplete) {
            return res.status(400).json({ message: 'Stripe account not fully set up.' });
        }
        const loginLink = await stripe.accounts.createLoginLink(user.stripeAccountId);
        res.json({ url: loginLink.url });
    } catch (error) {
        console.error('[/create-express-dashboard-link] Error:', error);
        if (error.type === 'StripeInvalidRequestError') {
            return res.status(400).json({ message: 'Unable to generate dashboard link for this account type.' });
        }
        res.status(500).json({ message: 'Error creating dashboard link', error: error.message });
    }
});

// Export ONLY the router. The webhook handler is now in index.js
module.exports = router;
