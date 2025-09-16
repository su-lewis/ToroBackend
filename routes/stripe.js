// routes/stripe.js
const express = require('express');
const router = express.Router();
// Initialize its own Stripe instance
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY, {
    apiVersion: '2023-10-16',
    appInfo: {
        name: 'TributeToro',
        version: '1.0.0',
        url: process.env.FRONTEND_URL || 'https://tributetoro.com'
    }
});
const prisma = require('../lib/prisma');
const { authMiddleware } = require('../middleware/auth');

// --- Constants ---
const PLATFORM_FEE_PERCENTAGE = 0.15;
const PLATFORM_FEE_FIXED_CENTS = 100;
const MINIMUM_SEND_AMOUNT = 1.00;
const MAXIMUM_SEND_AMOUNT = 2500.00;

// 1. Create Onboarding Link
router.post('/connect/onboard-user', authMiddleware, async (req, res) => {
    try {
        const { country } = req.body;
        if (!country || !/^[A-Z]{2}$/.test(country)) {
            return res.status(400).json({ message: 'A valid 2-letter country code is required.' });
        }
        if (!req.localUser?.id) return res.status(403).json({ message: 'Application profile setup required first.' });
        
        const appUserId = req.localUser.id;
        const appProfile = req.localUser;
        const emailForStripe = req.user?.email || appProfile?.email;
        if (!emailForStripe) return res.status(400).json({ message: 'An email address is required.' });

        const platformBaseUrl = process.env.FRONTEND_URL;
        if (!platformBaseUrl) return res.status(500).json({ message: 'Server configuration error.' });

        let stripeAccountId = appProfile.stripeAccountId;
        if (!stripeAccountId) {
            const accountParams = {
                type: 'express', 
                email: emailForStripe, // This is the correct place to provide the email
                country: country, 
                business_type: 'individual',
                business_profile: { url: `${platformBaseUrl}/${appProfile.username}`, mcc: '5815' },
                capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
            };
            const account = await stripe.accounts.create(accountParams);
            stripeAccountId = account.id;
            await prisma.user.update({
                where: { id: appUserId },
                data: { stripeAccountId: stripeAccountId, stripeAccountCountry: country },
            });
        }
        
        // --- THIS IS THE FIX ---
        // The `accountLinks.create` call should be simple and contain only the required parameters.
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

// 2. Get Account Status
router.get('/connect/account-status', authMiddleware, async (req, res) => {
    try {
        if (!req.localUser?.id) return res.status(403).json({ message: 'User profile not found.' });
        const user = req.localUser;
        if (!user.stripeAccountId) return res.status(404).json({ message: 'Stripe account not connected for this user.' });
        const account = await stripe.accounts.retrieve(user.stripeAccountId);
        const onboardingComplete = !!(account.charges_enabled && account.details_submitted && account.payouts_enabled);
        await prisma.user.update({
            where: { id: user.id },
            data: {
                stripeOnboardingComplete: onboardingComplete,
                stripeDefaultCurrency: account.default_currency,
                stripeAccountCountry: account.country,
            },
        });
        res.json({
            stripeAccountId: user.stripeAccountId, detailsSubmitted: account.details_submitted,
            chargesEnabled: account.charges_enabled, payoutsEnabled: account.payouts_enabled,
            onboardingComplete: onboardingComplete, accountCountry: account.country,
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
        
        // --- CHANGE 1: Destructure `pageBlockId` from the request body ---
        const { amount: amountForCreatorDollars, recipientUsername, donorName, pageBlockId } = req.body;

        const recipientUser = await prisma.user.findUnique({
            where: { username: recipientUsername },
            select: { id: true, username: true, displayName: true, stripeAccountId: true, stripeOnboardingComplete: true, payoutsInUsd: true, stripeDefaultCurrency: true }
        });

        if (!recipientUser || !recipientUser.stripeAccountId || !recipientUser.stripeOnboardingComplete) {
            return res.status(400).json({ message: 'This creator is not set up for payments.' });
        }

        let chargeCurrency = recipientUser.payoutsInUsd ? 'usd' : (recipientUser.stripeDefaultCurrency || 'usd');
        let creatorReceivesAmountInCents;
        let productName;

        // --- CHANGE 2: Conditional logic for Wishlist vs. Generic Tip ---
        if (pageBlockId) {
            // This is a Wishlist Item purchase
            const wishlistItem = await prisma.pageBlock.findFirst({
                where: { id: pageBlockId, userId: recipientUser.id, type: 'WISHLIST' },
                include: { _count: { select: { payments: true } } }
            });
            if (!wishlistItem) return res.status(404).json({ message: 'Wishlist item not found.' });

            // Check if the goal has been met
            if (!wishlistItem.isUnlimited && wishlistItem._count.payments >= wishlistItem.quantityGoal) {
                return res.status(400).json({ message: 'This wishlist item goal has already been met.' });
            }
            
            creatorReceivesAmountInCents = wishlistItem.priceCents;
            productName = `Funding: ${wishlistItem.title}`;
        } else {
            // This is a generic tip, use the amount from the form
            if (!amountForCreatorDollars || isNaN(parseFloat(amountForCreatorDollars)) || 
                parseFloat(amountForCreatorDollars) < MINIMUM_SEND_AMOUNT ||
                parseFloat(amountForCreatorDollars) > MAXIMUM_SEND_AMOUNT
            ) {
                return res.status(400).json({ 
                    message: `A valid amount (min ${MINIMUM_SEND_AMOUNT.toFixed(2)}, max ${MAXIMUM_SEND_AMOUNT.toFixed(2)}) is required.` 
                });
            }
            creatorReceivesAmountInCents = Math.round(parseFloat(amountForCreatorDollars) * 100);
            productName = `Support for ${recipientUser.displayName || recipientUser.username}`;
        }

        const platformFeeInCents = Math.round((creatorReceivesAmountInCents * PLATFORM_FEE_PERCENTAGE) + PLATFORM_FEE_FIXED_CENTS);
        const grossAmountInCents = creatorReceivesAmountInCents + platformFeeInCents;
        
        const MINIMUM_CHARGE_CENTS = { 'usd': 50, 'cad': 50, 'aud': 50, 'gbp': 30, 'eur': 50 };
        if (grossAmountInCents < (MINIMUM_CHARGE_CENTS[chargeCurrency] || 50)) {
            return res.status(400).json({ message: `The total charge amount is below the minimum.` });
        }
        
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card', 'klarna', 'link'],
            line_items: [{
                price_data: {
                    currency: chargeCurrency,
                    product_data: { name: productName },
                    unit_amount: grossAmountInCents
                },
                quantity: 1
            }],
            mode: 'payment',
            success_url: `${process.env.FRONTEND_URL}/payment-success?recipient=${recipientUsername}&amount_sent=${(creatorReceivesAmountInCents / 100).toFixed(2)}`,
            cancel_url: `${process.env.FRONTEND_URL}/${recipientUser.username}?payment_cancelled=true`,
            payment_intent_data: {
                on_behalf_of: recipientUser.stripeAccountId,
                transfer_data: {
                    destination: recipientUser.stripeAccountId,
                    amount: creatorReceivesAmountInCents
                }
            },
            billing_address_collection: 'required',
            metadata: {
                appRecipientUserId: recipientUser.id,
                grossAmountChargedToDonor: grossAmountInCents.toString(),
                intendedAmountForCreator: creatorReceivesAmountInCents.toString(),
                platformFeeCalculated: platformFeeInCents.toString(),
                paymentCurrency: chargeCurrency,
                donorName: donorName ? donorName.substring(0, 100) : 'Anonymous',
                // --- CHANGE 3: Add `pageBlockId` to metadata if it exists ---
                pageBlockId: pageBlockId || null,
            },
        });

        res.json(session);

    } catch (error) {
        console.error('[/create-checkout-session] Error:', error.message, error.stack);
        res.status(500).json({ message: 'Error creating payment session', error: error.message });
    }
});

// 4. Create Express Dashboard Link
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

// 5. Trigger a MANUAL STANDARD PAYOUT ("Payout Now" button)
router.post('/payouts/instant', authMiddleware, async (req, res) => {
    try {
        if (!req.localUser?.stripeAccountId || !req.localUser.stripeOnboardingComplete) {
            return res.status(400).json({ message: "Stripe account not fully set up for payouts." });
        }
        const user = req.localUser;
        const stripeAccountId = user.stripeAccountId;
        const balance = await stripe.balance.retrieve({ stripeAccount: stripeAccountId });
        const connectedAccount = await stripe.accounts.retrieve(stripeAccountId);
        const defaultCurrency = connectedAccount.default_currency;
        const availableBalance = balance.available.find(b => b.currency === defaultCurrency);
        if (!availableBalance || availableBalance.amount <= 0) {
            return res.status(400).json({ message: "No available balance for a payout." });
        }
        
        const payout = await stripe.payouts.create({
            amount: availableBalance.amount, 
            currency: defaultCurrency, 
            method: 'standard', // This correctly triggers a free, 2-5 day payout
        }, { stripeAccount: stripeAccountId });

        res.json({ success: true, message: `Standard payout of ${formatCurrency(payout.amount, payout.currency)} initiated. It should arrive in 2-5 business days.`, payoutId: payout.id });

    } catch (error) {
        console.error("[/payouts/instant] Stripe Payout Error:", error);
        let userMessage = "Failed to initiate payout.";
        if (error.type === 'StripeInvalidRequestError') {
            if (error.code === 'balance_insufficient') userMessage = "Your available balance is insufficient.";
            else if (error.code === 'payouts_not_allowed') userMessage = "Payouts are currently disabled on your account.";
            else userMessage = "Could not process payout. Please check your Stripe dashboard for issues.";
        }
        res.status(400).json({ message: userMessage, error: error.message });
    }
});

// 6. TOGGLE AUTOMATIC INSTANT PAYOUTS
router.post('/payouts/toggle-mode', authMiddleware, async (req, res) => {
    try {
        if (!req.localUser?.stripeAccountId || !req.localUser.stripeOnboardingComplete) {
            return res.status(400).json({ message: "Stripe account not fully set up." });
        }
        
        const { instantPayoutsEnabled } = req.body;
        if (typeof instantPayoutsEnabled !== 'boolean') {
            return res.status(400).json({ message: "Invalid value provided." });
        }

        const user = req.localUser;
        const stripeAccountId = user.stripeAccountId;

        // --- THIS IS THE KEY LOGIC CHANGE ---
        // To enable our app's auto-payout webhook, we must set Stripe's schedule to manual.
        // To disable it, we also set it to manual, so no payouts happen automatically at all.
        await stripe.accounts.update(stripeAccountId, {
            settings: {
                payouts: {
                    schedule: {
                        interval: 'manual',
                    }
                }
            }
        });

        // The only thing we toggle is the flag in our own database.
        const updatedUser = await prisma.user.update({
            where: { id: user.id },
            data: { autoInstantPayoutsEnabled: instantPayoutsEnabled },
        });

        const message = instantPayoutsEnabled 
            ? "Automatic Instant Payouts have been enabled." 
            : "Automatic Instant Payouts have been disabled.";

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

// 7. Get Balance
router.get('/balance', authMiddleware, async (req, res) => {
    try {
        if (!req.localUser?.stripeAccountId || !req.localUser.stripeOnboardingComplete) {
            return res.status(404).json({ message: "Stripe account not fully set up." });
        }
        const stripeAccountId = req.localUser.stripeAccountId;
        const balance = await stripe.balance.retrieve({ stripeAccount: stripeAccountId });
        res.json(balance);
    } catch (error) {
        console.error('[/stripe/balance] Error fetching Stripe balance:', error);
        res.status(500).json({ message: 'Error fetching Stripe balance', error: error.message });
    }
});

module.exports = router;