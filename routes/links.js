// backend/routes/links.js
const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
// The authMiddleware is applied in index.js, so req.localUser is available and confirmed.

// GET /api/links - Fetch all links for the authenticated user (Still useful for initial page load)
router.get('/', async (req, res) => {
  try {
    const links = await prisma.link.findMany({
      where: { userId: req.localUser.id },
      orderBy: { order: 'asc' },
    });
    res.json(links);
  } catch (error) {
    console.error('[/api/links GET] Error fetching links:', error);
    res.status(500).json({ message: 'Failed to fetch links.' });
  }
});

// NEW: POST /api/links/bulk-update - Replaces all links for a user with a new set
router.post('/bulk-update', async (req, res) => {
  // Expects req.body to be { links: [ { title: '..', url: '..' }, ... ] }
  const { links } = req.body;
  
  if (!Array.isArray(links)) {
    return res.status(400).json({ message: 'A "links" array is required.' });
  }

  const userId = req.localUser.id;

  // Validate all links before proceeding
  for (const link of links) {
    if (!link.title || !link.url) {
      return res.status(400).json({ message: 'All provided links must have a title and a URL.' });
    }
    try {
      new URL(link.url.startsWith('http') ? link.url : `https://${link.url}`);
    } catch (_) {
      return res.status(400).json({ message: `Invalid URL found: ${link.url}` });
    }
  }

  try {
    // Use a transaction to ensure atomicity:
    // 1. Delete all existing links for this user.
    // 2. Create all the new links from the provided array.
    const result = await prisma.$transaction(async (tx) => {
      await tx.link.deleteMany({
        where: { userId: userId },
      });

      if (links.length === 0) {
        return []; // If they're just clearing all links
      }

      const newLinksData = links.map((link, index) => ({
        title: link.title,
        url: link.url,
        order: index, // Set order based on the array index
        userId: userId,
      }));

      await tx.link.createMany({
        data: newLinksData,
      });

      // Fetch the newly created links to return them
      const createdLinks = await tx.link.findMany({
        where: { userId: userId },
        orderBy: { order: 'asc' },
      });

      return createdLinks;
    });

    res.status(200).json(result);
  } catch (error) {
    console.error('[/api/links/bulk-update] Error:', error);
    res.status(500).json({ message: 'An error occurred while saving your links.' });
  }
});

// You can keep or remove the individual POST, PUT, DELETE, and /reorder routes
// if they are no longer needed by your frontend.
// For now, let's leave them commented out or remove them to avoid confusion.
/*
router.post('/', ...);
router.put('/:linkId', ...);
router.delete('/:linkId', ...);
router.post('/reorder', ...);
*/

module.exports = router;