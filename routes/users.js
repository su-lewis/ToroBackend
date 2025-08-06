// backend/routes/users.js
const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma'); // Using the separated Prisma client
const { authMiddleware } = require('../middleware/auth');
const { createClient } = require('@supabase/supabase-js'); // Needed for re-authentication

// GET current logged-in user's application profile
// Fetches all relevant fields including avatar and banner URLs
router.get('/me', authMiddleware, async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ message: 'User not authenticated (no Supabase user context).' });
  }
  if (!req.localUser) {
    // console.log(`GET /api/users/me: App profile not found for Supabase user ${req.user.id}. Prompting profile setup.`);
    return res.status(404).json({ 
      message: 'Application profile not found. Please complete your profile setup.',
      code: 'PROFILE_NOT_FOUND' 
    });
  }
  // console.log(`GET /api/users/me: Successfully retrieved profile for Supabase user ${req.user.id}`);
  res.json(req.localUser); // req.localUser should contain all fields from Prisma User model
});

// POST Create or Update user's application profile
router.post('/profile', authMiddleware, async (req, res) => {
  const { 
    username, 
    displayName, 
    bio, 
    profileImageUrl, // URL from Supabase Storage for avatar
    bannerImageUrl,
    profileBackgroundColor // Optional background color for profile
  } = req.body; 
  
  if (!req.user || !req.user.id) {
    return res.status(401).json({ message: "Authentication error: Supabase user ID missing." });
  }
  const supabaseAuthId = req.user.id;
  const userEmail = req.user.email; // Get email from authenticated Supabase user

  if (!username || typeof username !== 'string' || username.trim() === '') {
    return res.status(400).json({ message: "Username is required and cannot be empty." });
  }
  const trimmedUsername = username.trim();
  if (!/^[a-zA-Z0-9_.-]{3,20}$/.test(trimmedUsername)) {
    return res.status(400).json({ message: "Username must be 3-20 characters (letters, numbers, _, ., -)." });
  }

  try {
    const existingUserByUsername = await prisma.user.findFirst({
      where: { 
        username: { equals: trimmedUsername, mode: 'insensitive' },
        NOT: { supabaseAuthId: supabaseAuthId }
      },
    });

    if (existingUserByUsername) {
      return res.status(409).json({ message: "Username is already taken by another user." });
    }

    // Data for creating a new user profile
    const dataForCreate = {
      username: trimmedUsername,
      displayName: displayName || null,
      bio: bio || null,
      email: userEmail,
      profileImageUrl: profileImageUrl || null,
      bannerImageUrl: bannerImageUrl || null,
      profileBackgroundColor: profileBackgroundColor || '#FFFFFF',
      supabaseAuthId: supabaseAuthId, // Link to Supabase Auth user
    };
    
    // Data for updating an existing user profile
    const dataForUpdate = {
        username: trimmedUsername,
        displayName: displayName || null,
        bio: bio || null,
        email: userEmail, // Keep email in sync
        profileImageUrl: profileImageUrl, // If null is passed, it will set it to null
        bannerImageUrl: bannerImageUrl,   // If null is passed, it will set it to null
        profileBackgroundColor: profileBackgroundColor,
    };

    const upsertedUser = await prisma.user.upsert({
      where: { supabaseAuthId: supabaseAuthId }, // Find user by their Supabase Auth ID
      update: dataForUpdate,
      create: dataForCreate,
    });

    console.log(`POST /api/users/profile: Profile successfully upserted for Supabase user ${supabaseAuthId}`);
    res.status(200).json(upsertedUser);

  } catch (error) {
    console.error(`POST /api/users/profile error for Supabase user ${supabaseAuthId}:`, error);
    if (error.code === 'P2002' && error.meta?.target?.includes('username')) {
      return res.status(409).json({ message: "This username is already registered (database constraint)." });
    }
    res.status(500).json({ message: "An error occurred while saving the profile.", error: error.message });
  }
});

router.post('/update-password', authMiddleware, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    const supabaseUser = req.user;

    if (!currentPassword || !newPassword) {
        return res.status(400).json({ message: 'Current and new passwords are required.' });
    }
    if (newPassword.length < 6) {
        return res.status(400).json({ message: 'New password must be at least 6 characters long.' });
    }

    try {
        // Step 1: Verify the current password by trying to sign in with it.
        const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
        const { error: signInError } = await supabase.auth.signInWithPassword({
            email: supabaseUser.email,
            password: currentPassword,
        });

        if (signInError) {
            return res.status(401).json({ message: 'Incorrect current password.' });
        }

        // Step 2: If correct, update the user with the admin client.
        const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
        const { error: updateUserError } = await supabaseAdmin.auth.admin.updateUserById(
            supabaseUser.id,
            { password: newPassword }
        );

        if (updateUserError) { throw updateUserError; }
        
        res.status(200).json({ message: 'Password updated successfully.' });

    } catch (error) {
        console.error(`[/users/update-password] Error for user ${supabaseUser.id}:`, error);
        res.status(500).json({ message: error.message || 'An error occurred while updating your password.' });
    }
});


// --- NEW ROUTE: Securely Update User Email ---
// Follows the same pattern: verify password, then update with admin client.
router.post('/update-email', authMiddleware, async (req, res) => {
    const { currentPassword, newEmail } = req.body;
    const supabaseUser = req.user;

    if (!currentPassword || !newEmail) {
        return res.status(400).json({ message: 'Current password and new email are required.' });
    }

    try {
        const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
        const { error: signInError } = await supabase.auth.signInWithPassword({
            email: supabaseUser.email,
            password: currentPassword,
        });
        if (signInError) {
            return res.status(401).json({ message: 'Incorrect password.' });
        }
        
        const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
        const { error: updateUserError } = await supabaseAdmin.auth.admin.updateUserById(
            supabaseUser.id,
            { email: newEmail }
        );
        if (updateUserError) {
            if (updateUserError.message.includes('unique constraint')) {
                return res.status(409).json({ message: 'This email address is already in use.' });
            }
            throw updateUserError;
        }

        res.status(200).json({ message: 'Confirmation links sent to both old and new email addresses. Please verify to complete the change.' });
    } catch (error) {
        console.error(`[/users/update-email] Error for user ${supabaseUser.id}:`, error);
        res.status(500).json({ message: error.message || 'An error occurred while updating your email.' });
    }
});

module.exports = router;