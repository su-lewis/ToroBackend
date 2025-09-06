// --- CHECKPOINT 1 ---
console.log("[DEBUG] Starting index.js...");

try {
    require('dotenv').config();
    // --- CHECKPOINT 2 ---
    console.log("[DEBUG] dotenv loaded.");

    const express = require('express');
    const cors = require('cors');
    // --- CHECKPOINT 3 ---
    console.log("[DEBUG] Express and CORS loaded.");

    const prisma = require('./lib/prisma');
    // --- CHECKPOINT 4 ---
    console.log("[DEBUG] Prisma client loaded.");

    const { Resend } = require('resend');
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    // --- CHECKPOINT 5 ---
    console.log("[DEBUG] Resend and Stripe clients loaded.");

    const resend = new Resend(process.env.RESEND_API_KEY);
    const app = express();
    const PORT = process.env.PORT || 3001;
    // --- CHECKPOINT 6 ---
    console.log("[DEBUG] App and constants initialized.");

    // --- CORS Configuration ---
    const frontendUrlFromEnv = process.env.FRONTEND_URL;
    if (!frontendUrlFromEnv) { console.warn("WARNING: FRONTEND_URL is not set."); }
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
    // --- CHECKPOINT 7 ---
    console.log("[DEBUG] CORS middleware configured.");
    
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
                
                if (appRecipientUserId && !isNaN(intendedAmountForCreator)) {
                    try {
                        const creator = await prisma.user.findUnique({
                            where: { id: appRecipientUserId },
                            select: { email: true, hasFeeRebateBonus: true, stripeAccountId: true }
                        });

                        if (creator && creator.hasFeeRebateBonus) {
                            const bonusAmount = Math.round(intendedAmountForCreator * 0.10);
                            if (bonusAmount > 0) {
                                await stripe.transfers.create({
                                    amount: bonusAmount,
                                    currency: paymentIntent.currency,
                                    destination: creator.stripeAccountId,
                                    transfer_group: `bonus_${paymentIntent.id}`,
                                    description: `10% TributeToro Bonus for payment ${paymentIntent.id}`
                                });
                                console.log(`[BONUS] Successfully sent ${bonusAmount} bonus to ${creator.stripeAccountId}`);
                            }
                        }

                        const existingPayment = await prisma.payment.findUnique({ where: { stripePaymentIntentId: paymentIntent.id } });
                        if (!existingPayment) {
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
                        }
                        
                        if (creator && creator.email && process.env.RESEND_API_KEY) {
                            const amountString = new Intl.NumberFormat('en-US', {
                                style: 'currency',
                                currency: paymentIntent.currency.toUpperCase(),
                            }).format(intendedAmountForCreator / 100);

                            await resend.emails.send({
                                from: 'TributeToro <noreply@tributetoro.com>',
                                to: [creator.email],
                                subject: `You received a new tip of ${amountString}!`,
                                html: `<div style="font-family: sans-serif; padding: 20px; color: #333;"><h2>Congratulations!</h2><p>You've received a new tip of <strong>${amountString}</strong> from <strong>${metadata.donorName || 'Anonymous'}</strong>.</p><p>The funds have been added to your Stripe account balance.</p><p>- The TributeToro Team</p></div>`,
                            });
                            console.log(`[EMAIL] Sent new tip notification to ${creator.email}`);
                        }
                    } catch (err) {
                        console.error(`[Webhook] Error in payment_intent.succeeded handler for PI ${paymentIntent.id}:`, err.message);
                    }
                }
                break;
            }
            // ... (all your other webhook cases)
        }
        res.status(200).json({ received: true });
    });
    // --- CHECKPOINT 8 ---
    console.log("[DEBUG] Webhook handler defined.");


    // --- GENERAL MIDDLEWARE AND ROUTE MOUNTING ---
    app.use(express.json());

    const stripeRoutes = require('./routes/stripe'); 
    const userRoutes = require('./routes/users');
    const linkRoutes = require('./routes/links');
    const publicProfileRoutes = require('./routes/publicProfile');
    const paymentRoutes = require('./routes/payments');
    const { authMiddleware } = require('./middleware/auth');
    // --- CHECKPOINT 9 ---
    console.log("[DEBUG] All route files have been required.");

    app.use('/api/stripe', stripeRoutes); 
    app.use('/api/public', publicProfileRoutes);
    app.use('/api/users', userRoutes);
    app.use('/api/payments', authMiddleware, paymentRoutes);
    app.use('/api/links', authMiddleware, linkRoutes);
    // --- CHECKPOINT 10 ---
    console.log("[DEBUG] All routes have been mounted.");

    app.get('/api', (req, res) => res.status(200).json({ status: 'healthy' }));

    // --- ERROR HANDLING & SERVER START ---
    app.use((err, req, res, next) => {
        console.error("--- Unhandled Express Error ---", err.stack);
        if (res.headersSent) { return next(err); }
        res.status(err.status || 500).json({ error: "INTERNAL_SERVER_ERROR", message: err.message || 'An unexpected error occurred!' });
    });

    app.listen(PORT, () => {
        // --- FINAL CHECKPOINT ---
        console.log(`[SUCCESS] Backend server is officially running on port ${PORT}`);
    });

} catch (error) {
    // --- CATASTROPHIC FAILURE CHECKPOINT ---
    console.error("!!! CATASTROPHIC STARTUP FAILURE !!!");
    console.error(error);
    process.exit(1);
}