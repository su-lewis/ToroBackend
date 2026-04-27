const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../lib/supabase');

// GET public profile by username
router.get('/profile/:username', async (req, res) => {
  const { username } = req.params;
  try {
    const { data: user, error: userError } = await supabaseAdmin
      .from('User')
      .select('id,username,displayName,bio,profileImageUrl,bannerImageUrl,profileBackgroundColor,stripeAccountId,stripeOnboardingComplete,payoutsInUsd,stripeDefaultCurrency')
      .eq('username', username)
      .single();

    if (userError) {
      if (userError.code === 'PGRST116' || userError.details?.includes('No rows found')) {
        return res.status(404).json({ message: 'User not found' });
      }
      throw userError;
    }

    const { data: pageBlocks, error: blocksError } = await supabaseAdmin
      .from('PageBlock')
      .select('*')
      .eq('userId', user.id)
      .order('order', { ascending: true });
    if (blocksError) throw blocksError;

    const blocksWithCounts = (pageBlocks || []).map(({ payments, ...block }) => ({
      ...block,
      _count: { payments: payments?.length ?? 0 }
    }));

    res.json({ ...user, pageBlocks: blocksWithCounts });
  } catch (error) {
    console.error("Error fetching public profile:", error);
    res.status(500).json({ message: 'Error fetching public profile', error: error.message });
  }
});

module.exports = router;