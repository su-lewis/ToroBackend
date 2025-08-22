// File: backend/middleware/auth.js (Corrected Version)

const { createClient } = require('@supabase/supabase-js');
const prisma = require('../lib/prisma');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const authMiddleware = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Authentication required: No token provided.' });
  }

  const token = authHeader.split(' ')[1];
  if (!token) {
    return res.status(401).json({ message: 'Authentication required: Malformed token.' });
  }

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error) {
      console.warn('Supabase auth error:', error.message);
      return res.status(401).json({ message: 'Authentication failed: Invalid token.', error: error.message });
    }

    if (!user) {
      return res.status(401).json({ message: 'Authentication failed: User not found for this token.' });
    }

    req.user = user;

    // --- THIS IS THE FIX ---
    // We are now selecting the new `payoutsInUsd` field and have removed the old `preferredCurrency` field.
    const localUser = await prisma.user.findUnique({
      where: { supabaseAuthId: user.id },
      select: {
        id: true,
        supabaseAuthId: true,
        email: true,
        username: true,
        displayName: true,
        bio: true,
        profileImageUrl: true,
        bannerImageUrl: true,
        profileBackgroundColor: true,
        country: true,
        dobDay: true,
        dobMonth: true,
        dobYear: true,
        firstName: true,
        lastName: true,
        phone: true,
        payoutsInUsd: true, // <-- The new, correct field
        stripeAccountId: true,
        stripeOnboardingComplete: true,
        stripeAutoPayoutsEnabled: true,
        stripeAccountCountry: true,
        stripeDefaultCurrency: true,
        createdAt: true,
        updatedAt: true,
      }
    });
    
    req.localUser = localUser;

    next();
  } catch (err) {
    console.error('Auth middleware internal error:', err);
    res.status(500).json({ message: 'An internal server error occurred during authentication.' });
  }
};

module.exports = { authMiddleware };