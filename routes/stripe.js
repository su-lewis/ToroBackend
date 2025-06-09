// backend/routes/stripe.js
const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const prisma = require('../lib/prisma'); // Using the separated Prisma client
const { authMiddleware } = require('../middleware/auth');

// Environment variable checks at module load time
if (!process.env.STRIPE_SECRET_KEY) {
    console.error("FATAL BACKEND ERROR: STRIPE_SECRET_KEY is not defined in .env. Stripe routes will fail catastrophically.");
}
if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.warn("WARNING: STRIPE_WEBHOOK_SECRET is not defined in .env. Webhook signature verification will fail.");
}
if (!process.env.FRONTEND_URL) {
    console.warn("WARNING: FRONTEND_URL is not defined in .env. Stripe redirect URLs may be invalid, leading to errors.");
}
if (!process.env.PLATFORM_DISPLAY_NAME) {
    console.warn("WARNING: PLATFORM_DISPLAY_NAME is not defined in .env. Descriptions sent to Stripe may be generic.");
}

console.log("[Stripe Router] File loaded and router instance created.");

// 1. Create Stripe Connect Account and Onboarding Link
router.post('/connect/onboard-user', authMiddleware, async (req, res) => {
  console.log("--- [Stripe Router] POST /connect/onboard-user START ---");
  console.log("[Stripe Router /onboard-user] req.user (Supabase User ID):", req.user ? req.user.id : "undefined");
  console.log("[Stripe Router /onboard-user] req.localUser (Prisma User ID):", req.localUser ? req.localUser.id : "undefined");

  try {
    if (!req.localUser || !req.localUser.id) {
      console.error("[Stripe Router /onboard-user] Error: Application user profile (localUser) not found or missing ID.");
      return res.status(403).json({ message: 'User application profile is not fully set up. Please complete your profile on our site first (e.g., set a username).' });
    }
    const appUserId = req.localUser.id;
    const appProfile = req.localUser;

    if (!appProfile.username) {
        console.error(`[Stripe Router /onboard-user] Error: Username missing for appUser ${appUserId}. Profile URL cannot be constructed.`);
        return res.status(400).json({ message: 'A username is required in your profile to connect with Stripe.' });
    }

    const emailForStripe = req.user?.email || appProfile?.email;
    if (!emailForStripe) {
        console.error(`[Stripe Router /onboard-user] Error: Email address not available for user ${appUserId} for Stripe account creation.`);
        return res.status(400).json({ message: 'An email address is required to connect with Stripe.' });
    }
    
    const platformBaseUrl = process.env.FRONTEND_URL;
    if (!platformBaseUrl || !platformBaseUrl.startsWith('http')) { // Basic check for a valid URL
        console.error("[Stripe Router /onboard-user] CRITICAL: FRONTEND_URL is not defined or is invalid in .env! Value:", platformBaseUrl);
        return res.status(500).json({ message: 'Server configuration error: Frontend URL for Stripe redirects is missing or invalid.' });
    }

    let stripeAccountId = appProfile.stripeAccountId;

    if (!stripeAccountId) {
      console.log(`[Stripe Router /onboard-user] No Stripe Account ID for user ${appUserId}. Creating new Stripe Express account.`);
      
      const userProfileUrlOnPlatform = `${platformBaseUrl}/${appProfile.username}`;
      const productDescriptionOnPlatform = `Receiving tips and support via their page on ${process.env.PLATFORM_DISPLAY_NAME || 'our platform'}.`;

      console.log("[Stripe Router /onboard-user] URL for business_profile.url:", userProfileUrlOnPlatform);
      console.log("[Stripe Router /onboard-user] Product description:", productDescriptionOnPlatform);
      console.log("[Stripe Router /onboard-user] Email for Stripe account:", emailForStripe);
      console.log("[Stripe Router /onboard-user] Country for Stripe account (defaulting/from profile):", appProfile.country || 'US');


      const accountParams = {
        type: 'express',
        country: appProfile.country || 'US', // Default to 'US', or make this configurable/collect from user
        email: emailForStripe,
        business_type: 'individual',
        business_profile: {
          url: userProfileUrlOnPlatform,
          mcc: '8999', // Professional Services (generic for creators/tips)
          product_description: productDescriptionOnPlatform,
        },
        capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
      };
      
      const account = await stripe.accounts.create(accountParams);
      stripeAccountId = account.id;
      console.log(`[Stripe Router /onboard-user] Created Stripe Account ${stripeAccountId} for user ${appUserId}.`);
      
      await prisma.user.update({
        where: { id: appUserId },
        data: { stripeAccountId: stripeAccountId, stripeOnboardingComplete: false },
      });
      console.log(`[Stripe Router /onboard-user] Updated user ${appUserId} with Stripe Account ID.`);
    } else {
      console.log(`[Stripe Router /onboard-user] User ${appUserId} already has Stripe Account ID: ${stripeAccountId}. Proceeding to create account link.`);
    }

    const refreshUrlForStripe = `${platformBaseUrl}/connect-stripe?reauth=true&stripe_account_id=${stripeAccountId}`;
    const returnUrlForStripe = `${platformBaseUrl}/connect-stripe?status=success&stripe_account_id=${stripeAccountId}`;
    console.log("[Stripe Router /onboard-user] refresh_url for AccountLink:", refreshUrlForStripe);
    console.log("[Stripe Router /onboard-user] return_url for AccountLink:", returnUrlForStripe);

    const accountLink = await stripe.accountLinks.create({
      account: stripeAccountId,
      refresh_url: refreshUrlForStripe,
      return_url: returnUrlForStripe,
      type: 'account_onboarding',
    });
    
    // console.log(`[Stripe Router /onboard-user] Created account link for ${stripeAccountId}. URL (partial): ${accountLink.url.substring(0,50)}...`);
    res.json({ url: accountLink.url });

  } catch (error) {
    console.error('[Stripe Router /onboard-user] CRITICAL ERROR in /connect/onboard-user:', error.message, error.type ? `Type: ${error.type}` : '', error.code ? `Code: ${error.code}` : '', error.param ? `Param: ${error.param}` : '', error.stack);
    res.status(500).json({ message: 'Error creating Stripe onboarding link', error: error.message });
  }
  console.log("--- [Stripe Router] POST /connect/onboard-user END ---");
});

