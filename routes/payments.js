// backend/routes/payments.js
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const { supabaseAdmin } = require('../lib/supabase');
const { subDays, startOfDay } = require('date-fns');

// Helper function to abstract the database query for payment stats.
// This avoids repeating the same aggregation logic.
const getPaymentStats = async (userId, currency, dateFilter = {}) => {
  let query = supabaseAdmin
    .from('Payment')
    .select('netAmountToRecipient', { count: 'exact' })
    .eq('recipientUserId', userId)
    .eq('status', 'SUCCEEDED')
    .eq('currency', currency.toLowerCase());

  if (dateFilter.createdAt?.gte) {
    query = query.gte('createdAt', dateFilter.createdAt.gte);
  }

  const { data, error, count } = await query.range(0, 9999);
  if (error) throw error;

  return {
    revenueCents: (data || []).reduce((sum, row) => sum + (row.netAmountToRecipient || 0), 0),
    giftCount: count || 0,
  };
};

// GET /api/payments/stats - Fetch payment stats for the authenticated user
// Accepts query parameters: ?period=7d&currency=usd
router.get('/stats', authMiddleware, async (req, res) => {
  if (!req.localUser?.id) {
    return res.status(403).json({ message: 'User profile not found.' });
  }
  const userId = req.localUser.id;
  const period = req.query.period || '30d'; // Default to 30d if not provided
  const currency = req.query.currency || 'usd'; // Default to USD if not provided

  const now = new Date();

  // Use a map for a more declarative way to determine the start date.
  const periodMap = {
    'today': () => startOfDay(now),
    '7d': () => subDays(now, 7),
    '30d': () => subDays(now, 30),
  };
  const startDate = (periodMap[period] || periodMap['30d'])();

  try {
    // Use the helper function to get both sets of stats
    const [periodStatsData, allTimeStatsData] = await Promise.all([
      getPaymentStats(userId, currency, { createdAt: { gte: startDate } }),
      getPaymentStats(userId, currency),
    ]);

    const stats = {
      allTime: {
        ...allTimeStatsData,
        currency: currency,
      },
      period: {
        ...periodStatsData,
        currency: currency,
        timeframe: period,
      },
    };

    res.json(stats);

  } catch (error) {
    console.error(`[/api/payments/stats] Error fetching payment stats for user ${userId}:`, error);
    res.status(500).json({ message: 'Failed to fetch payment stats.' });
  }
});

// GET /api/payments/history - Fetch a unified, chronological list of all transactions (payments and payouts)
router.get('/history', authMiddleware, async (req, res) => {
    if (!req.localUser?.id) {
      return res.status(403).json({ message: 'User profile not found.' });
    }
    const userId = req.localUser.id;

    try {
        // 1. Fetch recent payments (including non-succeeded ones)
        const { data: payments, error: paymentsError } = await supabaseAdmin
          .from('Payment')
          .select('id,createdAt,status,netAmountToRecipient,currency,payerName')
          .eq('recipientUserId', userId)
          .in('status', ['SUCCEEDED', 'REFUNDED', 'DISPUTED'])
          .order('createdAt', { ascending: false })
          .limit(50);
        if (paymentsError) throw paymentsError;

        // 2. Fetch recent payouts
        const { data: payouts, error: payoutsError } = await supabaseAdmin
          .from('Payout')
          .select('id,createdAt,status,amount,currency')
          .eq('userId', userId)
          .order('createdAt', { ascending: false })
          .limit(50);
        if (payoutsError) throw payoutsError;

        // 3. Map payments to a common, standardized format
        const formattedPayments = payments.map(p => ({
            id: `payment-${p.id}`,
            date: p.createdAt,
            type: 'PAYMENT',
            status: p.status, // SUCCEEDED, REFUNDED, DISPUTED
            amount: p.netAmountToRecipient,
            currency: p.currency,
            description: `From ${p.payerName || 'Anonymous'}`
        }));

        // 4. Map payouts to the same common format
        const formattedPayouts = payouts.map(p => ({
            id: `payout-${p.id}`,
            date: p.createdAt,
            type: 'PAYOUT',
            status: p.status.toString(), // PAID or FAILED
            amount: p.amount,
            currency: p.currency,
            description: p.status === 'FAILED' ? 'Payout Failed' : 'Payout to your bank'
        }));
        
        // 5. Combine both arrays, sort by date descending, and take the most recent 50
        const transactions = [...formattedPayments, ...formattedPayouts]
            .sort((a, b) => new Date(b.date) - new Date(a.date))
            .slice(0, 50);

        res.json(transactions);

    } catch (error) {
        console.error(`[/api/payments/history] Error fetching transaction history for user ${userId}:`, error);
        res.status(500).json({ message: 'Failed to fetch transaction history.' });
    }
});

module.exports = router;