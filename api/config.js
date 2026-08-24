module.exports = function handler(req, res) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabasePublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  const casaLiveEngineUrl = process.env.CASA_LIVE_ENGINE_URL || '';

  if (!supabaseUrl || !supabasePublishableKey) {
    return res.status(500).json({
      error: 'Supabase non configurato. Imposta SUPABASE_URL e SUPABASE_PUBLISHABLE_KEY su Vercel.'
    });
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ supabaseUrl, supabasePublishableKey, casaLiveEngineUrl });
};
