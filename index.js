require('dotenv').config();
const express = require('express');
const cors = require('cors');
const prisma = require('./lib/prisma');
const { Resend } = require('resend');
// Initialize Stripe and Resend directly in this file
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

const app = express();
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
            console.error(`[CORS] Origin ${origin} is NOT ALLOWED.`);
            callback(new Error(`Origin [${origin}] not allowed by CORS policy`));
        }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Client-Info'],
    optionsSuccessStatus: 204
};
app.use(cors(corsOptions));

// --- WEBHOOK HANDLER #1: For Standard "Account" Events ---
// URL: /api/stripe/account-webhook
app.post('/api/stripe/account-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_ACCOUNT_WEBHOOK_SECRET; 
    if (!webhookSecret) {
        console.error("FATAL: STRIPE_ACCOUNT_WEBHOOK_SECRET env var is not set.");
        return res.status(500).send("Account Webhook secret not configured.");
    }
    
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
        console.error(`[Account Webhook] Signature verification failed: ${err.message}`);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    
    console.log(`[Account Webhook] Event received: ${event.type}, ID: ${event.id}`);
    res.status(200).json({ received: true });
});

// URL: /api/stripe/connect-webhook
app.post('/api/stripe/connect-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
    if (!webhookSecret) {
        console.error("FATAL: STRIPE_CONNECT_WEBHOOK_SECRET env var is not set.");
        return res.status(500).send("Connect Webhook secret not configured.");
    }

    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
        console.error(`[Connect Webhook] Signature verification failed: ${err.message}`);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    console.log(`[Connect Webhook] Event received and verified: ${event.type}, ID: ${event.id}`);

    switch (event.type) {
        case 'checkout.session.completed': {
            const session = event.data.object;
            
            if (session.payment_status !== 'paid') {
                console.log(`[Connect Webhook] Ignoring checkout.session.completed with status: ${session.payment_status}`);
                break;
            }

            const paymentIntentId = session.payment_intent;
            const metadata = session.metadata;
            const appRecipientUserId = metadata?.appRecipientUserId;

            if (!appRecipientUserId || !paymentIntentId) {
                console.error(`[Connect Webhook] Missing critical metadata for session ${session.id}`);
                break;
            }

            // Step 1: Create the payment record. This is our source of truth.
            try {
                const existingPayment = await prisma.payment.findUnique({ where: { stripePaymentIntentId: paymentIntentId } });
                if (!existingPayment) {
                    const intendedAmountForCreator = parseInt(metadata.intendedAmountForCreator, 10);
                    const grossAmountChargedToDonor = parseInt(metadata.grossAmountChargedToDonor, 10);
                    await prisma.payment.create({
                        data: {
                            stripePaymentIntentId: paymentIntentId,
                            amount: grossAmountChargedToDonor,
                            currency: session.currency.toLowerCase(),
                            status: 'SUCCEEDED',
                            recipientUserId: appRecipientUserId,
                            platformFee: grossAmountChargedToDonor - intendedAmountForCreator,
                            netAmountToRecipient: intendedAmountForCreator,
                            payerName: metadata.donorName || 'Anonymous',
                            payerEmail: session.customer_details?.email,
                        },
                    });
                    console.log(`[Connect Webhook] Payment record created from session ${session.id} for PI ${paymentIntentId}.`);
                }
            } catch (dbError) {
                console.error(`[Connect Webhook] CRITICAL: DB write failed for session ${session.id}. Error:`, dbError);
                return res.status(500).json({ error: "Database write failed." });
            }

            // Step 2: Handle secondary actions.
            try {
                const creator = await prisma.user.findUnique({ where: { id: appRecipientUserId }, select: { email: true, hasFeeRebateBonus: true, stripeAccountId: true }});
                if (creator) {
                    // Bonus Logic
                    if (creator.hasFeeRebateBonus) {
                        try {
                            const intendedAmountForCreator = parseInt(metadata.intendedAmountForCreator, 10);
                            const bonusAmount = Math.round(intendedAmountForCreator * 0.10);
                            if (bonusAmount > 0) {
                                await stripe.transfers.create({ amount: bonusAmount, currency: session.currency, destination: creator.stripeAccountId, transfer_group: `bonus_${paymentIntentId}` });
                            }
                        } catch (bonusError) { console.error(`[Connect Webhook] BONUS FAILED for session ${session.id}:`, bonusError.message); }
                    }
                    // Email Logic
                    if (creator.email && process.env.RESEND_API_KEY) {
                        try {
                            const intendedAmountForCreator = parseInt(metadata.intendedAmountForCreator, 10);
                            const amountString = new Intl.NumberFormat('en-US', { style: 'currency', currency: session.currency.toUpperCase() }).format(intendedAmountForCreator / 100);
                            await resend.emails.send({ from: 'TributeToro <noreply@tributetoro.com>', to: [creator.email], subject: `You received a new tip of ${amountString}!`, html: `<div>...</div>` });
                        } catch (emailError) { console.error(`[Connect Webhook] EMAIL FAILED for session ${session.id}:`, emailError.message); }
                    }
                }
            } catch (secondaryError) {
                console.error(`[Connect Webhook] Error in secondary actions for session ${session.id}:`, secondaryError.message);
            }
            break;
        }

        case 'checkout.session.completed': {
            console.log(`[Connect Webhook] Received checkout.session.completed for session: ${event.data.object.id}. Main logic is handled by payment_intent.succeeded.`);
            break;
        }
        case 'payment_intent.payment_failed': {
            const failedPI = event.data.object;
            await prisma.failedPaymentAttempt.create({
                data: {
                    stripePiId: failedPI.id, amount: failedPI.amount, currency: failedPI.currency,
                    recipientUserId: failedPI.metadata?.appRecipientUserId || 'unknown',
                    failureCode: failedPI.last_payment_error?.code,
                    failureMessage: failedPI.last_payment_error?.message,
                }
            }).catch(err => console.error(`[Connect Webhook] DB Error logging failed payment:`, err));
            break;
        }
        case 'charge.refunded': {
            const refund = event.data.object;
            await prisma.payment.update({
                where: { stripePaymentIntentId: refund.payment_intent }, data: { status: 'REFUNDED' },
            }).catch(err => console.error(`[Connect Webhook] DB Error on charge.refunded:`, err));
            break;
        }
        case 'charge.dispute.created': {
            const dispute = event.data.object;
            await prisma.payment.update({
                where: { stripePaymentIntentId: dispute.payment_intent }, data: { status: 'DISPUTED' },
            }).catch(err => console.error(`[Connect Webhook] DB Error on charge.dispute.created:`, err));
            break;
        }
        case 'charge.dispute.closed': {
            const closedDispute = event.data.object;
            const newStatus = closedDispute.status === 'won' ? 'SUCCEEDED' : 'FAILED';
            await prisma.payment.update({
                where: { stripePaymentIntentId: closedDispute.payment_intent }, data: { status: newStatus },
            }).catch(err => console.error(`[Connect Webhook] DB Error on charge.dispute.closed:`, err));
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
                }).catch(err => console.error(`[Connect Webhook] DB Error on payout.paid:`, err));
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
                }).catch(err => console.error(`[Connect Webhook] DB Error on payout.failed:`, err));
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
                        amount: availableBalance.amount, currency: availableBalance.currency, method: 'instant',
                    }, { stripeAccount: stripeAccountId })
                        .catch(payoutError => console.error(`[Connect Webhook] Auto-payout failed for ${stripeAccountId}:`, payoutError.message));
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