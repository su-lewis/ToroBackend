// backend/routes/stripe.js
const express = require('express');
const router = express.Router();
// Stripe client is initialized with secret key from .env
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY); 
const prisma = require('../lib/prisma'); // Using the separated Prisma client
const { authMiddleware } = require('../middleware/auth');

// Environment variable checks at module load time for better startup diagnostics
if (!process.env.STRIPE_SECRET_KEY) {
    console.error("FATAL BACKEND ERROR: STRIPE_SECRET_KEY is not defined in .env. Stripe routes will fail catastrophically.");
}
if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.warn("WARNING: STRIPE_WEBHOOK_SECRET is not defined in .env. Webhook signature verification will fail.");
}
if (!process.env.FRONTEND_URL) {
    console.warn("WARNING: FRONTEND_URL is not defined in .env. Stripe redirects may be invalid, leading to errors.");
}
if (!process.env.PLATFORM_DISPLAY_NAME) {
    console.warn("WARNING: PLATFORM_DISPLAY_NAME is not defined in .env. Descriptions sent to Stripe may be generic.");
}

console.log("[Stripe Router] File loaded and router instance created.");

// 1. Create Stripe Connect Account and Onboarding Link
router.post('/connect/onboard-user', authMiddleware, async (req, res) => {
  console.log("--- [Stripe Router] POST /connect/onboard-user START ---");
  try {
    if (!req.localUser || !req.localUser.id) {
      return res.status(403).json({ message: 'Application profile setup is required before connecting Stripe.' });
    }
    const appUserId = req.localUser.id;
    const appProfile = req.localUser;

    if (!appProfile.username) {
        return res.status(400).json({ message: 'A username is required in your profile to connect with Stripe.' });
    }
    const emailForStripe = req.user?.email || appProfile?.email;
    if (!emailForStripe) {
        return res.status(400).json({ message: 'An email address is required to connect with Stripe.' });
    }
    const platformBaseUrl = process.env.FRONTEND_URL;
    if (!platformBaseUrl || !platformBaseUrl.startsWith('http')) {
        return res.status(500).json({ message: 'Server configuration error: FRONTEND_URL is missing or invalid.' });
    }

    let stripeAccountId = appProfile.stripeAccountId;
    if (!stripeAccountId) {
      const userProfileUrlOnPlatform = `${platformBaseUrl}/${appProfile.username}`;
      const productDescriptionOnPlatform = `Receiving tips and support via their page on ${process.env.PLATFORM_DISPLAY_NAME || 'our platform'}.`;

      console.log(`[Stripe Router /onboard-user] Creating new Stripe Express account for user ${appUserId}.`);
      
      const account = await stripe.accounts.create({
        type: 'express', country: 'US', email: emailForStripe, business_type: 'individual',
        business_profile: { url: userProfileUrlOnPlatform, mcc: '8999', product_description: productDescriptionOnPlatform },
        capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
      });
      stripeAccountId = account.id;
      
      await prisma.user.update({
        where: { id: appUserId },
        data: { stripeAccountId: stripeAccountId, stripeOnboardingComplete: false },
      });
      console.log(`[Stripe Router /onboard-user] User ${appUserId} updated with new Stripe Account ID: ${stripeAccountId}.`);
    }

    const accountLink = await stripe.accountLinks.create({
      account: stripeAccountId,
      refresh_url: `${platformBaseUrl}/connect-stripe?reauth=true&stripe_account_id=${stripeAccountId}`,
      return_url: `${platformBaseUrl}/connect-stripe?status=success&stripe_account_id=${stripeAccountId}`,
      type: 'account_onboarding',
    });
    res.json({ url: accountLink.url });
  } catch (error) {
    console.error('[/onboard-user] Stripe Connect onboarding error:', error.message, error.stack);
    res.status(500).json({ message: 'Error creating Stripe onboarding link', error: error.message });
  }
});

