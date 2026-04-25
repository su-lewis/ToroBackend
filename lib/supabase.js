const { createClient } = require('@supabase/supabase-js');

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const supabaseAnon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

module.exports = {
  supabaseAdmin,
  supabaseAnon,
  createSupabaseClient: (key) => createClient(process.env.SUPABASE_URL, key),
};
