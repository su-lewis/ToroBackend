// backend/index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const prisma = require('./lib/prisma');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

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
        case 'checkout.session.completed':
            const session = event.data.object;
            if (session.payment_status === 'paid') {
                console.log('[Webhook] Checkout Session paid. Recording payment (Direct Charge model).');
                const metadata = session.metadata;
                const paymentIntentId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
                const appRecipientUserId = metadata?.appRecipientUserId;
                const intendedAmountForCreator = parseInt(metadata?.intendedAmountForCreator, 10);
                const grossAmountChargedToDonor = parseInt(metadata?.grossAmountChargedToDonor, 10);
                const paymentCurrency = metadata?.paymentCurrency || session.currency;

                if (!paymentIntentId || !appRecipientUserId || isNaN(intendedAmountForCreator) || isNaN(grossAmountChargedToDonor)) {
                    console.error('[Webhook] CRITICAL: Essential metadata missing for payment record. Session ID:', session.id);
                    return res.status(200).json({ received: true, error: "Metadata missing." });
                }

                try {
                    const existingPayment = await prisma.payment.findUnique({ where: { stripePaymentIntentId: paymentIntentId } });
                    if (existingPayment) {
                        console.log(`[Webhook] Payment ${paymentIntentId} already recorded.`);
                        return res.status(200).json({ received: true, message: "Already recorded" });
                    }
                    
                    await prisma.payment.create({
                        data: {
                            stripePaymentIntentId: paymentIntentId,
                            amount: grossAmountChargedToDonor,
                            currency: paymentCurrency.toLowerCase(),
                            status: 'succeeded',
                            recipientUserId: appRecipientUserId,
                            payerEmail: session.customer_details?.email,
                            platformFee: grossAmountChargedToDonor - intendedAmountForCreator, 
                            netAmountToRecipient: intendedAmountForCreator,
                            payerName: metadata.donorName || 'Anonymous',
                        },
                    });
                    console.log(`[Webhook] Payment record created for PI ${paymentIntentId}.`);
                } catch (err) {
                    console.error(`[Webhook] FATAL ERROR during DB op for PI ${paymentIntentId}:`, err.message, err.stack);
                    return res.status(500).json({ error: `Webhook processing failed: ${err.message}` });
                }
            }
            break;
            
        case 'balance.available':
            const balance = event.data.object;
            const stripeAccountId = event.account; // The ID of the connected account

            try {
                const user = await prisma.user.findFirst({
                    where: { stripeAccountId: stripeAccountId },
                });

                // Check if the user exists and has this feature enabled
                if (user && user.autoInstantPayoutsEnabled) {
                    const availableBalance = balance.available.find(b => b.currency === user.stripeDefaultCurrency);
                    
                    if (availableBalance && availableBalance.amount > 0) {
                        console.log(`[Webhook] Auto-Instant Payout triggered for ${stripeAccountId}. Amount: ${availableBalance.amount}`);
                        // Trigger an instant payout for the entire available balance
                        await stripe.payouts.create({
                            amount: availableBalance.amount,
                            currency: availableBalance.currency,
                            method: 'instant',
                        }, {
                            stripeAccount: stripeAccountId,
                        });
                    }
                }
            } catch (payoutError) {
                console.error(`[Webhook] FAILED to process auto-instant payout for ${stripeAccountId}:`, payoutError.message);
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
            // console.log(`[Webhook] Unhandled event type ${event.type}`);
    }
    res.status(200).json({ received: true });
});

// --- GENERAL MIDDLEWARE AND OTHER ROUTERS ---
app.use(express.json());

const stripeRoutes = require('./routes/stripe'); // Import the router from stripe.js
const userRoutes = require('./routes/users');
const linkRoutes = require('./routes/links');
const publicProfileRoutes = require('./routes/publicProfile');
const paymentRoutes = require('./routes/payments');
const { authMiddleware } = require('./middleware/auth');

app.use('/api/stripe', stripeRoutes); // Mount the router for non-webhook stripe routes
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