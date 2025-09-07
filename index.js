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
const allowedOrigins = [frontendUrlFromEnv].filter(Boolean); // Only use the one from env for security
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
// This must be defined before `app.use(express.json())`
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
            // Ensure the session was actually paid
            if (session.payment_status === 'paid') {
                const metadata = session.metadata;
                const paymentIntentId = session.payment_intent; // This is the PI created by Checkout

                const appRecipientUserId = metadata?.appRecipientUserId;
                const intendedAmountForCreator = parseInt(metadata?.intendedAmountForCreator, 10);
                const grossAmountChargedToDonor = parseInt(metadata?.grossAmountChargedToDonor, 10);

                if (!paymentIntentId || !appRecipientUserId || isNaN(intendedAmountForCreator) || isNaN(grossAmountChargedToDonor)) {
                    console.error(`[Webhook] Missing or invalid metadata for Checkout Session ${session.id}`);
                    // Respond with 400 if critical metadata is missing to retry event
                    return res.status(400).send('Missing essential metadata in checkout.session.completed.');
                }

                // Step 1: Create the critical payment record FIRST.
                try {
                    const existingPayment = await prisma.payment.findUnique({ where: { stripePaymentIntentId: paymentIntentId } });
                    if (!existingPayment) {
                        await prisma.payment.create({
                            data: {
                                stripePaymentIntentId: paymentIntentId,
                                amount: grossAmountChargedToDonor,
                                currency: session.currency.toLowerCase(),
                                status: 'SUCCEEDED', // Mark as succeeded as checkout is completed and paid
                                recipientUserId: appRecipientUserId,
                                payerEmail: session.customer_details?.email,
                                platformFee: grossAmountChargedToDonor - intendedAmountForCreator,
                                netAmountToRecipient: intendedAmountForCreator,
                                payerName: metadata.donorName || 'Anonymous',
                            },
                        });
                        console.log(`[Webhook] Payment record created for Checkout Session ${session.id} (PI: ${paymentIntentId}).`);
                    } else {
                        console.log(`[Webhook] Payment record for PI ${paymentIntentId} already exists. Skipping creation.`);
                    }
                } catch (dbError) {
                    console.error(`[Webhook] CRITICAL: Failed to create payment record for Checkout Session ${session.id} (PI: ${paymentIntentId}). Error:`, dbError.message);
                    // Respond with 500 if critical DB operation fails for Stripe to retry
                    return res.status(500).send("Database error during payment record creation.");
                }

                // Step 2: Fetch creator details for secondary actions.
                const creator = await prisma.user.findUnique({
                    where: { id: appRecipientUserId },
                    select: { email: true, hasFeeRebateBonus: true, stripeAccountId: true }
                });

                if (!creator) {
                    console.warn(`[Webhook] Could not find creator with ID ${appRecipientUserId} for secondary actions after Checkout Session ${session.id}.`);
                    // Don't return here; the payment record is saved, secondary actions failing
                    // shouldn't block the 200 response to Stripe.
                }

                // Step 3: Attempt the bonus transfer in its own isolated block.
                // This bonus must come from your platform's balance as the main transfer
                // to the creator has already occurred with the `payment_intent_data`.
                if (creator && creator.hasFeeRebateBonus) {
                    try {
                        const bonusAmount = Math.round(intendedAmountForCreator * 0.10); // 10% of creator's intended amount
                        if (bonusAmount > 0) {
                             await stripe.transfers.create({
                                amount: bonusAmount,
                                currency: session.currency, // Use session currency for consistency
                                destination: creator.stripeAccountId,
                                transfer_group: `bonus_${paymentIntentId}`, // Group with the main PI for tracking
                                description: `10% TributeToro Bonus for payment ${paymentIntentId}`
                            });
                            console.log(`[BONUS] Successfully sent ${bonusAmount} bonus for PI ${paymentIntentId} to ${creator.stripeAccountId}`);
                        }
                    } catch (bonusError) {
                        console.error(`[Webhook] BONUS FAILED for PI ${paymentIntentId}. Error:`, bonusError.message);
                    }
                }

                // Step 4: Attempt to send the email in its own isolated block.
                if (creator && creator.email && process.env.RESEND_API_KEY) {
                    try {
                        const amountString = new Intl.NumberFormat('en-US', {
                            style: 'currency', currency: session.currency.toUpperCase(),
                        }).format(intendedAmountForCreator / 100);

                        await resend.emails.send({
                            from: 'TributeToro <noreply@tributetoro.com>', // Use your actual verified domain
                            to: [creator.email],
                            subject: `You received a new tip of ${amountString}!`,
                            html: `<div style="font-family: sans-serif; padding: 20px; color: #333;"><h2>Congratulations!</h2><p>You've received a new tip of <strong>${amountString}</strong> from <strong>${metadata.donorName || 'Anonymous'}</strong>.</p><p>The funds have been added to your Stripe account balance.</p><p>- The TributeToro Team</p></div>`,
                        });
                        console.log(`[EMAIL] Sent new tip notification to ${creator.email} for PI ${paymentIntentId}`);
                    } catch (emailError) {
                        console.error(`[Webhook] EMAIL FAILED for PI ${paymentIntentId}. Error:`, emailError.message);
                    }
                }
            } else {
                console.warn(`[Webhook] Checkout Session ${session.id} completed but payment_status is not 'paid'. No payment record created.`);
            }
            break;
        }

        case 'payment_intent.succeeded': {
            const paymentIntent = event.data.object;
            // This event might still fire for other PaymentIntent flows or internal Stripe operations.
            // For Checkout Sessions with `transfer_data` in `payment_intent_data`, the critical
            // processing happens in `checkout.session.completed`.
            // Log for awareness, but avoid duplicating the core payment processing logic.
            console.log(`[Webhook] Received payment_intent.succeeded for PI: ${paymentIntent.id}. (Primary handling for Checkout via checkout.session.completed)`);
            break;
        }
        
        case 'payment_intent.payment_failed': {
            const failedPI = event.data.object;
            await prisma.failedPaymentAttempt.create({
                data: {
                    stripePiId: failedPI.id,
                    amount: failedPI.amount,
                    currency: failedPI.currency,
                    recipientUserId: failedPI.metadata?.appRecipientUserId || 'unknown', // Use optional chaining
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