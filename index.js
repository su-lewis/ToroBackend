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

    switch (event.type) {
        case 'checkout.session.completed':
            const session = event.data.object;
            if (session.payment_status === 'paid') {
                const metadata = session.metadata;
                const paymentIntentId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
                const appRecipientUserId = metadata?.appRecipientUserId;

                if (!paymentIntentId || !appRecipientUserId) {
                    return res.status(200).json({ received: true, error: "Essential metadata missing." });
                }

                try {
                    const existingPayment = await prisma.payment.findUnique({ where: { stripePaymentIntentId: paymentIntentId } });
                    if (existingPayment) {
                        return res.status(200).json({ received: true, message: "Already recorded" });
                    }
                    
                    const grossAmountCharged = parseInt(metadata.grossAmountChargedToDonor, 10);
                    const intendedForCreator = parseInt(metadata.intendedAmountForCreator, 10);
                    
                    await prisma.payment.create({
                        data: {
                            stripePaymentIntentId: paymentIntentId,
                            amount: grossAmountCharged,
                            currency: (metadata.paymentCurrency || 'usd').toLowerCase(),
                            status: 'succeeded',
                            recipientUserId: appRecipientUserId,
                            payerEmail: session.customer_details?.email,
                            platformFee: grossAmountCharged - intendedForCreator, 
                            netAmountToRecipient: intendedForCreator,
                            // --- CHANGE: Save donorName from metadata ---
                            payerName: metadata.donorName || 'Anonymous',
                        },
                    });
                    console.log(`[Webhook] Payment record created for PI ${paymentIntentId}.`);
                } catch (err) {
                    console.error(`[Webhook] FATAL ERROR during DB op for PI ${paymentIntentId}:`, err.message);
                    return res.status(500).json({ error: `Webhook processing failed: ${err.message}` });
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
    }
    res.status(200).json({ received: true });
});

// --- GENERAL MIDDLEWARE AND OTHER ROUTERS ---
app.use(express.json());

const stripeRoutes = require('./routes/stripe');
const userRoutes = require('./routes/users');
const linkRoutes = require('./routes/links');
const publicProfileRoutes = require('./routes/publicProfile');
const { authMiddleware } = require('./middleware/auth');

app.use('/api/stripe', stripeRoutes);
app.use('/api/public', publicProfileRoutes);
app.use('/api/users', userRoutes);
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