// 2. Get Stripe Account Status
router.get('/connect/account-status', authMiddleware, async (req, res) => {
  // ... (Keep this route exactly as the last full version provided)
  console.log("[Stripe Router] GET /connect/account-status hit.");
  try {
    const appUserId = req.localUser?.id;
    if (!appUserId) { console.log("[Stripe Router /account-status] Error: User profile not found (no localUser.id)."); return res.status(403).json({ message: 'User profile not found.' });}
    const user = req.localUser;
    if (!user.stripeAccountId) { console.log(`[Stripe Router /account-status] User ${appUserId} has no Stripe Account ID.`); return res.status(404).json({ message: 'Stripe account not connected for this user.' });}
    const account = await stripe.accounts.retrieve(user.stripeAccountId);
    const onboardingComplete = !!(account.charges_enabled && account.details_submitted && account.payouts_enabled);
    if (user.stripeOnboardingComplete !== onboardingComplete) {
      console.log(`[Stripe Router /account-status] Updating onboarding status for user ${appUserId} to ${onboardingComplete}.`);
      await prisma.user.update({ where: { id: appUserId }, data: { stripeOnboardingComplete: onboardingComplete }});
    }
    res.json({ stripeAccountId: user.stripeAccountId, detailsSubmitted: account.details_submitted, chargesEnabled: account.charges_enabled, payoutsEnabled: account.payouts_enabled, onboardingComplete: onboardingComplete });
  } catch (error) {
    console.error('[Stripe Router /account-status] Error fetching Stripe account status:', error.message, error.stack);
    res.status(500).json({ message: 'Error fetching Stripe account status', error: error.message });
  }
});

// 3. Create Stripe Checkout Session
router.post('/create-checkout-session', async (req, res) => {
  // ... (Keep this route exactly as the last full version, with 10% platform fee and metadata)
  console.log("[Stripe Router] POST /create-checkout-session hit. Body:", req.body); 
  if (!req.body) { console.error("[Stripe Router /create-checkout-session] Error: req.body is undefined."); return res.status(400).json({ message: 'Request body is missing.' }); }
  const { amount, recipientUsername } = req.body;
  if (!amount || !recipientUsername || isNaN(parseFloat(amount)) || parseFloat(amount) < 0.50) { return res.status(400).json({ message: 'Valid amount (min $0.50) and recipient username required.' });}
  const amountInCents = Math.round(parseFloat(amount) * 100);
  try {
    const recipientUser = await prisma.user.findUnique({ where: { username: recipientUsername }, select: { id: true, username: true, displayName: true, stripeAccountId: true, stripeOnboardingComplete: true }});
    if (!recipientUser) return res.status(404).json({ message: 'Recipient user not found.' });
    if (!recipientUser.stripeAccountId || !recipientUser.stripeOnboardingComplete) return res.status(400).json({ message: 'Creator not set up for payments.' });
    const platformFeePercentage = 0.10; const platformFeeInCents = Math.floor(amountInCents * platformFeePercentage);
    if (amountInCents - platformFeeInCents < 50) return res.status(400).json({ message: 'Amount too small after platform fees.' });
    const productName = `Support for ${recipientUser.displayName || recipientUser.username} via ${process.env.PLATFORM_DISPLAY_NAME || 'Our Platform'}`;
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'], line_items: [{ price_data: { currency: 'usd', product_data: { name: productName }, unit_amount: amountInCents }, quantity: 1 }], mode: 'payment',
      success_url: `${process.env.FRONTEND_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}&recipient=${recipientUsername}`,
      cancel_url: `${process.env.FRONTEND_URL}/${recipientUsername}?payment_cancelled=true`,
      payment_intent_data: { application_fee_amount: platformFeeInCents > 0 ? platformFeeInCents : undefined, transfer_data: { destination: recipientUser.stripeAccountId }, description: `Payment to ${recipientUser.username} via ${process.env.PLATFORM_DISPLAY_NAME || 'Our Platform'}`,},
      metadata: { appRecipientUserId: recipientUser.id, appRecipientUsername: recipientUser.username, platformFeeCharged: platformFeeInCents.toString(), totalAmountPaidByDonor: amountInCents.toString(),},
    });
    res.json({ id: session.id });
  } catch (error) { console.error('[Stripe Router /create-checkout-session] Error:', error.message, error.stack); res.status(500).json({ message: 'Error creating payment session', error: error.message });}
});

