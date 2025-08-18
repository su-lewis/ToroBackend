// File: backend/routes/users.js

const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { authMiddleware } = require('../middleware/auth');
const { createClient } = require('@supabase/supabase-js');

// --- Helper Function for Password Verification ---
const verifyCurrentUserPassword = async (email, password) => {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const { error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    const authError = new Error('Incorrect password.');
    authError.status = 401; // Unauthorized
    throw authError;
  }
};

// GET current logged-in user's application profile
// This route now simply returns the full user profile fetched by the auth middleware.
router.get('/me', authMiddleware, async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ message: 'User not authenticated (no Supabase user context).' });
  }
  
  if (!req.localUser) {
    return res.status(404).json({
      message: 'Application profile not found. Please complete your profile setup.',
      code: 'PROFILE_NOT_FOUND'
    });
  }

  res.json(req.localUser);
});


// POST Create or Update user's application profile
// This route is now more flexible and allows for partial updates.
router.post('/profile', authMiddleware, async (req, res) => {
  const {
    username,
    displayName,
    bio,
    profileImageUrl,
    bannerImageUrl,
    profileBackgroundColor,
    preferredCurrency // Added for currency updates
  } = req.body;

  if (!req.user || !req.user.id) {
    return res.status(401).json({ message: "Authentication error: Supabase user ID missing." });
  }
  const supabaseAuthId = req.user.id;
  
  // --- FIX: Only validate username IF it is provided in the request body ---
  if (username !== undefined) {
    if (typeof username !== 'string' || username.trim() === '') {
      return res.status(400).json({ message: "Username cannot be empty." });
    }
    const trimmedUsername = username.trim();
    if (!/^[a-zA-Z0-9_.-]{3,20}$/.test(trimmedUsername)) {
      return res.status(400).json({ message: "Username must be 3-20 characters (letters, numbers, _, ., -)." });
    }

    const existingUserByUsername = await prisma.user.findFirst({
      where: {
        username: { equals: trimmedUsername, mode: 'insensitive' },
        NOT: { supabaseAuthId: supabaseAuthId }
      },
    });

    if (existingUserByUsername) {
      return res.status(409).json({ message: "Username is already taken by another user." });
    }
  }

  try {
    const profileData = {
      // Use trimmed username only if it was provided, otherwise it remains undefined and is ignored by Prisma
      username: username !== undefined ? username.trim() : undefined,
      displayName,
      bio,
      profileImageUrl,
      bannerImageUrl,
      profileBackgroundColor,
      preferredCurrency
    };

    // Use `update` instead of `upsert`. `upsert` is for "create if not exist," 
    // but the /me route and auth middleware should handle profile creation logic.
    const updatedUser = await prisma.user.update({
      where: { supabaseAuthId: supabaseAuthId },
      data: profileData,
    });

    res.status(200).json(updatedUser);

  } catch (error) {
    console.error(`POST /api/users/profile error for Supabase user ${supabaseAuthId}:`, error);
    if (error.code === 'P2002' && error.meta?.target?.includes('username')) {
      return res.status(409).json({ message: "This username is already registered (database constraint)." });
    }
    // Handle case where user might not exist yet if using `update` strictly
    if (error.code === 'P2025') {
       return res.status(404).json({ message: "User profile not found to update." });
    }
    res.status(500).json({ message: "An error occurred while saving the profile.", error: error.message });
  }
});

// --- CORRECTED: Securely Update User Password ---
router.post('/update-password', authMiddleware, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    const supabaseUser = req.user;

    if (!currentPassword || !newPassword) return res.status(400).json({ message: 'Current and new passwords are required.' });
    if (newPassword.length < 6) return res.status(400).json({ message: 'New password must be at least 6 characters long.' });

    try {
        // Step 1: Verify the current password using the helper.
        await verifyCurrentUserPassword(supabaseUser.email, currentPassword);

        // Step 2: If correct, update the user with the admin client.
        const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
        const { error: updateUserError } = await supabaseAdmin.auth.admin.updateUserById(
            supabaseUser.id,
            { password: newPassword }
        );
        if (updateUserError) throw updateUserError;
        
        res.status(200).json({ message: 'Password updated successfully.' });
    } catch (error) {
        if (error.status === 401) {
            return res.status(401).json({ message: 'Incorrect current password.' });
        }
        console.error(`[/users/update-password] Error for user ${supabaseUser.id}:`, error);
        res.status(500).json({ message: error.message || 'An error occurred while updating your password.' });
    }
});

// --- Securely Update User Email (no confirmation) ---
router.post('/update-email', authMiddleware, async (req, res) => {
    const { currentPassword, newEmail } = req.body;
    const supabaseUser = req.user;

    if (!currentPassword || !newEmail) return res.status(400).json({ message: 'Current password and new email are required.' });
    const trimmedNewEmail = newEmail.trim().toLowerCase();
    if (trimmedNewEmail === supabaseUser.email.toLowerCase()) return res.status(400).json({ message: 'New email must be different from the current one.' });

    try {
        // Step 1: Verify the current password using the helper.
        await verifyCurrentUserPassword(supabaseUser.email, currentPassword);

        // Step 2: Update the email directly using the admin client.
        const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
        const { error: updateUserError } = await supabaseAdmin.auth.admin.updateUserById(
            supabaseUser.id,
            { email: trimmedNewEmail }
        );

        if (updateUserError) {
            if (updateUserError.message.includes('unique constraint') || updateUserError.message.includes('already registered')) {
                return res.status(409).json({ message: 'This email address is already in use.' });
            }
            throw updateUserError; // Let the main catch block handle other errors
        }

        // Step 3: Also update the email in our local Prisma database.
        await prisma.user.update({
            where: { supabaseAuthId: supabaseUser.id },
            data: { email: trimmedNewEmail },
        });

        res.status(200).json({ message: `Email updated successfully to ${trimmedNewEmail}.` });
    } catch (error) {
        if (error.status === 401) {
            return res.status(401).json({ message: error.message });
        }
        console.error(`[/users/update-email] Error for user ${supabaseUser.id}:`, error);
        res.status(500).json({ message: error.message || 'An error occurred while processing your email change request.' });
    }
});

module.exports = router;