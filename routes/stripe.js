// backend/routes/stripe.js
const express = require('express');
const router = express.Router();
const stripe = require('../lib/stripe'); 
const prisma = require('../lib/prisma');
const { authMiddleware } = require('../middleware/auth');

// --- Constants for payment logic ---
const PLATFORM_FEE_PERCENTAGE = 0.15; // 15% platform fee
const PLATFORM_FEE_FIXED_CENTS = 100; // $1.00 in cents
const MINIMUM_SEND_AMOUNT_USD_EQUIVALENT = 5.00; // The minimum amount a user can send, in USD equivalent.

// 1. Create Stripe Connect Account and Onboarding Link
// (This route's logic is fine and doesn't need to change, but including for completeness)
// --- MODIFY THIS ROUTE ---
router.post('/connect/onboard-user', authMiddleware, async (req, res) => {
    try {
        // Get the country code from the request body
        const { country } = req.body;
        if (!country || !/^[A-Z]{2}$/.test(country)) {
            return res.status(400).json({ message: 'A valid 2-letter country code is required.' });
        }

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
                country: country, // <-- Use the country code here
                business_type: 'individual',
                business_profile: { url: userProfileUrlOnPlatform, mcc: '5815', product_description: productDescriptionOnPlatform, },
                capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
            };
            const account = await stripe.accounts.create(accountParams);
            stripeAccountId = account.id;
            await prisma.user.update({ 
                where: { id: appUserId }, 
                data: { 
                    stripeAccountId: stripeAccountId, 
                    stripeAccountCountry: country, // <-- Save the country to your DB
                    stripeOnboardingComplete: false 
                },
            });
        }
        
        const accountLink = await stripe.accountLinks.create({ account: stripeAccountId, refresh_url: `${platformBaseUrl}/connect-stripe?reauth=true`, return_url: `${platformBaseUrl}/connect-stripe?status=success`, type: 'account_onboarding' });
        res.json({ url: accountLink.url });
    } catch (error) {
        console.error('[/onboard-user] Error:', error.message, error.stack);
        res.status(500).json({ message: 'Error creating Stripe onboarding link', error: error.message });
    }
});


// 2. Get Stripe Account Status
// --- THIS ROUTE IS NOW CORRECTED AND UPDATED ---
router.get('/connect/account-status', authMiddleware, async (req, res) => {
    try {
        if (!req.localUser?.id) return res.status(403).json({ message: 'User profile not found.' });
        const user = req.localUser;
        if (!user.stripeAccountId) return res.status(404).json({ message: 'Stripe account not connected for this user.' });

        const account = await stripe.accounts.retrieve(user.stripeAccountId);
        const onboardingComplete = !!(account.charges_enabled && account.details_submitted && account.payouts_enabled);

        // **CORRECTED LOGIC**: Update our database with the latest info from Stripe
        await prisma.user.update({
            where: { id: user.id },
            data: {
                stripeOnboardingComplete: onboardingComplete,
                stripeDefaultCurrency: account.default_currency, // e.g., 'eur'
                stripeAccountCountry: account.country, // e.g., 'DE'
            },
        });

        res.json({
            stripeAccountId: user.stripeAccountId,
            detailsSubmitted: account.details_submitted,
            chargesEnabled: account.charges_enabled,
            payoutsEnabled: account.payouts_enabled,
            onboardingComplete: onboardingComplete,
            accountCountry: account.country,
            defaultCurrency: account.default_currency,
        });
    } catch (error) {
        console.error('[/account-status] Error:', error.message, error.stack);
        res.status(500).json({ message: 'Error fetching Stripe account status', error: error.message });
    }
});

