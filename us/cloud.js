import { validateState } from './model.js?v=1';

export async function createCloudStore(config) {
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
  const client = createClient(config.supabaseUrl, config.supabasePublicKey);
  const unwrap = ({ data, error }) => { if (error) throw new Error(error.message); return data; };
  let profile = null;
  return {
    mode: 'cloud',
    get profile() { return profile; },
    async session() { return unwrap(await client.auth.getSession()).session; },
    async signIn(email, password) { return unwrap(await client.auth.signInWithPassword({ email, password })); },
    async signOut() { profile = null; unwrap(await client.auth.signOut()); },
    async load() {
      const data = unwrap(await client.rpc('universe_snapshot'));
      profile = data.profile;
      return validateState(data.state);
    },
    async add(record) { unwrap(await client.rpc('universe_add', { p_id: record.id, p_person: record.person, p_delta: record.delta, p_reason: record.reason })); return this.load(); },
    async undo(id) { unwrap(await client.rpc('universe_undo', { p_record_id: id })); return this.load(); },
    subscribe(callback) {
      // Refresh only visible tabs; every write is validated and serialized in Postgres.
      const timer = setInterval(() => { if (!document.hidden) callback(); }, 20000);
      const listener = () => { if (!document.hidden) callback(); };
      document.addEventListener('visibilitychange', listener);
      return () => { clearInterval(timer); document.removeEventListener('visibilitychange', listener); };
    },
  };
}
