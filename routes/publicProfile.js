const express = require('express');
const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
// We still initialize Stripe locally here as it's the most reliable pattern we've found
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// GET /api/public/stripe-supported-countries
router.get('/stripe-supported-countries', async (req, res) => {
  try {
    // --- ULTRA-DEFENSIVE CHECK ---
    if (!stripe || typeof stripe.countries === 'undefined') {
        // This is our custom error. If we see this in the logs, we know the constructor failed.
        console.error("!!! CRITICAL FAILURE: Stripe instance is malformed. `stripe.countries` is undefined. !!!");
        throw new Error("Stripe client failed to initialize on the server.");
    }
    
    const countries = await stripe.countries.list({ limit: 100 });
    
    const displayNames = new Intl.DisplayNames(['en'], { type: 'country' });
    
    const supportedCountries = countries.data.map(country => ({
        code: country.id,
        name: displayNames.of(country.id),
    })).sort((a, b) => a.name.localeCompare(b.name));

    res.json(supportedCountries);
  } catch (error) {
    console.error("Error fetching Stripe supported countries:", error);
    // Send back the specific error message
    res.status(500).json({ message: error.message || 'Error fetching supported countries' });
  }
});

// GET public profile by username
router.get('/profile/:username', async (req, res) => {
  const { username } = req.params;
  try {
    const user = await prisma.user.findUnique({
      where: { username: username },
      select: {
        id: true,
        username: true,
        displayName: true,
        bio: true,
        profileImageUrl: true,
		    bannerImageUrl: true,
        profileBackgroundColor: true,
        stripeAccountId: true,
        stripeOnboardingComplete: true,
        payoutsInUsd: true,           
        stripeDefaultCurrency: true,
        links: {
          orderBy: { order: 'asc' },
          select: { id: true, title: true, url: true }
        }
      }
    });

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    res.json(user);
  } catch (error) {
    console.error("Error fetching public profile:", error);
    res.status(500).json({ message: 'Error fetching public profile', error: error.message });
  }
});

module.exports = router;