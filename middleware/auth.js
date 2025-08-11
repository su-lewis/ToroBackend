// backend/middleware/auth.js
const { createClient } = require('@supabase/supabase-js');
const prisma = require('../lib/prisma');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const authMiddleware = async (req, res, next) => {
  // 1. Check for the Authorization header
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Authentication required: No token provided.' });
  }

  // 2. Extract the token
  const token = authHeader.split(' ')[1];
  if (!token) {
    return res.status(401).json({ message: 'Authentication required: Malformed token.' });
  }

  try {
    // 3. Securely validate the token and get the user from Supabase.
    //    This is the recommended approach and fixes the security warning.
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error) {
      console.warn('Supabase auth error:', error.message);
      return res.status(401).json({ message: 'Authentication failed: Invalid token.', error: error.message });
    }

    if (!user) {
      return res.status(401).json({ message: 'Authentication failed: User not found for this token.' });
    }

    // 4. Attach the authenticated Supabase user to the request object
    req.user = user;

    // 5. Fetch the corresponding user profile from your local Prisma database
     const localUser = await prisma.user.findUnique({
      where: { supabaseAuthId: user.id },
      // By explicitly selecting, we avoid errors if a new column is missing.
      select: {
        id: true,
        supabaseAuthId: true,
        username: true,
        stripeAccountId: true,
        stripeOnboardingComplete: true
      }
    });
    // 6. Attach the local user profile. It's okay if it's null for new users.
    req.localUser = localUser;

    // 7. Proceed to the next middleware or route handler
    next();
  } catch (err) {
    console.error('Auth middleware internal error:', err);
    res.status(500).json({ message: 'An internal server error occurred during authentication.' });
  }
};

module.exports = { authMiddleware };