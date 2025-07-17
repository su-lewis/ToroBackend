// backend/routes/stripe.js
const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const prisma = require('../lib/prisma');
const { authMiddleware } = require('../middleware/auth');

console.log("[Stripe Router Module] File loaded.");

// =================================================================
// Standard JSON Routes (These expect req.body to be parsed as JSON)
// =================================================================

// 1. Create Stripe Connect Account and Onboarding Link
router.post('/connect/onboard-user', authMiddleware, async (req, res) => {
  console.log("--- [Stripe Router] POST /connect/onboard-user ---");
  try {
    if (!req.localUser?.id) return res.status(403).json({ message: 'App profile setup required first.' });
    const appUserId = req.localUser.id;
    let appProfile = req.localUser;
    if (!appProfile.username) return res.status(400).json({ message: 'Username required in profile for Stripe.' });
    const emailForStripe = req.user?.email || appProfile?.email;
    if (!emailForStripe) return res.status(400).json({ message: 'Email required for Stripe.' });
    const platformBaseUrl = process.env.FRONTEND_URL;
    if (!platformBaseUrl || !platformBaseUrl.startsWith('http')) return res.status(500).json({ message: 'Server config error: FRONTEND_URL invalid.' });
    let stripeAccountId = appProfile.stripeAccountId;
    if (!stripeAccountId) {
      const userProfileUrlOnPlatform = `${platformBaseUrl}/${appProfile.username}`;
      const productDescriptionOnPlatform = `Receiving support via ${process.env.PLATFORM_DISPLAY_NAME || 'our platform'}.`;
      const account = await stripe.accounts.create({
        type: 'express', country: 'US', email: emailForStripe, business_type: 'individual',
        business_profile: { url: userProfileUrlOnPlatform, mcc: '8999', product_description: productDescriptionOnPlatform },
        capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
      });
      stripeAccountId = account.id;
      await prisma.user.update({ where: { id: appUserId }, data: { stripeAccountId, stripeOnboardingComplete: false }});
      console.log(`[/onboard-user] Created Stripe Acct ${stripeAccountId} for user ${appUserId}.`);
    }
    const accountLink = await stripe.accountLinks.create({ account: stripeAccountId, refresh_url: `${platformBaseUrl}/connect-stripe?reauth=true`, return_url: `${platformBaseUrl}/connect-stripe?status=success`, type: 'account_onboarding' });
    res.json({ url: accountLink.url });
  } catch (error) {
    console.error('[/onboard-user] Error:', error.message, error.stack);
    res.status(500).json({ message: 'Error creating Stripe onboarding link', error: error.message });
  }
});

// 2. Get Stripe Account Status
router.get('/connect/account-status', authMiddleware, async (req, res) => {
  console.log("[Stripe Router] GET /connect/account-status");
  try {
    if (!req.localUser?.id) return res.status(403).json({ message: 'User profile not found.' });
    const user = req.localUser;
    if (!user.stripeAccountId) return res.status(404).json({ message: 'Stripe account not connected.' });
    const account = await stripe.accounts.retrieve(user.stripeAccountId);
    const onboardingComplete = !!(account.charges_enabled && account.details_submitted && account.payouts_enabled);
    if (user.stripeOnboardingComplete !== onboardingComplete) {
      await prisma.user.update({ where: { id: user.id }, data: { stripeOnboardingComplete }});
      console.log(`[/account-status] Onboarding status for user ${user.id} updated to ${onboardingComplete}`);
    }
    res.json({ onboardingComplete, stripeAccountId: user.stripeAccountId, detailsSubmitted: account.details_submitted, chargesEnabled: account.charges_enabled, payoutsEnabled: account.payouts_enabled });
  } catch (error) {
    console.error('[/account-status] Error:', error.message, error.stack);
    res.status(500).json({ message: 'Error fetching Stripe status', error: error.message });
  }
});

