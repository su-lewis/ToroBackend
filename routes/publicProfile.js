const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
// We will only require the main library here
const Stripe = require('stripe');

// GET /api/public/stripe-supported-countries
router.get('/stripe-supported-countries', async (req, res) => {
  try {
    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
        console.error("!!! CRITICAL ERROR: STRIPE_SECRET_KEY is NOT DEFINED inside the route handler. !!!");
        throw new Error("Stripe secret key is not configured on the server.");
    }
    
    // --- FINAL ATTEMPT ---
    // Initialize Stripe with the full appInfo block.
    const stripe = new Stripe(secretKey, {
        apiVersion: '2023-10-16', // It's good practice to pin this
        appInfo: {
            name: 'TributeToro Staging', // Be explicit for debugging
            version: '1.0.0',
            url: process.env.FRONTEND_URL || 'https://tributetoro.com'
        }
    });

    if (!stripe || typeof stripe.countries === 'undefined') {
        console.error("!!! CRITICAL FAILURE: Stripe instance is malformed EVEN WITH appInfo. !!!");
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
    console.error("Error fetching Stripe supported countries:", error.message);
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