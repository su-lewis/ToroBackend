// routes/pageBlocks.js
const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');

// GET /api/page-blocks - Fetch all page blocks for the authenticated user for the editor
router.get('/', async (req, res) => {
  try {
    const blocks = await prisma.pageBlock.findMany({
      where: { userId: req.localUser.id },
      orderBy: { order: 'asc' },
      include: {
          _count: {
              select: { payments: true } // Count how many payments are linked to wishlist blocks
          }
      }
    });
    res.json(blocks);
  } catch (error) {
    console.error('[/api/page-blocks GET] Error fetching page blocks:', error);
    res.status(500).json({ message: 'Failed to fetch page blocks.' });
  }
});

// POST /api/page-blocks/bulk-update - Replaces all blocks for a user with a new set
router.post('/bulk-update', async (req, res) => {
  const { blocks } = req.body;
  
  if (!Array.isArray(blocks)) {
    return res.status(400).json({ message: 'A "blocks" array is required.' });
  }

  const userId = req.localUser.id;

  // --- Data validation loop ---
  for (const block of blocks) {
    if (!block.type) {
        return res.status(400).json({ message: 'All blocks must have a type.' });
    }
    if (block.type === 'LINK') {
      if (!block.title || !block.url) {
        return res.status(400).json({ message: 'Link blocks must have a title and a URL.' });
      }
      try {
        new URL(block.url.startsWith('http') ? block.url : `https://${block.url}`);
      } catch (_) {
        return res.status(400).json({ message: `Invalid URL found for link: ${block.title}` });
      }
    }
    if (block.type === 'WISHLIST') {
        if (!block.title || !block.priceCents) {
            return res.status(400).json({ message: 'Wishlist blocks must have a title and a price.' });
        }
        if (!block.isUnlimited && (!block.quantityGoal || parseInt(block.quantityGoal) <= 0)) {
            return res.status(400).json({ message: 'Wishlist items with a quantity must have a goal greater than 0.' });
        }
    }
  }

  try {
    // Use a transaction to perform the delete and create operations atomically.
    const result = await prisma.$transaction(async (tx) => {
      // 1. Delete all existing blocks for this user.
      await tx.pageBlock.deleteMany({
        where: { userId: userId },
      });

      // 2. If the new blocks array is not empty, create the new set.
      if (blocks.length > 0) {
        const newBlocksData = blocks.map((block, index) => ({
          type: block.type,
          order: index,
          title: block.title,
          url: block.type === 'LINK' ? block.url : null,
          priceCents: block.type === 'WISHLIST' ? parseInt(block.priceCents) : null,
          quantityGoal: (block.type === 'WISHLIST' && !block.isUnlimited) ? parseInt(block.quantityGoal) : null,
          isUnlimited: block.type === 'WISHLIST' ? block.isUnlimited || false : false,
          userId: userId,
        }));

        await tx.pageBlock.createMany({
          data: newBlocksData,
        });
      }

      // 3. Fetch the newly created blocks to return them with their generated IDs.
      const createdBlocks = await tx.pageBlock.findMany({
        where: { userId: userId },
        orderBy: { order: 'asc' },
        include: {
            _count: {
                select: { payments: true }
            }
        }
      });
      return createdBlocks;
    });

    res.status(200).json({ success: true, message: "Page saved successfully!", data: result });
  } catch (error) {
    console.error('[/api/page-blocks/bulk-update] Error:', error);
    res.status(500).json({ success: false, message: 'An error occurred while saving your page.' });
  }
});

module.exports = router;