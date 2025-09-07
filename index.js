require('dotenv').config();
const express = require('express');
const cors = require('cors');
const prisma = require('./lib/prisma');
const { Resend } = require('resend');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const resend = new Resend(process.env.RESEND_API_KEY);
const app = express(); // --- FIX: `app` is now defined at the top ---
const PORT = process.env.PORT || 3001;

// --- CORS Configuration ---
const frontendUrlFromEnv = process.env.FRONTEND_URL;
if (!frontendUrlFromEnv) { console.warn("WARNING: FRONTEND_URL environment variable is NOT SET."); }
const allowedOrigins = [frontendUrlFromEnv].filter(Boolean);
const corsOptions = {
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            callback(new Error(`Origin [${origin}] not allowed by CORS policy`));
        }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Client-Info'],
    optionsSuccessStatus: 204
};
app.use(cors(corsOptions));

// --- STRIPE WEBHOOK HANDLER ---
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
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

    if (event.type === 'payment_intent.succeeded') {
        const paymentIntent = event.data.object;
        const metadata = paymentIntent.metadata;
        const appRecipientUserId = metadata?.appRecipientUserId;
        
        if (!appRecipientUserId) {
            console.error(`[Webhook] Missing appRecipientUserId metadata for PI ${paymentIntent.id}`);
            return res.status(200).json({ received: true, message: "Ignoring event with missing metadata." });
        }
        
        // Step 1: Create the critical payment record FIRST.
        try {
            const existingPayment = await prisma.payment.findUnique({ where: { stripePaymentIntentId: paymentIntent.id } });
            if (!existingPayment) {
                const intendedAmountForCreator = parseInt(metadata?.intendedAmountForCreator, 10);
                const grossAmountChargedToDonor = parseInt(metadata?.grossAmountChargedToDonor, 10);
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
                console.log(`[Webhook] Payment record created for PI ${paymentIntent.id}.`);
            } else {
                console.log(`[Webhook] Payment record for PI ${paymentIntent.id} already exists.`);
            }
        } catch (dbError) {
            console.error(`[Webhook] CRITICAL: Failed to create payment record for PI ${paymentIntent.id}. Error:`, dbError);
            return res.status(500).json({ error: "Database error during payment creation." });
        }

        // Step 2: Handle secondary actions (bonus, email) in isolated blocks.
        try {
            const creator = await prisma.user.findUnique({ where: { id: appRecipientUserId }, select: { email: true, hasFeeRebateBonus: true, stripeAccountId: true }});
            if (creator) {
                if (creator.hasFeeRebateBonus) {
                    try {
                        const intendedAmountForCreator = parseInt(metadata?.intendedAmountForCreator, 10);
                        const bonusAmount = Math.round(intendedAmountForCreator * 0.10);
                        if (bonusAmount > 0) {
                            await stripe.transfers.create({ amount: bonusAmount, currency: paymentIntent.currency, destination: creator.stripeAccountId, transfer_group: `bonus_${paymentIntent.id}` });
                            console.log(`[BONUS] Successfully sent bonus for PI ${paymentIntent.id}`);
                        }
                    } catch (bonusError) { console.error(`[Webhook] BONUS FAILED for PI ${paymentIntent.id}:`, bonusError.message); }
                }
                if (creator.email && process.env.RESEND_API_KEY) {
                    try {
                        const intendedAmountForCreator = parseInt(metadata?.intendedAmountForCreator, 10);
                        const amountString = new Intl.NumberFormat('en-US', { style: 'currency', currency: paymentIntent.currency.toUpperCase() }).format(intendedAmountForCreator / 100);
                        await resend.emails.send({ from: 'TributeToro <noreply@tributetoro.com>', to: [creator.email], subject: `You received a new tip of ${amountString}!`, html: `<div>...</div>` });
                        console.log(`[EMAIL] Sent email for PI ${paymentIntent.id}`);
                    } catch (emailError) { console.error(`[Webhook] EMAIL FAILED for PI ${paymentIntent.id}:`, emailError.message); }
                }
            }
        } catch (secondaryActionError) {
            console.error(`[Webhook] Error during secondary actions for PI ${paymentIntent.id}:`, secondaryActionError.message);
        }
    
    } else {
        // Handle all other events in a switch
        switch (event.type) {

        case 'checkout.session.completed': {
            console.log(`[Webhook] Received checkout.session.completed for session: ${event.data.object.id}. Associated payment will be handled by payment_intent.succeeded.`);
            break;
        }
        
        case 'payment_intent.payment_failed': {
            const failedPI = event.data.object;
            await prisma.failedPaymentAttempt.create({
                data: {
                    stripePiId: failedPI.id,
                    amount: failedPI.amount,
                    currency: failedPI.currency,
                    recipientUserId: failedPI.metadata?.appRecipientUserId || 'unknown',
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
            const user = await prisma.user.findFirst({ where: { stripeAccountId: event.account } });
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
            const user = await prisma.user.findFirst({ where: { stripeAccountId: event.account } });
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
                    await prisma.user.update({ where: { id: userToUpdate.id }, data: { stripeOnboardingComplete } });
                }
            }
            break;
        }
    }
    }
    res.status(200).json({ received: true });
});


// --- GENERAL MIDDLEWARE AND ROUTE IMPORTS ---
app.use(express.json());

const stripeRoutes = require('./routes/stripe');
const userRoutes = require('./routes/users');
const linkRoutes = require('./routes/links');
const publicProfileRoutes = require('./routes/publicProfile');
const paymentRoutes = require('./routes/payments');
const { authMiddleware } = require('./middleware/auth');

app.use('/api/stripe', stripeRoutes);
app.use('/api/public', publicProfileRoutes);
app.use('/api/users', userRoutes);
app.use('/api/payments', authMiddleware, paymentRoutes);
app.use('/api/links', authMiddleware, linkRoutes);

app.get('/api', (req, res) => res.status(200).json({ status: 'healthy' }));

// --- ERROR HANDLING & SERVER START ---
app.use((err, req, res, next) => {
    console.error("--- Unhandled Express Error ---", err.stack);
    if (res.headersSent) { return next(err); }
    res.status(err.status || 500).json({ error: "INTERNAL_SERVER_ERROR", message: err.message || 'An unexpected error occurred!' });
});

app.listen(PORT, () => {
    console.log(`Backend server is officially running on port ${PORT}`);
});