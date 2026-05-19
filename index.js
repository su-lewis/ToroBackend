// backend/index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
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
                const onboardingComplete = !!(account.charges_enabled && account.details_submitted && account.payouts_enabled);
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

// --- STRIPE PAYMENT WEBHOOK ---
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
        console.error('FATAL: STRIPE_WEBHOOK_SECRET env var is not set.');
        return res.status(500).send('Stripe Webhook secret not configured.');
    }

    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
        console.error(`[Stripe Webhook] Signature verification failed: ${err.message}`);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    console.log(`[Stripe Webhook] Event received: ${event.type} (ID: ${event.id})`);

    if (event.type === 'charge.succeeded') {
        const charge = event.data.object;
        const fingerprint = charge.payment_method_details?.card?.fingerprint;
        const metadata = charge.metadata || {};
        const destinationAccount = metadata.destination_account || metadata.destinationAccount;
        const netTransferAmountCents = parseInt(metadata.net_transfer_amount || metadata.intendedAmountForCreator || metadata.net_transfer_amount, 10);
        const paymentIntentId = charge.payment_intent;
        const stripeChargeId = charge.id;
        const recipientUserId = metadata.appRecipientUserId;

        if (!fingerprint || !destinationAccount || !netTransferAmountCents || !recipientUserId) {
            console.error('[Stripe Webhook] Missing required metadata or fingerprint for charge.succeeded.');
            return res.status(400).send('Missing required metadata or fingerprint.');
        }

        try {
            const { data: existingPayment, error: paymentLookupError } = await supabaseAdmin
                .from('Payment')
                .select('id')
                .eq('stripeChargeId', stripeChargeId)
                .maybeSingle();
            if (paymentLookupError) throw paymentLookupError;

            if (!existingPayment) {
                const { error: insertPaymentError } = await supabaseAdmin.from('Payment').insert([{
                    stripeChargeId,
                    stripePaymentIntentId: paymentIntentId,
                    amount: charge.amount,
                    currency: charge.currency,
                    status: 'SUCCEEDED',
                    recipientUserId,
                    platformFee: charge.amount - netTransferAmountCents,
                    netAmountToRecipient: netTransferAmountCents,
                    payerName: charge.billing_details?.name || metadata.donor_name || 'Anonymous',
                    payerEmail: charge.billing_details?.email || null,
                    pageBlockId: metadata.pageBlockId || null,
                }] );
                if (insertPaymentError) throw insertPaymentError;
            }

            const { data: existingTransfer, error: transferLookupError } = await supabaseAdmin
                .from('pending_transfers')
                .select('id')
                .eq('stripe_charge_id', stripeChargeId)
                .maybeSingle();
            if (transferLookupError) throw transferLookupError;
            if (existingTransfer) {
                console.log('[Stripe Webhook] Transfer already recorded for charge', stripeChargeId);
                return res.status(200).json({ received: true });
            }

            const { data: trustedCard, error: trustedCardError } = await supabaseAdmin
                .from('trusted_cards')
                .select('fingerprint')
                .eq('fingerprint', fingerprint)
                .maybeSingle();
            if (trustedCardError) throw trustedCardError;

            if (!trustedCard) {
                const { error: trustedInsertError } = await supabaseAdmin.from('trusted_cards').insert([{
                    fingerprint,
                    created_at: new Date().toISOString(),
                }]);
                if (trustedInsertError) throw trustedInsertError;

                const unlockDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
                const { error: pendingInsertError } = await supabaseAdmin.from('pending_transfers').insert([{
                    amount_cents: netTransferAmountCents,
                    currency: charge.currency,
                    destination_account: destinationAccount,
                    unlock_date: unlockDate,
                    status: 'pending',
                    stripe_charge_id: stripeChargeId,
                    payment_intent_id: paymentIntentId,
                    recipient_user_id: recipientUserId,
                }]);
                if (pendingInsertError) throw pendingInsertError;

                console.log('[Stripe Webhook] New card fingerprint; scheduled pending transfer for', destinationAccount);
            } else {
                const transfer = await stripe.transfers.create({
                    amount: netTransferAmountCents,
                    currency: charge.currency,
                    destination: destinationAccount,
                    transfer_group: paymentIntentId ? `pi_${paymentIntentId}` : undefined,
                });

                const { error: completedInsertError } = await supabaseAdmin.from('pending_transfers').insert([{
                    amount_cents: netTransferAmountCents,
                    currency: charge.currency,
                    destination_account: destinationAccount,
                    unlock_date: new Date().toISOString(),
                    status: 'completed',
                    stripe_charge_id: stripeChargeId,
                    stripe_transfer_id: transfer.id,
                    payment_intent_id: paymentIntentId,
                    recipient_user_id: recipientUserId,
                }]);
                if (completedInsertError) throw completedInsertError;

                console.log('[Stripe Webhook] Immediate transfer executed', transfer.id);
            }
        } catch (err) {
            console.error('[Stripe Webhook] Processing error:', err);
            return res.status(500).send(`Webhook processing failed: ${err.message}`);
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

// --- HOURLY TRANSFER WORKER ---
cron.schedule('0 * * * *', async () => {
    console.log('[Transfer Worker] Running hourly pending transfer job.');
    try {
        const nowIso = new Date().toISOString();
        const { data: pendingTransfers, error: pendingError } = await supabaseAdmin
            .from('pending_transfers')
            .select('*')
            .lte('unlock_date', nowIso)
            .eq('status', 'pending');

        if (pendingError) throw pendingError;
        if (!pendingTransfers || pendingTransfers.length === 0) {
            console.log('[Transfer Worker] No pending transfers ready to run.');
            return;
        }

        for (const transfer of pendingTransfers) {
            try {
                const createdTransfer = await stripe.transfers.create({
                    amount: transfer.amount_cents,
                    currency: transfer.currency,
                    destination: transfer.destination_account,
                    transfer_group: transfer.payment_intent_id ? `pi_${transfer.payment_intent_id}` : undefined,
                });

                const { error: updateError } = await supabaseAdmin.from('pending_transfers')
                    .update({ status: 'completed', stripe_transfer_id: createdTransfer.id, completed_at: new Date().toISOString() })
                    .eq('id', transfer.id);
                if (updateError) throw updateError;
                console.log('[Transfer Worker] Completed transfer for pending_transfer', transfer.id);
            } catch (transferError) {
                console.error('[Transfer Worker] Failed to execute transfer for pending_transfer', transfer.id, transferError.message);
            }
        }
    } catch (err) {
        console.error('[Transfer Worker] Error querying pending transfers:', err.message || err);
    }
}, {
    scheduled: true,
    timezone: 'UTC'
});

// --- ERROR HANDLING & SERVER START ---
app.use((err, req, res, next) => {
    console.error("--- Unhandled Express Error ---", err.stack);
    if (res.headersSent) { return next(err); }
    res.status(err.status || 500).json({ error: "INTERNAL_SERVER_ERROR", message: err.message || 'An unexpected error occurred!' });
});

app.listen(PORT, () => {
    console.log(`Backend server is officially running on port ${PORT}`);
});