// 3. Create Stripe Checkout Session
router.post('/create-checkout-session', async (req, res) => {
    try {
        if (!req.body) return res.status(400).json({ message: 'Request body is missing.' });
        const { amount: amountForCreatorDollars, recipientUsername, donorName } = req.body;

        const recipientUser = await prisma.user.findUnique({
            where: { username: recipientUsername },
            select: {
                id: true,
                username: true,
                displayName: true,
                stripeAccountId: true,
                stripeOnboardingComplete: true,
                payoutsInUsd: true,
                stripeDefaultCurrency: true,
            }
        });

        if (!recipientUser || !recipientUser.stripeAccountId || !recipientUser.stripeOnboardingComplete) {
            return res.status(400).json({ message: 'This creator is not set up for payments.' });
        }

        let chargeCurrency;
        if (recipientUser.payoutsInUsd) {
            chargeCurrency = 'usd';
        } else {
            chargeCurrency = recipientUser.stripeDefaultCurrency || 'usd';
        }
        
        if (!recipientUsername || isNaN(parseFloat(amountForCreatorDollars)) || parseFloat(amountForCreatorDollars) < MINIMUM_SEND_AMOUNT_USD_EQUIVALENT) {
            return res.status(400).json({ message: `A valid recipient and amount (min $${MINIMUM_SEND_AMOUNT_USD_EQUIVALENT.toFixed(2)} USD or equivalent) are required.` });
        }
        
        const creatorReceivesAmountInCents = Math.round(parseFloat(amountForCreatorDollars) * 100);
        const platformFeeInCents = Math.round((creatorReceivesAmountInCents * PLATFORM_FEE_PERCENTAGE) + PLATFORM_FEE_FIXED_CENTS);
        const grossAmountInCents = creatorReceivesAmountInCents + platformFeeInCents;
        
        const MINIMUM_CHARGE_CENTS = { 'usd': 50, 'cad': 50, 'aud': 50, 'gbp': 50, 'eur': 50 };
        const minChargeInCents = MINIMUM_CHARGE_CENTS[chargeCurrency] || 50;
        if (grossAmountInCents < minChargeInCents) {
            return res.status(400).json({ message: `The total charge amount is below the minimum of ${formatCurrency(minChargeInCents, chargeCurrency)}.` });
        }
        
        const productName = `Support for ${recipientUser.displayName || recipientUser.username}`;

        // --- THIS IS THE FIX ---
        // We add the missing variable definition right here.
        const productDescription = `A one-time payment to support ${recipientUser.displayName || recipientUser.username}.`;

        const prefix = process.env.STRIPE_STATEMENT_DESCRIPTOR_PREFIX;
        if (!prefix) {
            console.error("CRITICAL: STRIPE_STATEMENT_DESCRIPTOR_PREFIX is not set in environment variables.");
            return res.status(500).json({ message: "Server configuration error." });
        }
        const maxSuffixLength = 22 - (prefix.length + 2);
        const sanitizedUsername = recipientUser.username.replace(/['"*<>]/g, '');
        const statementDescriptorSuffix = sanitizedUsername.substring(0, maxSuffixLength);
        
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card', 'klarna', 'link'],
            line_items: [{
                price_data: {
                    currency: chargeCurrency,
                    product_data: { 
                        name: productName, 
                        description: productDescription // Now this variable exists
                    },
                    unit_amount: grossAmountInCents
                },
                quantity: 1
            }],
            mode: 'payment',
            success_url: `${process.env.FRONTEND_URL}/payment-success?recipient=${recipientUsername}&amount_sent=${(creatorReceivesAmountInCents / 100).toFixed(2)}`,
            cancel_url: `${process.env.FRONTEND_URL}/${recipientUsername}?payment_cancelled=true`,
            payment_intent_data: {
                transfer_data: { 
                    destination: recipientUser.stripeAccountId,
                    amount: creatorReceivesAmountInCents,
                },
                statement_descriptor_suffix: statementDescriptorSuffix,
            },
            billing_address_collection: 'required',
            metadata: {
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

// 5. TRIGGER A MANUAL INSTANT PAYOUT ("Payout Now" button)
router.post('/payouts/instant', authMiddleware, async (req, res) => {
    try {
        if (!req.localUser?.stripeAccountId || !req.localUser.stripeOnboardingComplete) {
            return res.status(400).json({ message: "Stripe account not fully set up for payouts." });
        }
        const user = req.localUser;
        const stripeAccountId = user.stripeAccountId;

        // Get the available balance for the connected account
        const balance = await stripe.balance.retrieve({
            stripeAccount: stripeAccountId,
        });

        // Find their main currency balance
        const connectedAccount = await stripe.accounts.retrieve(stripeAccountId);
        const defaultCurrency = connectedAccount.default_currency;
        const availableBalance = balance.available.find(b => b.currency === defaultCurrency);

        if (!availableBalance || availableBalance.amount <= 0) {
            return res.status(400).json({ message: "No available balance for an instant payout." });
        }

        console.log(`[Payout Now] Initiating instant payout of ${availableBalance.amount} ${defaultCurrency.toUpperCase()} for ${stripeAccountId}`);

        // Create the instant payout on behalf of the connected account
        const payout = await stripe.payouts.create({
            amount: availableBalance.amount,
            currency: defaultCurrency,
            method: 'instant',
        }, {
            stripeAccount: stripeAccountId, // This header makes the API call on behalf of the connected account
        });

        res.json({ success: true, message: `Instant payout of ${formatCurrency(payout.amount, payout.currency)} initiated.`, payoutId: payout.id });

    } catch (error) {
        console.error("[/payouts/instant] Stripe Payout Error:", error);
        let userMessage = "Failed to initiate instant payout. Please try again later.";
        if (error.type === 'StripeInvalidRequestError') {
            // These are common, actionable errors for the user.
            if (error.code === 'balance_insufficient') {
                userMessage = "Your available balance is insufficient for a payout.";
            } else if (error.code === 'instant_payouts_unsupported') {
                userMessage = "Instant Payouts are not supported for your bank account country.";
            } else if (error.code === 'payouts_not_allowed') {
                userMessage = "Payouts are currently disabled on your account. Please check your Stripe dashboard.";
            } else {
                userMessage = "Could not process payout. Please ensure you have an eligible debit card on file with Stripe for Instant Payouts.";
            }
        }
        res.status(400).json({ message: userMessage, error: error.message });
    }
});

// 6. TOGGLE AUTOMATIC PAYOUT MODE (NEW LOGIC)
router.post('/payouts/toggle-mode', authMiddleware, async (req, res) => {
    try {
        if (!req.localUser?.stripeAccountId || !req.localUser.stripeOnboardingComplete) {
            return res.status(400).json({ message: "Stripe account not fully set up." });
        }
        
        const { instantPayoutsEnabled } = req.body; // Expects a boolean
        if (typeof instantPayoutsEnabled !== 'boolean') {
            return res.status(400).json({ message: "A boolean value for 'instantPayoutsEnabled' is required." });
        }

        const user = req.localUser;
        const stripeAccountId = user.stripeAccountId;

        // 'true' (Instant Mode): We take over, so Stripe's schedule should be manual.
        // 'false' (Standard Mode): We want Stripe to handle it, so set the schedule to daily.
        const stripeInterval = instantPayoutsEnabled ? 'manual' : 'daily';

        await stripe.accounts.update(stripeAccountId, {
            settings: {
                payouts: {
                    schedule: {
                        interval: stripeInterval,
                    }
                }
            }
        });

        const updatedUser = await prisma.user.update({
            where: { id: user.id },
            data: { autoInstantPayoutsEnabled: instantPayoutsEnabled },
        });

        const message = instantPayoutsEnabled 
            ? "Automatic Instant Payouts enabled." 
            : "Automatic Standard Payouts enabled.";

        res.json({ 
            success: true, 
            message: message,
            autoInstantPayoutsEnabled: updatedUser.autoInstantPayoutsEnabled
        });

    } catch (error) {
        console.error("[/payouts/toggle-mode] Error:", error);
        res.status(500).json({ message: error.message || "Failed to update payout settings." });
    }
});
// 7. GET STRIPE CONNECT ACCOUNT BALANCE
router.get('/balance', authMiddleware, async (req, res) => {
    try {
        if (!req.localUser?.stripeAccountId || !req.localUser.stripeOnboardingComplete) {
            return res.status(404).json({ message: "Stripe account not fully set up." });
        }
        const stripeAccountId = req.localUser.stripeAccountId;

        const balance = await stripe.balance.retrieve({
            stripeAccount: stripeAccountId,
        });

        res.json(balance);
    } catch (error) {
        console.error('[/stripe/balance] Error fetching Stripe balance:', error);
        res.status(500).json({ message: 'Error fetching Stripe balance', error: error.message });
    }
});

// --- CORRECTED HELPER FUNCTION ---
const formatCurrency = (cents, currency = 'USD') => {
    // The key change is removing 'en-US' from the constructor.
    // This allows the constructor to use the correct symbol for the provided currency code.
    return new Intl.NumberFormat(undefined, { 
        style: 'currency', 
        currency: currency.toUpperCase() 
    }).format(cents / 100);
};


module.exports = router;