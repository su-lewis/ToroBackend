// backend/index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const prisma = require('./lib/prisma');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY); // Stripe instance for webhook and other direct calls

// --- CORS Configuration ---
const frontendUrlFromEnv = process.env.FRONTEND_URL;

if (!frontendUrlFromEnv) {
    console.warn(
        "--------------------------------------------------------------------------\n" +
        "WARNING: FRONTEND_URL environment variable is NOT SET in backend/.env. \n" +
        "CORS will default to allow 'http://localhost:3000' only.\n" +
        "This WILL cause CORS errors if your frontend is deployed elsewhere.\n" +
        "--------------------------------------------------------------------------"
    );
}
const allowedOrigins = [
    frontendUrlFromEnv || 'http://localhost:3000'
].filter(Boolean);

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
    credentials: true,
    optionsSuccessStatus: 204
};

const app = express();
const PORT = process.env.PORT || 3001;

// Apply CORS middleware globally and FIRST.
app.use(cors(corsOptions));


// --- Import Other Routers ---
const userRoutes = require('./routes/users');
const linkRoutes = require('./routes/links');
const publicProfileRoutes = require('./routes/publicProfile');
const { authMiddleware } = require('./middleware/auth');


// --- STRIPE WEBHOOK HANDLER (Directly in index.js) ---
// This route needs to exactly match your webhook URL in Stripe dashboard.
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!webhookSecret) {
        console.error("FATAL: STRIPE_WEBHOOK_SECRET environment variable is not set.");
        return res.status(500).send("Webhook secret not configured.");
    }

    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
        console.error(`[Webhook] Signature verification failed: ${err.message}`);
        // IMPORTANT: Return 400 for failed signature verification, so Stripe knows it failed
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    console.log(`[Webhook] Event received and verified: ${event.type}, ID: ${event.id}`);
    switch (event.type) {
        case 'checkout.session.completed':
            const session = event.data.object;
            if (session.payment_status === 'paid') {
                console.log('[Webhook] Checkout Session paid. Recording payment.');
                const metadata = session.metadata;
                const paymentIntentId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
                
                // Extracting other metadata, assuming it's correct from your create-checkout-session
                const appRecipientUserId = metadata?.appRecipientUserId;
                const platformFeeCalculated = parseInt(metadata?.platformFeeCalculated, 10);
                const grossAmountChargedToDonor = parseInt(metadata?.grossAmountChargedToDonor, 10);
                const intendedAmountForCreator = parseInt(metadata?.intendedAmountForCreator, 10);
                const paymentCurrency = metadata?.paymentCurrency; // <-- NEW: Get currency from metadata

                if (!appRecipientUserId || !paymentIntentId || isNaN(platformFeeCalculated) || isNaN(grossAmountChargedToDonor) || isNaN(intendedAmountForCreator) || !paymentCurrency) {
                    console.error('[Webhook] CRITICAL: Essential metadata missing or invalid for payment record. Session ID:', session.id, 'Metadata:', metadata);
                    return res.status(200).json({ received: true, error: "Essential metadata missing/invalid for payment record." });
                }

                try {
                    const existingPayment = await prisma.payment.findUnique({ where: { stripePaymentIntentId: paymentIntentId } });
                    if (existingPayment) {
                        console.log(`[Webhook] Payment ${paymentIntentId} already recorded.`);
                        return res.status(200).json({ received: true, message: "Already recorded" });
                    }
                    
                    // Since you are using Direct Charge & Application Fee model in create-checkout-session,
                    // Stripe already handled the transfer to the connected account.
                    // This webhook only needs to record the payment in your database.
                    await prisma.payment.create({
                        data: {
                            stripePaymentIntentId: paymentIntentId,
                            amount: grossAmountChargedToDonor, // Total amount charged to donor
                            currency: paymentCurrency.toLowerCase(), // <-- Use dynamic currency from metadata
                            status: 'succeeded',
                            recipientUserId: appRecipientUserId,
                            payerEmail: session.customer_details?.email,
                            platformFee: platformFeeCalculated,
                            netAmountToRecipient: intendedAmountForCreator, // Using existing schema field
                        },
                    });
                    console.log(`[Webhook] Payment record created for PI ${paymentIntentId}. Amount to creator: ${intendedAmountForCreator} cents. Currency: ${paymentCurrency}.`);

                } catch (err) {
                    console.error(`[Webhook] FATAL ERROR during DB operation for PI ${paymentIntentId}:`, err.message, err.stack);
                    // Return 500 here to tell Stripe to retry the webhook later (it will do so exponentially)
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
        case 'charge.succeeded': // Good for more detailed logging/auditing
            const charge = event.data.object;
            console.log(`[Webhook] Charge succeeded: ${charge.id}. Amount: ${charge.amount}. Currency: ${charge.currency}. Destination: ${charge.destination || 'N/A'}. On Behalf Of: ${charge.on_behalf_of || 'N/A'}`);
            break;
        case 'transfer.succeeded': // Good for more detailed logging/auditing of the direct transfer
            const transfer = event.data.object;
            console.log(`[Webhook] Transfer succeeded: ${transfer.id}. Amount: ${transfer.amount}. Currency: ${transfer.currency}. Destination: ${transfer.destination}`);
            break;
        default:
            // console.log(`[Webhook] Unhandled event type ${event.type}`); // Keep this commented or at debug level
    }
    // Always respond with 200 to Stripe when the event is successfully received and processed
    res.status(200).json({ received: true });
});