// 4. Stripe Webhook Handler
router.post( '/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    // ... (Keep this webhook handler exactly as the last full version)
    const sig = req.headers['stripe-signature']; const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET; let event;
    try { event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret); } catch (err) { console.error(`[Stripe Webhook] Sig verification failed: ${err.message}`); return res.status(400).send(`Webhook Error: ${err.message}`); }
    console.log(`[Stripe Webhook] Event received: ${event.type}, ID: ${event.id}`);
    switch (event.type) {
      case 'checkout.session.completed': /* ... (logic as before) ... */
        const session = event.data.object; const appRecipientUserId = session.metadata?.appRecipientUserId; const paymentIntentId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id; const platformFeeFromMeta = parseInt(session.metadata?.platformFeeCharged, 10); const totalAmountFromMeta = parseInt(session.metadata?.totalAmountPaidByDonor, 10);
        if (appRecipientUserId && paymentIntentId && session.payment_status === 'paid') {
          try { if (!paymentIntentId) { console.error('[Webhook] PI ID missing', session.id); return res.status(200).json({ received: true, error: "PI ID missing" });} const existingPayment = await prisma.payment.findUnique({ where: { stripePaymentIntentId: paymentIntentId }}); if (existingPayment) { console.log(`[Webhook] Payment ${paymentIntentId} already processed.`); return res.status(200).json({ received: true, message: "Already processed" });} const createdPayment = await prisma.payment.create({ data: { stripePaymentIntentId: paymentIntentId, amount: totalAmountFromMeta || session.amount_total, currency: session.currency.toLowerCase(), status: 'succeeded', recipientUserId: appRecipientUserId, payerEmail: session.customer_details?.email, platformFee: !isNaN(platformFeeFromMeta) ? platformFeeFromMeta : (session.application_fee_amount || 0), }, }); console.log(`[Webhook] Payment ${createdPayment.id} (PI: ${paymentIntentId}) recorded for user ${appRecipientUserId}.`); } catch (dbError) { console.error('[Webhook] DB error saving payment:', dbError.message, dbError.stack); return res.status(500).json({ error: "DB error" }); }
        } else { console.warn('[Webhook] checkout.session.completed insufficient data/not paid:', { sessionId: session.id, paymentStatus: session.payment_status, appRecipientUserId, paymentIntentId }); }
        break;
      case 'account.updated': /* ... (logic as before) ... */
        const account = event.data.object; console.log(`[Webhook] account.updated for Stripe Account ID: ${account.id}`);
        try { const userToUpdate = await prisma.user.findFirst({ where: { stripeAccountId: account.id } }); if (userToUpdate) { const onboardingComplete = !!(account.charges_enabled && account.details_submitted && account.payouts_enabled); if (userToUpdate.stripeOnboardingComplete !== onboardingComplete) { await prisma.user.update({ where: { id: userToUpdate.id }, data: { stripeOnboardingComplete: onboardingComplete }, }); console.log(`[Webhook] Updated onboarding for Stripe account ${account.id} to ${onboardingComplete}`); } } else { console.warn(`[Webhook] Received account.updated for unknown Stripe account ID ${account.id}`); } } catch (dbError) { console.error('[Webhook] DB error from account.updated:', dbError.message, dbError.stack); }
        break;
      default: /* console.log(`[Webhook] Unhandled type: ${event.type}`); */
    }
    res.status(200).json({ received: true });
  }
);

// 5. CREATE STRIPE EXPRESS DASHBOARD LOGIN LINK
router.post('/create-express-dashboard-link', authMiddleware, async (req, res) => {
  // ... (Keep this route exactly as the last full version)
  console.log("[Stripe Router] POST /create-express-dashboard-link hit.");
  try {
    const appUserId = req.localUser?.id; if (!appUserId) { return res.status(403).json({ message: 'User application profile not found.' });}
    const user = req.localUser; if (!user.stripeAccountId || !user.stripeOnboardingComplete) { return res.status(400).json({ message: 'Stripe account not fully set up or not connected.' });}
    const loginLink = await stripe.accounts.createLoginLink(user.stripeAccountId);
    res.json({ url: loginLink.url });
  } catch (error) { console.error('[Stripe Router /create-express-dashboard-link] Error:', error.message, error.stack); if (error.type === 'StripeInvalidRequestError' && error.message.includes('log in to your dashboard')) { return res.status(400).json({ message: 'Unable to generate dashboard link for this Stripe account type.' }); } res.status(500).json({ message: 'Error creating Stripe dashboard link', error: error.message }); }
});

module.exports = router;