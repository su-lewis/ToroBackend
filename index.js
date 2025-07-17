// backend/index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const prisma = require('./lib/prisma');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY); // Initialize Stripe here for the webhook

// --- CORS Configuration (same as before) ---
const frontendUrlFromEnv = process.env.FRONTEND_URL;
if (!frontendUrlFromEnv) { console.warn("WARNING: FRONTEND_URL is not set."); }
const allowedOrigins = [ frontendUrlFromEnv || 'http://localhost:3000' ];
const corsOptions = {
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            console.error(`[CORS] Origin ${origin} is NOT ALLOWED.`);
            callback(new Error(`Origin [${origin}] not allowed by CORS`));
        }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Client-Info'],
    credentials: true,
    optionsSuccessStatus: 204
};
const app = express();
const PORT = process.env.PORT || 3001;
app.use(cors(corsOptions));

// --- STRIPE WEBHOOK HANDLER ---
// Define the webhook route with its raw body parser here, BEFORE the global express.json()
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!webhookSecret) {
        console.error("[Webhook] CRITICAL: STRIPE_WEBHOOK_SECRET is not set.");
        return res.status(500).send("Webhook secret not configured on server.");
    }

    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
        console.error(`[Webhook] Signature verification failed: ${err.message}`);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Process the event (copied from your stripe.js handler)
    console.log(`[Webhook] Event received and verified: ${event.type}, ID: ${event.id}`);
    switch (event.type) {
        case 'checkout.session.completed':
            const session = event.data.object;
            if (session.payment_status === 'paid') {
                console.log('[Webhook] Checkout Session paid. Processing...');
                const metadata = session.metadata;
                const recipientStripeAccountId = metadata?.appRecipientStripeAccountId;
                const transferAmountCents = parseInt(metadata?.transferAmountCents, 10);
                const paymentIntentId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
                const appRecipientUserId = metadata?.appRecipientUserId;

                if (!recipientStripeAccountId || !transferAmountCents || !paymentIntentId || !appRecipientUserId) {
                    console.error('[Webhook] CRITICAL: Metadata missing for transfer. Session ID:', session.id, 'Metadata:', metadata);
                    return res.status(200).json({ received: true, error: "Metadata missing." });
                }
                
                try {
                    const existingPayment = await prisma.payment.findUnique({ where: { stripePaymentIntentId: paymentIntentId } });
                    if (existingPayment) {
                        console.log(`[Webhook] Payment ${paymentIntentId} already processed.`);
                        return res.status(200).json({ received: true, message: "Already processed" });
                    }
                    
                    if (session.payment_intent_data?.transfer_data?.destination) {
                        // This indicates a Direct Charge with application fee model
                        console.log('[Webhook] Processing Direct Charge model.');
                        await prisma.payment.create({
                            data: {
                                stripePaymentIntentId: paymentIntentId,
                                amount: session.amount_total,
                                currency: session.currency.toLowerCase(),
                                status: 'succeeded',
                                recipientUserId: appRecipientUserId,
                                payerEmail: session.customer_details?.email,
                                platformFee: session.application_fee_amount || 0,
                            },
                        });
                    } else {
                        // This indicates a Separate Charge and Transfer model
                        console.log('[Webhook] Processing Separate Charge and Transfer model.');
                        const transfer = await stripe.transfers.create({
                            amount: transferAmountCents,
                            currency: 'usd',
                            destination: recipientStripeAccountId,
                            source_transaction: paymentIntentId,
                        });
                        console.log(`[Webhook] SUCCESS: Transfer created: ${transfer.id}`);
                        
                        await prisma.payment.create({
                            data: {
                                stripePaymentIntentId: paymentIntentId,
                                amount: session.amount_total,
                                currency: session.currency.toLowerCase(),
                                status: 'succeeded',
                                recipientUserId: appRecipientUserId,
                                payerEmail: session.customer_details?.email,
                                platformFee: session.amount_total - transferAmountCents,
                            },
                        });
                    }
                    console.log(`[Webhook] Payment record created for PI ${paymentIntentId}.`);
                } catch (err) {
                    console.error(`[Webhook] FATAL ERROR during transfer/DB op for PI ${paymentIntentId}:`, err.message, err.stack);
                    return res.status(500).json({ error: `Webhook processing failed: ${err.message}` });
                }
            }
            break;
        case 'account.updated':
            const account = event.data.object;
            // ... logic is fine ...
            break;
        default:
            // console.log(`[Webhook] Unhandled event type ${event.type}`);
    }
    res.status(200).json({ received: true });
});

// --- GENERAL MIDDLEWARE AND ROUTERS ---
// This must be AFTER the specific raw webhook route.
app.use(express.json());

// Import and use other routers
const stripeRoutes = require('./routes/stripe').router; // Only import the router part now
const userRoutes = require('./routes/users');
const linkRoutes = require('./routes/links');
const publicProfileRoutes = require('./routes/publicProfile');
const { authMiddleware } = require('./middleware/auth');

app.use('/api/stripe', stripeRoutes); // Mounts all routes from stripe.js EXCEPT the webhook
app.use('/api/public', publicProfileRoutes);
app.use('/api/users', userRoutes);
app.use('/api/links', authMiddleware, (req, res, next) => {
    if (!req.localUser) {
        return res.status(403).json({ message: "Profile setup required." });
    }
    next();
}, linkRoutes);
app.get('/api', (req, res) => res.status(200).json({ status: 'healthy' }));

// --- ERROR HANDLING & SERVER START (same as before) ---
app.use((err, req, res, next) => { /* ... */ });
app.listen(PORT, () => { /* ... */ });