// --- GENERAL MIDDLEWARE AND OTHER ROUTERS ---
app.use(express.json()); // This will parse JSON for /api/stripe/create-checkout-session etc.
app.use(express.urlencoded({ extended: true })); // Good practice if you expect form-urlencoded data


// IMPORT THE SIMPLIFIED STRIPE ROUTER *AFTER* GENERAL MIDDLEWARE
const stripeRoutes = require('./routes/stripe'); 

// Mount the imported routers
app.use('/api/stripe', stripeRoutes); // This should now correctly mount the router
app.use('/api/public', publicProfileRoutes);
app.use('/api/users', userRoutes);

// Apply authMiddleware specifically to /api/links routes if needed
app.use('/api/links', authMiddleware, (req, res, next) => {
    if (!req.localUser) {
        return res.status(403).json({
            message: "User profile must be set up to manage links.",
            code: "PROFILE_REQUIRED_FOR_LINKS"
        });
    }
    next();
}, linkRoutes);

// Simple health check endpoint
app.get('/api', (req, res) => {
    res.status(200).json({ status: 'healthy', message: 'Link Bio API is running!' });
});


// --- Centralized Error Handling Middleware (must be last) ---
app.use((err, req, res, next) => {
    console.error("--- Unhandled Express Error ---");
    console.error("Timestamp:", new Date().toISOString());
    console.error("Route:", req.method, req.originalUrl);
    console.error("Error Message:", err.message);
    console.error("Error Stack:", err.stack);
    console.error("--- End Unhandled Express Error ---");

    if (res.headersSent) {
        return next(err);
    }

    if (err.message && err.message.includes("not allowed by CORS")) {
        return res.status(403).json({ error: "CORS_POLICY_VIOLATION", message: err.message });
    }

    res.status(err.status || 500).json({
        error: "INTERNAL_SERVER_ERROR",
        message: err.message || 'An unexpected internal server error occurred on the API!',
    });
});


// --- Start Server ---
app.listen(PORT, () => {
    console.log(`Backend server running. Listening on port ${PORT}`);
    console.log(`CORS configured. Allowed origins: [${allowedOrigins.join(', ')}]`);
    if (!frontendUrlFromEnv) {
        console.warn("Reminder: FRONTEND_URL env var is not set; using fallback for CORS. This should be set in production.");
    }
});