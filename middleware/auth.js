// File: backend/middleware/auth.js (Final Corrected Version)

const { supabaseAdmin } = require('../lib/supabase');

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
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);

    if (error) {
      console.warn('Supabase auth error:', error.message);
      return res.status(401).json({ message: 'Authentication failed: Invalid token.', error: error.message });
    }

    if (!user) {
      return res.status(401).json({ message: 'Authentication failed: User not found for this token.' });
    }

    req.user = user;

    // --- Fetch the local user profile from Supabase using only the application fields we need.
    const { data: localUser, error: localUserError } = await supabaseAdmin.from('User').select(
      `id, supabase_auth_id, email, username, displayName, bio, profileImageUrl, bannerImageUrl,
       profileBackgroundColor, payoutsInUsd, autoInstantPayoutsEnabled, stripeAccountId,
       stripeOnboardingComplete, stripeAccountCountry, stripeDefaultCurrency, createdAt, updatedAt`
    ).eq('supabase_auth_id', user.id).single();

    if (localUserError && localUserError.code !== 'PGRST116') {
      console.error('Supabase local user lookup error:', localUserError);
      return res.status(500).json({ message: 'Failed to load local user profile.' });
    }

    req.localUser = localUser;

    next();
  } catch (err) {
    console.error('Auth middleware internal error:', err);
    res.status(500).json({ message: 'An internal server error occurred during authentication.' });
  }
};

module.exports = { authMiddleware };