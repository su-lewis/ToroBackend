// backend/index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { supabaseAdmin } = require('./lib/supabase');
const { Resend } = require('resend');
// Initialize Stripe and Resend directly in this file
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

const app = express();
const PORT = process.env.PORT || 3001;

// --- CORS Configuration ---
const frontendUrlFromEnv = process.env.FRONTEND_URL;
if (!frontendUrlFromEnv) { console.warn("WARNING: FRONTEND_URL environment variable is NOT SET."); }
const allowedOrigins = [
    frontendUrlFromEnv,
    'http://localhost:3000',
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

    // --- PAYMENT LOGIC MOVED HERE ---
    switch (event.type) {
        case 'checkout.session.completed': {
            const session = event.data.object;
            
            if (session.payment_status !== 'paid') {
                console.log(`[Account Webhook] Ignoring checkout.session.completed with status: ${session.payment_status}`);
                break;
            }

            const paymentIntentId = session.payment_intent;
            const metadata = session.metadata;
            const appRecipientUserId = metadata?.appRecipientUserId;

            if (!appRecipientUserId || !paymentIntentId) {
                console.error(`[Account Webhook] Missing critical metadata for session ${session.id}`);
                break;
            }

            // Step 1: Create the payment record. This is our source of truth.
            try {
                const { data: existingPayment, error: findError } = await supabaseAdmin
                    .from('Payment')
                    .select('stripePaymentIntentId')
                    .eq('stripePaymentIntentId', paymentIntentId)
                    .maybeSingle();
                if (findError) throw findError;

                if (!existingPayment) {
                    const intendedAmountForCreator = parseInt(metadata.intendedAmountForCreator, 10);
                    const grossAmountChargedToDonor = parseInt(metadata.grossAmountChargedToDonor, 10);
                    const { error: insertError } = await supabaseAdmin.from('Payment').insert([{
                        stripePaymentIntentId: paymentIntentId,
                        amount: grossAmountChargedToDonor,
                        currency: session.currency.toLowerCase(),
                        status: 'SUCCEEDED',
                        recipientUserId: appRecipientUserId,
                        platformFee: grossAmountChargedToDonor - intendedAmountForCreator,
                        netAmountToRecipient: intendedAmountForCreator,
                        payerName: metadata.donorName || 'Anonymous',
                        payerEmail: session.customer_details?.email,
                        pageBlockId: metadata.pageBlockId || undefined,
                    }]);
                    if (insertError) throw insertError;
                    console.log(`[Account Webhook] Payment record created from session ${session.id} for PI ${paymentIntentId}.`);
                }
            } catch (dbError) {
                console.error(`[Account Webhook] CRITICAL: DB write failed for session ${session.id}. Error:`, dbError);
                return res.status(500).json({ error: "Database write failed." });
            }

            // Step 2: Handle secondary actions.
            try {
                const { data: creator, error: creatorError } = await supabaseAdmin
                    .from('User')
                    .select('email,hasFeeRebateBonus,stripeAccountId')
                    .eq('id', appRecipientUserId)
                    .single();
                if (creatorError) throw creatorError;

                if (creator) {
                    // Bonus Logic
                    if (creator.hasFeeRebateBonus) {
                        try {
                            const intendedAmountForCreator = parseInt(metadata.intendedAmountForCreator, 10);
                            const bonusAmount = Math.round(intendedAmountForCreator * 0.10);
                            if (bonusAmount > 0) {
                                // NOTE: For Destination charges, bonuses are platform-to-creator transfers.
                                await stripe.transfers.create({ amount: bonusAmount, currency: session.currency, destination: creator.stripeAccountId, transfer_group: `bonus_${paymentIntentId}` });
                            }
                        } catch (bonusError) { console.error(`[Account Webhook] BONUS FAILED for session ${session.id}:`, bonusError.message); }
                    }
                    // Email Logic
                    if (creator.email && process.env.RESEND_API_KEY) {
                        try {
                            const intendedAmountForCreator = parseInt(metadata.intendedAmountForCreator, 10);
                            const amountString = new Intl.NumberFormat('en-US', { style: 'currency', currency: session.currency.toUpperCase() }).format(intendedAmountForCreator / 100);
                            await resend.emails.send({ from: 'TributeToro <noreply@tributetoro.com>', to: [creator.email], subject: `You received a new tip of ${amountString}!`, html: `<div>...</div>` });
                        } catch (emailError) { console.error(`[Account Webhook] EMAIL FAILED for session ${session.id}:`, emailError.message); }
                    }
                }
            } catch (secondaryError) {
                console.error(`[Account Webhook] Error in secondary actions for session ${session.id}:`, secondaryError.message);
            }
            break;
        }
        // You can add other account-level event handlers here if needed
    }

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
    
    // --- PAYMENT LOGIC IS REMOVED FROM HERE ---
    switch (event.type) {
        case 'payment_intent.payment_failed': {
            // This logic can stay if you need to track failures
            const failedPI = event.data.object;
            const { error: failedAttemptError } = await supabaseAdmin.from('FailedPaymentAttempt').insert([{
                stripePiId: failedPI.id,
                amount: failedPI.amount,
                currency: failedPI.currency,
                recipientUserId: failedPI.metadata?.appRecipientUserId || 'unknown',
                failureCode: failedPI.last_payment_error?.code,
                failureMessage: failedPI.last_payment_error?.message,
            }]);
            if (failedAttemptError) console.error(`[Connect Webhook] DB Error logging failed payment:`, failedAttemptError);
            break;
        }
        case 'charge.refunded': {
            // This logic stays here
            const refund = event.data.object;
            const { error: updateError } = await supabaseAdmin.from('Payment').update({ status: 'REFUNDED' }).eq('stripePaymentIntentId', refund.payment_intent);
            if (updateError) console.error(`[Connect Webhook] DB Error on charge.refunded:`, updateError);
            break;
        }
        case 'charge.dispute.created': {
             // This logic stays here
            const dispute = event.data.object;
            const { error: disputeError } = await supabaseAdmin.from('Payment').update({ status: 'DISPUTED' }).eq('stripePaymentIntentId', dispute.payment_intent);
            if (disputeError) console.error(`[Connect Webhook] DB Error on charge.dispute.created:`, disputeError);
            break;
        }
        case 'charge.dispute.closed': {
             // This logic stays here
            const closedDispute = event.data.object;
            const newStatus = closedDispute.status === 'won' ? 'SUCCEEDED' : 'FAILED';
            const { error: closedError } = await supabaseAdmin.from('Payment').update({ status: newStatus }).eq('stripePaymentIntentId', closedDispute.payment_intent);
            if (closedError) console.error(`[Connect Webhook] DB Error on charge.dispute.closed:`, closedError);
            break;
        }
        case 'payout.paid': {
             // This logic stays here
            const payout = event.data.object;
            const { data: user, error: userError } = await supabaseAdmin.from('User').select('id').eq('stripeAccountId', event.account).maybeSingle();
            if (userError) {
                console.error(`[Connect Webhook] User lookup error on payout.paid:`, userError);
                break;
            }
            if (user) {
                const { error: payoutError } = await supabaseAdmin.from('Payout').insert([{
                    stripePayoutId: payout.id,
                    amount: payout.amount,
                    currency: payout.currency,
                    status: 'PAID',
                    arrivalDate: new Date(payout.arrival_date * 1000).toISOString(),
                    userId: user.id,
                }]);
                if (payoutError) console.error(`[Connect Webhook] DB Error on payout.paid:`, payoutError);
            }
            break;
        }
        case 'payout.failed': {
             // This logic stays here
            const payout = event.data.object;
            const { data: user, error: userError } = await supabaseAdmin.from('User').select('id').eq('stripeAccountId', event.account).maybeSingle();
            if (userError) {
                console.error(`[Connect Webhook] User lookup error on payout.failed:`, userError);
                break;
            }
            if (user) {
                const { error: payoutError } = await supabaseAdmin.from('Payout').insert([{
                    stripePayoutId: payout.id,
                    amount: payout.amount,
                    currency: payout.currency,
                    status: 'FAILED',
                    failureReason: payout.failure_message,
                    userId: user.id,
                }]);
                if (payoutError) console.error(`[Connect Webhook] DB Error on payout.failed:`, payoutError);
            }
            break;
        }
        case 'balance.available': {
             // This logic stays here
            const stripeAccountId = event.account;
            const { data: user, error: userError } = await supabaseAdmin.from('User').select('id,autoInstantPayoutsEnabled,stripeDefaultCurrency').eq('stripeAccountId', stripeAccountId).maybeSingle();
            if (userError) {
                console.error(`[Connect Webhook] User lookup error on balance.available:`, userError);
                break;
            }
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
            const { data: userToUpdate, error: userError } = await supabaseAdmin.from('User').select('id,stripeOnboardingComplete').eq('stripeAccountId', account.id).maybeSingle();
            if (userError) {
                console.error(`[Connect Webhook] User lookup error on account.updated:`, userError);
                break;
            }
            if (userToUpdate) {
                // --- THIS IS THE FIX ---
                // We must define `onboardingComplete` by checking the account's status.
                const onboardingComplete = !!(account.charges_enabled && account.details_submitted && account.payouts_enabled);

                // Now we can safely compare the new status with the one in our database.
                if (userToUpdate.stripeOnboardingComplete !== onboardingComplete) {
                    const { error: updateError } = await supabaseAdmin.from('User').update({ stripeOnboardingComplete: onboardingComplete }).eq('id', userToUpdate.id);
                    if (updateError) console.error(`[Connect Webhook] DB Error updating onboarding status:`, updateError);
                    console.log(`[Connect Webhook] User ${userToUpdate.id} onboarding status updated to: ${onboardingComplete}`);
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
const pageBlockRoutes = require('./routes/pageBlocks');
const publicProfileRoutes = require('./routes/publicProfile');
const paymentRoutes = require('./routes/payments');
const { authMiddleware } = require('./middleware/auth');

app.use('/api/stripe', stripeRoutes);
app.use('/api/public', publicProfileRoutes);
app.use('/api/users', userRoutes);
app.use('/api/payments', authMiddleware, paymentRoutes);
app.use('/api/page-blocks', authMiddleware, pageBlockRoutes);

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