// backend/index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const prisma = require('./lib/prisma');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// --- CORS Configuration (same as before) ---
// ...
const allowedOrigins = [process.env.FRONTEND_URL || 'http://localhost:3000'];
const corsOptions = { origin: (origin, callback) => { /* ... */ }, methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'], credentials: true, optionsSuccessStatus: 204 };
const app = express();
const PORT = process.env.PORT || 3001;
app.use(cors(corsOptions));
// ...

// --- STRIPE WEBHOOK HANDLER ---
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) { /* ... error handling ... */ }
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

                    // --- FIX IS HERE ---
                    // 1. Retrieve the Payment Intent from Stripe to get the Charge ID
                    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
                    const chargeId = paymentIntent.latest_charge;

                    if (!chargeId) {
                        console.error(`[Webhook] CRITICAL: Could not find a 'latest_charge' on Payment Intent ${paymentIntentId}.`);
                        // This is a serious issue, maybe the charge hasn't fully settled.
                        // Returning 500 will make Stripe retry, which might be what we want.
                        return res.status(500).json({ error: "Could not find charge for payment intent." });
                    }
                    console.log(`[Webhook] Found Charge ID: ${chargeId} for Payment Intent ${paymentIntentId}.`);
                    
                    // 2. Use the Charge ID as the source_transaction for the transfer
                    console.log(`[Webhook] Creating transfer of ${transferAmountCents} cents to ${recipientStripeAccountId}.`);
                    const transfer = await stripe.transfers.create({
                        amount: transferAmountCents,
                        currency: 'usd',
                        destination: recipientStripeAccountId,
                        source_transaction: chargeId, // Use the Charge ID here!
                    });
                    console.log(`[Webhook] SUCCESS: Transfer created: ${transfer.id}`);
                    
                    // 3. Record the payment in your database (this logic was already fine)
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
                    console.log(`[Webhook] Payment record created for PI ${paymentIntentId}.`);

                } catch (err) {
                    console.error(`[Webhook] FATAL ERROR during transfer/DB op for PI ${paymentIntentId}:`, err.message, err.stack);
                    return res.status(500).json({ error: `Webhook processing failed: ${err.message}` });
                }
            }
            break;
        case 'account.updated':
            // ... your account.updated logic (which is fine) ...
            break;
        default:
            // console.log(`[Webhook] Unhandled event type ${event.type}`);
    }
    res.status(200).json({ received: true });
});

// --- GENERAL MIDDLEWARE AND ROUTERS (no changes from your working version) ---
app.use(express.json());

const stripeRoutes = require('./routes/stripe').router;
const userRoutes = require('./routes/users');
const linkRoutes = require('./routes/links');
const publicProfileRoutes = require('./routes/publicProfile');
const { authMiddleware } = require('./middleware/auth');

app.use('/api/stripe', stripeRoutes);
app.use('/api/public', publicProfileRoutes);
app.use('/api/users', userRoutes);
app.use('/api/links', authMiddleware, (req, res, next) => { /* ... */ }, linkRoutes);
app.get('/api', (req, res) => res.status(200).json({ status: 'healthy' }));

// --- ERROR HANDLING & SERVER START (no changes) ---
app.use((err, req, res, next) => { /* ... */ });
app.listen(PORT, () => { /* ... */ });