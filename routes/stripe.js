const express = require('express');
const router = express.Router(); // Renamed to 'router' for clarity when exporting
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const prisma = require('../lib/prisma');
const { authMiddleware } = require('../middleware/auth');

// Environment variable checks
if (!process.env.STRIPE_SECRET_KEY) { console.error("FATAL: STRIPE_SECRET_KEY missing"); }
if (!process.env.STRIPE_WEBHOOK_SECRET) { console.warn("WARN: STRIPE_WEBHOOK_SECRET missing"); }

console.log("[Stripe Router] Initialized.");

// 1. Create Stripe Connect Account and Onboarding Link
router.post('/connect/onboard-user', authMiddleware, async (req, res) => {
    try {
        if (!req.localUser?.id) return res.status(403).json({ message: 'App profile setup required first.' });
        const appUserId = req.localUser.id;
        let appProfile = req.localUser;
        if (!appProfile.username) return res.status(400).json({ message: 'Username required in profile for Stripe.' });
        const emailForStripe = req.user?.email || appProfile?.email;
        if (!emailForStripe) return res.status(400).json({ message: 'Email required for Stripe.' });
        const platformBaseUrl = process.env.FRONTEND_URL;
        if (!platformBaseUrl || !platformBaseUrl.startsWith('http')) {
            return res.status(500).json({ message: 'Server config error: FRONTEND_URL invalid.' });
        }
        let stripeAccountId = appProfile.stripeAccountId;
        if (!stripeAccountId) {
            const userProfileUrlOnPlatform = `${platformBaseUrl}/${appProfile.username}`;
            const productDescriptionOnPlatform = `Receiving support via ${process.env.PLATFORM_DISPLAY_NAME || 'our platform'}.`;
            const account = await stripe.accounts.create({
                type: 'express', country: 'US', email: emailForStripe, business_type: 'individual',
                business_profile: { url: userProfileUrlOnPlatform, mcc: '8999', product_description: productDescriptionOnPlatform },
                capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
            });
            stripeAccountId = account.id;
            await prisma.user.update({ where: { id: appUserId }, data: { stripeAccountId, stripeOnboardingComplete: false }});
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
        if (!user.stripeAccountId) return res.status(404).json({ message: 'Stripe account not connected.' });
        const account = await stripe.accounts.retrieve(user.stripeAccountId);
        const onboardingComplete = !!(account.charges_enabled && account.details_submitted && account.payouts_enabled);
        if (user.stripeOnboardingComplete !== onboardingComplete) {
            await prisma.user.update({ where: { id: user.id }, data: { stripeOnboardingComplete }});
        }
        res.json({ onboardingComplete, stripeAccountId: user.stripeAccountId, detailsSubmitted: account.details_submitted, chargesEnabled: account.charges_enabled, payoutsEnabled: account.payouts_enabled });
    } catch (error) {
        console.error('[/account-status] Error:', error.message, error.stack);
        res.status(500).json({ message: 'Error fetching Stripe status', error: error.message });
    }
});

// 3. Create Stripe Checkout Session (Separate Charge and Transfer model)
// This route will now correctly receive a parsed req.body
router.post('/create-checkout-session', async (req, res) => {
    console.log("[Stripe Router] POST /create-checkout-session. Body:", req.body);
    if (!req.body) return res.status(400).json({ message: 'Request body missing.' });
    const { amount: creatorReceivesAmountDollars, recipientUsername } = req.body;
    if (!recipientUsername || isNaN(parseFloat(creatorReceivesAmountDollars)) || parseFloat(creatorReceivesAmountDollars) < 1.00) {
        return res.status(400).json({ message: 'Valid amount for creator (min $1.00) and recipient username required.' });
    }
    try {
        const recipientUser = await prisma.user.findUnique({
            where: { username: recipientUsername },
            select: { id: true, username: true, displayName: true, stripeAccountId: true, stripeOnboardingComplete: true }
        });
        if (!recipientUser || !recipientUser.stripeAccountId || !recipientUser.stripeOnboardingComplete) {
            return res.status(400).json({ message: 'This creator is not currently set up to receive payments.' });
        }
        const creatorReceivesAmount = parseFloat(creatorReceivesAmountDollars);
        const platformFeePercentage = 0.15;
        const platformFeeDollars = creatorReceivesAmount * platformFeePercentage;
        const grossAmountDollars = creatorReceivesAmount + platformFeeDollars;
        const grossAmountInCents = Math.round(grossAmountDollars * 100);
        const creatorReceivesAmountInCents = Math.round(creatorReceivesAmount * 100);
        if (grossAmountInCents < 50) return res.status(400).json({ message: 'Calculated charge amount is too small.' }); // Stripe minimum is 50 cents
        const productName = `Support for ${recipientUser.displayName || recipientUser.username}`;
        const productDescription = `Total payment of $${grossAmountDollars.toFixed(2)} via ${process.env.PLATFORM_DISPLAY_NAME || 'Our Platform'}.`;
        const transferGroup = `tip_${recipientUser.id}_${Date.now()}`;
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{ price_data: { currency: 'usd', product_data: { name: productName, description: productDescription }, unit_amount: grossAmountInCents }, quantity: 1 }],
            mode: 'payment',
            success_url: `${process.env.FRONTEND_URL}/payment-success?recipient=${recipientUsername}&amount_sent=${creatorReceivesAmount.toFixed(2)}`,
            cancel_url: `${process.env.FRONTEND_URL}/${recipientUsername}?payment_cancelled=true`,
            payment_intent_data: {
                transfer_group: transferGroup, // Link this payment to a group for the future transfer
            },
            metadata: {
                appRecipientUserId: recipientUser.id,
                appRecipientStripeAccountId: recipientUser.stripeAccountId,
                transferAmountCents: creatorReceivesAmountInCents.toString(),
                transfer_group: transferGroup, // Also store in metadata for easy access
            },
        });
        res.json({ id: session.id });
    } catch (error) {
        console.error('[/create-checkout-session] Error:', error.message, error.stack);
        res.status(500).json({ message: 'Error creating payment session', error: error.message });
    }
});

