// backend/routes/users.js
const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { authMiddleware } = require('../middleware/auth');

// GET current logged-in user's application profile
router.get('/me', authMiddleware, async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ message: 'User not authenticated.' });
  }
  if (!req.localUser) { // localUser is from your Prisma User table
    return res.status(404).json({ 
      message: 'Application profile not found. Please complete your profile setup.',
      code: 'PROFILE_NOT_FOUND' 
    });
  }
  res.json(req.localUser);
});

// POST Create or Update user's application profile
router.post('/profile', authMiddleware, async (req, res) => {
  // Destructure all expected fields from the request body
  const { 
    username, 
    displayName, 
    bio, 
    profileImageUrl, 
    bannerImageUrl, 
    profileBackgroundColor 
  } = req.body; 
  
  if (!req.user || !req.user.id) {
    return res.status(401).json({ message: "Authentication error: Supabase user ID missing." });
  }
  const supabaseAuthId = req.user.id;
  const userEmail = req.user.email;

  if (!username || typeof username !== 'string' || username.trim() === '') {
    return res.status(400).json({ message: "Username is required and cannot be empty." });
  }
  const trimmedUsername = username.trim();
  if (!/^[a-zA-Z0-9_.-]{3,20}$/.test(trimmedUsername)) {
    return res.status(400).json({ message: "Username must be 3-20 characters (letters, numbers, _, ., -)." });
  }
  
  // Basic hex color validation (optional but good)
  if (profileBackgroundColor && !/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/.test(profileBackgroundColor)) {
      return res.status(400).json({ message: "Invalid background color format. Please use a valid hex code (e.g., #RRGGBB)." });
  }

  try {
    // Check if username is already taken by *another* user
    const existingUserByUsername = await prisma.user.findFirst({
      where: { 
        username: { equals: trimmedUsername, mode: 'insensitive' },
        NOT: { supabaseAuthId: supabaseAuthId } 
      },
    });
    if (existingUserByUsername) {
      return res.status(409).json({ message: "Username is already taken by another user." });
    }

    // Prepare data for the update (doesn't include supabaseAuthId)
    const userDataForUpdate = {
      username: trimmedUsername,
      displayName: displayName || null,
      bio: bio || null,
      email: userEmail,
      profileImageUrl: profileImageUrl, // Can be null if user removes it
      bannerImageUrl: bannerImageUrl,   // Can be null
      profileBackgroundColor: profileBackgroundColor || null, // Add the new field
    };
    
    // Prepare data for creation (includes the supabaseAuthId link)
    const userDataForCreate = {
      ...userDataForUpdate,
      supabaseAuthId: supabaseAuthId,
    };

    // Upsert: create if doesn't exist (based on supabaseAuthId), update if it does.
    const upsertedUser = await prisma.user.upsert({
      where: { supabaseAuthId: supabaseAuthId },
      update: userDataForUpdate,
      create: userDataForCreate,
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

module.exports = router;