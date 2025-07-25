// backend/routes/payments.js
const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { authMiddleware } = require('../middleware/auth');
const { subDays } = require('date-fns'); // A helpful library for date calculations: npm install date-fns

// GET /api/payments/stats - Fetch payment stats for the authenticated user
router.get('/stats', authMiddleware, async (req, res) => {
  if (!req.localUser?.id) {
    return res.status(403).json({ message: 'User profile not found.' });
  }
  const userId = req.localUser.id;

  try {
    // 1. Calculate All-Time Stats
    const allTimeStats = await prisma.payment.aggregate({
      where: { recipientUserId: userId, status: 'succeeded' },
      _sum: {
        netAmountToRecipient: true, // Sum of what the creator received (in cents)
      },
      _count: {
        id: true, // Count of successful payments
      },
    });

    // 2. Calculate Last 30 Days Stats
    const thirtyDaysAgo = subDays(new Date(), 30);
    const last30DaysStats = await prisma.payment.aggregate({
      where: {
        recipientUserId: userId,
        status: 'succeeded',
        createdAt: {
          gte: thirtyDaysAgo, // gte = greater than or equal to
        },
      },
      _sum: {
        netAmountToRecipient: true,
      },
      _count: {
        id: true,
      },
    });

    const stats = {
      allTime: {
        revenueCents: allTimeStats._sum.netAmountToRecipient || 0,
        giftCount: allTimeStats._count.id || 0,
      },
      last30Days: {
        revenueCents: last30DaysStats._sum.netAmountToRecipient || 0,
        giftCount: last30DaysStats._count.id || 0,
      },
    };

    res.json(stats);

  } catch (error) {
    console.error(`[/api/payments/stats] Error fetching payment stats for user ${userId}:`, error);
    res.status(500).json({ message: 'Failed to fetch payment stats.' });
  }
});

// GET /api/payments/history - Fetch detailed payment history for the authenticated user
router.get('/history', authMiddleware, async (req, res) => {
    if (!req.localUser?.id) {
      return res.status(403).json({ message: 'User profile not found.' });
    }
    const userId = req.localUser.id;
  
    try {
      const paymentHistory = await prisma.payment.findMany({
        where: { recipientUserId: userId, status: 'succeeded' },
        orderBy: {
          createdAt: 'desc', // Show most recent first
        },
        select: {
          id: true,
          createdAt: true,
          netAmountToRecipient: true, // What the creator received (in cents)
          currency: true,
          payerName: true,
          // payerMessage: true, // If you ever add this back
        },
      });
  
      res.json(paymentHistory);
  
    } catch (error) {
      console.error(`[/api/payments/history] Error fetching payment history for user ${userId}:`, error);
      res.status(500).json({ message: 'Failed to fetch payment history.' });
    }
});


module.exports = router;