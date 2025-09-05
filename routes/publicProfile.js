// backend/routes/publicProfile.js
const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// GET /api/public/stripe-supported-countries
router.get('/stripe-supported-countries', async (req, res) => {
  try {
    // Fetch all countries from Stripe's API
    const countries = await stripe.countries.list({ limit: 100 }); // Get up to 100 countries

    // Use Node's built-in Intl API to get the full name for each country code
    const displayNames = new Intl.DisplayNames(['en'], { type: 'country' });
    
    const supportedCountries = countries.data.map(country => ({
        code: country.id, // e.g., "US"
        name: displayNames.of(country.id), // e.g., "United States"
    })).sort((a, b) => a.name.localeCompare(b.name)); // Sort them alphabetically

    res.json(supportedCountries);
  } catch (error) {
    console.error("Error fetching Stripe supported countries:", error);
    res.status(500).json({ message: 'Error fetching supported countries' });
  }
});

// GET public profile by username
router.get('/profile/:username', async (req, res) => {
  const { username } = req.params;
  try {
    const user = await prisma.user.findUnique({
      where: { username: username },
      select: { // Only select public fields
        id: true,
        username: true,
        displayName: true,
        bio: true,
        profileImageUrl: true,
		bannerImageUrl: true,
     profileBackgroundColor: true,
        stripeAccountId: true, // For frontend to know if payments can be made
        stripeOnboardingComplete: true, // For frontend logic
        payoutsInUsd: true,           
        stripeDefaultCurrency: true,  // <-- The creator's native currency
        links: {
          orderBy: { order: 'asc' },
          select: {
            id: true,
            title: true,
            url: true,
          }
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