// 3. Create Stripe Checkout Session
router.post('/create-checkout-session', async (req, res) => {
  console.log("[Stripe Router] POST /create-checkout-session. Body:", req.body); 
  if (!req.body) return res.status(400).json({ message: 'Request body missing.' });
  const { amount: creatorReceivesAmountDollars, recipientUsername } = req.body;
  if (!recipientUsername || isNaN(parseFloat(creatorReceivesAmountDollars)) || parseFloat(creatorReceivesAmountDollars) < 1.00) {
    return res.status(400).json({ message: 'Valid amount (min $1.00) and recipient username required.' });
  }
  try {
    const recipientUser = await prisma.user.findUnique({
      where: { username: recipientUsername },
      select: { id: true, username: true, displayName: true, stripeAccountId: true, stripeOnboardingComplete: true }
    });
    if (!recipientUser || !recipientUser.stripeAccountId || !recipientUser.stripeOnboardingComplete) {
      return res.status(400).json({ message: 'This creator is not currently set up to receive payments.' });
    }
    const creatorReceivesAmount = parseFloat(creatorReceivesAmountDollars);
    const platformFeePercentage = 0.15;
    const platformFeeDollars = creatorReceivesAmount * platformFeePercentage;
    const grossAmountDollars = creatorReceivesAmount + platformFeeDollars;
    const grossAmountInCents = Math.round(grossAmountDollars * 100);
    const creatorReceivesAmountInCents = Math.round(creatorReceivesAmount * 100);
    if (grossAmountInCents < 50) return res.status(400).json({ message: 'Calculated charge amount is too small.' });
    const productName = `Support for ${recipientUser.displayName || recipientUser.username}`;
    const productDescription = `Total payment of $${grossAmountDollars.toFixed(2)} via ${process.env.PLATFORM_DISPLAY_NAME || 'Our Platform'}.`;
    const transferGroup = `tip_${recipientUser.id}_${Date.now()}`;
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price_data: { currency: 'usd', product_data: { name: productName, description: productDescription }, unit_amount: grossAmountInCents }, quantity: 1 }],
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL}/payment-success?recipient=${recipientUsername}&amount_sent=${creatorReceivesAmount.toFixed(2)}`,
      cancel_url: `${process.env.FRONTEND_URL}/${recipientUsername}?payment_cancelled=true`,
      payment_intent_data: {
        transfer_group: transferGroup,
      },
      metadata: { 
        appRecipientUserId: recipientUser.id,
        appRecipientStripeAccountId: recipientUser.stripeAccountId,
        transferAmountCents: creatorReceivesAmountInCents.toString(),
        transfer_group: transferGroup,
      },
    });
    res.json({ id: session.id });
  } catch (error) {
    console.error('[/create-checkout-session] Error:', error.message, error.stack);
    res.status(500).json({ message: 'Error creating payment session', error: error.message });
  }
});

// 5. Create Stripe Express Dashboard Login Link
router.post('/create-express-dashboard-link', authMiddleware, async (req, res) => {
    try {
        if (!req.localUser?.id) return res.status(403).json({ message: 'User profile not found.' });
        if (!req.localUser.stripeAccountId || !req.localUser.stripeOnboardingComplete) return res.status(400).json({ message: 'Stripe account not fully set up.' });
        const loginLink = await stripe.accounts.createLoginLink(req.localUser.stripeAccountId);
        res.json({ url: loginLink.url });
      } catch (error) { 
          console.error('[/create-express-dashboard-link] Error:', error); 
          if (error.type === 'StripeInvalidRequestError') return res.status(400).json({ message: 'Unable to generate dashboard link.' }); 
          res.status(500).json({ message: 'Error creating dashboard link', error: error.message }); 
      }
});


// =================================================================
// Webhook Handler (Exported separately to be used with raw body parser)
// =================================================================
const handleStripeWebhook = async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    let event;

    try {
        // req.body is the RAW buffer here because we use express.raw() in index.js for this route
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
                console.log('[Webhook] Processing paid checkout.session.completed...');
                const metadata = session.metadata;
                const recipientStripeAccountId = metadata?.appRecipientStripeAccountId;
                const transferAmountCents = parseInt(metadata?.transferAmountCents, 10);
                const paymentIntentId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
                const appRecipientUserId = metadata?.appRecipientUserId;

                if (!recipientStripeAccountId || !transferAmountCents || !paymentIntentId || !appRecipientUserId) {
                    console.error('[Webhook] CRITICAL: Metadata missing for transfer.', metadata);
                    return res.status(200).json({ received: true, error: "Metadata missing, cannot create transfer." });
                }
                try {
                    const existingPayment = await prisma.payment.findUnique({ where: { stripePaymentIntentId: paymentIntentId } });
                    if (existingPayment) { console.log(`[Webhook] Payment ${paymentIntentId} already processed.`); return res.status(200).json({ received: true, message: "Already processed" }); }
                    
                    console.log(`[Webhook] Creating transfer of ${transferAmountCents} cents to ${recipientStripeAccountId}.`);
                    const transfer = await stripe.transfers.create({
                        amount: transferAmountCents,
                        currency: 'usd',
                        destination: recipientStripeAccountId,
                        source_transaction: paymentIntentId,
                    });
                    console.log(`[Webhook] SUCCESS: Transfer created: ${transfer.id}`);

                    await prisma.payment.create({
                        data: {
                            stripePaymentIntentId: paymentIntentId, amount: session.amount_total,
                            currency: session.currency.toLowerCase(), status: 'succeeded', recipientUserId: appRecipientUserId,
                            payerEmail: session.customer_details?.email,
                            platformFee: session.amount_total - transferAmountCents,
                        },
                    });
                    console.log(`[Webhook] SUCCESS: Payment and Transfer for PI ${paymentIntentId} recorded.`);
                } catch (err) {
                    console.error('[Webhook] FATAL ERROR during transfer/DB operation:', err);
                    return res.status(500).json({ error: `Failed to process webhook: ${err.message}` });
                }
            }
            break;
        case 'account.updated':
            const account = event.data.object;
            console.log(`[Webhook] account.updated for Stripe Acct ID: ${account.id}`);
            try {
                const userToUpdate = await prisma.user.findFirst({ where: { stripeAccountId: account.id } });
                if (userToUpdate) {
                    const onboardingComplete = !!(account.charges_enabled && account.details_submitted && account.payouts_enabled);
                    if (userToUpdate.stripeOnboardingComplete !== onboardingComplete) {
                        await prisma.user.update({ where: { id: userToUpdate.id }, data: { stripeOnboardingComplete } });
                        console.log(`[Webhook] Updated onboarding for Stripe account ${account.id} to ${onboardingComplete}`);
                    }
                }
            } catch (dbError) { console.error('[Webhook] DB error from account.updated:', dbError); }
            break;
        default:
            console.log(`[Webhook] Unhandled event type: ${event.type}`);
    }
    res.status(200).json({ received: true });
};

// Export both the router for standard routes and the handler for the special webhook route
module.exports = {
    stripeRouter: router,
    stripeWebhookHandler: handleStripeWebhook
};