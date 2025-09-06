require('dotenv').config();
const express = require('express');
const cors = require('cors');
const prisma = require('./lib/prisma');
// Initialize Stripe instance specifically for this file's needs (webhooks)
const stripe = require('./lib/stripe'); // Import the shared instance for webhooks

const app = express();
const PORT = process.env.PORT || 3001;

// --- CORS Configuration ---
const frontendUrlFromEnv = process.env.FRONTEND_URL;
if (!frontendUrlFromEnv) { console.warn("WARNING: FRONTEND_URL environment variable is NOT SET."); }
const allowedOrigins = [frontendUrlFromEnv || 'http://localhost:3000'].filter(Boolean);
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

// --- ROUTE IMPORTS ---
const stripeRoutes = require('./routes/stripe'); 
const userRoutes = require('./routes/users');
const linkRoutes = require('./routes/links');
const publicProfileRoutes = require('./routes/publicProfile');
const paymentRoutes = require('./routes/payments');
const { authMiddleware } = require('./middleware/auth');


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
});

// --- GENERAL MIDDLEWARE AND ROUTE MOUNTING ---
app.use(express.json());

app.use('/api/stripe', stripeRoutes); 
app.use('/api/public', publicProfileRoutes);
app.use('/api/users', userRoutes);
app.use('/api/payments', authMiddleware, paymentRoutes);
app.use('/api/links', authMiddleware, (req, res, next) => {
    if (!req.localUser) {
        return res.status(403).json({ message: "Profile setup required." });
    }
    next();
}, linkRoutes);

app.get('/api', (req, res) => res.status(200).json({ status: 'healthy' }));


// --- ERROR HANDLING & SERVER START ---
app.use((err, req, res, next) => {
    console.error("--- Unhandled Express Error ---", err.stack);
    if (res.headersSent) { return next(err); }
    if (err.message.includes("not allowed by CORS")) { return res.status(403).json({ error: "CORS_ERROR", message: err.message }); }
    res.status(err.status || 500).json({ error: "INTERNAL_SERVER_ERROR", message: err.message || 'An unexpected error occurred!' });
});

app.listen(PORT, () => { console.log(`Backend server running on port ${PORT}`); });