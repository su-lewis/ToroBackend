const express = require('express');
const router = express.Router();
const stripe = require('../lib/stripe'); // Import the shared Stripe instance
const prisma = require('../lib/prisma');
const { authMiddleware } = require('../middleware/auth');

// --- Constants for payment logic ---
const PLATFORM_FEE_PERCENTAGE = 0.15; // 15% platform fee
const PLATFORM_FEE_FIXED_CENTS = 100; // $1.00 in cents
const MINIMUM_SEND_AMOUNT_USD_EQUIVALENT = 5.00; // The minimum amount a user can send, in USD equivalent.

// --- API ROUTES ---

// 1. Create Stripe Connect Account and Onboarding Link
router.post('/connect/onboard-user', authMiddleware, async (req, res) => {
    try {
        const { country } = req.body;
        if (!country || !/^[A-Z]{2}$/.test(country)) {
            return res.status(400).json({ message: 'A valid 2-letter country code is required.' });
        }
        if (!req.localUser?.id) return res.status(403).json({ message: 'Application profile setup required first.' });
        
        const appUserId = req.localUser.id;
        const appProfile = req.localUser;
        if (!appProfile.username) return res.status(400).json({ message: 'A username is required to connect with Stripe.' });
        
        const emailForStripe = req.user?.email || appProfile?.email;
        if (!emailForStripe) return res.status(400).json({ message: 'An email address is required to connect with Stripe.' });

        const platformBaseUrl = process.env.FRONTEND_URL;
        if (!platformBaseUrl || !platformBaseUrl.startsWith('http')) return res.status(500).json({ message: 'Server configuration error: A valid FRONTEND_URL is required.' });

        let stripeAccountId = appProfile.stripeAccountId;
        if (!stripeAccountId) {
            const accountParams = {
                type: 'express',
                email: emailForStripe,
                country: country,
                business_type: 'individual',
                business_profile: { url: `${platformBaseUrl}/${appProfile.username}`, mcc: '5815' },
                capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
            };
            const account = await stripe.accounts.create(accountParams);
            stripeAccountId = account.id;
            await prisma.user.update({
                where: { id: appUserId },
                data: { stripeAccountId: stripeAccountId, stripeAccountCountry: country, stripeOnboardingComplete: false },
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
            select: { id: true, username: true, displayName: true, stripeAccountId: true, stripeOnboardingComplete: true, payoutsInUsd: true, stripeDefaultCurrency: true }
        });

        if (!recipientUser || !recipientUser.stripeAccountId || !recipientUser.stripeOnboardingComplete) {
            return res.status(400).json({ message: 'This creator is not set up for payments.' });
        }

        let chargeCurrency = recipientUser.payoutsInUsd ? 'usd' : (recipientUser.stripeDefaultCurrency || 'usd');
        
        if (!recipientUsername || isNaN(parseFloat(amountForCreatorDollars)) || parseFloat(amountForCreatorDollars) < MINIMUM_SEND_AMOUNT_USD_EQUIVALENT) {
            return res.status(400).json({ message: `A valid recipient and amount (min $${MINIMUM_SEND_AMOUNT_USD_EQUIVALENT.toFixed(2)} USD or equivalent) are required.` });
        }
        
        const creatorReceivesAmountInCents = Math.round(parseFloat(amountForCreatorDollars) * 100);
        const platformFeeInCents = Math.round((creatorReceivesAmountInCents * PLATFORM_FEE_PERCENTAGE) + PLATFORM_FEE_FIXED_CENTS);
        const grossAmountInCents = creatorReceivesAmountInCents + platformFeeInCents;
        
        const MINIMUM_CHARGE_CENTS = { 'usd': 50, 'cad': 50, 'aud': 50, 'gbp': 50, 'eur': 50 };
        const minChargeInCents = MINIMUM_CHARGE_CENTS[chargeCurrency] || 50;
        if (grossAmountInCents < minChargeInCents) {
            return res.status(400).json({ message: `The total charge amount is below the minimum.` });
        }
        
        const productName = `Support for ${recipientUser.displayName || recipientUser.username}`;
        const productDescription = `A one-time payment to support ${recipientUser.displayName || recipientUser.username}.`;
        const prefix = process.env.STRIPE_STATEMENT_DESCRIPTOR_PREFIX;
        if (!prefix) {
            console.error("CRITICAL: STRIPE_STATEMENT_DESCRIPTOR_PREFIX is not set.");
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
                    product_data: { name: productName, description: productDescription },
                    unit_amount: grossAmountInCents
                },
                quantity: 1
            }],
            mode: 'payment',
            success_url: `${process.env.FRONTEND_URL}/payment-success?recipient=${recipientUsername}&amount_sent=${(creatorReceivesAmountInCents / 100).toFixed(2)}`,
            cancel_url: `${process.env.FRONTEND_URL}/${recipientUsername}?payment_cancelled=true`,
            payment_intent_data: {
                transfer_data: { destination: recipientUser.stripeAccountId, amount: creatorReceivesAmountInCents },
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

// 4. Create Stripe Express Dashboard Login Link
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

// --- WEBHOOK HANDLER ---
const handleWebhook = async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
        console.error("FATAL: STRIPE_WEBHOOK_SECRET env var is not set.");
        return res.status(500).send("Webhook secret not configured.");
    }
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
        console.error(`[Webhook] Signature verification failed: ${err.message}`);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    console.log(`[Webhook] Event received and verified: ${event.type}, ID: ${event.id}`);
    // This is the entire switch statement moved from index.js
    switch (event.type) {
        case 'checkout.session.completed': {
            const session = event.data.object;
            if (session.payment_status === 'paid') {
                const metadata = session.metadata;
                const paymentIntentId = session.payment_intent;
                const appRecipientUserId = metadata?.appRecipientUserId;
                const intendedAmountForCreator = parseInt(metadata?.intendedAmountForCreator, 10);
                const grossAmountChargedToDonor = parseInt(metadata?.grossAmountChargedToDonor, 10);
                if (paymentIntentId && appRecipientUserId && !isNaN(intendedAmountForCreator)) {
                    const existingPayment = await prisma.payment.findUnique({ where: { stripePaymentIntentId: paymentIntentId } });
                    if (!existingPayment) {
                        await prisma.payment.create({
                            data: {
                                stripePaymentIntentId: paymentIntentId,
                                amount: grossAmountChargedToDonor,
                                currency: session.currency.toLowerCase(),
                                status: 'SUCCEEDED',
                                recipientUserId: appRecipientUserId,
                                payerEmail: session.customer_details?.email,
                                platformFee: grossAmountChargedToDonor - intendedAmountForCreator,
                                netAmountToRecipient: intendedAmountForCreator,
                                payerName: metadata.donorName || 'Anonymous',
                            },
                        });
                    }
                }
            }
            break;
        }
        case 'payment_intent.succeeded': {
            const paymentIntent = event.data.object;
            const metadata = paymentIntent.metadata;
            const appRecipientUserId = metadata?.appRecipientUserId;
            const intendedAmountForCreator = parseInt(metadata?.intendedAmountForCreator, 10);
            const grossAmountChargedToDonor = parseInt(metadata?.grossAmountChargedToDonor, 10);
            if (paymentIntent.id && appRecipientUserId && !isNaN(intendedAmountForCreator)) {
                const existingPayment = await prisma.payment.findUnique({ where: { stripePaymentIntentId: paymentIntent.id } });
                if (!existingPayment) {
                    await prisma.payment.create({
                        data: {
                            stripePaymentIntentId: paymentIntent.id,
                            amount: grossAmountChargedToDonor,
                            currency: paymentIntent.currency.toLowerCase(),
                            status: 'SUCCEEDED',
                            recipientUserId: appRecipientUserId,
                            platformFee: grossAmountChargedToDonor - intendedAmountForCreator,
                            netAmountToRecipient: intendedAmountForCreator,
                            payerName: metadata.donorName || 'Anonymous',
                        },
                    });
                }
            }
            break;
        }
        case 'payment_intent.payment_failed': {
            const failedPI = event.data.object;
            await prisma.failedPaymentAttempt.create({
                data: {
                    stripePiId: failedPI.id,
                    amount: failedPI.amount,
                    currency: failedPI.currency,
                    recipientUserId: failedPI.metadata.appRecipientUserId || 'unknown',
                    failureCode: failedPI.last_payment_error?.code,
                    failureMessage: failedPI.last_payment_error?.message,
                }
            }).catch(err => console.error(`[Webhook] DB Error logging failed payment:`, err));
            break;
        }
        case 'charge.refunded': {
            const refund = event.data.object;
            await prisma.payment.update({
                where: { stripePaymentIntentId: refund.payment_intent },
                data: { status: 'REFUNDED' },
            }).catch(err => console.error(`[Webhook] DB Error on charge.refunded:`, err));
            break;
        }
        case 'charge.dispute.created': {
            const dispute = event.data.object;
            await prisma.payment.update({
                where: { stripePaymentIntentId: dispute.payment_intent },
                data: { status: 'DISPUTED' },
            }).catch(err => console.error(`[Webhook] DB Error on charge.dispute.created:`, err));
            break;
        }
        case 'charge.dispute.closed': {
            const closedDispute = event.data.object;
            const newStatus = closedDispute.status === 'won' ? 'SUCCEEDED' : 'FAILED';
            await prisma.payment.update({
                where: { stripePaymentIntentId: closedDispute.payment_intent },
                data: { status: newStatus },
            }).catch(err => console.error(`[Webhook] DB Error on charge.dispute.closed:`, err));
            break;
        }
        case 'payout.paid': {
            const payout = event.data.object;
            const user = await prisma.user.findFirst({ where: { stripeAccountId: event.account }});
            if (user) {
                await prisma.payout.create({
                    data: {
                        stripePayoutId: payout.id, amount: payout.amount, currency: payout.currency,
                        status: 'PAID', arrivalDate: new Date(payout.arrival_date * 1000), userId: user.id,
                    }
                }).catch(err => console.error(`[Webhook] DB Error on payout.paid:`, err));
            }
            break;
        }
        case 'payout.failed': {
            const payout = event.data.object;
            const user = await prisma.user.findFirst({ where: { stripeAccountId: event.account }});
            if (user) {
                await prisma.payout.create({
                    data: {
                        stripePayoutId: payout.id, amount: payout.amount, currency: payout.currency,
                        status: 'FAILED', failureReason: payout.failure_message, userId: user.id,
                    }
                }).catch(err => console.error(`[Webhook] DB Error on payout.failed:`, err));
            }
            break;
        }
        case 'balance.available': {
            const stripeAccountId = event.account;
            const user = await prisma.user.findFirst({ where: { stripeAccountId } });
            if (user && user.autoInstantPayoutsEnabled) {
                const balance = event.data.object;
                const availableBalance = balance.available.find(b => b.currency === user.stripeDefaultCurrency);
                if (availableBalance && availableBalance.amount > 0) {
                    await stripe.payouts.create({
                        amount: availableBalance.amount,
                        currency: availableBalance.currency,
                        method: 'instant',
                    }, { stripeAccount: stripeAccountId })
                    .catch(payoutError => console.error(`[Webhook] Auto-payout failed for ${stripeAccountId}:`, payoutError.message));
                }
            }
            break;
        }
        case 'account.updated': {
            const account = event.data.object;
            const userToUpdate = await prisma.user.findFirst({ where: { stripeAccountId: account.id } });
            if (userToUpdate) {
                const onboardingComplete = !!(account.charges_enabled && account.details_submitted && account.payouts_enabled);
                if (userToUpdate.stripeOnboardingComplete !== onboardingComplete) {
                    await prisma.user.update({ where: { id: userToUpdate.id }, data: { stripeOnboardingComplete }});
                }
            }
            break;
        }
    }
    res.status(200).json({ received: true });
};

// --- EXPORTS ---
module.exports = {
    router: router,
    handleWebhook: handleWebhook,
};