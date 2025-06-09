// backend/routes/publicProfile.js
const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');

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
		bannerImageUrl: true, // <<<< MAKE SURE THIS IS INCLUDED
        stripeAccountId: true, // For frontend to know if payments can be made
        stripeOnboardingComplete: true, // For frontend logic
        links: {
          orderBy: { order: 'asc' }, // Or createdAt
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