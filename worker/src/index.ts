/**
 * Casa Live - Cloudflare Worker skeleton
 * Ruolo futuro:
 * - ricevere webhook/eventi provider
 * - normalizzare gli eventi
 * - valutare automazioni e desired-state rules
 * - inviare comandi ai provider
 * - aggiornare Supabase server-side
 *
 * Le credenziali provider NON devono mai essere inviate al browser.
 */
export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({ ok: true, service: 'casa-live-engine' });
    }

    if (url.pathname === '/events' && request.method === 'POST') {
      const event = await request.json();
      // TODO V2: validate + normalize + persist + evaluate affected rules.
      return Response.json({ accepted: true, event }, { status: 202 });
    }

    return new Response('Casa Live Engine', { status: 200 });
  }
};
