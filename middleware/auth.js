// backend/middleware/auth.js
const { createClient } = require('@supabase/supabase-js');
const prisma = require('../lib/prisma');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error("FATAL BACKEND ERROR: Supabase URL or Service Role Key is not defined in .env. Auth middleware WILL FAIL.");
}
const supabaseAdmin = (supabaseUrl && supabaseServiceKey) ? createClient(supabaseUrl, supabaseServiceKey) : null;

const authMiddleware = async (req, res, next) => {
  if (!supabaseAdmin) {
    console.error("[AuthMiddleware] CRITICAL: Supabase admin client not initialized due to missing .env credentials.");
    return res.status(500).json({ message: "Server authentication configuration error." });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Unauthorized: No authentication token provided.' });
  }

  const token = authHeader.split(' ')[1];
  if (!token) {
    return res.status(401).json({ message: 'Unauthorized: Token is missing after Bearer.' });
  }

  try {
    const { data, error: getUserError } = await supabaseAdmin.auth.getUser(token);

    if (getUserError) {
      console.warn('[AuthMiddleware] Supabase auth.getUser error:', getUserError.message);
      return res.status(401).json({ message: `Unauthorized: ${getUserError.message}. Please log in again.` });
    }
    
    if (!data || !data.user) { 
      console.warn('[AuthMiddleware] Supabase auth.getUser returned no user for token. Token might be invalid/revoked.');
      return res.status(401).json({ message: 'Unauthorized: Invalid session or user not identifiable by token.' });
    }

    const supabaseUser = data.user;
    req.user = supabaseUser; // Attach Supabase user object (id, email, etc.)

    const appUser = await prisma.user.findUnique({
      where: { supabaseAuthId: supabaseUser.id },
    });
    req.localUser = appUser; // Attach your app's user profile (can be null if not created yet)

    next();
  } catch (err) {
    console.error('[AuthMiddleware] UNEXPECTED error during token processing or Prisma lookup:', err);
    return res.status(500).json({ message: 'Internal server error during authentication process.' });
  }
};

module.exports = { authMiddleware };