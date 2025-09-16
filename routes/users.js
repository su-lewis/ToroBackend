// File: backend/routes/users.js
const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { authMiddleware } = require('../middleware/auth');
const { createClient } = require('@supabase/supabase-js');
const { Prisma } = require('@prisma/client');

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
router.post('/profile', authMiddleware, async (req, res) => {
  const {
    username,
    displayName,
    bio,
    profileImageUrl,
    bannerImageUrl,
    profileBackgroundColor,
    payoutsInUsd
  } = req.body;

  if (!req.user || !req.user.id) {
    return res.status(401).json({ message: "Authentication error." });
  }
  const supabaseAuthId = req.user.id;
  const email = req.user.email;

  const profileData = {};
  if (username !== undefined) profileData.username = username.trim();
  if (displayName !== undefined) profileData.displayName = displayName;
  if (bio !== undefined) profileData.bio = bio;
  if (profileImageUrl !== undefined) profileData.profileImageUrl = profileImageUrl || null;
  if (bannerImageUrl !== undefined) profileData.bannerImageUrl = bannerImageUrl || null;
  if (profileBackgroundColor !== undefined) profileData.profileBackgroundColor = profileBackgroundColor;
  if (payoutsInUsd !== undefined) profileData.payoutsInUsd = payoutsInUsd;
  
  if (profileData.username) {
    if (profileData.username.trim() === '') return res.status(400).json({ message: "Username cannot be empty." });
    if (!/^[a-zA-Z0-9_.-]{3,20}$/.test(profileData.username)) {
      return res.status(400).json({ message: "Username must be 3-20 characters long." });
    }
    const existingUser = await prisma.user.findFirst({
      where: { 
        username: { equals: profileData.username, mode: 'insensitive' },
        NOT: { supabaseAuthId: supabaseAuthId }
      },
    });
    if (existingUser) return res.status(409).json({ message: "Username is already taken." });
  }

  try {
    const userProfile = await prisma.user.upsert({
      where: { supabaseAuthId: supabaseAuthId },
      update: profileData,
      create: {
        supabaseAuthId: supabaseAuthId,
        email: email,
        // --- FIX #2: Ensure `username` is always present in the `create` block ---
        // We use the local user profile from the middleware to get the current username if it's not being updated.
        username: profileData.username || req.localUser?.username,
        ...profileData,
      },
    });

    res.status(200).json(userProfile);

  } catch (error) {
    console.error(`POST /api/users/profile error for Supabase user ${supabaseAuthId}:`, error);
    
    // Now that `Prisma` is imported, this check will work correctly.
    if (error instanceof Prisma.PrismaClientValidationError) {
        if (error.message.includes("Argument `username` is missing")) {
            return res.status(400).json({ message: "A username is required to create your profile." });
        }
        return res.status(400).json({ message: "Invalid data provided.", details: error.message });
    }
    if (error.code === 'P2002') {
      return res.status(409).json({ message: "This username is already registered." });
    }
    res.status(500).json({ message: "An error occurred while saving the profile." });
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