// 4. Stripe Webhook Handler (Exported as a named function for index.js to use directly)
const handleStripeWebhook = async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    // --- DEBUGGING LOGS ---
    console.log('[Webhook Debug] Type of req.body:', typeof req.body);
    if (req.body instanceof Buffer) {
        console.log('[Webhook Debug] req.body is a Buffer. Length:', req.body.length);
        // Do NOT log the full raw body in production logs for security reasons,
        // but it's useful for debugging this specific error.
        // console.log('[Webhook Debug] req.body (as string):', req.body.toString('utf8').substring(0, 500) + '...');
    } else {
        console.log('[Webhook Debug] req.body is NOT a Buffer. Value:', req.body);
    }
    // --- END DEBUGGING LOGS ---

    let event;
    try {
        // req.body should be the raw buffer here because of express.raw() in index.js
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
        console.error(`[Webhook] Signature verification failed: ${err.message}`);
        // IMPORTANT: Return 400 for failed signature verification
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    console.log(`[Webhook] Event received: ${event.type}, ID: ${event.id}`);
    switch (event.type) {
        case 'checkout.session.completed':
            const session = event.data.object;
            if (session.payment_status === 'paid') {
                console.log('[Webhook] Checkout Session paid. Processing separate transfer.');
                const metadata = session.metadata;
                const recipientStripeAccountId = metadata?.appRecipientStripeAccountId;
                const transferAmountCents = parseInt(metadata?.transferAmountCents, 10);
                const paymentIntentId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
                const appRecipientUserId = metadata?.appRecipientUserId;

                if (!recipientStripeAccountId || !transferAmountCents || !paymentIntentId || !appRecipientUserId) {
                    console.error('[Webhook] CRITICAL: Metadata missing for transfer. Session ID:', session.id, 'Metadata:', metadata);
                    return res.status(200).json({ received: true, error: "Metadata missing, cannot create transfer." });
                }
                try {
                    const existingPayment = await prisma.payment.findUnique({ where: { stripePaymentIntentId: paymentIntentId }});
                    if (existingPayment) {
                        console.log(`[Webhook] Payment ${paymentIntentId} already processed.`);
                        return res.status(200).json({ received: true, message: "Already processed" });
                    }

                    console.log(`[Webhook] Creating transfer of ${transferAmountCents} cents to ${recipientStripeAccountId}. Source PaymentIntent: ${paymentIntentId}`);
                    const transfer = await stripe.transfers.create({
                        amount: transferAmountCents,
                        currency: 'usd',
                        destination: recipientStripeAccountId,
                        source_transaction: paymentIntentId, // This correctly links to the original PaymentIntent
                    });
                    console.log(`[Webhook] SUCCESS: Transfer created with ID: ${transfer.id} for PaymentIntent ${paymentIntentId}`);

                    await prisma.payment.create({
                        data: {
                            stripePaymentIntentId: paymentIntentId,
                            amount: session.amount_total, // Total amount paid by donor
                            currency: session.currency.toLowerCase(),
                            status: 'succeeded',
                            recipientUserId: appRecipientUserId,
                            payerEmail: session.customer_details?.email,
                            platformFee: session.amount_total - transferAmountCents, // Your fee calculated
                        },
                    });
                    console.log(`[Webhook] Payment and Transfer for PI ${paymentIntentId} recorded successfully.`);
                } catch (err) {
                    console.error(`[Webhook] FATAL ERROR during transfer or DB operation for PI ${paymentIntentId}:`, err.message, err.stack);
                    // Consider logging more context about the payment intent
                    // A 500 here tells Stripe to retry the webhook
                    return res.status(500).json({ error: `Failed to process webhook: ${err.message}` });
                }
            }
            break;
        case 'account.updated':
            const account = event.data.object;
            try {
                const userToUpdate = await prisma.user.findFirst({ where: { stripeAccountId: account.id } });
                if (userToUpdate) {
                    const onboardingComplete = !!(account.charges_enabled && account.details_submitted && account.payouts_enabled);
                    if (userToUpdate.stripeOnboardingComplete !== onboardingComplete) {
                        await prisma.user.update({ where: { id: userToUpdate.id }, data: { stripeOnboardingComplete }});
                        console.log(`[Webhook] Updated onboarding for Stripe account ${account.id} to ${onboardingComplete}`);
                    }
                }
            } catch (dbError) { console.error('[Webhook] DB error from account.updated:', dbError); }
            break;
        default:
            console.log(`[Webhook] Unhandled event type ${event.type}`);
    }
    // Always respond with 200 to Stripe when the event is successfully received and processed
    res.status(200).json({ received: true });
};


// 5. CREATE STRIPE EXPRESS DASHBOARD LOGIN LINK
router.post('/create-express-dashboard-link', authMiddleware, async (req, res) => {
    try {
        if (!req.localUser?.id) return res.status(403).json({ message: 'User profile not found.' });
        if (!req.localUser.stripeAccountId || !req.localUser.stripeOnboardingComplete) return res.status(400).json({ message: 'Stripe account not fully set up.' });
        const loginLink = await stripe.accounts.createLoginLink(req.localUser.stripeAccountId);
        res.json({ url: loginLink.url });
    } catch (error) {
        console.error('[/create-express-dashboard-link] Error:', error);
        if (error.type === 'StripeInvalidRequestError') return res.status(400).json({ message: 'Unable to generate dashboard link.' });
        res.status(500).json({ message: 'Error creating dashboard link', error: error.message });
    }
});

// Export both the router instance and the webhook handler function
module.exports = {
    router: router, // Export the Express router for other routes
    handleWebhook: handleStripeWebhook // Export the webhook handler function
};