// 2. Get Stripe Account Status
router.get('/connect/account-status', authMiddleware, async (req, res) => {
    // ... (This route remains the same as the last version) ...
    try {
        if (!req.localUser?.id) return res.status(403).json({ message: 'User profile not found.' });
        const user = req.localUser;
        if (!user.stripeAccountId) return res.status(404).json({ message: 'Stripe account not connected.' });
        const account = await stripe.accounts.retrieve(user.stripeAccountId);
        const onboardingComplete = !!(account.charges_enabled && account.details_submitted && account.payouts_enabled);
        if (user.stripeOnboardingComplete !== onboardingComplete) {
          await prisma.user.update({ where: { id: user.id }, data: { stripeOnboardingComplete: onboardingComplete }});
          console.log(`[/account-status] Onboarding status for user ${user.id} updated to ${onboardingComplete}`);
        }
        res.json({ stripeAccountId: user.stripeAccountId, detailsSubmitted: account.details_submitted, chargesEnabled: account.charges_enabled, payoutsEnabled: account.payouts_enabled, onboardingComplete: onboardingComplete });
      } catch (error) {
        console.error('[/account-status] Error:', error.message, error.stack);
        res.status(500).json({ message: 'Error fetching Stripe status', error: error.message });
      }
});

// 3. Create Stripe Checkout Session (with 15% fee on top model)
router.post('/create-checkout-session', async (req, res) => {
  console.log("[Stripe Router] POST /create-checkout-session hit. Body:", req.body);
  if (!req.body) {
    return res.status(400).json({ message: 'Request body missing.' });
  }
  const { amount: creatorReceivesAmountDollars, recipientUsername } = req.body;
  if (!recipientUsername || isNaN(parseFloat(creatorReceivesAmountDollars)) || parseFloat(creatorReceivesAmountDollars) < 1.00) {
    return res.status(400).json({ message: 'Valid amount for creator (min $1.00) and recipient username required.' });
  }
  const creatorReceivesAmount = parseFloat(creatorReceivesAmountDollars);
  const platformFeePercentage = 0.15; // Your flat 15% fee
  const platformFeeDollars = creatorReceivesAmount * platformFeePercentage;
  const grossAmountDollars = creatorReceivesAmount + platformFeeDollars;
  const grossAmountInCents = Math.round(grossAmountDollars * 100);
  const creatorReceivesAmountInCents = Math.round(creatorReceivesAmount * 100);
  if (grossAmountInCents < 50) {
      return res.status(400).json({ message: 'Calculated charge amount is too small.' });
  }
  try {
    const recipientUser = await prisma.user.findUnique({
      where: { username: recipientUsername },
      select: { id: true, username: true, displayName: true, stripeAccountId: true, stripeOnboardingComplete: true }
    });
    if (!recipientUser || !recipientUser.stripeAccountId || !recipientUser.stripeOnboardingComplete) {
      return res.status(400).json({ message: 'This creator is not currently set up to receive payments.' });
    }
    const productName = `Support for ${recipientUser.displayName || recipientUser.username}`;
    const productDescription = `Total payment of $${grossAmountDollars.toFixed(2)} to support ${recipientUser.displayName || recipientUser.username} via ${process.env.PLATFORM_DISPLAY_NAME || 'Our Platform'}.`;
    
    console.log(`[Checkout] Creator to get: $${creatorReceivesAmount.toFixed(2)}. Total donor charge: $${grossAmountDollars.toFixed(2)}.`);

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: { currency: 'usd', product_data: { name: productName, description: productDescription }, unit_amount: grossAmountInCents, },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL}/payment-success?recipient=${recipientUsername}&amount_sent=${creatorReceivesAmount.toFixed(2)}`,
      cancel_url: `${process.env.FRONTEND_URL}/${recipientUsername}?payment_cancelled=true`,
      // NO application_fee_amount or transfer_data. The charge is on the platform.
      // We will create the transfer in the webhook handler.
      metadata: { 
        appRecipientUserId: recipientUser.id,
        appRecipientStripeAccountId: recipientUser.stripeAccountId, // MUST pass this for the transfer
        transferAmountCents: creatorReceivesAmountInCents.toString(), // The exact amount to transfer
      },
    });
    res.json({ id: session.id });
  } catch (error) {
    console.error('[Stripe Router /create-checkout-session] Error:', error.message, error.stack);
    res.status(500).json({ message: 'Error creating payment session', error: error.message });
  }
});

// 4. Stripe Webhook Handler (with Separate Transfer logic)
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    let event;
    try { event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret); } catch (err) { console.error(`[Webhook] Sig verification failed: ${err.message}`); return res.status(400).send(`Webhook Error: ${err.message}`); }

    console.log(`[Webhook] Event received: ${event.type}, ID: ${event.id}`);
    switch (event.type) {
      case 'checkout.session.completed':
        const session = event.data.object;
        if (session.payment_status === 'paid') {
          console.log('[Webhook] Checkout Session paid. Processing separate transfer.');
          const metadata = session.metadata;
          const recipientStripeAccountId = metadata?.appRecipientStripeAccountId;
          const transferAmountCents = parseInt(metadata?.transferAmountCents, 10);
          const paymentIntentId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
          const appRecipientUserId = metadata?.appRecipientUserId;
          if (!recipientStripeAccountId || !transferAmountCents || !paymentIntentId || !appRecipientUserId) {
            console.error('[Webhook] CRITICAL: Metadata missing for transfer.', metadata);
            return res.status(200).json({ received: true, error: "Metadata missing, cannot create transfer." }); // Ack to Stripe
          }
          try {
            const existingPayment = await prisma.payment.findUnique({ where: { stripePaymentIntentId: paymentIntentId }});
            if (existingPayment) {
              console.log(`[Webhook] Payment ${paymentIntentId} already processed. Transfer will not be re-created.`);
              return res.status(200).json({ received: true, message: "Already processed" });
            }
            console.log(`[Webhook] Creating transfer of ${transferAmountCents} cents to ${recipientStripeAccountId} from source PI ${paymentIntentId}`);
            const transfer = await stripe.transfers.create({
              amount: transferAmountCents, currency: 'usd', destination: recipientStripeAccountId,
              source_transaction: paymentIntentId, // Link the transfer to the original charge
            });
            console.log(`[Webhook] Transfer created: ${transfer.id}`);
            await prisma.payment.create({
              data: {
                stripePaymentIntentId: paymentIntentId, amount: session.amount_total, // Gross donor payment
                currency: session.currency.toLowerCase(), status: 'succeeded', recipientUserId: appRecipientUserId,
                payerEmail: session.customer_details?.email,
                platformFee: session.amount_total - transferAmountCents, // Your GROSS profit
              },
            });
            console.log(`[Webhook] Payment and Transfer for PI ${paymentIntentId} recorded successfully.`);
          } catch (err) {
            console.error('[Webhook] Error creating transfer or saving payment to DB:', err);
            return res.status(500).json({ error: `Failed to process transfer: ${err.message}` }); // Tell Stripe to retry
          }
        }
        break;
      case 'account.updated':
        const account = event.data.object;
        console.log(`[Webhook] account.updated for Stripe Account ID: ${account.id}`);
        try {
          const userToUpdate = await prisma.user.findFirst({ where: { stripeAccountId: account.id } });
          if (userToUpdate) {
            const onboardingComplete = !!(account.charges_enabled && account.details_submitted && account.payouts_enabled);
            if (userToUpdate.stripeOnboardingComplete !== onboardingComplete) {
              await prisma.user.update({ where: { id: userToUpdate.id }, data: { stripeOnboardingComplete: onboardingComplete }});
              console.log(`[Webhook] Updated onboarding for Stripe account ${account.id} to ${onboardingComplete}`);
            }
          } else { console.warn(`[Webhook] Received account.updated for unknown Stripe account ID ${account.id}`); }
        } catch (dbError) { console.error('[Webhook] DB error from account.updated:', dbError); }
        break;
      default: /* console.log(`[Webhook] Unhandled event type: ${event.type}`); */
    }
    res.status(200).json({ received: true });
  }
);

// 5. CREATE STRIPE EXPRESS DASHBOARD LOGIN LINK
router.post('/create-express-dashboard-link', authMiddleware, async (req, res) => {
    // ... (This route remains the same as the last full version) ...
    try {
        if (!req.localUser?.id) return res.status(403).json({ message: 'User profile not found.' });
        const user = req.localUser; if (!user.stripeAccountId || !user.stripeOnboardingComplete) return res.status(400).json({ message: 'Stripe account not fully set up.' });
        const loginLink = await stripe.accounts.createLoginLink(user.stripeAccountId);
        res.json({ url: loginLink.url });
      } catch (error) { console.error('[/create-express-dashboard-link] Error:', error); if (error.type === 'StripeInvalidRequestError') return res.status(400).json({ message: 'Unable to generate dashboard link.' }); res.status(500).json({ message: 'Error creating dashboard link', error: error.message }); }
});

module.exports = router;